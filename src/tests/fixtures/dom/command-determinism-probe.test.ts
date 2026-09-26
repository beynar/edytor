// @ts-nocheck
/**
 * Fresh-process probe for the deterministic command simulator — spawned
 * by `command-determinism.test.ts` via `pnpm exec vitest run` (a real new
 * OS process, new module registry, new rand/id streams).
 *
 * With `CMD_TRACE_PROBE=1` it writes `TRACE:<digest>` and `PROJ:<digest>`
 * for the parent to compare; it always passes.
 *
 * Digests go through `process.stdout.write`, never `console.log`: vitest
 * intercepts console calls and forwards them to the reporter
 * asynchronously (worker → main RPC → reporter), which can drop them when
 * the child run finishes before the flush — the exact failure the review
 * caught. Raw stdout writes cannot be intercepted or swallowed.
 */
import { describe, expect, it } from 'vitest';
import '../../crdt/harness/vclock.js';
import { runCommandScenario } from './deterministic-command-scenario.js';

const fnv = (s: string) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
};

describe('command determinism probe', () => {
	it('prints the scenario fingerprint', async () => {
		const r = await runCommandScenario();
		try {
			const proj = fnv(
				JSON.stringify({
					signatures: r.signatures,
					selections: r.selections,
					afterUndo: r.afterUndo
				})
			);
			if (process.env.CMD_TRACE_PROBE === '1') {
				// One write — the line pair cannot be interleaved or split.
				process.stdout.write(`TRACE:${fnv(r.trace)}\nPROJ:${proj}\n`);
			}
			expect(r.trace.length).toBeGreaterThan(0);
		} finally {
			r.unmountAll();
		}
	});
});
