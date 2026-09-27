/**
 * arch-v2 R7 — the truth invariant in the dom lane (plan §8.7 F-O10, R12):
 * at the end of every test, once every live view settled (bounded), each
 * host must be the projection of its cells (`src/tests/oracles/truth.ts`).
 * Views are discovered the way the cells shadow does: the first `facade`
 * read of a view. Replaces R6's observer shadow.
 */
import { tick } from 'svelte';
import { expect } from 'vitest';
import { truthOf } from '../oracles/truth.js';

// Loosely typed: the check holds views without importing their module.
type Any = any;

const views = new Set<Any>();
const seen = new WeakSet<object>();
let installed = false;

export const installTruthCheck = async () => {
	views.clear();
	if (installed) return;
	installed = true;
	const { Edytor } = await import('$lib/edytor.svelte.js');
	const facade = Object.getOwnPropertyDescriptor(Edytor.prototype, 'facade')!.get!;
	Object.defineProperty(Edytor.prototype, 'facade', {
		configurable: true,
		get() {
			if (!seen.has(this)) {
				seen.add(this);
				views.add(this);
			}
			return facade.call(this);
		}
	});
};

const live = () => [...views].filter((edytor) => !edytor.destroyed && edytor.node?.isConnected);

/** Test end, before the unmount: every live view settled, then compared with its cells. */
export const endTruthCheck = async () => {
	const busy = () =>
		live().some(
			(edytor) => edytor.attempts.busy || edytor.composition.live || edytor.surface.pending()
		);
	for (let waited = 0; waited < 400 && busy(); waited += 10)
		await new Promise((resolve) => setTimeout(resolve, 10));
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const divergences = live().flatMap((edytor) => truthOf(edytor));
	views.clear();
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
		?.env;
	if (env?.TRUTH_CHECK === '0') return;
	expect(divergences, 'F-O10: after a settle every content equals its cell').toEqual([]);
};
