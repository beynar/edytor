/**
 * arch-v2 R7 — the truth invariant in the browser lanes (plan §8.7 F-O10,
 * R12): at the end of a test or DST schedule, once the page settled, the
 * view's host must be the projection of its cells
 * (`src/tests/oracles/truth.ts`, evaluated in the page on `__EDYTOR__`).
 * Replaces R6's shadow census.
 */
import type { Page } from '@playwright/test';
import { truthOf } from '../src/tests/oracles/truth';

/**
 * The divergences left after a bounded settle; null when the page is closed or
 * has no view. An evaluation that throws is not a verdict: it propagates (a
 * check that could not look must not pass, review 2026-09-29). The callers
 * read only open pages, so no teardown case needs telling apart.
 */
export const readTruth = async (page: Page): Promise<string[] | null> => {
	if (page.isClosed()) return null;
	return page.evaluate(`(async () => {
		const edytor = window.__EDYTOR__;
		if (!edytor || edytor.destroyed || !edytor.node?.isConnected) return null;
		const busy = () =>
			edytor.attempts.busy || edytor.composition.live || edytor.surface.pending();
		for (let waited = 0; waited < 400 && busy(); waited += 20)
			await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		return (${truthOf.toString()})(edytor);
	})()`);
};

/** Throws when the settled host diverges from its cells, or when the check could not run. */
export const assertTruth = async (page: Page, label: string) => {
	let divergences: string[] | null;
	try {
		divergences = await readTruth(page);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`F-O10 (${label}): the truth check could not run: ${reason}`, {
			cause: error
		});
	}
	if (divergences?.length)
		throw new Error(
			`F-O10 (${label}): the host diverges from its cells:\n${divergences.join('\n')}`
		);
};
