/**
 * The maintained form of one backing text's boundary table (P1) — the
 * index's row: the text's live boundary items in text order and the live
 * units between them, held in a Fenwick tree so an edit that writes or
 * removes no boundary moves every later boundary in O(log B) instead of a
 * rescan.
 *
 * `h[j]` is the units before boundary `j` since the one before it, plus
 * boundary `j` itself (`h[B]`: the units after the last boundary), so the
 * live index of boundary `j` is `H(j) - 1` (`H` the prefix sum) and the
 * text's live length is `H(B)`. A row's boundary SET only changes through a
 * rescan ({@link rowOf}); an insert or delete of other units changes one
 * `h` entry ({@link shiftGap}), found by walking the item list from the
 * edited item to its nearest boundary ({@link gapOfItem}).
 *
 * The streams of a row (`text/model.ts` `placeText`) are its segments
 * between consecutive delimiting boundaries (`cuts`): segment `k` starts
 * after cut `k - 1` (the text start for `k = 0`) and ends at cut `k` (the
 * text end past the last). Segment 0 is the home block's stream unless the
 * home is delimited elsewhere (`head: null` — that stretch is nobody's);
 * segment `k > 0` is the stream of the block its opening cut names.
 */
import type { EngineNode } from '../engine-api.js';
import { isBoundary, type BlockId, type Bound, type Stream, type TextRow } from './model.js';

export type LiveRow = {
	home: BlockId;
	text: EngineNode;
	/** The live boundaries in text order (`at` is NOT maintained: read {@link boundAt}). */
	bounds: readonly Bound[];
	/** Fenwick tree over `h` (1-based, size `bounds.length + 1`). */
	tree: Float64Array;
	/** The bound keys joined — the boundary set's identity. */
	key: string;
	/** Each bound's index by its key. */
	keyIndex: Map<string, number>;
	/** Indexes into `bounds` of the delimiting boundaries, ascending ({@link placeRow}). */
	cuts: number[];
	/** The block of segment 0 (`null`: the home is delimited elsewhere). */
	head: BlockId | null;
};

const add = (row: LiveRow, i: number, d: number): void => {
	const t = row.tree;
	for (let x = i + 1; x < t.length; x += x & -x) t[x] += d;
};

/** `H(i)`: the sum of `h[0..i]`. */
const prefix = (row: LiveRow, i: number): number => {
	const t = row.tree;
	let s = 0;
	for (let x = i + 1; x > 0; x -= x & -x) s += t[x];
	return s;
};

/** The smallest `j` with `H(j) >= target` (`bounds.length + 1` when none). */
const lowerBound = (row: LiveRow, target: number): number => {
	const t = row.tree;
	const n = t.length - 1;
	let pos = 0;
	let rem = target;
	let step = 1;
	while (step * 2 <= n) step *= 2;
	for (; step > 0; step >>= 1) {
		const next = pos + step;
		if (next <= n && t[next] < rem) {
			pos = next;
			rem -= t[next];
		}
	}
	return pos;
};

/** `h[j]` itself. */
const valueAt = (row: LiveRow, j: number): number =>
	prefix(row, j) - (j > 0 ? prefix(row, j - 1) : 0);

/** The live index of boundary `j`. */
export const boundAt = (row: LiveRow, j: number): number => prefix(row, j) - 1;

/** The text's live length. */
export const rowLength = (row: LiveRow): number => prefix(row, row.bounds.length);

/** A row from a scan (its segments are set by {@link placeRow}). */
export const rowOf = (scan: TextRow): LiveRow => {
	const n = scan.bounds.length;
	const keyIndex = new Map<string, number>();
	const t = new Float64Array(n + 2);
	let prev = -1;
	for (let j = 0; j <= n; j++) {
		const at = j < n ? scan.bounds[j].at : scan.len;
		if (j < n) keyIndex.set(scan.bounds[j].key, j);
		t[j + 1] += j < n ? at - prev : at - prev - 1;
		prev = at;
		// Linear Fenwick build: push the node's sum to its parent.
		const parent = j + 1 + ((j + 1) & -(j + 1));
		if (parent <= n + 1) t[parent] += t[j + 1];
	}
	return {
		home: scan.home,
		text: scan.text,
		bounds: scan.bounds,
		tree: t,
		key: scan.key,
		keyIndex,
		cuts: [],
		head: scan.home
	};
};

/** A sequence item as the walk reads it (`text/model.ts` `SeqItem`, with its left neighbour). */
export type RowItem = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable?: boolean;
	left?: RowItem | null;
	right?: RowItem | null;
	content?: { arr?: unknown[] };
};

/**
 * The index of the live boundary `it` holds last (`first`: first), `-1` when
 * it holds none, `-2` when it holds one the row does not know (stale row).
 */
const boundIn = (row: LiveRow, it: RowItem, first: boolean): number => {
	if (it.deleted || it.countable === false) return -1;
	const arr = it.content?.arr;
	if (arr === undefined) return -1;
	for (let n = 0; n < it.length; n++) {
		const k = first ? n : it.length - 1 - n;
		if (!isBoundary(arr[k])) continue;
		return row.keyIndex.get(`${it.id.client}:${it.id.clock + k}`) ?? -2;
	}
	return -1;
};

/**
 * The gap (`h` entry) item `it` lies in — between the nearest live
 * boundaries on its left and right, found by walking the item list both
 * ways at once (the cost is the distance to the nearer one, never the
 * text). It reads only the list, never the engine's position caches, so a
 * write the caches have not seen yet places it all the same. `-1` when the
 * walk finds a boundary the row does not hold (the caller rescans).
 */
export const gapOfItem = (row: LiveRow, it: RowItem): number => {
	if (row.bounds.length === 0) return 0;
	let l = it.left ?? null;
	let r = it.right ?? null;
	while (l !== null || r !== null) {
		if (l !== null) {
			const j = boundIn(row, l, false);
			if (j === -2) return -1;
			if (j >= 0) return j + 1;
			l = l.left ?? null;
		}
		if (r !== null) {
			const j = boundIn(row, r, true);
			if (j === -2) return -1;
			if (j >= 0) return j;
			r = r.right ?? null;
		}
	}
	return -1;
};

/**
 * Add `delta` units (an insert, or a delete when negative) to gap `gap`.
 * `false` when a delete takes more units than the gap holds (a stale row:
 * the caller rescans).
 */
export const shiftGap = (row: LiveRow, gap: number, delta: number): boolean => {
	if (delta < 0 && valueAt(row, gap) + delta < (gap < row.bounds.length ? 1 : 0)) return false;
	add(row, gap, delta);
	return true;
};

/** The segment holding gap `gap` (the units before boundary `gap`). */
export const segmentOfGap = (row: LiveRow, gap: number): number => {
	const cuts = row.cuts;
	let lo = 0;
	let hi = cuts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cuts[mid] < gap) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

/** The segment whose `[start, end]` holds live index `x` (the first, at a seam). */
export const segmentAt = (row: LiveRow, x: number): number =>
	segmentOfGap(row, Math.min(lowerBound(row, x + 1), row.bounds.length));

/** The segment the cut keyed `cut` opens (`null`: segment 0); `-1` when it is no cut of the row. */
export const segmentOfCut = (row: LiveRow, cut: string | null): number => {
	if (cut === null) return 0;
	const j = row.keyIndex.get(cut);
	if (j === undefined) return -1;
	const k = segmentOfGap(row, j);
	return row.cuts[k] === j ? k + 1 : -1;
};

/** The block of segment `k` (`null`: nobody's). */
export const headOf = (row: LiveRow, k: number): BlockId | null =>
	k === 0 ? row.head : row.bounds[row.cuts[k - 1]].s;

/** Segment `k` as a {@link Stream} of `block`. */
export const streamOfSegment = (row: LiveRow, k: number, block: BlockId): Stream => {
	const lo = k === 0 ? -1 : row.cuts[k - 1];
	const hi = k < row.cuts.length ? row.cuts[k] : row.bounds.length;
	const start = lo < 0 ? 0 : boundAt(row, lo) + 1;
	const end = hi === row.bounds.length ? rowLength(row) : boundAt(row, hi);
	const inert: number[] = [];
	for (let j = lo + 1; j < hi; j++) inert.push(boundAt(row, j));
	return { block, home: row.home, text: row.text, start, end, inert };
};

/**
 * Set the row's segments from the delimiting boundaries (`delim`): the
 * home's head (unless delimited elsewhere), then one per cut — the same
 * streams `placeText` returns for the row's scan.
 */
export const placeRow = (row: LiveRow, delim: ReadonlyMap<BlockId, string>): void => {
	const cuts: number[] = [];
	for (let j = 0; j < row.bounds.length; j++) {
		const b = row.bounds[j];
		if (delim.get(b.s) === b.key) cuts.push(j);
	}
	row.cuts = cuts;
	row.head = delim.has(row.home) ? null : row.home;
};

/** The row agrees with a fresh scan of its text (the index's self-check). */
export const sameRow = (row: LiveRow, scan: TextRow): boolean => {
	if (row.key !== scan.key || row.bounds.length !== scan.bounds.length) return false;
	if (rowLength(row) !== scan.len) return false;
	for (let j = 0; j < scan.bounds.length; j++)
		if (boundAt(row, j) !== scan.bounds[j].at) return false;
	return true;
};
