/**
 * Rank keys for the placement model (U03) — a Logoot-style dense ordering.
 *
 * A rank is a non-empty sequence of *segments* `(v, t)`:
 *
 * - `v` — a signed digit in `[VMIN, VMAX]` (≈±2^40). There is always room
 *   between two distinct digits (`rv - lv > 1`); when there is not, the
 *   generator descends one level instead of renumbering.
 * - `t` — the allocator's `doc.clientID` (uint53), the *tiebreak* that makes
 *   concurrent allocations of the same digit path distinct. Ties are what let
 *   a later insert land **between two equal-prefix keys**: the pair is ordered
 *   by `(v, t)`, so copying the left segment and descending yields a key that
 *   sorts strictly between them. Plain fractional-index strings (digit-only)
 *   cannot express this — the documented failure mode of the article's sample
 *   generator (`a0:c1` vs `a0:c2` admit no midpoint key).
 *
 * Encoding is fixed-width and order-preserving, so the persisted rank is a
 * plain string and the comparator is `a < b`:
 *
 * - `v` → base64url(`v - VMIN`, 7 chars) — biased so negatives encode first.
 * - `t` → base64url(clientId, 9 chars) — 54 bits covers uint53.
 * - rank = segments concatenated; a prefix sorts before its extension, exactly
 *   like string `<` on the encoding.
 *
 * Allocation (`rankBetween(left, right, clientId)`):
 *
 * - gap at level `i` (`rv - lv > 1`): emit `lv + 1 + floor(rand·(rv-lv-1))`,
 *   own tie — random-in-gap keeps sequential inserts shallow and concurrent
 *   same-gap inserts deterministic-distinct.
 * - adjacent or equal segment (`rv - lv ≤ 1`): copy the left segment and
 *   descend — an extension of the left prefix is always `> left`, and it is
 *   `< right` because the copied segment is `≤` the right's at the first
 *   differing level (strictly less unless the segments are identical, in which
 *   case the decision defers one level deeper).
 * - left exhausted/open: emit `rSeg.v - 1` (boundary-minus). Sequential
 *   prepends stay at depth 1 (v decrements by one); the bound can only
 *   underflow after ~2^40 consecutive boundary pushes — documented
 *   unreachable, guarded by a descriptive throw.
 *
 * No floating point, no global renumbering, no wall clocks.
 */

/**
 * Order-preserving alphabet: charCode order equals numeric order.
 * `-`(45) < `0-9`(48-57) < `A-Z`(65-90) < `_`(95) < `a-z`(97-122) — 64 chars,
 * strictly ascending charCodes, all safe inside a plain JSON string.
 */
const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const BASE = 64;

/** Digit range. VMIN = -2^40, VMAX = 2^40 - 1 → biased value fits 41 bits. */
export const RANK_VMIN = -(2 ** 40);
export const RANK_VMAX = 2 ** 40 - 1;
/** Characters per encoded digit: ceil(41/6) = 7. */
const V_CHARS = 7;
/** Characters per encoded tiebreak (clientIds are uint53 → 54 bits → 9). */
const T_CHARS = 9;
/** Encoded segment length. */
const SEG_LEN = V_CHARS + T_CHARS;

export type RankSeg = { v: number; t: number };

/** Thrown when rank generation would need a digit below VMIN (unreachable). */
export class RankSpaceExhausted extends Error {
	constructor() {
		super(
			'rank space exhausted at digit minimum — requires ~2^40 sequential boundary inserts; unreachable in practice'
		);
		this.name = 'RankSpaceExhausted';
	}
}

/** Encode a non-negative integer as fixed-width base64url (order-preserving). */
const encNum = (n: number, width: number): string => {
	let out = '';
	for (let i = 0; i < width; i++) {
		out = ALPHABET[n % BASE] + out;
		n = Math.floor(n / BASE);
	}
	if (n > 0) throw new Error(`rank encode overflow: value exceeds ${width} chars`);
	return out;
};

const decNum = (s: string): number => {
	let n = 0;
	for (const ch of s) {
		const d = ALPHABET.indexOf(ch);
		if (d < 0) throw new Error(`rank decode: bad char ${ch}`);
		n = n * BASE + d;
	}
	return n;
};

/** Decode a rank string into its segment array. */
export const decodeRank = (rank: string): RankSeg[] => {
	if (rank.length === 0 || rank.length % SEG_LEN !== 0) {
		throw new Error(`rank decode: bad length ${rank.length}`);
	}
	const segs: RankSeg[] = [];
	for (let i = 0; i < rank.length; i += SEG_LEN) {
		segs.push({
			v: decNum(rank.slice(i, i + V_CHARS)) + RANK_VMIN,
			t: decNum(rank.slice(i + V_CHARS, i + SEG_LEN))
		});
	}
	return segs;
};

/** Encode segments back to the persisted string form. */
export const encodeRank = (segs: readonly RankSeg[]): string => {
	let out = '';
	for (const { v, t } of segs) {
		out += encNum(v - RANK_VMIN, V_CHARS) + encNum(t, T_CHARS);
	}
	return out;
};

const segLess = (a: RankSeg, b: RankSeg): number => a.v - b.v || a.t - b.t;

/**
 * Allocate a rank strictly between `left` and `right` (either may be
 * `undefined` for the open end of a sibling list). `clientId` is the
 * allocating doc's clientID; `rand` supplies the in-gap pick (defaults to
 * `Math.random`, tests inject a seeded stream).
 *
 * Guaranteed: `left < result < right` for any `left < right`, including
 * equal-prefix/concurrent-collision inputs — the tiebreak dimension makes a
 * strictly-between key always exist (modulo the documented VMIN bound).
 */
/**
 * Window for open-end (append-at-tail) allocation: emit at most `lv + APPEND_WINDOW`
 * rather than anywhere in `(lv, VMAX]`. Sequential appends advance the tail
 * digit by ≤2^16, so the digit space only saturates after ~2^24 tail-appends;
 * a uniform-in-`(lv, VMAX]` pick would instead halve the headroom every step
 * and cascade into ever-deeper levels after ~40 appends. Concurrent tail
 * inserts may collide on `v` — the `t` tiebreak orders them.
 */
const APPEND_WINDOW = 2 ** 16;

export const rankBetween = (
	left: string | undefined,
	right: string | undefined,
	clientId: number,
	rand: () => number = Math.random
): string => {
	const L = left === undefined ? [] : decodeRank(left);
	const R = right === undefined ? [] : decodeRank(right);
	if (left !== undefined && right !== undefined && left >= right) {
		throw new Error(`rankBetween: left >= right (${left} !< ${right})`);
	}
	const rightOpen = right === undefined;
	const path: RankSeg[] = [];
	// `locked` = the emitted prefix already guarantees result < right because a
	// copied left segment was strictly less than the right segment at its level.
	let locked = false;
	// `floor` = right segments at the digit minimum were copied past the left
	// bound's end (a promoted slot's separator): the result equals right so far.
	let floor = false;
	for (let i = 0; ; i++) {
		const lSeg = L[i] as RankSeg | undefined;
		const rSeg = rightOpen ? undefined : (R[i] as RankSeg | undefined);
		if (lSeg === undefined) {
			// Left bound exhausted (or absent): extending its prefix already makes
			// the result > left. Only the right bound constrains the emitted digit.
			// Locked: the right bound no longer constrains the result.
			if (rSeg === undefined || locked) {
				if (floor) throw new RankSpaceExhausted();
				// Open right (or, unreachable under valid inputs, both bounds
				// exhausted while equal): the canonical extension digit.
				path.push({ v: 0, t: clientId });
				return encodeRank(path);
			}
			if (rSeg.v <= RANK_VMIN) {
				// No digit below: copy it and descend — below a promoted block
				// (`slot + separator + rank`) there is room under its own rank.
				floor = true;
				path.push(rSeg);
				continue;
			}
			path.push({ v: rSeg.v - 1, t: clientId });
			return encodeRank(path);
		}
		if (rSeg === undefined) {
			// Right bound ended while left continues: valid only when `locked`
			// already holds (an earlier copied segment was < the right's). If not,
			// right is a proper prefix of left — i.e. right < left, caller error.
			if (!rightOpen && !locked) {
				throw new Error(`rankBetween: right bound is a prefix of left (right < left)`);
			}
			// No right bound at this level (open, or `locked` below it): emit
			// within the bounded append window — dense growth, and one more
			// level per exhausted gap, not one per insert (SW12-crdt-2: copying
			// every left segment made each insert at a filled seam one longer).
			const span = Math.min(APPEND_WINDOW, RANK_VMAX - lSeg.v);
			if (span <= 0) {
				path.push(lSeg); // digit space exhausted at this level — descend
				continue;
			}
			const v = lSeg.v + 1 + Math.floor(rand() * span);
			path.push({ v, t: clientId });
			return encodeRank(path);
		}
		if (rSeg.v - lSeg.v > 1) {
			// Gap at this level: any v in (lv, rv) is > left and < right (the
			// emitted digit exceeds lv, and stays below the real right segment).
			const v = lSeg.v + 1 + Math.floor(rand() * (rSeg.v - lSeg.v - 1));
			path.push({ v, t: clientId });
			return encodeRank(path);
		}
		// rv - lv ≤ 1: adjacent digits or equal digit — copy the left segment and
		// descend; the copied segment is ≤ rSeg, which locks result < right the
		// moment it is strictly less. Once locked, deeper right segments no
		// longer constrain the result — lSeg > rSeg at a deeper level is legal.
		const c = segLess(lSeg, rSeg);
		if (c < 0) locked = true;
		else if (c > 0 && !locked) {
			// Never locked and left's segment exceeds right's at the first
			// differing level → left > right (invalid bounds — caller error).
			throw new Error(`rankBetween: left >= right at level ${i}`);
		}
		path.push(lSeg);
	}
};
