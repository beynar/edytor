/**
 * The index of text delete marks and restoration records (`text/deletes.ts`):
 * which root characters each live mark holds, every copy of a character and
 * what it copied, and the reads over them (members, leaves, holders, the
 * parts of one status), kept in each document's `State`.
 */
import * as decoding from 'lib0-v14/decoding';
import * as encoding from 'lib0-v14/encoding';
import type { EngineApi, EngineDoc, EngineNode, YUndoManager } from '../engine-api.js';
import {
	asYDoc,
	clientsOf,
	collectable,
	collectNow,
	collects,
	engineOps,
	structAt,
	walkIdSetStructs,
	type IdSetLike,
	type IdSetOf,
	type StoreStruct
} from '../structs.js';
import type { Span } from './deletes.js';

/** Copy `c:k…` of member `oc:ok…`, whose root characters are `rc:rk…` (`n` of them). */
export type Copy = Span & { rc: number; rk: number; oc: number; ok: number };
/** A piece of one member (root or copy) of some characters: ids `c:k…`, root characters from `rk`. */
export type Member = Span & { rk: number };
/** A record (one element of a records list), by engine id. */
export type Rec = { client: number; clock: number };

export type Unit = StoreStruct & {
	parent: EngineNode & { name?: string };
	content: {
		getContent(): unknown[];
		str?: string;
		type?: { name?: string; _map?: Map<string, Unit> };
	};
	delete(tr: unknown): void;
};
export type IdSet = IdSetOf;
export type Tr = {
	local: boolean;
	insertSet: IdSet;
	deleteSet: IdSet;
	changed: Map<unknown, unknown>;
};
export type Step = { inserts: IdSet; deletes: IdSet };

export type Policy = {
	um: () => YUndoManager;
	/**
	 * Root spans this session answers for: characters an undo skipped (held,
	 * or shown by another copy) and copies it removed as duplicates. Each is
	 * restored whenever nothing shows it and no mark holds it.
	 */
	watch: Span[];
	/** The text units of the step being popped (its transaction). */
	tr: unknown;
	units: Span[];
};

export type State = {
	doc: EngineDoc & { clientID: number; _transaction: Tr | null };
	marks: EngineNode;
	restored: EngineNode;
	/** The purge horizon's root (H7): a transaction that changes it is a purge. */
	horizon: EngineNode;
	/** Marks by root client: the root spans each holds (and by mark key). */
	held: Map<number, Map<string, { k: number; n: number; mark: Rec }[]>>;
	holds: Map<string, Span[]>;
	/** Copies by copy client, root client and origin client. */
	copies: Map<number, Copy[]>;
	byRoot: Map<number, Copy[]>;
	byOrigin: Map<number, Copy[]>;
	copyKeys: Set<string>;
	policies: Set<Policy>;
	/** P4: this replica's last delete record (its id), the one a delete may fold into. */
	lastMark: { c: number; k: number } | null;
};

export const overlaps = (a: { k: number; n: number }, b: { k: number; n: number }): boolean =>
	a.k < b.k + b.n && b.k < a.k + a.n;
export const push = <T>(map: Map<number, T[]>, key: number, v: T): void => {
	const list = map.get(key);
	if (list === undefined) map.set(key, [v]);
	else list.push(v);
};
export const keyOf = (r: Rec): string => `${r.client}:${r.clock}`;
/** P4: the most spans a folded delete record holds (a backspace run merges into one). */
export const FOLD_SPANS = 8;
/** `spans` sorted, with touching and overlapping spans of one client merged. */
export const mergeSpans = (spans: readonly Span[]): Span[] => {
	const out: Span[] = [];
	for (const sp of [...spans].sort((a, b) => a.c - b.c || a.k - b.k)) {
		const last = out[out.length - 1];
		if (last !== undefined && last.c === sp.c && sp.k <= last.k + last.n)
			last.n = Math.max(last.n, sp.k + sp.n - last.k);
		else out.push({ ...sp });
	}
	return out;
};
/** `m` narrowed to root characters `[lo, hi)`. */
export const clip = (m: Member, lo: number, hi: number): Member => ({
	c: m.c,
	k: m.k + lo - m.rk,
	n: hi - lo,
	rk: lo
});

export const encode = (rows: number[][]): Uint8Array => {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, rows.length);
	for (const row of rows) for (const v of row) encoding.writeVarUint(e, v);
	return encoding.toUint8Array(e);
};
export const decode = (bytes: Uint8Array, width: number): number[][] => {
	const d = decoding.createDecoder(bytes);
	const rows: number[][] = [];
	for (let i = decoding.readVarUint(d); i > 0; i--) {
		const row: number[] = [];
		for (let j = 0; j < width; j++) row.push(decoding.readVarUint(d));
		rows.push(row);
	}
	return rows;
};

/** The index's reads and writes over a document's `State`. */
export const deleteIndex = (Y: EngineApi) => {
	const ops = engineOps(Y);
	const idSet = (spans: readonly Span[]): IdSet => {
		const set = ops.idSet();
		for (const sp of spans) set.add(sp.c, sp.k, sp.n);
		return set;
	};
	/** Each item of `spans`, split at their edges. */
	const each = (tr: Tr, spans: readonly Span[], fn: (it: Unit) => void): void =>
		ops.iterate(tr, idSet(spans), fn);

	// ── the index ──────────────────────────────────────────────────────

	/** `sp` as the root spans of its characters, in order (its own ids where it is no copy). */
	const rootSpans = (s: State, sp: Span): Span[] => {
		const out: Span[] = [];
		let k = sp.k;
		const end = sp.k + sp.n;
		const copies = (s.copies.get(sp.c) ?? []).filter((e) => overlaps(e, sp));
		for (const e of copies.sort((a, b) => a.k - b.k)) {
			const lo = Math.max(k, e.k);
			const hi = Math.min(end, e.k + e.n);
			if (lo > k) out.push({ c: sp.c, k, n: lo - k });
			out.push({ c: e.rc, k: e.rk + lo - e.k, n: hi - lo });
			k = hi;
		}
		if (end > k) out.push({ c: sp.c, k, n: end - k });
		return out;
	};

	/** Every member of root span `r`'s characters: the root itself and each copy. */
	const members = (s: State, r: Span): Member[] => [
		{ ...r, rk: r.k },
		...(s.byRoot.get(r.c) ?? [])
			.filter((e) => overlaps({ k: e.rk, n: e.n }, r))
			.map((e) =>
				clip(
					{ c: e.c, k: e.k, n: e.n, rk: e.rk },
					Math.max(r.k, e.rk),
					Math.min(r.k + r.n, e.rk + e.n)
				)
			)
	];

	/** The live parts of member `m`, in root coordinates. */
	const liveRoots = (s: State, m: Member): Span[] => {
		const out: Span[] = [];
		walkIdSetStructs(Y, s.doc, idSet([m]), (st) => {
			if (st.deleted) return;
			const lo = Math.max(m.k, st.id.clock);
			const hi = Math.min(m.k + m.n, st.id.clock + st.length);
			if (hi > lo) out.push({ c: m.c, k: m.rk + lo - m.k, n: hi - lo });
		});
		return out;
	};
	/** The live ids showing root spans `roots`. */
	const shown = (s: State, roots: readonly Span[]): Span[] =>
		roots.flatMap((r) =>
			members(s, r).flatMap((m) => liveRoots(s, m).map((p) => clip(m, p.k, p.k + p.n)))
		);

	/** The live index of id `c:k` in its text (YATA order: the same on every replica). */
	const indexOf = (s: State, c: number, k: number): number =>
		Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON({ item: { client: c, clock: k }, assoc: 0 }),
			asYDoc(s.doc),
			false
		)?.index ?? Infinity;

	/**
	 * List order of ids `a` and `b` of one text (negative: `a` first): their
	 * live indices, and where no live unit separates them, the walk from one
	 * to the other through the dead run between them.
	 */
	const order = (s: State, a: { c: number; k: number }, b: { c: number; k: number }): number => {
		const d = indexOf(s, a.c, a.k) - indexOf(s, b.c, b.k);
		if (d !== 0 || (a.c === b.c && a.k === b.k)) return d;
		const find = (x: { c: number; k: number }) =>
			structAt(Y, clientsOf(s.doc).get(x.c) ?? [], x.k) as (Unit & { right: Unit | null }) | null;
		const [sa, sb] = [find(a), find(b)];
		if (sa === sb) return a.k - b.k;
		for (let it = sa?.right ?? null; it !== null; it = it.right as typeof it) {
			if (it === sb) return -1;
			if (!it.deleted && it.countable !== false) break;
		}
		return 1;
	};

	/**
	 * What restores root span `r`: per character, the leftmost leaf of its
	 * lineage (a member no copy was made of). A copy sits right before what it
	 * copied, so leaves are the newest incarnations, and the leftmost one is
	 * where the leftmost-wins deduplication keeps its neighbours.
	 */
	const leaves = (s: State, r: Span): Member[] => {
		const ms = members(s, r);
		if (ms.length === 1) return ms;
		const copied = (m: Member, rk: number): boolean => {
			const id = m.k + rk - m.rk;
			return (s.byOrigin.get(m.c) ?? []).some((e) => e.ok <= id && id < e.ok + e.n);
		};
		// A leaf beside a shown neighbour of the same copy puts the character back
		// among the neighbours it was restored with.
		const beside = (m: Member, rk: number): boolean => {
			const id = m.k + rk - m.rk;
			const e = (s.copies.get(m.c) ?? []).find((x) => x.k <= id && id < x.k + x.n);
			const lo = e?.k ?? -Infinity;
			const hi = e === undefined ? Infinity : e.k + e.n;
			return [id - 1, id + 1].some(
				(k) =>
					k >= lo && k < hi && structAt(Y, clientsOf(s.doc).get(m.c) ?? [], k)?.deleted === false
			);
		};
		const out: Member[] = [];
		for (let rk = r.k; rk < r.k + r.n; rk++) {
			let best: Member | null = null;
			let near = false;
			for (const m of ms) {
				if (rk < m.rk || rk >= m.rk + m.n || copied(m, rk)) continue;
				const id = { c: m.c, k: m.k + rk - m.rk };
				const b = beside(m, rk);
				if (
					best === null ||
					(b && !near) ||
					(b === near && order(s, id, { c: best.c, k: best.k + rk - best.rk }) < 0)
				)
					[best, near] = [m, b];
			}
			if (best === null) continue;
			const last = out[out.length - 1];
			if (
				last !== undefined &&
				last.c === best.c &&
				last.rk + last.n === rk &&
				last.k + last.n === best.k + rk - best.rk
			)
				last.n++;
			else out.push(clip(best, rk, rk + 1));
		}
		return out;
	};

	/** Whether the record `r` is live (the struct holding it is not deleted). */
	const alive = (s: State, r: Rec): boolean =>
		structAt(Y, clientsOf(s.doc).get(r.client) ?? [], r.clock)?.deleted === false;

	/** Every hold on root characters of client `c`. */
	const heldOf = (s: State, c: number): { k: number; n: number; mark: Rec }[] =>
		[...(s.held.get(c)?.values() ?? [])].flat();

	/** Live marks holding any character of `r`, except those `skip` names. */
	const holders = (s: State, r: Span, skip?: (mark: Rec) => boolean): Rec[] =>
		heldOf(s, r.c)
			.filter((h) => overlaps(h, r) && !skip?.(h.mark) && alive(s, h.mark))
			.map((h) => h.mark);

	/** `r` without the spans `done`. */
	const minus = (r: Span, done: readonly Span[]): Span[] => {
		let out = [r];
		for (const d of done)
			if (d.c === r.c)
				out = out.flatMap((x) => {
					if (!overlaps(x, d)) return [x];
					const keep: Span[] = [];
					if (d.k > x.k) keep.push({ c: x.c, k: x.k, n: d.k - x.k });
					if (d.k + d.n < x.k + x.n) keep.push({ c: x.c, k: d.k + d.n, n: x.k + x.n - d.k - d.n });
					return keep;
				});
		return out;
	};

	/** `r` cut where a live hold or a shown copy starts or ends: parts of one status each. */
	const parts = (s: State, r: Span): Span[] => {
		const cuts = new Set([r.k, r.k + r.n]);
		const edge = (k: number) => k > r.k && k < r.k + r.n && cuts.add(k);
		for (const h of heldOf(s, r.c))
			if (overlaps(h, r) && alive(s, h.mark)) [h.k, h.k + h.n].forEach(edge);
		for (const m of members(s, r)) for (const p of liveRoots(s, m)) [p.k, p.k + p.n].forEach(edge);
		const at = [...cuts].sort((a, b) => a - b);
		return at.slice(1).map((hi, i) => ({ c: r.c, k: at[i], n: hi - at[i] }));
	};

	/** Index `copies`; the ones that were new. */
	const addCopies = (s: State, copies: readonly Copy[]): Copy[] =>
		copies.filter((e) => {
			const key = `${e.c}:${e.k}`;
			if (s.copyKeys.has(key)) return false;
			s.copyKeys.add(key);
			push(s.copies, e.c, e);
			push(s.byRoot, e.rc, e);
			push(s.byOrigin, e.oc, e);
			return true;
		});
	const indexRecord = (s: State, rec: Rec, bytes: Uint8Array): Copy[] =>
		addCopies(
			s,
			decode(bytes, 6).map(([k, n, rc, rk, oc, ok]) => ({ c: rec.client, k, n, rc, rk, oc, ok }))
		);
	const indexMark = (s: State, mark: Rec, bytes: Uint8Array): boolean => {
		const key = keyOf(mark);
		if (s.holds.has(key)) return false;
		const roots = decode(bytes, 3).flatMap(([c, k, n]) => rootSpans(s, { c, k, n }));
		s.holds.set(key, roots);
		for (const r of roots) {
			let byMark = s.held.get(r.c);
			if (byMark === undefined) s.held.set(r.c, (byMark = new Map()));
			const list = byMark.get(key);
			if (list === undefined) byMark.set(key, [{ k: r.k, n: r.n, mark }]);
			else list.push({ k: r.k, n: r.n, mark });
		}
		return true;
	};
	/** Drop the marks `marks` from the index (by mark: P4 folds drop one per delete); whether any was indexed. */
	const dropMarks = (s: State, marks: readonly Rec[]): boolean => {
		let any = false;
		for (const key of marks.map(keyOf)) {
			const roots = s.holds.get(key);
			if (roots === undefined) continue;
			any = true;
			s.holds.delete(key);
			for (const r of roots) {
				const byMark = s.held.get(r.c);
				byMark?.delete(key);
				if (byMark?.size === 0) s.held.delete(r.c);
			}
		}
		return any;
	};

	/** The records `st` (a struct of a records list) holds that `ids` names, with their bytes. */
	const recordsIn = (st: StoreStruct, ids: IdSetLike | null): [Rec, Uint8Array][] => {
		const content = (st as Unit).content?.getContent?.() ?? [];
		const out: [Rec, Uint8Array][] = [];
		for (let j = 0; j < st.length; j++) {
			const r = { client: st.id.client, clock: st.id.clock + j };
			// A collected record (its content gone) names nothing.
			if (!(content[j] instanceof Uint8Array)) continue;
			if (ids === null || ids.has(r.client, r.clock)) out.push([r, content[j] as Uint8Array]);
		}
		return out;
	};

	/** Index the records `tr` wrote (restorations first: a mark's roots may need them). */
	const sync = (s: State, tr: Tr) => {
		const fresh = { copies: [] as Copy[], marks: [] as Rec[], released: false };
		if (!tr.changed.has(s.marks) && !tr.changed.has(s.restored)) return fresh;
		const inserted: StoreStruct[] = [];
		walkIdSetStructs(Y, s.doc, tr.insertSet, (st) => {
			if (st.parent === s.restored || st.parent === s.marks) inserted.push(st);
		});
		for (const st of inserted)
			if (st.parent === s.restored && !st.deleted)
				for (const [r, bytes] of recordsIn(st, tr.insertSet))
					fresh.copies.push(...indexRecord(s, r, bytes));
		for (const st of inserted)
			if (st.parent === s.marks && !st.deleted)
				for (const [r, bytes] of recordsIn(st, tr.insertSet))
					if (indexMark(s, r, bytes)) fresh.marks.push(r);
		const dropped: Rec[] = [];
		walkIdSetStructs(Y, s.doc, tr.deleteSet, (st) => {
			if (st.parent === s.marks) for (const [r] of recordsIn(st, tr.deleteSet)) dropped.push(r);
			// A restoration record only the purge deletes (H7): its copies are
			// forgotten and collected on every replica, as on the room.
			if (st.parent === s.restored && !tr.insertSet.has(st.id.client, st.id.clock))
				for (const [r, bytes] of recordsIn(st, null)) {
					const copies = copiesOf(r, bytes);
					forget(s, copies);
					collect(s, tr, copies);
				}
		});
		fresh.released = dropMarks(s, dropped);
		return fresh;
	};

	/** The copies record `r` names. */
	const copiesOf = (r: Rec, bytes: Uint8Array): Copy[] =>
		decode(bytes, 6).map(([k, n, rc, rk, oc, ok]) => ({ c: r.client, k, n, rc, rk, oc, ok }));

	/** Drop `copies` from the index: the `gcFilter` no longer keeps them. */
	const forget = (s: State, copies: readonly Copy[]): void => {
		const gone = new Set(copies.map((e) => `${e.c}:${e.k}`));
		const keep = (e: Copy) => !gone.has(`${e.c}:${e.k}`);
		for (const map of [s.copies, s.byRoot, s.byOrigin])
			for (const [c, list] of map) map.set(c, list.filter(keep));
		for (const key of gone) s.copyKeys.delete(key);
	};

	/** Collect the deleted items wholly inside `copies` (none a history keeps). */
	const collect = (s: State, tr: unknown, copies: readonly Copy[]): void => {
		if (!collects(s.doc) || copies.length === 0) return;
		walkIdSetStructs(Y, s.doc, idSet(copies), (st) => {
			const it = st as Unit & { keep?: boolean; content: { constructor: { name: string } } };
			const inside = copies.some(
				(e) => e.c === it.id.client && e.k <= it.id.clock && it.id.clock + it.length <= e.k + e.n
			);
			if (
				inside &&
				it.deleted &&
				it.keep !== true &&
				it.parent !== undefined &&
				collectable(s.doc, it)
			)
				collectNow(it, tr);
		});
	};

	return {
		idSet,
		each,
		rootSpans,
		members,
		liveRoots,
		shown,
		indexOf,
		order,
		leaves,
		alive,
		heldOf,
		holders,
		minus,
		parts,
		addCopies,
		indexRecord,
		indexMark,
		dropMarks,
		recordsIn,
		sync,
		copiesOf,
		forget,
		collect
	};
};

export type DeleteIndex = ReturnType<typeof deleteIndex>;
