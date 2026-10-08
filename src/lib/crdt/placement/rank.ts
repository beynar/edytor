/**
 * Rank keys for the placement model — a Logoot-style dense ordering.
 *
 * A rank is a non-empty sequence of *segments* `(v, t)`:
 *
 * - `v` — a signed digit in `[VMIN, VMAX]` (±2^40). There is always room
 *   between two distinct digits (`rv - lv > 1`); when there is not, the
 *   generator descends one level instead of renumbering.
 * - `t` — the allocator's `doc.clientID` (uint53), the *tiebreak* that makes
 *   concurrent allocations of the same digit path distinct, or none
 *   (`Infinity`: sorts above every client) on a segment that only leads to
 *   deeper ones. The last segment always carries one (schema
 *   generation 5): a rank's own client sits on its last segment, and a
 *   copied segment keeps its tie only where the order needs it (between two
 *   keys that differ only by their ties).
 *
 * Encoding is variable-length and order-preserving, so the persisted rank
 * is a plain string and the comparator is `a < b` (CRDT study 2026-10;
 * up to generation 4 every segment was 16 characters, 9 of them a tie):
 *
 * - `v` → a length character (`'H'` for zero, `'H' + k` for a positive
 *   digit of `k` base-64 places, `'H' - k` for a negative one, its places
 *   complemented) and its places — small digits are short;
 * - a tie → `'!'`, then `t` as a digit (`'!'` sorts below every length
 *   character, so a tied segment sorts before the same digit leading on);
 * - rank = segments concatenated; a prefix sorts before its extension, as
 *   string `<` does.
 *
 * Allocation (`rankBetween(left, right, clientId)`):
 *
 * - gap at level `i` (`rv - lv > 1`): emit `lv + 1 + floor(rand·(rv-lv-1))`,
 *   own tie — random-in-gap keeps sequential inserts shallow and concurrent
 *   same-gap inserts deterministic-distinct.
 * - adjacent or equal digits (`rv - lv ≤ 1`): the left digit or the right
 *   one with the allocator's own tie when that tie sorts between theirs;
 *   else copy the left segment and descend — untied when that already sorts
 *   below the right bound (the result is then above left and below right,
 *   and the next level is free), tied otherwise.
 * - left exhausted/open: emit `rSeg.v - 1` (boundary-minus). Sequential
 *   prepends stay at depth 1; the bound can only underflow after ~2^40
 *   consecutive boundary pushes — documented unreachable, guarded by a
 *   descriptive throw.
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

/** Digit range. VMIN = -2^40, VMAX = 2^40 - 1. */
export const RANK_VMIN = -(2 ** 40);
export const RANK_VMAX = 2 ** 40 - 1;
/** The length character of zero; a digit of `k` places is `ZERO ± k`. */
const ZERO = 'H'.charCodeAt(0);
/** Most places a digit or a tie takes (uint53 → 9 base-64 places). */
const MAX_PLACES = 9;
/** Marks a segment's tie: below every length character. */
const TIE = '!';

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

/** `n` (≥ 0) as exactly `width` base-64 places. */
const places = (n: number, width: number): string => {
	let out = '';
	for (let i = 0; i < width; i++) {
		out = ALPHABET[n % BASE] + out;
		n = Math.floor(n / BASE);
	}
	if (n > 0) throw new Error(`rank encode overflow: value exceeds ${width} places`);
	return out;
};
/** How many base-64 places `m` (≥ 1) takes. */
const width = (m: number): number => {
	let k = 1;
	for (let x = Math.floor(m / BASE); x > 0; x = Math.floor(x / BASE)) k++;
	return k;
};

/** A signed integer as a self-delimiting, order-preserving string. */
const encInt = (v: number): string => {
	if (!Number.isSafeInteger(v)) throw new Error(`rank encode: bad digit ${v}`);
	if (v === 0) return 'H';
	const m = Math.abs(v);
	const k = width(m);
	if (k > MAX_PLACES) throw new Error(`rank encode overflow: ${v}`);
	if (v > 0) return String.fromCharCode(ZERO + k) + places(m, k);
	// Complemented: a greater magnitude sorts first.
	return String.fromCharCode(ZERO - k) + places(BASE ** k - 1 - m, k);
};

/** The integer at `s[i]`, and where it ends. */
const decInt = (s: string, i: number): [number, number] => {
	const k = s.charCodeAt(i) - ZERO;
	if (Number.isNaN(k) || Math.abs(k) > MAX_PLACES)
		throw new Error(`rank decode: bad length at ${i}`);
	const n = Math.abs(k);
	if (i + 1 + n > s.length) throw new Error(`rank decode: truncated at ${i}`);
	let x = 0;
	for (let j = i + 1; j <= i + n; j++) {
		const d = ALPHABET.indexOf(s[j]);
		if (d < 0) throw new Error(`rank decode: bad char ${s[j]}`);
		x = x * BASE + d;
	}
	const v = k === 0 ? 0 : k > 0 ? x : -(BASE ** n - 1 - x);
	return [v, i + 1 + n];
};

/** Decode a rank string into its segment array (`t: Infinity` where a segment has no tie). */
export const decodeRank = (rank: string): RankSeg[] => {
	if (rank.length === 0) throw new Error('rank decode: empty');
	const segs: RankSeg[] = [];
	for (let i = 0; i < rank.length; ) {
		const [v, j] = decInt(rank, i);
		let t = Infinity;
		i = j;
		if (rank[i] === TIE) [t, i] = decInt(rank, i + 1);
		segs.push({ v, t });
	}
	if (segs[segs.length - 1].t === Infinity) throw new Error('rank decode: untied last segment');
	return segs;
};

/** Encode segments back to the persisted string form. */
export const encodeRank = (segs: readonly RankSeg[]): string => {
	let out = '';
	for (const { v, t } of segs) {
		if (v < RANK_VMIN || v > RANK_VMAX) throw new Error(`rank encode overflow: digit ${v}`);
		out += encInt(v);
		if (t !== Infinity) out += TIE + encInt(t);
	}
	return out;
};

const tieCmp = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);
const segCmp = (a: RankSeg, b: RankSeg): number => a.v - b.v || tieCmp(a.t, b.t);

/**
 * Window for open-end (append-at-tail) allocation: emit at most `lv + APPEND_WINDOW`
 * rather than anywhere in `(lv, VMAX]`. Sequential appends advance the tail
 * digit by ≤2^16, so the digit space only saturates after ~2^24 tail-appends;
 * a uniform-in-`(lv, VMAX]` pick would instead halve the headroom every step
 * and cascade into ever-deeper levels after ~40 appends. Concurrent tail
 * inserts may collide on `v` — the `t` tiebreak orders them.
 */
const APPEND_WINDOW = 2 ** 16;

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
export const rankBetween = (
	left: string | undefined,
	right: string | undefined,
	clientId: number,
	rand: () => number = Math.random,
	compact = true
): string => {
	const L = left === undefined ? [] : decodeRank(left);
	const R = right === undefined ? [] : decodeRank(right);
	if (left !== undefined && right !== undefined && left >= right) {
		throw new Error(`rankBetween: left >= right (${left} !< ${right})`);
	}
	const rightOpen = right === undefined;
	const path: RankSeg[] = [];
	// `locked`: the emitted prefix already sorts below the right bound.
	let locked = false;
	// `above`: the emitted prefix already sorts above the left bound.
	let above = false;
	// `floor` = right segments at the digit minimum were copied past the left
	// bound's end (a promoted slot's separator): the result equals right so far.
	let floor = false;
	const own = (v: number): string => encodeRank([...path, { v, t: clientId }]);
	for (let i = 0; ; i++) {
		const lSeg = above ? undefined : (L[i] as RankSeg | undefined);
		// Locked: the right bound no longer constrains any deeper level
		// (descending past it grew ranks linearly under concentrated edits).
		const rSeg = rightOpen || locked ? undefined : (R[i] as RankSeg | undefined);
		if (lSeg === undefined) {
			// Left bound exhausted (or passed): extending the prefix keeps the
			// result above it. Only the right bound constrains the digit.
			if (rSeg === undefined) {
				if (floor) throw new RankSpaceExhausted();
				return own(0);
			}
			if (rSeg.v <= RANK_VMIN) {
				// No digit below: copy it and descend — below a promoted block
				// (`slot + separator + rank`) there is room under its own rank.
				floor = true;
				path.push(rSeg);
				continue;
			}
			return own(rSeg.v - 1);
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
			// level per exhausted gap, not one per insert (SW12-crdt-2).
			const span = Math.min(APPEND_WINDOW, RANK_VMAX - lSeg.v);
			if (span <= 0) {
				path.push(lSeg); // digit space exhausted at this level — descend
				continue;
			}
			return own(lSeg.v + 1 + Math.floor(rand() * span));
		}
		if (rSeg.v - lSeg.v > 1) {
			// Gap at this level: any v in (lv, rv) is > left and < right.
			return own(lSeg.v + 1 + Math.floor(rand() * (rSeg.v - lSeg.v - 1)));
		}
		// rv - lv ≤ 1. Compact: the left digit with our tie, or the right
		// one, when it sorts between; else the left digit untied when that
		// already sorts below the right bound. A run's member (`rankAfter`) is
		// never compact: a peer's rank of the same digit and another tie would
		// sort between two of its members.
		const mineL = { v: lSeg.v, t: clientId };
		if (compact && segCmp(lSeg, mineL) < 0 && segCmp(mineL, rSeg) < 0) return own(lSeg.v);
		const mineR = { v: rSeg.v, t: clientId };
		if (compact && rSeg.v > lSeg.v && segCmp(mineR, rSeg) < 0) return own(rSeg.v);
		// Copy the left digit and descend: untied when compact and that
		// already sorts below the right bound (then above the left one too,
		// unless its segment was untied as well), else with its tie.
		const bare = { v: lSeg.v, t: Infinity };
		if (compact && segCmp(bare, rSeg) < 0) {
			path.push(bare);
			locked = true;
			if (lSeg.t !== Infinity) above = true;
			continue;
		}
		const c = segCmp(lSeg, rSeg);
		if (c < 0) locked = true;
		else if (c > 0 && !locked) {
			// Never locked and left's segment exceeds right's at the first
			// differing level → left > right (invalid bounds — caller error).
			throw new Error(`rankBetween: left >= right at level ${i}`);
		}
		path.push(lSeg);
	}
};

/**
 * The digit of the run marker data arrays wrote up to 0.1.0-next.21 (a run
 * of that form is the marker segment, then ranks of the client's own): still
 * read as a run, so what a client inserts there stays in it.
 */
export const RANK_RUN = -(2 ** 30);
/**
 * A run member's digit lies in `(RANK_RUN, RANK_RUN + RUN_BAND)`: below every
 * digit a plain rank extends a prefix with (`0`, an append's), far above the
 * digit minimum. A run opens at {@link RUN_START}, the middle of the band, so
 * its members can be inserted before and after one another.
 */
const RUN_BAND = 2 ** 29;
const RUN_START = RANK_RUN + 2 ** 28;
const inRun = (v: number): boolean => v > RANK_RUN && v < RANK_RUN + RUN_BAND;

/**
 * A rank in `(left, right)` for an insert right after `left` — one rule for
 * array items (`crdt/data.ts`) and inserted blocks (`order.insert.run`).
 * When `client` made `left`, the rank is in the client's run after it: `left`
 * itself as the prefix, then one segment of the run band — or, when `left`
 * is already a member of the client's run, that run's prefix and a member
 * between `left` and the next one. So what one client inserts after its own
 * items stays together whatever a peer inserts in that gap meanwhile: a
 * peer's rank there is either no extension of the run's prefix (it sorts
 * after the whole run) or one whose next digit is above the band (YATA's
 * origin rule, as `Y.Array` keeps an insert after its origin). Elsewhere, or
 * when the run rank would not sort below `right`, a plain {@link rankBetween}.
 */
export const rankAfter = (
	left: string | undefined,
	right: string | undefined,
	client: number,
	rand: () => number = Math.random
): string => {
	const plain = () => rankBetween(left, right, client, rand);
	if (left === undefined) return plain();
	const segs = decodeRank(left);
	const last = segs.at(-1)!;
	const bottom = encodeRank([{ v: RANK_RUN, t: 0 }]);
	const top = encodeRank([{ v: RANK_RUN + RUN_BAND, t: 0 }]);
	/**
	 * `prefix` and a rank after `after` (`undefined`: the run opens) in the
	 * run: inside the band when `band`. Opening, it takes the band's middle,
	 * or a digit below the run's first member; at the run's end it appends as
	 * an open end does (a window, not half the band); else between the two.
	 */
	const own = (prefix: string, after: string | undefined, band: boolean): string => {
		const tail = (r?: string) =>
			r && r.length > prefix.length && r.startsWith(prefix) ? r.slice(prefix.length) : undefined;
		let next = tail(right);
		if (band && next !== undefined && next > top) next = undefined;
		let mine: string;
		if (after === undefined) {
			if (next === undefined) mine = encodeRank([{ v: RUN_START, t: client }]);
			else if (band && next > bottom) mine = rankBetween(bottom, next, client, rand, false);
			else return plain();
		} else if (next === undefined && band) {
			const append = rankBetween(after, undefined, client, rand, false);
			mine = append < top ? append : rankBetween(after, top, client, rand, false);
		} else mine = rankBetween(after, next, client, rand, false);
		const rank = prefix + mine;
		return right === undefined || rank < right ? rank : plain();
	};
	// A member of the client's run: the next member, inside the band.
	if (last.t === client && inRun(last.v))
		return own(encodeRank(segs.slice(0, -1)), encodeRank([last]), true);
	// A run of the earlier form (the marker, then the client's ranks): stays in it.
	const k = segs.findLastIndex((g) => g.v === RANK_RUN);
	if (k >= 0 && segs[k]!.t === client) {
		const prefix = encodeRank(segs.slice(0, k + 1));
		return own(prefix, left.length > prefix.length ? left.slice(prefix.length) : undefined, false);
	}
	// A rank the client made: its run opens right after it. The prefix keeps
	// `left`'s tie: a peer's rank of the same digit and a greater tie
	// then sorts after the whole run, never between `left` and it.
	if (last.t === client) return own(left, undefined, true);
	return plain();
};
