/**
 * Per-doc in-gap rank randomness — a module-level `WeakMap` side-channel
 * instead of shape-extending the vendored `Doc` (the old `doc.rand`
 * monkey-patch). The test harness seeds a deterministic stream per doc
 * (`setDocRand`, keyed by `(rngSeed, peerIndex[, generation])`); docs that
 * were never seeded get `Math.random`.
 */
import type { EngineDoc } from './engine-api.js';

const streams = new WeakMap<EngineDoc, () => number>();

/** Seed/override `doc`'s rank-rand stream — the harness determinism hook. */
export const setDocRand = (doc: EngineDoc, rand: () => number): void => {
	streams.set(doc, rand);
};

/** `doc`'s rank-rand stream — `Math.random` when none was seeded. */
export const randOf = (doc: EngineDoc): (() => number) => streams.get(doc) ?? Math.random;

/** A fresh 32-bit block incarnation nonce from `doc`'s stream. */
export const nonceOf = (doc: EngineDoc): number => (randOf(doc)() * 2 ** 32) >>> 0;

/** 32-bit FNV-1a — the seed writer id is this hash of the canonical seed. */
export const hash32 = (text: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return h >>> 0;
};

/**
 * A 53-bit hash (two FNV-1a passes: 32 high bits, 21 low) — a derived writer
 * id spans the engine's whole clientID space, so two concurrent derivations
 * collide at ~2^-53, not ~2^-32. Integer in `[0, 2^53)`.
 */
export const hash53 = (text: string): number =>
	hash32(text) * 2 ** 21 + (hash32(`${text}\u0000`) >>> 11);
