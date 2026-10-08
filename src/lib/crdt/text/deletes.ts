/**
 * Per-writer text delete marks — D54 applied to text (fork patch P11).
 *
 * Deleting text tombstones its engine items, and the engine's undo brings
 * text back as COPIES (new items). The engine records no writer for a
 * delete, so two writers who deleted the same character concurrently could
 * not tell each other's delete from their own: one undo brought it back
 * although the other writer's delete still held it, and the second undo
 * brought a second copy. A mark names the writer: every text delete writes
 * one record (its engine client is the writer) listing the characters it
 * deleted. Records sit in the history's scope — an undo deletes the undoer's
 * own record and a redo writes a copy of it — so a live record is exactly
 * "this writer's delete is in effect".
 *
 * The rule: a character is visible iff no writer's delete of it is in
 * effect, and at most one copy of it is visible. A character keeps one
 * identity across copies, its ROOT (the original item): every restoration
 * writes a record naming, for each copy, the member it copied and the root
 * (never removed). A character is restored by copying its newest member —
 * the leaf of that lineage, where its neighbours' copies are — so restored
 * text keeps its order whoever restores it. Every decision is made by the
 * replica whose fact it is, never on another replica's stale state:
 *
 * - restoring (the undoing history): the engine hands every text unit of a
 *   popped step to `restoreFilter`, which withholds it, and `onApply`
 *   restores each character of the step no other live mark holds and no
 *   copy shows, once. A character another mark holds stays PENDING on that
 *   history, which restores it once no mark holds it and no copy shows (two
 *   writers undid a double delete concurrently, each withheld by the other);
 * - holding (the mark's writer): a copy that appears while the writer's
 *   mark holds its character — a peer undid without having seen the delete
 *   — is deleted by that writer, as part of the marked step (so its undo
 *   brings the character back). A delete, and a redo that writes its mark
 *   again, hide the character's other visible copies in the same step;
 * - deduplicating (the copy's writer): a replica deletes its own copy when a
 *   copy with a smaller id shows the same character (concurrent
 *   restorations; the smaller one wins).
 *
 * Writes a local step needs join it (`onApply`, the facade's delete), so an
 * undo stays one update. Writes a REMOTE change calls for run in one
 * follow-up transaction under an origin no history tracks, like the
 * engine's formatting cleanup (P10). Pending characters, holding and
 * deduplication are session facts: a writer whose history ended no longer
 * hides a concurrent restoration, though its live mark still withholds every
 * later undo.
 *
 * The index of marks and copies is `text/delete-index.ts`; this module
 * writes the marks, restores, holds and deduplicates.
 */
import type { EngineApi, EngineDoc, EngineNode, YUndoManager } from '../engine-api.js';
import {
	CONTENT_NODE,
	HORIZON_ROOT,
	INLINE_NODE,
	RESTORED_ROOT,
	TEXT_DELETES_ROOT
} from '../schema.js';
import {
	attrItems,
	clientsOf,
	dropSearchMarkers,
	engineOps,
	firstItem,
	keepFromCollection,
	nextClock,
	onTransaction,
	stepsOf,
	structAt,
	walkIdSetStructs,
	type StoreStruct
} from '../structs.js';
import {
	clip,
	decode,
	deleteIndex,
	encode,
	FOLD_SPANS,
	keyOf,
	mergeSpans,
	overlaps,
	type Copy,
	type IdSet,
	type Policy,
	type Rec,
	type State,
	type Step,
	type Tr,
	type Unit
} from './delete-index.js';

/** Engine ids `c:k … c:k+n-1`. */
export type Span = { c: number; k: number; n: number };

const REACT = Symbol('edytor.text-deletes');
const states = new WeakMap<EngineDoc, State>();

export const bindDeletes = (Y: EngineApi) => {
	const {
		idSet,
		each,
		rootSpans,
		members,
		liveRoots,
		shown,
		indexOf,
		leaves,
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
	} = deleteIndex(Y);
	const ops = engineOps(Y);

	const attach = (doc: EngineDoc): State => {
		let s = states.get(doc);
		if (s !== undefined) return s;
		s = {
			doc: doc as State['doc'],
			marks: doc.get(TEXT_DELETES_ROOT),
			restored: doc.get(RESTORED_ROOT),
			horizon: doc.get(HORIZON_ROOT),
			held: new Map(),
			holds: new Map(),
			copies: new Map(),
			byRoot: new Map(),
			byOrigin: new Map(),
			copyKeys: new Set(),
			policies: new Set(),
			lastMark: null
		};
		states.set(doc, s);
		const st = s;
		const records = (node: EngineNode, fn: (r: Rec, bytes: Uint8Array) => unknown): void => {
			for (let it = firstItem<Unit>(node); it; it = it.right as Unit)
				if (!it.deleted) for (const [r, bytes] of recordsIn(it, null)) fn(r, bytes);
		};
		attrItems<Unit>(st.restored).forEach((it) => {
			// A record the purge deleted names nothing any more (H7).
			if (!it.deleted) for (const [r, bytes] of recordsIn(it, null)) indexRecord(st, r, bytes);
		});
		records(st.marks, (r, bytes) => indexMark(st, r, bytes));
		// A deleted copy may have to be copied again by any replica (holds,
		// duplicates, pending characters): garbage collection keeps its content.
		const copy = (it: StoreStruct | null | undefined): boolean =>
			it != null &&
			(st.copies.get(it.id.client) ?? []).some((e) =>
				overlaps(e, { k: it.id.clock, n: it.length })
			);
		// (an inline atom copy keeps its attributes too)
		keepFromCollection<Unit>(
			doc,
			(it) => !copy(it) && !copy((it.parent as { _item?: StoreStruct | null } | undefined)?._item)
		);
		onTransaction<Tr>(doc, 'afterTransaction', (tr) => react(st, tr));
		return st;
	};

	// ── the writes ─────────────────────────────────────────────────────

	/** Delete the live ids `live` (split at their edges); `into` a step, kept for its undo. */
	const remove = (tr: Tr, live: readonly Span[], into?: Step, keep = into !== undefined): void => {
		if (live.length === 0) return;
		each(tr, live, (it) => {
			if (it.deleted) return;
			it.delete(tr);
			dropSearchMarkers(it.parent);
			if (keep) (it as { keep?: boolean }).keep = true;
		});
		if (into !== undefined) ops.insertInto(into.deletes, idSet(live));
	};

	/** Restore root span `r` by copying its leaves; writes the restoration record. */
	const restore = (s: State, p: Policy, tr: Tr, r: Span): void => {
		const rows: number[][] = [];
		const copies: Copy[] = [];
		for (const leaf of leaves(s, r)) {
			const items: Unit[] = [];
			each(tr, [leaf], (it) => void (it.deleted && items.push(it)));
			for (const it of items) {
				// A leaf has no copy: a local `redone` link left by an earlier
				// restoration points at a copy this lineage no longer shows.
				(it as { redone: unknown }).redone = null;
				const copy = ops.redo(tr, it, new Set([it]), p.um());
				if (copy === null) continue;
				dropSearchMarkers(copy.parent);
				// An inline atom comes back with its attributes: they were deleted with
				// it and are re-created into the copy (their parent's `redone`).
				const attrs = it.content.type?._map;
				if (attrs !== undefined) {
					const kids = [...attrs.values()].filter((c) => c.deleted);
					for (const kid of kids) ops.redo(tr, kid, new Set(kids), p.um());
				}
				const e = {
					c: copy.id.client,
					k: copy.id.clock,
					n: it.length,
					rc: r.c,
					rk: leaf.rk + it.id.clock - leaf.k,
					oc: it.id.client,
					ok: it.id.clock
				};
				rows.push([e.k, e.n, e.rc, e.rk, e.oc, e.ok]);
				copies.push(e);
			}
		}
		if (rows.length === 0) return;
		// One key per record (its own id): a map entry depends on nothing, so
		// the record integrates with the copies it names, before collection.
		const next = nextClock(s.doc, s.doc.clientID);
		s.restored.setAttr(`${s.doc.clientID.toString(36)}.${next.toString(36)}`, encode(rows));
		addCopies(s, copies);
	};

	/**
	 * Keep root spans `roots` visible for `p`: restore what nothing shows and
	 * no mark (but those `skip` names) holds; return the rest, which `p`
	 * watches — unless this replica's own copy shows it. `done` collects what
	 * this pass restored (once per character).
	 */
	const settle = (
		s: State,
		p: Policy,
		tr: Tr,
		roots: readonly Span[],
		skip?: (mark: Rec) => boolean,
		done: Span[] = []
	): Span[] => {
		const watch: Span[] = [];
		for (const r of roots)
			for (const part of minus(r, done).flatMap((x) => parts(s, x))) {
				const live = shown(s, [part]);
				if (live.length > 0) {
					if (live.some((l) => l.c !== s.doc.clientID)) watch.push(part);
				} else if (holders(s, part, skip).length > 0) watch.push(part);
				else {
					restore(s, p, tr, part);
					done.push(part);
				}
			}
		return watch;
	};

	/** The undo step of this replica that wrote `mark`. */
	const stepOf = (s: State, mark: Rec): Step | undefined => {
		for (const p of s.policies)
			for (const step of stepsOf<Step>(p.um().undoStack))
				if (step.inserts.has(mark.client, mark.clock)) return step;
		return undefined;
	};

	/** This replica's live marks hide what the copies `copies` show, in their steps. */
	const hold = (s: State, tr: Tr, copies: readonly Copy[]): void => {
		for (const e of copies) {
			const r = { c: e.rc, k: e.rk, n: e.n };
			for (const mark of holders(s, r, (m) => m.client !== s.doc.clientID)) {
				const roots = (s.holds.get(keyOf(mark)) ?? []).flatMap((h) => {
					const lo = Math.max(h.k, r.k);
					const hi = Math.min(h.k + h.n, r.k + r.n);
					return h.c === r.c && hi > lo ? [{ c: r.c, k: lo, n: hi - lo }] : [];
				});
				remove(tr, shown(s, roots), stepOf(s, mark));
			}
		}
	};

	/**
	 * Delete this replica's copies of characters another copy shows further
	 * left (and watch them). The leftmost copy wins: a copy sits right before
	 * the member it restored, so keeping the leftmost keeps restored text in
	 * order whichever restorations overlapped.
	 */
	const dedupe = (s: State, tr: Tr, copies: readonly Copy[]): void => {
		const doomed: Span[] = [];
		for (const e of copies) {
			const ms = members(s, { c: e.rc, k: e.rk, n: e.n });
			const live = ms.flatMap((m) => liveRoots(s, m).map((p) => clip(m, p.k, p.k + p.n)));
			for (const o of live) {
				if (o.c !== s.doc.clientID) continue;
				for (let rk = o.rk; rk < o.rk + o.n; rk++) {
					const k = o.k + rk - o.rk;
					const at = indexOf(s, o.c, k);
					const left = live.some(
						(m) => m !== o && m.rk <= rk && rk < m.rk + m.n && indexOf(s, m.c, m.k + rk - m.rk) < at
					);
					if (left) doomed.push({ c: o.c, k, n: 1 });
				}
			}
		}
		remove(tr, doomed, undefined, true);
		const [p] = s.policies;
		for (const d of doomed) p.watch.push(...rootSpans(s, d));
	};

	/** Whether `tr` deleted a member of a character some history watches. */
	const watchedDied = (s: State, tr: Tr): boolean =>
		[...s.policies].some((p) =>
			p.watch.some((w) => members(s, w).some((m) => tr.deleteSet.intersects(m.c, m.k, m.n)))
		);

	/** After every commit: index its records; after a remote one, keep this replica's facts. */
	const react = (s: State, tr: Tr): void => {
		const fresh = sync(s, tr);
		// A purge (H7) deletes marks past the horizon: nothing comes back for
		// it, and a pending character only they held stays deleted.
		if ((tr.changed as Map<unknown, unknown>).has(s.horizon)) {
			for (const p of s.policies)
				p.watch = p.watch.filter((w) => holders(s, w).length > 0 || shown(s, [w]).length > 0);
			return;
		}
		if (tr.local || s.policies.size === 0) return;
		if (fresh.copies.length === 0 && !fresh.released && !watchedDied(s, tr)) return;
		s.doc.transact((t) => {
			hold(s, t as Tr, fresh.copies);
			dedupe(s, t as Tr, fresh.copies);
			for (const p of s.policies) p.watch = settle(s, p, t as Tr, p.watch);
		}, REACT);
	};

	/**
	 * P4: the spans of this writer's last record merged with `spans`, when a
	 * delete may fold into it — it is the records list's last element, live,
	 * this replica's, written in this transaction or in the step still
	 * capturing (`open`: the history steps whose capture group is open), or
	 * anywhere when no history records steps here; and the merged record
	 * stays small ({@link FOLD_SPANS}). `null`: write a record of its own.
	 */
	const foldInto = (
		s: State,
		tr: Tr | null,
		open: readonly IdSet[],
		spans: readonly Span[]
	): Span[] | null => {
		const at = s.lastMark;
		if (at === null || at.c !== s.doc.clientID) return null;
		const last = structAt(Y, clientsOf(s.doc).get(at.c) ?? [], at.k) as
			| (Unit & { right: Unit | null })
			| null;
		if (
			last === null ||
			last.deleted ||
			last.parent !== s.marks ||
			last.right !== null ||
			last.id.clock + last.length - 1 !== at.k
		)
			return null;
		const same =
			tr?.insertSet.has(at.c, at.k) === true ||
			open.some((ids) => ids.has(at.c, at.k)) ||
			s.policies.size === 0;
		if (!same) return null;
		const [, bytes] = recordsIn(last, null).at(-1) ?? [];
		if (bytes === undefined) return null;
		const merged = mergeSpans([...decode(bytes, 3).map(([c, k, n]) => ({ c, k, n })), ...spans]);
		return merged.length <= FOLD_SPANS ? merged : null;
	};

	/**
	 * P4: delete this replica's last record (the list's tail, {@link foldInto})
	 * and append `bytes` right after it, by item: no index walk over the
	 * list's tombstones. The list's search markers are dropped (their
	 * positions no longer hold).
	 */
	const replaceLast = (s: State, tr: Tr, bytes: Uint8Array): void => {
		const at = s.lastMark!;
		const tail = ops.cleanStart<Unit>(tr, at.c, at.k);
		tail.delete(tr);
		dropSearchMarkers(s.marks);
		const client = s.doc.clientID;
		ops.appendAfter(tr, tail, s.marks, client, nextClock(s.doc, client), [bytes]);
	};

	/** The text units `ids` names, as spans. */
	const unitsIn = (s: State, ids: IdSet): Span[] => {
		const out: Span[] = [];
		ids.clients.forEach((ranges, c) => {
			for (const r of ranges.getIds())
				walkIdSetStructs(Y, s.doc, idSet([{ c, k: r.clock, n: r.len }]), (st) => {
					const lo = Math.max(r.clock, st.id.clock);
					const hi = Math.min(r.clock + r.len, st.id.clock + st.length);
					if (hi > lo && isUnit(st as Unit)) out.push({ c, k: lo, n: hi - lo });
				});
		});
		return out;
	};

	/** A text unit a mark can hold: a character or inline atom of a backing text. */
	const isUnit = (it: Unit): boolean =>
		it.parentSub === null &&
		it.parent?.name === CONTENT_NODE &&
		(typeof it.content?.str === 'string' || it.content?.type?.name === INLINE_NODE);

	return {
		/** The history's extra scope: the marks (an undo removes its own). */
		scope: (doc: EngineDoc): EngineNode => attach(doc).marks,

		/**
		 * Mark `spans` (the characters a text delete just deleted, inside its
		 * transaction) as this writer's, and hide their other visible copies.
		 */
		markDeleted: (doc: EngineDoc, deleted: readonly Span[]): void => {
			const s = attach(doc);
			// Text inserted and deleted within one open capture group never comes
			// back by that step's undo (the engine skips such a step): no mark.
			const fresh = [...s.policies].flatMap((p) => {
				const um = p.um();
				const top = stepsOf<Step>(um.undoStack).at(-1);
				const open =
					top !== undefined &&
					!um.undoing &&
					!um.redoing &&
					um.lastChange > 0 &&
					Date.now() - um.lastChange < um.captureTimeout;
				return open ? [top.inserts] : [];
			});
			const tr = s.doc._transaction;
			const spans = deleted.flatMap((sp) => {
				const out: Span[] = [];
				for (let k = sp.k; k < sp.k + sp.n; k++) {
					if (fresh.some((ids) => ids.has(sp.c, k))) continue;
					const last = out[out.length - 1];
					if (last !== undefined && last.k + last.n === k) last.n++;
					else out.push({ c: sp.c, k, n: 1 });
				}
				return out;
			});
			if (spans.length === 0) return;
			// P4: a delete in the step that wrote this writer's last record
			// (a backspace run) folds into it, its spans merged — one record per
			// step, not per keystroke. The record is replaced (deleted and
			// written again), never edited, so an undo of the step still takes
			// back exactly what the step deleted.
			const folded = tr === null ? null : foldInto(s, tr, fresh, spans);
			const k = nextClock(s.doc, s.doc.clientID);
			const bytes = encode((folded ?? spans).map((sp) => [sp.c, sp.k, sp.n]));
			if (folded === null) s.marks.insert(s.marks.length, [bytes]);
			else replaceLast(s, tr!, bytes);
			s.lastMark = { c: s.doc.clientID, k };
			if (tr !== null)
				remove(
					tr,
					shown(
						s,
						spans.flatMap((sp) => rootSpans(s, sp))
					)
				);
		},

		/**
		 * Whether every live mark holding a character of `spans` was written
		 * where `old` says (H7: a withdrawn block's content was deleted
		 * before the horizon). Characters no mark holds count as old.
		 */
		heldBefore: (
			doc: EngineDoc,
			spans: readonly Span[],
			old: (client: number, clock: number) => boolean
		): boolean => {
			const s = attach(doc);
			return spans
				.flatMap((sp) => rootSpans(s, sp))
				.every((r) => holders(s, r).every((mark) => old(mark.client, mark.clock)));
		},

		/**
		 * The purge's part (H7, `room.purge.what`), inside the purge
		 * transaction: delete every text delete mark record `old` names, and
		 * every restoration record `old` names whose copies are all deleted
		 * and that no remaining mark holds; its copies are forgotten (the
		 * `gcFilter` no longer keeps them) and collected. Writes no mark.
		 */
		purge: (
			doc: EngineDoc,
			old: (client: number, clock: number) => boolean
		): { marks: number; records: number } => {
			const s = attach(doc);
			const tr = s.doc._transaction;
			if (tr === null) throw new Error('purge: outside a transaction');
			const spans: Span[] = [];
			const dropped: Rec[] = [];
			for (let it = firstItem<Unit>(s.marks); it; it = it.right as Unit)
				if (!it.deleted)
					for (let j = 0; j < it.length; j++) {
						const r = { client: it.id.client, clock: it.id.clock + j };
						if (!old(r.client, r.clock)) continue;
						dropped.push(r);
						const last = spans[spans.length - 1];
						if (last !== undefined && last.c === r.client && last.k + last.n === r.clock) last.n++;
						else spans.push({ c: r.client, k: r.clock, n: 1 });
					}
			dropMarks(s, dropped);
			const marks = dropped.length;
			remove(tr, spans);
			const doomed: { key: string; copies: Copy[] }[] = [];
			attrItems<Unit>(s.restored).forEach((it, key) => {
				if (it.deleted || !old(it.id.client, it.id.clock)) return;
				const [record, bytes] = recordsIn(it, null)[0] ?? [];
				if (bytes === undefined) return;
				const copies = copiesOf(record, bytes);
				const dead = copies.every(
					(e) =>
						liveRoots(s, { c: e.c, k: e.k, n: e.n, rk: e.k }).length === 0 &&
						holders(s, { c: e.rc, k: e.rk, n: e.n }).length === 0
				);
				if (dead) doomed.push({ key, copies });
			});
			for (const { key, copies } of doomed) {
				s.restored.deleteAttr(key);
				forget(s, copies);
				collect(s, tr, copies);
			}
			return { marks, records: doomed.length };
		},

		/** The `restoreFilter` and `onApply` options of a history on `doc` (P11). */
		history: (doc: EngineDoc, um: () => YUndoManager) => {
			const s = attach(doc);
			const p: Policy = { um, watch: [], tr: null, units: [] };
			s.policies.add(p);
			const current = (): Policy => {
				const tr = s.doc._transaction;
				if (p.tr !== tr) Object.assign(p, { tr, units: [] });
				return p;
			};
			return {
				/** Text units are restored by `onApply`, character by character. */
				restoreFilter: (item: unknown): boolean => {
					const it = item as Unit;
					if (!isUnit(it)) return true;
					current().units.push({ c: it.id.client, k: it.id.clock, n: it.length });
					return false;
				},
				onApply: (transaction: unknown, stackItem: unknown): void => {
					const tr = transaction as Tr;
					const q = current();
					const step = stackItem as Step;
					const fresh = sync(s, tr);
					const roots = q.units.flatMap((u) => rootSpans(s, u));
					const ours = (m: Rec) => step.inserts.has(m.client, m.clock);
					q.watch.push(...settle(s, q, tr, roots, ours));
					// A redo writes its marks again: they hide what shows their characters.
					const held = fresh.marks.flatMap((m) => s.holds.get(keyOf(m)) ?? []);
					remove(tr, shown(s, held));
					// Text the step deleted that no mark of it holds (an undo of typing) is
					// this writer's delete too.
					const bare = unitsIn(s, tr.deleteSet).filter((u) =>
						rootSpans(s, u).some(
							(r) => !held.some((h) => h.c === r.c && h.k <= r.k && r.k + r.n <= h.k + h.n)
						)
					);
					if (bare.length > 0)
						s.marks.insert(s.marks.length, [encode(bare.map((u) => [u.c, u.k, u.n]))]);
					q.units = [];
				}
			};
		}
	};
};

export type TextDeletes = ReturnType<typeof bindDeletes>;
