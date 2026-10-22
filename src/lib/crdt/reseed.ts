/**
 * A document's re-seed (`room.reseed.*` in `docs/editor-delete-contract.md`):
 * the room rebuilds a document that grew near its quota from its visible
 * content, with fresh identities, and keeps a cut so that an offline
 * client's unsaved edits made against the old document still merge.
 * Worker-safe; the room (`cloudflare/room/reseed.ts`) owns the storage,
 * the trigger and the protocol, this module the cut and the merge.
 *
 * The cut (`cutDocument`): the new epoch's document, seeded from the old
 * one's JSON (same block ids, kinds, data, content, marks, block
 * attribution), and what the room keeps of the old one: its state vector
 * and its deletes (which part of an uploaded old document the room had)
 * and the cut map (each seed character's old identity).
 *
 * The rebase (`rebaseOnto`), from a client's old document:
 *
 * 1. its base, the part the room had at the cut (`Y.clipUpdate`, fork
 *    patch YP34), into a scratch document, the shadow; its own edits, the
 *    rest (`Y.diffUpdate`);
 * 2. the current document written onto the shadow by identity
 *    (`restoreByIdentity`): a seed character is its old character (the
 *    cut map), so the shadow keeps it and the client's edits still find
 *    it; the new document's splits and merges are written as splits and
 *    merges;
 * 3. the client's edits merged into the shadow by the CRDT;
 * 4. the shadow written onto the current document by identity, in the
 *    caller's transaction.
 *
 * Exact for text; when both sides restructured the same blocks the CRDT's
 * outcome can depend on the old document's structural history, which the
 * cut does not keep (`room.reseed.residue`).
 */
import { Y } from './engine.js';
import { clipUpdate, diffUpdate } from './engine-room.js';
import type { EngineDoc } from './engine-api.js';
import { asYDoc } from './structs.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { blockNodeOf, view as modelView, type BlockId } from './placement/model.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	CONTRIBUTOR_PREFIX,
	CREATED_KEY
} from './attribution/block.js';
import { LAST_CHANGED_ATTR } from './schema.js';
import { common } from './data.js';
import { canonKey } from './text/model.js';
import { restoreDocument, runsOf, unitsOf, type RestoreFacade, type Unit } from './restore.js';
import { displayOf, isRowMark, openRangeCursor } from './text/model.js';
import type { ModelView } from './placement/model.js';
import type { JSONDoc } from '../utils/json.js';

/** What the rebase reads and writes through: a facade over a document (structurally). */
export type ReseedFacade<Plan = unknown> = RestoreFacade<Plan> & {
	order(): readonly BlockId[];
	displayLength(id: BlockId): number;
	toJSON(options?: { suggestions?: boolean }): JSONDoc;
	/** The facade's reads beyond its operations: the index's view (`doc/suggest.ts` builds over it too). */
	part: { view(): ModelView };
	prepare: RestoreFacade<Plan>['prepare'] & {
		formatRange(id: BlockId, offset: number, length: number, marks: Record<string, unknown>): Plan;
		splitBlock(id: BlockId, offset: number, newId: BlockId): Plan;
		mergeBlocks(from: BlockId, into: BlockId): Plan;
	};
};

/** A document and the facade over it. */
export type Replica = { doc: EngineDoc; facade: ReseedFacade };

const width = (u: Unit) => (u.item.kind === 'text' ? u.item.text.length : 1);
const sum = (units: readonly Unit[]) => units.reduce((n, u) => n + width(u), 0);

/**
 * Each unit's identity in block `id` (its character's or atom's item: the
 * engine id of its first code unit), in display order, as `unitsOf` lists
 * the block's units: one walk over the pieces the block displays.
 */
const idsOf = (facade: ReseedFacade, id: BlockId): string[] => {
	const { blocks, own } = facade.part.view();
	const out: string[] = [];
	for (const seg of displayOf(id, blocks, own, undefined, true) ?? []) {
		for (const piece of openRangeCursor(seg.text).read(seg.i0, seg.i1)) {
			if (piece.deleted || piece.len === 0) continue;
			const { client, clock } = piece.id;
			const c = piece.content;
			if (typeof c.str === 'string') {
				let k = piece.offset;
				for (const ch of c.str.slice(piece.offset, piece.offset + piece.len)) {
					out.push(`${client}:${clock + k}`);
					k += ch.length;
				}
			} else if (typeof c.getContent === 'function') {
				const all = c.getContent();
				for (let k = piece.offset; k < piece.offset + piece.len; k++)
					if (!isRowMark(all[k])) out.push(`${client}:${clock + k}`);
			}
		}
	}
	return out;
};

/** Every displayed block's unit identities. */
const identities = (facade: ReseedFacade) =>
	new Map(
		facade
			.order()
			.filter((id) => facade.displayLength(id) >= 0)
			.map((id) => [id, idsOf(facade, id)])
	);

/** The cut map: runs of seed items (client, clock, length) and the old items they stand for. */
type CutRun = { c: number; k: number; len: number; oc: number; ok: number };

const encodeRuns = (runs: readonly CutRun[]) => {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, runs.length);
	for (const r of runs) for (const n of [r.c, r.k, r.len, r.oc, r.ok]) encoding.writeVarUint(e, n);
	return encoding.toUint8Array(e);
};

const decodeRuns = (bytes: Uint8Array): CutRun[] => {
	const d = decoding.createDecoder(bytes);
	return Array.from({ length: decoding.readVarUint(d) }, () => {
		const [c, k, len, oc, ok] = Array.from({ length: 5 }, () => decoding.readVarUint(d));
		return { c: c!, k: k!, len: len!, oc: oc!, ok: ok! };
	});
};

/** What the room keeps of a re-seed (`room.reseed.cut`). */
export type Cut = {
	/** The old document's state vector at the cut. */
	sv: Uint8Array;
	/** The old document's deletes at the cut (an update without structs). */
	ds: Uint8Array;
	/** The cut map (`encodeRuns`). */
	map: Uint8Array;
};

/** A cut as one value (`Cut` → bytes and back), for the room's storage. */
export const encodeCut = (cut: Cut) => {
	const e = encoding.createEncoder();
	for (const part of [cut.sv, cut.ds, cut.map]) encoding.writeVarUint8Array(e, part);
	return encoding.toUint8Array(e);
};
export const decodeCut = (bytes: Uint8Array): Cut => {
	const d = decoding.createDecoder(bytes);
	const [sv, ds, map] = Array.from({ length: 3 }, () => decoding.readVarUint8Array(d));
	return { sv: sv!, ds: ds!, map: map! };
};

/**
 * The new epoch's document (`room.reseed.cut`): `seed` builds it from the
 * old one's JSON (the caller's semantics and actor), then its blocks take
 * the old ones' attribution. Reads `old`, writes only the new document.
 */
export const seedFrom = (old: Replica, seed: (json: JSONDoc) => Replica): Replica => {
	const fresh = seed(old.facade.toJSON());
	const { ensureRecord } = bindBlockAttribution(Y);
	fresh.doc.transact(() => {
		for (const id of fresh.facade.order()) {
			const node = blockNodeOf(fresh.doc, id);
			if (node === null) continue;
			// The record and `lastChangedBy` become the old block's, whatever the seed wrote.
			const att = blockAttributionOf(old.doc, id);
			const rec = ensureRecord(fresh.doc, id, node);
			for (const key of rec.attrKeys()) if (key.startsWith(CONTRIBUTOR_PREFIX)) rec.deleteAttr(key);
			for (const actor of att?.contributors ?? []) rec.setAttr(CONTRIBUTOR_PREFIX + actor, true);
			if (att?.createdBy === undefined) rec.deleteAttr(CREATED_KEY);
			else rec.setAttr(CREATED_KEY, att.createdBy);
			if (att?.lastChangedBy === undefined) node.deleteAttr(LAST_CHANGED_ATTR);
			else node.setAttr(LAST_CHANGED_ATTR, att.lastChangedBy);
		}
	});
	return fresh;
};

/** The cut between `old` and `fresh`, the new epoch seeded from it ({@link seedFrom}): each seed unit stands for the old unit at its place. */
export const cutBetween = (old: Replica, fresh: Replica): Cut => {
	const before = identities(old.facade);
	const runs: CutRun[] = [];
	for (const [block, ids] of identities(fresh.facade)) {
		const was = before.get(block) ?? [];
		ids.forEach((id, i) => {
			const o = was[i];
			if (o === undefined || id.startsWith('?') || o.startsWith('?')) return;
			const [c, k] = id.split(':').map(Number) as [number, number];
			const [oc, ok] = o.split(':').map(Number) as [number, number];
			const last = runs.at(-1);
			if (
				last &&
				last.c === c &&
				last.k + last.len === k &&
				last.oc === oc &&
				last.ok + last.len === ok
			)
				last.len++;
			else runs.push({ c, k, len: 1, oc, ok });
		});
	}
	const update = Y.encodeStateAsUpdate(asYDoc(old.doc));
	const sv = Y.encodeStateVector(asYDoc(old.doc));
	return { sv, ds: diffUpdate(update, sv), map: encodeRuns(runs) };
};

/** Cut `old` (`room.reseed.cut`): the new epoch's document and the cut ({@link seedFrom}, {@link cutBetween}). */
export const cutDocument = (old: Replica, seed: (json: JSONDoc) => Replica) => {
	const document = seedFrom(old, seed);
	return { document, cut: cutBetween(old, document) };
};

/** The cut map as a lookup: a seed item's id → the old item's (`undefined`: not a seed character). */
const lookupOf = (map: Uint8Array) => {
	const byClient = new Map<number, CutRun[]>();
	for (const run of decodeRuns(map)) byClient.set(run.c, [...(byClient.get(run.c) ?? []), run]);
	for (const list of byClient.values()) list.sort((a, b) => a.k - b.k);
	return (id: string): string | undefined => {
		const [c, k] = id.split(':').map(Number) as [number, number];
		const list = byClient.get(c);
		if (!list) return undefined;
		let [lo, hi] = [0, list.length];
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid]!.k + list[mid]!.len <= k) lo = mid + 1;
			else hi = mid;
		}
		const run = list[lo];
		return run && run.k <= k ? `${run.oc}:${run.ok + (k - run.k)}` : undefined;
	};
};

/**
 * Make block `id`'s content read `want` keeping every unit whose identity
 * the two key lists share in order: each gap between kept units deleted
 * and written again, a kept unit whose marks differ formatted (runs of the
 * same change in one write). Edits through the display.
 */
const rewriteKeyed = (
	facade: ReseedFacade,
	id: BlockId,
	have: readonly Unit[],
	want: readonly Unit[],
	haveKeys: readonly string[],
	wantKeys: readonly string[]
) => {
	let [at, i, j] = [0, 0, 0];
	let run: { at: number; len: number; marks: Record<string, unknown>; tag: string } | null = null;
	const flush = () => {
		if (run !== null) facade.apply(facade.prepare.formatRange(id, run.at, run.len, run.marks));
		run = null;
	};
	for (const [pi, pj] of [...common(haveKeys, wantKeys), [have.length, want.length]]) {
		const gone = sum(have.slice(i, pi));
		if (gone > 0 || pj! > j) flush();
		if (gone > 0) facade.apply(facade.prepare.deleteText(id, at, gone));
		for (const item of runsOf(want.slice(j, pj))) {
			if (item.kind === 'text')
				facade.apply(facade.prepare.insertText(id, at, item.text, item.marks ?? {}));
			else
				facade.apply(
					facade.prepare.insertInline(id, at, { id: item.id, type: item.type, data: item.data })
				);
			at += item.kind === 'text' ? item.text.length : 1;
		}
		if (pi === have.length) break;
		const [h, w] = [have[pi!]!, want[pj!]!];
		if (h.key !== w.key && h.item.kind === 'text' && w.item.kind === 'text') {
			const [hm, wm] = [h.item.marks ?? {}, w.item.marks ?? {}];
			const marks: Record<string, unknown> = {};
			for (const k of new Set([...Object.keys(hm), ...Object.keys(wm)]))
				if (canonKey({ v: hm[k] ?? null }) !== canonKey({ v: wm[k] ?? null }))
					marks[k] = wm[k] ?? null;
			const tag = canonKey(marks);
			if (run !== null && run.tag === tag && run.at + run.len === at) run.len += width(h);
			else {
				flush();
				run = { at, len: width(h), marks, tag };
			}
		} else flush();
		at += width(h);
		[i, j] = [pi! + 1, pj! + 1];
	}
	flush();
};

/**
 * Make `doc` show `json`, where `ids` names each unit of each of its blocks
 * (an identity `doc` holds is that unit, kept where it can be; any other
 * is new text). Splits and merges first: each block of `doc` is cut where
 * its units go to another block of `json` (or where another block's text
 * comes between them), then each block of `json` is assembled from its
 * pieces in order (its first piece takes its id, the others are merged
 * into it; a unit `json` no longer shows stays in the piece before it).
 * Then `restoreDocument` writes the rest, its content by identity, and
 * keeps the pending suggestions. Runs inside the caller's transaction.
 */
export const restoreByIdentity = (
	doc: EngineDoc,
	facade: ReseedFacade,
	json: JSONDoc,
	ids: ReadonlyMap<BlockId, readonly string[]>
) => {
	const where = new Map<string, { x: BlockId; i: number }>();
	for (const [x, list] of ids) list.forEach((id, i) => where.set(id, { x, i }));
	const base = modelView(doc).order.ids.slice();
	const srcOf = new Map<string, BlockId>();
	for (const a of base) for (const k of idsOf(facade, a)) srcOf.set(k, a);
	type Piece = { start: number; dest: BlockId; first: number; last: number; id: BlockId };
	const pieces = new Map<BlockId, Piece[]>();
	let temp = 0;
	for (const a of base) {
		const list: Piece[] = [];
		let cur: Piece | null = null;
		idsOf(facade, a).forEach((k, u) => {
			const w = where.get(k);
			if (!w) return;
			const between = (ids.get(w.x) ?? []).slice((cur?.last ?? 0) + 1, w.i);
			if (
				cur !== null &&
				cur.dest === w.x &&
				w.i > cur.last &&
				between.every((key) => (srcOf.get(key) ?? a) === a)
			) {
				cur.last = w.i;
				return;
			}
			const first = list.length === 0;
			cur = { start: first ? 0 : u, dest: w.x, first: w.i, last: w.i, id: first ? a : '' };
			list.push(cur);
		});
		pieces.set(a, list);
	}
	const byDest = new Map<BlockId, Piece[]>();
	for (const list of pieces.values())
		for (const piece of list) byDest.set(piece.dest, [...(byDest.get(piece.dest) ?? []), piece]);
	for (const [x, list] of byDest) {
		list.sort((a, b) => a.first - b.first);
		if (list[0]!.id === '' && blockNodeOf(doc, x) === null) list[0]!.id = x;
	}
	for (const list of pieces.values())
		for (const piece of list) if (piece.id === '') piece.id = `~cut${temp++}`;
	for (const [a, list] of pieces)
		for (let k = list.length - 1; k >= 1; k--) {
			const at = sum(unitsOf(facade.contentItems(a)).slice(0, list[k]!.start));
			facade.apply(facade.prepare.splitBlock(a, at, list[k]!.id));
		}
	for (const [x, list] of byDest) {
		const head = list[0]!;
		if (blockNodeOf(doc, x) === null && head.id !== x) {
			facade.apply(facade.prepare.splitBlock(head.id, 0, x));
			head.id = x;
		}
		for (const piece of list)
			if (piece.id !== x) facade.apply(facade.prepare.mergeBlocks(piece.id, x));
	}
	const want = (id: BlockId) => [...(ids.get(id) ?? [])];
	const report = restoreDocument(doc, facade, json, {
		rewrite: (f, id, have, wanted) => {
			rewriteKeyed(f as ReseedFacade, id, have, wanted, idsOf(f as ReseedFacade, id), want(id));
			return true;
		},
		suggestions: 'keep'
	});
	// Same text, another identity (a unit deleted and typed again): by identity too.
	for (const [id, list] of ids) {
		const have = idsOf(facade, id);
		if (have.length === list.length && have.every((k, i) => k === list[i])) continue;
		const units = unitsOf(facade.contentItems(id));
		rewriteKeyed(facade, id, units, units, have, list);
	}
	return report;
};

/** What a rebase did: nothing to merge, or the restore's report of its write. */
export type RebaseReport =
	| { status: 'noop' }
	| ({ status: 'applied' } & ReturnType<typeof restoreDocument>);

/**
 * What the rebases from one cut merged so far: the state they covered (a
 * state vector, and the deletes as an update without structs), so a second
 * upload of the same edits (another tab's) merges nothing twice. Starts as
 * the cut's own.
 */
export type Merged = { sv: Uint8Array; ds: Uint8Array };

/** `merged` grown by what `upload` holds. */
const mergedWith = (merged: Merged, upload: Uint8Array): Merged => {
	const sv = Y.decodeStateVector(merged.sv);
	const { structs } = Y.decodeUpdate(upload);
	for (const struct of structs)
		if (!(struct instanceof Y.Skip))
			sv.set(
				struct.id.client,
				Math.max(sv.get(struct.id.client) ?? 0, struct.id.clock + struct.length)
			);
	const all = Y.encodeStateVector(sv);
	const parts = [merged.ds, diffUpdate(upload, all)] as Uint8Array<ArrayBuffer>[];
	return { sv: all, ds: Y.mergeUpdates(parts) };
};

/**
 * Merge a client's unsaved edits, `upload` (its old document, whole),
 * into `target`, the current document: `cuts` are the re-seeds since the
 * client's epoch, oldest first (each one's map reads the next epoch's seed
 * units as the previous epoch's), `merged` what earlier rebases from the
 * oldest cut merged (default: the cut's own state), `scratch` builds a
 * document from an update. Writes `target` inside the caller's
 * transaction; answers the report and `merged` grown by `upload`.
 */
export const rebaseOnto = (
	target: Replica,
	cuts: readonly Cut[],
	upload: Uint8Array,
	scratch: (update: Uint8Array) => Replica,
	merged: Merged = { sv: cuts[0]!.sv, ds: cuts[0]!.ds }
): { report: RebaseReport; merged: Merged } => {
	const [first] = cuts as [Cut];
	const next = mergedWith(merged, upload);
	const mine = diffUpdate(upload, merged.sv);
	const own = Y.decodeUpdate(mine);
	if (own.structs.length === 0 && Y.diffIdSet(own.ds, Y.decodeUpdate(merged.ds).ds).isEmpty())
		return { report: { status: 'noop' }, merged: next };
	const shadow = scratch(clipUpdate(upload, first.sv, Y.decodeUpdate(first.ds).ds));
	// 2 · The current document, each seed unit read down the cuts to its old one.
	const lookups = cuts.map((cut) => lookupOf(cut.map));
	const old = (k: string) => {
		let id: string | undefined = k;
		for (let i = lookups.length - 1; i >= 0 && id !== undefined; i--) id = lookups[i]!(id);
		return id ?? k;
	};
	const theirs = target.facade.toJSON({ suggestions: true });
	const current = identities(target.facade);
	const asOld = new Map([...current].map(([id, list]) => [id, list.map(old)]));
	shadow.doc.transact(() => restoreByIdentity(shadow.doc, shadow.facade, theirs, asOld));
	// Each shadow unit's identity in the current document (they read the same now).
	const toCurrent = new Map<string, string>();
	for (const [id, list] of identities(shadow.facade)) {
		const now = current.get(id) ?? [];
		list.forEach((k, i) => {
			if (now[i] !== undefined) toCurrent.set(k, now[i]!);
		});
	}
	// 3 · The client's edits, merged by the CRDT.
	Y.applyUpdate(asYDoc(shadow.doc), mine);
	// 4 · Back onto the current document, by identity.
	const result = shadow.facade.toJSON({ suggestions: true });
	const ids = new Map(
		[...identities(shadow.facade)].map(([id, list]) => [
			id,
			list.map((k) => toCurrent.get(k) ?? `new:${k}`)
		])
	);
	const report = restoreByIdentity(target.doc, target.facade, result, ids);
	return { report: { status: 'applied', ...report }, merged: next };
};
