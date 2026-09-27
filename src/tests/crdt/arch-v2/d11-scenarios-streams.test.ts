/**
 * arch-v2 D11 — the pinned scenario corpus (TX01–TX09, ST01–ST03, MV, AN,
 * HI01a/b) run against the stream-boundary spike (`streams.next.ts`) through
 * the test-only backend switch. Same scenario bodies, same expectations as the
 * model lane; the rows re-pinned by D-1/D-17 (YATA order) are listed in
 * `REPINNED` and re-stated in `d11-streams.test.ts`.
 */
// @ts-nocheck -- scenario modules drive the vendored engine JS directly.
import { describe, expect, it } from 'vitest';
import { scenarioOps, useScenarioBackend } from '../harness/ops/backend.js';

useScenarioBackend('streams');
const { textScenarios } = await import('../scenarios/active-text.js');
const { modelScenarios } = await import('../scenarios/active-model.js');
const { richtextScenarios } = await import('../scenarios/active-richtext.js');

/** Red on the reference (no spike): `it.fails` in the tests-first commit. */
const row = it.fails;

/** Scenario id → the decision that re-pins it on streams (re-stated in d11-streams.test.ts). */
export const REPINNED: Record<string, string> = {
	TX06a:
		'D-1: a seam insert concurrent with a split lands by YATA order (client id), not head side',
	TX09a:
		'D-1 class: typing into an empty block concurrent with its split at 0 lands by YATA order, not head side'
};

const corpus = [...textScenarios, ...modelScenarios, ...richtextScenarios].filter((s) =>
	/^(TX0[1-9]|ST0[1-3]|MV|AN|HI01[ab]$)/.test(s.id)
);

describe('D11 spike: pinned scenarios on streams', () => {
	it('the switch selects the spike', () => expect(scenarioOps().name).toBe('streams-spike'));
	it('the corpus is the requested set', () => {
		const ids = corpus.map((s) => s.id);
		for (const want of [
			'TX01',
			'TX04a',
			'TX06a',
			'TX09a',
			'ST01a',
			'ST02a',
			'ST03',
			'MV01',
			'AN01',
			'HI01a',
			'HI01b'
		]) {
			expect(ids).toContain(want);
		}
	});
	for (const s of corpus) {
		if (REPINNED[s.id]) it.skip(`[${s.id}] re-pinned — ${REPINNED[s.id]}`, () => {});
		else row(`[${s.id}] ${s.title}`, () => s.run());
	}
});
