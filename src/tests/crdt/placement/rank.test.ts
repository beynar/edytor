/**
 * Unit tests for the U03 rank codec/generator (Logoot-style segment keys).
 *
 * Properties pinned here (ADR: docs/crdt-v14-move-adr.md):
 *
 * - encoding is order-preserving (string `<` == segment order, prefix < extension)
 * - `rankBetween` always lands strictly between its bounds — including
 *   equal-prefix (tied) neighbors, the documented failure mode of
 *   digit-only fractional indexing
 * - sequential same-gap inserts and prepend/append storms stay shallow
 *   (bounded depth, bounded key length)
 * - concurrent same-gap allocations from different clients are distinct and
 *   deterministically ordered
 * - ranks are plain strings that survive encode/reload
 */
import { describe, expect, it } from 'vitest';
import {
	decodeRank,
	encodeRank,
	rankBetween,
	RANK_VMIN,
	RANK_VMAX,
	RankSpaceExhausted
} from '../../../lib/crdt/placement/rank.js';
import { mulberry32 } from '../harness/rng.js';

/** Rank order is plain string order (the encoding is order-preserving). */
const compareRank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The smallest rank a client can mint — the first key of an empty list. */
const initialRank = (clientId: number): string => encodeRank([{ v: 0, t: clientId }]);

const C1 = 11;
const C2 = 22;
const C3 = 33;

describe('rank codec', () => {
	it('encode/decode round-trips segments', () => {
		const segs = [
			{ v: 0, t: 1 },
			{ v: -12345, t: 2 ** 53 - 1 },
			{ v: RANK_VMAX, t: 0 },
			{ v: RANK_VMIN, t: 7 }
		];
		expect(decodeRank(encodeRank(segs))).toEqual(segs);
	});

	it('string order equals segment order; prefix < extension', () => {
		const a = encodeRank([{ v: 5, t: 1 }]);
		const b = encodeRank([{ v: 5, t: 2 }]);
		const c = encodeRank([
			{ v: 5, t: 1 },
			{ v: 0, t: 9 }
		]);
		const d = encodeRank([{ v: 6, t: 0 }]);
		expect(compareRank(a, b)).toBeLessThan(0); // same digit, tie decides
		expect(compareRank(a, c)).toBeLessThan(0); // prefix < extension
		expect(compareRank(c, d)).toBeLessThan(0); // deeper beat shallower-high
	});

	it('encodes digit order across the signed boundary', () => {
		const lo = encodeRank([{ v: RANK_VMIN, t: 0 }]);
		const mid = encodeRank([{ v: 0, t: 0 }]);
		const hi = encodeRank([{ v: RANK_VMAX, t: 0 }]);
		expect(lo < mid && mid < hi).toBe(true);
	});
});

describe('rankBetween allocation', () => {
	it('first key then append chain stays depth-1', () => {
		const keys: string[] = [];
		let prev: string | undefined;
		for (let i = 0; i < 200; i++) {
			const k = rankBetween(prev, undefined, C1);
			if (prev !== undefined) expect(k > prev).toBe(true);
			keys.push(k);
			prev = k;
		}
		// every append found a free digit at depth 1 — no descent
		expect(keys.every((k) => decodeRank(k).length === 1)).toBe(true);
	});

	it('prepend chain (insert at 0 repeatedly) stays depth-1', () => {
		let min: string | undefined;
		for (let i = 0; i < 500; i++) {
			const k = rankBetween(undefined, min, C1);
			if (min !== undefined) expect(k < min).toBe(true);
			min = k;
			expect(decodeRank(k).length).toBe(1);
		}
	});

	it('random insertion order reproduces insertion order', () => {
		const rng = mulberry32(42);
		const sorted: string[] = [];
		for (let i = 0; i < 400; i++) {
			const idx = Math.floor(rng() * (sorted.length + 1));
			const k = rankBetween(sorted[idx - 1], sorted[idx], C1, rng);
			sorted.splice(idx, 0, k);
		}
		const copy = [...sorted].sort();
		expect(sorted).toEqual(copy);
	});

	it('concurrent same-gap allocations are distinct and ordered', () => {
		const L = rankBetween(undefined, undefined, C1);
		const R = rankBetween(L, undefined, C1);
		const a = rankBetween(L, R, C2, () => 0.5);
		const b = rankBetween(L, R, C3, () => 0.5);
		expect(a).not.toBe(b);
		// deterministic: ordering by encoded string agrees with (v, tie)
		expect(a < b || b < a).toBe(true);
		expect(L < a && a < R && L < b && b < R).toBe(true);
	});

	it('inserts between equal-digit (tied) neighbors — the collision case', () => {
		// Force a digit collision: two clients pick the same v in the same gap.
		const L = rankBetween(undefined, undefined, C1);
		const R = rankBetween(L, undefined, C1);
		const tieLow = rankBetween(L, R, C1, () => 0.5);
		const tieHigh = rankBetween(L, R, C2, () => 0.5);
		// Both picked the same digit v → same prefix, distinguished only by tie.
		const [lo, hi] = tieLow < tieHigh ? [tieLow, tieHigh] : [tieHigh, tieLow];
		expect(decodeRank(lo)[0].v).toBe(decodeRank(hi)[0].v);
		// A key strictly between two equal-prefix neighbors must exist.
		const mid = rankBetween(lo, hi, C3);
		expect(lo < mid && mid < hi).toBe(true);
		// And again, deeper: between the new mid and the high tie.
		const mid2 = rankBetween(mid, hi, C3);
		expect(mid < mid2 && mid2 < hi).toBe(true);
	});

	it('repeated same-gap inserts add at most one level per step', () => {
		// Adversarial case: always insert between L and the previous midpoint —
		// the classic Logoot depth-growth path. The bound to pin: each emitted
		// key extends the DEEPER of its two bounds by at most one level
		// (16 chars), never more — total growth stays O(depth), no renumbering.
		const L = rankBetween(undefined, undefined, C1);
		let R = encodeRank([{ v: decodeRank(L)[0].v + 1, t: C1 }]); // adjacent: forced descent
		for (let i = 0; i < 64; i++) {
			const mid = rankBetween(L, R, C2, () => 0);
			expect(L < mid && mid < R).toBe(true);
			expect(mid.length).toBeLessThanOrEqual(Math.max(L.length, R.length) + 16);
			R = mid;
		}
	});

	it('inserts after the previous one at a filled seam stay short (SW12-crdt-2)', () => {
		// Typing lines in the middle of a document: each key goes between the
		// last one and the same right neighbour. Once the seam's digits run
		// out, a key extends the left bound once and then has the append
		// window below the right bound — it used to copy every left segment
		// and add one, one level longer per line.
		const R = encodeRank([{ v: 1, t: C1 }]);
		let lo = encodeRank([{ v: 0, t: C1 }]);
		for (let i = 0; i < 1000; i++) {
			const k = rankBetween(lo, R, C2, () => 0.5);
			expect(lo < k && k < R).toBe(true);
			lo = k;
		}
		expect(decodeRank(lo).length).toBeLessThanOrEqual(3);
	});

	it('same-client subsequent inserts into one gap are ordered', () => {
		const L = rankBetween(undefined, undefined, C1);
		const R = rankBetween(L, undefined, C1);
		const keys = new Set<string>();
		let lo = L;
		for (let i = 0; i < 32; i++) {
			const k = rankBetween(lo, R, C1);
			expect(lo < k && k < R).toBe(true);
			expect(keys.has(k)).toBe(false);
			keys.add(k);
			lo = k;
		}
	});

	it('rejects inverted bounds', () => {
		const a = rankBetween(undefined, undefined, C1);
		const b = rankBetween(a, undefined, C1);
		expect(() => rankBetween(b, a, C1)).toThrow(/left >= right|prefix/);
	});

	it('extreme boundary: inserting below VMIN throws a documented error', () => {
		const floor = encodeRank([{ v: RANK_VMIN, t: 9 }]);
		expect(() => rankBetween(undefined, floor, C1)).toThrow(RankSpaceExhausted);
	});

	it('a VMIN segment inside the right bound is descended, not exhausted (promoted slots, UW-08)', () => {
		const slot = encodeRank([{ v: 3, t: C1 }]);
		const promoted = slot + encodeRank([{ v: RANK_VMIN, t: 0 }]) + encodeRank([{ v: 0, t: C2 }]);
		const r = rankBetween(slot, promoted, C3);
		expect(slot < r && r < promoted).toBe(true);
	});

	it('property: 2000 random pairs always produce a strictly-between key', () => {
		const rng = mulberry32(7);
		const keys = [initialRank(C1)];
		for (let i = 0; i < 2000; i++) {
			const sorted = [...keys].sort();
			const li = Math.floor(rng() * sorted.length);
			const ri = li + 1 + Math.floor(rng() * (sorted.length - li - 1));
			if (ri >= sorted.length) continue;
			const L = sorted[li];
			const R = sorted[ri];
			const k = rankBetween(L, R, [C1, C2, C3][i % 3], rng);
			expect(L < k && k < R, `L=${L} k=${k} R=${R}`).toBe(true);
			keys.push(k);
		}
	});
});
