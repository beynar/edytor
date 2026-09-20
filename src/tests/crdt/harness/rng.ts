/**
 * Deterministic seeded PRNG for the CRDT harness (mulberry32).
 *
 * The same seed must always produce the same op schedule, so randomized
 * corpus failures are reproducible from a committed seed number alone.
 */

export type Rng = () => number;

/** mulberry32 — small, fast, deterministic 32-bit PRNG. */
export const mulberry32 = (seed: number): Rng => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Integer in [min, max] inclusive. */
export const int = (rng: Rng, min: number, max: number): number =>
	min + Math.floor(rng() * (max - min + 1));

/** Pick an element; throws on empty input so callers notice model bugs. */
export const pick = <T>(rng: Rng, items: readonly T[]): T => {
	if (items.length === 0) throw new Error('rng.pick: empty array');
	return items[int(rng, 0, items.length - 1)];
};

/** pick or undefined for empty input. */
export const pickOr = <T>(rng: Rng, items: readonly T[]): T | undefined =>
	items.length === 0 ? undefined : pick(rng, items);

export const bool = (rng: Rng, probability = 0.5): boolean => rng() < probability;

/** Shuffle a copy of the array (Fisher–Yates on the given stream). */
export const shuffled = <T>(rng: Rng, items: readonly T[]): T[] => {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = int(rng, 0, i);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
};

const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** Short random lowercase string (for text inserts and generated ids). */
export const alpha = (rng: Rng, len: number): string => {
	let s = '';
	for (let i = 0; i < len; i++) s += LOWER[int(rng, 0, LOWER.length - 1)];
	return s;
};
