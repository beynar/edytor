// @ts-nocheck
/**
 * Fresh-process probe for the U3 determinism proof (spawned by
 * `determinism.test.ts` via `pnpm exec vitest run` — a real new OS
 * process, new module registry, new rand streams).
 *
 * With `CRDT_TRACE_PROBE=1` it prints `TRACE:<digest>` and `PROJ:<digest>`
 * lines for the parent to compare; it always passes. With `CRDT_TRACE_DEFECT=1`
 * it runs the defective variant (different fingerprint expected).
 *
 * Digests go through `process.stdout.write`, never `console.log`: vitest
 * intercepts console calls and forwards them to the reporter asynchronously
 * (worker → main RPC → reporter), which can drop them when the child run
 * finishes before the flush — silently breaking the parent's parse. Raw
 * stdout writes cannot be intercepted or swallowed.
 */
import { describe, expect, it } from 'vitest';
import { runDeterminismScenario } from './determinism-scenario.js';
import { traceDigest } from './trace.js';

const fnv = (s: string) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
};

describe('determinism probe', () => {
	it('prints the scenario fingerprint', () => {
		const {
			traceDigest: td,
			projections,
			set
		} = runDeterminismScenario({
			defect: process.env.CRDT_TRACE_DEFECT === '1'
		});
		const proj = fnv(projections.join('|'));
		if (process.env.CRDT_TRACE_PROBE === '1') {
			// One write — the line pair cannot be interleaved or split.
			process.stdout.write(`TRACE:${td}\nPROJ:${proj}\n`);
		}
		expect(td).toBe(traceDigest(set.trace));
	});
});
