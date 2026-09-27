/**
 * arch-v2 R7 — the truth invariant in the browser lanes (plan §8.7 F-O10,
 * R12): at the end of a test or DST schedule, once the page settled, the
 * view's host must be the projection of its cells
 * (`src/tests/oracles/truth.ts`, evaluated in the page on `__EDYTOR__`).
 * Replaces R6's shadow census.
 */
import type { Page } from '@playwright/test';
import { truthOf } from '../src/tests/oracles/truth';

/** The divergences left after a bounded settle; null when the page has no view. */
export const readTruth = async (page: Page): Promise<string[] | null> => {
	if (page.isClosed()) return null;
	try {
		return await page.evaluate(`(async () => {
			const edytor = window.__EDYTOR__;
			if (!edytor || edytor.destroyed || !edytor.node?.isConnected) return null;
			const busy = () =>
				edytor.attempts.busy || edytor.composition.live || edytor.surface.pending();
			for (let waited = 0; waited < 400 && busy(); waited += 20)
				await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
			return (${truthOf.toString()})(edytor);
		})()`);
	} catch {
		return null;
	}
};

/** Throws when the settled host diverges from its cells. */
export const assertTruth = async (page: Page, label: string) => {
	const divergences = await readTruth(page);
	if (divergences?.length)
		throw new Error(
			`F-O10 (${label}): the host diverges from its cells:\n${divergences.join('\n')}`
		);
};
