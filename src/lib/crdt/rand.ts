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
