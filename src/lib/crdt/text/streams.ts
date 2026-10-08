/**
 * The stream table, pure: a backing text's boundaries, each block's
 * delimiting boundary, a text's streams, and a block's display as pieces
 * of streams (its stream, then each effective claim's display).
 */
import type { EngineNode } from '../engine-api.js';
import { isBoundary, nodeStart } from './items.js';
import type { BlockId, Bound, Ownership, Seg, Stream, TextBlockRec, TextRow } from './model.js';

/** Scan `text` (live space, renderer-free) for its boundary items. */
export const scanText = (home: BlockId, text: EngineNode): TextRow => {
	const bounds: Bound[] = [];
	let at = 0;
	for (let it = nodeStart(text); it !== null; it = it.right) {
		if (it.deleted || it.countable === false) continue;
		const arr = it.content.arr;
		if (arr !== undefined) {
			for (let j = 0; j < it.length; j++) {
				const v = arr[j];
				if (isBoundary(v))
					bounds.push({ s: v.s, n: v.n, at: at + j, key: `${it.id.client}:${it.id.clock + j}` });
			}
		}
		at += it.length;
	}
	return { home, text, bounds, len: at, key: bounds.map((b) => b.key).join(',') };
};

export const byId = (a: string, b: string): number => {
	const [ac, ak] = a.split(':').map(Number);
	const [bc, bk] = b.split(':').map(Number);
	return ac - bc || ak - bk;
};

/** Each block's delimiting boundary: the lowest-id live boundary whose nonce matches its record. */
export const delimiters = (
	blocks: ReadonlyMap<BlockId, Pick<TextBlockRec, 'n'>>,
	rows: Iterable<TextRow>
): Map<BlockId, string> => {
	const out = new Map<BlockId, string>();
	for (const row of rows) {
		for (const b of row.bounds) {
			if (blocks.get(b.s)?.n !== b.n) continue;
			const cur = out.get(b.s);
			if (cur === undefined || byId(b.key, cur) < 0) out.set(b.s, b.key);
		}
	}
	return out;
};

/**
 * The streams of one text, in text order: the home's head (unless delimited
 * elsewhere), then one per delimiting boundary — one sweep over the
 * boundaries (each non-delimiting one is an inert boundary of the stream it
 * sits in).
 */
export const placeText = (row: TextRow, delim: ReadonlyMap<BlockId, string>): Stream[] => {
	const out: Stream[] = [];
	let block: BlockId | null = delim.has(row.home) ? null : row.home;
	let start = 0;
	let inert: number[] = [];
	const close = (end: number) => {
		if (block !== null) out.push({ block, home: row.home, text: row.text, start, end, inert });
	};
	for (const b of row.bounds) {
		if (delim.get(b.s) !== b.key) {
			inert.push(b.at);
			continue;
		}
		close(b.at);
		[block, start, inert] = [b.s, b.at + 1, []];
	}
	close(row.len);
	return out;
};

/** A stream's content pieces: the range minus its inert boundaries (at least one piece). */
export const pieces = (s: Stream): [number, number][] => {
	const out: [number, number][] = [];
	let a = s.start;
	for (const x of [...s.inert, s.end]) {
		if (x > a || out.length === 0) out.push([a, x]);
		a = x + 1;
	}
	return out;
};

/**
 * `display(b)`: `b`'s stream, then each effective claim's display, in claim
 * order. `track(x, home)` reports every walked block and the home of its
 * stream (the index's dependency capture). `null` when `b` is hidden, unless
 * `hidden` asks for the pieces a hidden block would show (an anchor minted in
 * a merged-away or deleted block binds its items all the same).
 */
export const displayOf = (
	b: BlockId,
	blocks: ReadonlyMap<BlockId, TextBlockRec>,
	own: Pick<Ownership, 'ownerOf' | 'top' | 'streamOf'>,
	track?: (x: BlockId, home: BlockId | undefined) => void,
	hidden = false
): Seg[] | null => {
	if (!hidden && own.ownerOf(b) !== b) return null;
	const out: Seg[] = [];
	const seen = new Set<BlockId>();
	const walk = (x: BlockId, path: Seg['path']): void => {
		seen.add(x);
		const s = own.streamOf(x);
		track?.(x, s?.home);
		if (s !== undefined) {
			for (const [i0, i1] of pieces(s))
				out.push({ t: s.home, text: s.text, block: x, i0, i1, path });
		}
		blocks.get(x)?.claims.forEach((c, entry) => {
			const r = blocks.get(c.m);
			if (r === undefined || r.deleted || seen.has(c.m) || own.top(c.m) !== x) return;
			walk(c.m, [...path, { holder: x, entry }]);
		});
	};
	walk(b, []);
	return out;
};

export const ownedLength = (segs: readonly Seg[]): number =>
	segs.reduce((n, s) => n + s.i1 - s.i0, 0);

/**
 * Display offset → piece + engine index. `left` (typing: left wins at a seam)
 * takes the first piece whose end reaches `k`; `right` the piece holding the
 * unit at `k` (the last piece at the display end). `null` for an empty display.
 */
export const locate = (segs: readonly Seg[], k: number, side: 'left' | 'right' = 'left') => {
	let acc = 0;
	for (let i = 0; i < segs.length; i++) {
		const len = segs[i].i1 - segs[i].i0;
		const last = i === segs.length - 1;
		if (side === 'left' ? k <= acc + len : k < acc + len || (last && k === acc + len)) {
			return { seg: segs[i], idx: segs[i].i0 + Math.max(0, k - acc) };
		}
		acc += len;
	}
	return null;
};

/** `[k0, k1)` of a display as engine ranges, rightmost first (indices stay valid while writing). */
export const rangesOf = (segs: readonly Seg[], k0: number, k1: number) => {
	const out: { text: EngineNode; a: number; b: number }[] = [];
	let acc = 0;
	for (const s of segs) {
		const len = s.i1 - s.i0;
		const lo = Math.max(k0, acc);
		const hi = Math.min(k1, acc + len);
		if (hi > lo) out.push({ text: s.text, a: s.i0 + lo - acc, b: s.i0 + hi - acc });
		acc += len;
	}
	return out.sort((x, y) => y.a - x.a);
};
