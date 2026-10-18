/**
 * Order keys — the in-memory keys the index sorts a parent's children by.
 *
 * A block's place is its slot in its parent's sequence (fork patch YP22:
 * the engine orders slots and move records); nothing about the order is
 * stored. The index still needs a comparable key per child, so that
 * `displaySlotOf`'s promotion, the layout rules, `positionInView`'s binary
 * search and `anchors.seam` keep working over `(rank, id)`-sorted lists:
 * each child gets a key between its sequence neighbours' when it is placed
 * (`keyBetween`), or a dense one when a whole sequence is read
 * (`denseKey`). Keys are plain strings compared with `<`; they are local to
 * one index and never leave it (two replicas may hold different keys for
 * one order).
 *
 * Three key spaces compose with them:
 *
 * - a promoted child's key is its slot's key, {@link PROMOTED} and its own
 *   ({@link promotedRank}): `PROMOTED` sorts below every key character, so
 *   the promoted children follow the slot and precede the next sibling;
 * - a merged-away block's children show after the owner's own children,
 *   by the owner's claim order ({@link claimedRank}): {@link CLAIMED} sorts
 *   above every key character;
 * - a table's cells show in column order ({@link cellKey}).
 */

/**
 * Order-preserving alphabet: charCode order equals numeric order (64
 * characters, all safe inside a JSON string).
 */
const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

/** Sorts below every key character: the separator of a promoted child's key. */
export const PROMOTED = '!';
/** Sorts above every key character: the prefix of a merged-away block's children. */
const CLAIMED = '~';

/** The index of a key character in the alphabet (`-1`: none). */
const digit = (s: string, i: number): number => (i < s.length ? ALPHABET.indexOf(s[i]!) : -1);

/**
 * A key strictly between `a` and `b` (`undefined`: no bound). Both bounds
 * are keys of this alphabet with `a < b`: place by place, a digit halfway
 * between theirs when one fits, else `a`'s digit and one place deeper
 * (classic fractional indexing). A key never ends in the lowest digit
 * (`denseKey` writes none), so a key fits between any two.
 */
export const keyBetween = (a: string | undefined, b: string | undefined): string => {
	let out = '';
	for (let i = 0; ; i++) {
		// Past a bound's end: below every digit (`a`), above every digit (`b`).
		const da = a !== undefined && i < a.length ? digit(a, i) : 0;
		const db = b === undefined ? BASE : i < b.length ? digit(b, i) : 0;
		if (db - da > 1) return out + ALPHABET[da + ((db - da) >> 1)]!;
		out += ALPHABET[da]!;
		// Below `b` already at this place: it bounds the deeper places no more.
		if (db - da === 1) b = undefined;
	}
};

/** The `i`-th of a whole sequence's dense keys, in order (none ends in the lowest digit). */
export const denseKey = (i: number): string => {
	// Four places of 63 digits (the lowest left out): 15M positions of one length.
	let out = '';
	let x = i;
	for (let k = 0; k < 4; k++) {
		out = ALPHABET[1 + (x % (BASE - 1))]! + out;
		x = Math.floor(x / (BASE - 1));
	}
	return out;
};

/**
 * The key of a block promoted into the slot keyed `slot` (read-time
 * promotion, `del.blocks.promote`): after the slot, before every later key of
 * the slot's list, in the promoted children's own order.
 */
export const promotedRank = (slot: string, rank: string): string => slot + PROMOTED + rank;

/**
 * The key of a child of a merged-away block shown under its owner: after the
 * owner's own children, by the owner's claims (`path`: the claim index at
 * each hop down to the child's parent), then the child's own key.
 */
export const claimedRank = (path: readonly number[], rank: string): string =>
	path.map((i) => CLAIMED + denseKey(i)).join('') + PROMOTED + rank;

/**
 * The key a table's cell displays at (`table.columns`): its column's
 * position, before every unlisted column (`unlistedCellKey`) and the cells
 * of no listed column (`LAST_CELL`).
 */
export const cellKey = (at: number): string => '0' + denseKey(at);
/** A withdrawn cell's column the table no longer lists: after the listed ones, by `unlistedRank`. */
export const unlistedCellKey = (hash: number): string => '1' + denseKey(hash % 2 ** 24);
/** A cell of no listed column: last (it does not display, `table.cell`). */
export const LAST_CELL = '2';
