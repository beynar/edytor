// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
/**
 * Dense ownership oracle (WU6 review) — the corrected PER-POSITION ownership
 * algorithm kept OUTSIDE shipped production code as the differential oracle
 * for the interval implementation in `text/model.ts`.
 *
 * `denseOwnership` mirrors the pre-WU6 `computeOwnership` exactly: for each
 * live slice record, resolve its anchored range, then for every covered
 * position keep the best contest key `(g, s0, stamp)` — tracking BOTH the
 * winning owner (`atomOwner`) and the winning RECORD (`atomClaim`), because
 * two records routing to the same display owner must not double-emit.
 * `denseFlatten` mirrors the old seg walker over those rows;
 * `denseResolveAnchor` mirrors the facade's anchor→display-position
 * algorithm over a dense row (emission-seam fallback included).
 *
 * The oracle exists so the interval code is reviewed as "the optimization"
 * against this file reviewed as "the semantics". Two implementations can
 * still share a mistaken assumption — which is why the expected-result
 * tests stay; this oracle only makes the differential coverage cheap.
 */
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import type { EngineDoc, EngineNode } from '../../../lib/crdt/engine-api.js';
import {
	bindText,
	claimKeyBetter,
	computeOwners,
	DEAD,
	isMergeClaim,
	isSliceRecord,
	type Anchor,
	type BlockId,
	type ClaimKey,
	type OwnInterval,
	type SliceEntry,
	type SliceRecord,
	type TextBlockRec
} from '../../../lib/crdt/text/model.js';

const T = bindText(Y);

/** The pre-WU6 dense ownership shape, reproduced for the oracle. */
export type DenseOwnership = {
	ownerOf: (b: BlockId) => string | typeof DEAD;
	/** Per-text atom→owner row (`undefined` = dead/unclaimed). */
	atomOwner: Map<string, (BlockId | undefined)[]>;
	/** Per-text atom→winning-record row (parallel to `atomOwner`). */
	atomClaim: Map<string, (SliceEntry | undefined)[]>;
	/** Resolved-range view (same anchor→index contract as production). */
	resolvedRange: (entry: SliceEntry, text: EngineNode) => [number, number] | null;
	/** Highest generation `g` of any record covering each text — includes
	 *  dead-held and losing records, same as production. */
	maxG: Map<string, number>;
};

/**
 * Dense per-position ownership — the exact pre-WU6 `computeOwnership`
 * algorithm, dense rows and all. Pure; safe mid-transaction.
 */
export const denseOwnership = (
	doc: EngineDoc,
	blocks: Map<BlockId, TextBlockRec>
): DenseOwnership => {
	const owners = computeOwners(blocks);
	const ownerOf = (b: BlockId) => owners.get(b) ?? DEAD;
	const rangeCache = new Map<SliceEntry, [number, number] | null>();
	const resolvedRange = (entry: SliceEntry, text: EngineNode): [number, number] | null => {
		if (rangeCache.has(entry)) return rangeCache.get(entry)!;
		const rec = entry.payload as SliceRecord;
		const i0 = T.resolveAnchor(doc, text, rec.s);
		const i1 = T.resolveAnchor(doc, text, rec.e);
		const v =
			i0 === null || i1 === null
				? null
				: ([Math.min(i0, i1), Math.max(i0, i1)] as [number, number]);
		rangeCache.set(entry, v);
		return v;
	};
	const atomOwner = new Map<string, (BlockId | undefined)[]>();
	const atomClaim = new Map<string, (SliceEntry | undefined)[]>();
	const bestKey = new Map<string, ClaimKey[]>();
	const maxG = new Map<string, number>();
	for (const [holderId, rec] of blocks) {
		const candBlock = ownerOf(holderId);
		for (const e of rec.entries) {
			if (!isSliceRecord(e.payload)) continue;
			const t = e.payload.t;
			const g = e.payload.g ?? 0;
			if (g > (maxG.get(t) ?? 0)) maxG.set(t, g);
			const textRec = blocks.get(t);
			if (!textRec || !textRec.content) continue;
			const range = resolvedRange(e, textRec.content);
			if (range === null) continue;
			const [i0, i1] = range;
			const key: ClaimKey = { g, s0: i0, st: e.stamp };
			const arr = atomOwner.get(t) ?? [];
			const claims = atomClaim.get(t) ?? [];
			const keys = bestKey.get(t) ?? [];
			for (let i = i0; i < i1 && i < textRec.content.length; i++) {
				if (claimKeyBetter(key, keys[i])) {
					keys[i] = key;
					arr[i] = candBlock;
					claims[i] = e;
				}
			}
			if (arr.length > 0) {
				atomOwner.set(t, arr);
				atomClaim.set(t, claims);
				bestKey.set(t, keys);
			}
		}
	}
	// R3 (D-14): dead holders contest like any other; what they win is hidden.
	for (const [t, arr] of atomOwner) {
		const claims = atomClaim.get(t)!;
		for (let i = 0; i < arr.length; i++) {
			if (arr[i] === DEAD) arr[i] = claims[i] = undefined;
		}
	}
	return { ownerOf, atomOwner, atomClaim, resolvedRange, maxG };
};

/**
 * Expand ordered disjoint intervals into the equivalent dense owner row —
 * the shape the old `atomOwner.get(t)` produced: length = one past the
 * last covered position, `null` at unowned positions. Used to migrate
 * row-shaped test assertions onto the interval structure.
 */
export const expandOwnerRow = (ivs: readonly OwnInterval[] | undefined): (BlockId | null)[] => {
	const row: (BlockId | null)[] = [];
	if (!ivs) return row;
	for (const iv of ivs) {
		while (row.length < iv.i1) row.push(null);
		for (let i = iv.i0; i < iv.i1; i++) row[i] = iv.owner;
	}
	return row;
};

/**
 * Expand intervals into the parallel winning-record row — the shape the
 * old `atomClaim.get(t)` produced (`null` at unowned positions).
 */
export const expandClaimRow = (ivs: readonly OwnInterval[] | undefined): (SliceEntry | null)[] => {
	const row: (SliceEntry | null)[] = [];
	if (!ivs) return row;
	for (const iv of ivs) {
		while (row.length < iv.i1) row.push(null);
		for (let i = iv.i0; i < iv.i1; i++) row[i] = iv.claim;
	}
	return row;
};

/**
 * Dense `flatten` — the exact pre-WU6 seg walker over the oracle's dense
 * rows. Returns the same `{t,i0,i1,holder,seqIndex,via}` tuples the
 * interval-based `flatten` emits.
 */
export const denseFlatten = (
	b: BlockId,
	blocks: Map<BlockId, TextBlockRec>,
	dense: DenseOwnership
): { t: string; i0: number; i1: number; holder: BlockId; seqIndex: number; via: SliceEntry }[] => {
	const segs: {
		t: string;
		i0: number;
		i1: number;
		holder: BlockId;
		seqIndex: number;
		via: SliceEntry;
	}[] = [];
	const emitRecord = (entry: SliceEntry, holder: BlockId, via: SliceEntry) => {
		const rec = entry.payload as SliceRecord;
		const textRec = blocks.get(rec.t);
		if (!textRec || !textRec.content) return;
		const range = dense.resolvedRange(entry, textRec.content);
		if (range === null) return;
		const owners = dense.atomOwner.get(rec.t);
		const claims = dense.atomClaim.get(rec.t);
		let i = range[0];
		while (i < range[1]) {
			if (owners?.[i] === b && claims?.[i] === entry) {
				const start = i;
				while (i < range[1] && owners?.[i] === b && claims?.[i] === entry) i++;
				segs.push({ t: rec.t, i0: start, i1: i, holder, seqIndex: entry.seqIndex, via });
			} else {
				i++;
			}
		}
	};
	const walk = (listId: BlockId, seen: Set<BlockId>, via: SliceEntry | null) => {
		if (seen.has(listId)) return;
		seen.add(listId);
		const rec = blocks.get(listId);
		if (!rec) return;
		for (const entry of rec.entries) {
			if (isSliceRecord(entry.payload)) emitRecord(entry, listId, via ?? entry);
			else if (isMergeClaim(entry.payload)) walk(entry.payload.m, seen, via ?? entry);
		}
	};
	walk(b, new Set(), null);
	return segs;
};

/**
 * Dense `resolveAnchor` — the facade's anchor→display-position algorithm
 * run over the oracle's dense row (adjacent-atom preference, outward
 * nearest-owned scan, emission-seam fallback). Returns the same
 * `{blockId, offset} | null` the facade produces.
 */
export const denseResolveAnchor = (
	doc: EngineDoc,
	blocks: Map<BlockId, TextBlockRec>,
	dense: DenseOwnership,
	anchor: { b: BlockId; a: Anchor; o?: BlockId }
): { blockId: BlockId; offset: number } | null => {
	const t = anchor.b;
	const text = blocks.get(t)?.content;
	if (!text) return null;
	const i = T.resolveAnchor(doc, text, anchor.a);
	if (i === null) return null;
	const owners = dense.atomOwner.get(t);
	const len = text.length;
	const ownedAt = (j: number): BlockId | undefined => (j >= 0 && j < len ? owners?.[j] : undefined);
	// Mirrors the facade: `a <= -2` + `o` rebases the resolved gap onto the
	// anchor's OWN block stream — foreign atoms inserted at the seam by a
	// left neighbour must not pull the caret across the block boundary.
	// `o` usable only while ALIVE AND SELF-OWNING — a merged-away block's
	// claim chain resolves to its surviving claimer (not DEAD); a deleted
	// block resolves DEAD. Both take the generic atom-follow path.
	if (anchor.a.a <= -2 && anchor.o !== undefined && dense.ownerOf(anchor.o) === anchor.o) {
		const o = anchor.o;
		let off = 0;
		let seamEnd: number | null = null;
		for (const seg of denseFlatten(o, blocks, dense)) {
			const w = seg.i1 - seg.i0;
			if (seg.t === t) {
				if (i <= seg.i1) {
					return { blockId: o, offset: off + Math.min(Math.max(i - seg.i0, 0), w) };
				}
				seamEnd = off + w;
			}
			off += w;
		}
		if (seamEnd !== null) return { blockId: o, offset: seamEnd };
		// `o` live but holding no atoms in the bound text → emptied in
		// place (a merge kills `o`; a backing change still puts the
		// stream-start caret at `o`'s start) — never the neighbour.
		return { blockId: o, offset: 0 };
	}
	const preferRightFacet = anchor.a.a >= 0 || anchor.a.a <= -2;
	let hit: { j: number; after: boolean } | null = null;
	const adjacent: [number, boolean][] = preferRightFacet
		? [
				[i, false],
				[i - 1, true]
			]
		: [
				[i - 1, true],
				[i, false]
			];
	for (const [j, after] of adjacent) {
		if (ownedAt(j) !== undefined) {
			hit = { j, after };
			break;
		}
	}
	if (hit === null) {
		const dirs = preferRightFacet ? [1, -1] : [-1, 1];
		outer: for (const dir of dirs) {
			for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < len; j += dir) {
				if (ownedAt(j) !== undefined) {
					hit = { j, after: dir < 0 };
					break outer;
				}
			}
		}
	}
	if (hit === null) {
		const owner = dense.ownerOf(t);
		if (owner === DEAD) return null;
		return { blockId: owner, offset: denseEmissionOffset(blocks, dense, owner, t) };
	}
	const owner = ownedAt(hit.j)!;
	const segs = denseFlatten(owner, blocks, dense);
	let off = 0;
	for (const seg of segs) {
		if (seg.t === t && seg.i0 <= hit.j && hit.j < seg.i1) {
			return { blockId: owner, offset: off + (hit.j - seg.i0) + (hit.after ? 1 : 0) };
		}
		off += seg.i1 - seg.i0;
	}
	return { blockId: owner, offset: off };
};

/** Dense `emissionOffset` — counts positions owned by `B` under `entry`
 *  position-by-position, matching the facade walk order. */
const denseEmissionOffset = (
	blocks: Map<BlockId, TextBlockRec>,
	dense: DenseOwnership,
	B: BlockId,
	t: BlockId
): number => {
	let off = 0;
	let found: number | null = null;
	const contribution = (entry: SliceEntry): number => {
		const p = entry.payload;
		if (!isSliceRecord(p)) return 0;
		const text = blocks.get(p.t)?.content;
		if (!text) return 0;
		const range = dense.resolvedRange(entry, text);
		if (range === null) return 0;
		const owners = dense.atomOwner.get(p.t);
		const claims = dense.atomClaim.get(p.t);
		let n = 0;
		for (let i = range[0]; i < range[1]; i++) {
			if (owners?.[i] === B && claims?.[i] === entry) n++;
		}
		return n;
	};
	const walk = (listId: BlockId, seen: Set<BlockId>): void => {
		if (found !== null || seen.has(listId)) return;
		seen.add(listId);
		if (listId === t && listId !== B) {
			found = off;
			return;
		}
		const rec = blocks.get(listId);
		if (!rec) return;
		for (const e of rec.entries) {
			if (found !== null) return;
			if (isSliceRecord(e.payload)) {
				if (e.payload.t === t) {
					found = off;
					return;
				}
				off += contribution(e);
			} else if (isMergeClaim(e.payload)) {
				walk(e.payload.m, seen);
			}
		}
	};
	walk(B, new Set());
	return found ?? off;
};
