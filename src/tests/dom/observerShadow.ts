/**
 * arch-v2 R6 — the observer shadow in the dom lane (plan §9.3 R6, §9.1 rule
 * 3). Installs the surface observer's log sink for every test, feeds the
 * census (`src/tests/oracles/observer-shadow.ts`) and, at the end of each
 * test, fails on a difference no class explains. Census:
 * `OBSERVER_SHADOW_REPORT=/abs/file.jsonl pnpm test:dom` appends one line per
 * test file. Rows read the raw log with `shadowEntries()`.
 * Temporary: removed at R7 with the comparison.
 */
import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';
import {
	createObserverCensus,
	mergeSummaries,
	type CensusSummary,
	type ObserverCensus,
	type ShadowEntry
} from '../oracles/observer-shadow.js';

type Sink = (entry: ShadowEntry & { edytor?: any }) => void;
const target = globalThis as { __EDYTOR_OBSERVER_SHADOW__?: Sink };

let census: ObserverCensus = createObserverCensus();
let entries: ShadowEntry[] = [];
const views = new Set<any>();
const summaries: CensusSummary[] = [];

/** Every entry logged since the test began (all views). */
export const shadowEntries = () => entries;

export const installObserverShadow = () => {
	census = createObserverCensus();
	entries = [];
	views.clear();
	target.__EDYTOR_OBSERVER_SHADOW__ = ({ edytor, ...entry }) => {
		views.add(edytor);
		entries.push(entry as ShadowEntry);
		census.push(entry as ShadowEntry);
	};
};

/** Test end: close the episodes; fail on an unexplained difference (`OBSERVER_SHADOW_STRICT=0` records only). */
export const endObserverShadowTest = async () => {
	// Today's observer defers records behind attempts and held writes: let
	// every live view settle (bounded) before the episodes close.
	const busy = () =>
		[...views].some(
			(edytor) =>
				!edytor.destroyed &&
				(edytor.observer?.pending() || edytor.attempts.busy || edytor.composition.live)
		);
	for (let waited = 0; waited < 400 && busy(); waited += 10)
		await new Promise((resolve) => setTimeout(resolve, 10));
	// The settle check: every content of every live view compared once more.
	for (const edytor of views)
		if (!edytor.destroyed && edytor.node?.isConnected) edytor.surface.check();
	await new Promise((resolve) => setTimeout(resolve, 0));
	census.end();
	const summary = census.summary();
	summaries.push(summary);
	if (process.env.OBSERVER_SHADOW_DEBUG && summary.differing)
		appendFileSync(
			process.env.OBSERVER_SHADOW_DEBUG,
			JSON.stringify({
				test: expect.getState().currentTestName,
				differences: census.differences,
				entries
			}) + '\n'
		);
	delete target.__EDYTOR_OBSERVER_SHADOW__;
	if (process.env.OBSERVER_SHADOW_STRICT === '0') return;
	expect(
		summary.unexplained.map((d) => `${d.key} @${d.block}`),
		'observer shadow: differences no §8 row explains'
	).toEqual([]);
};

export const reportObserverCensus = (file: string) => {
	const out = process.env.OBSERVER_SHADOW_REPORT;
	const merged = mergeSummaries(summaries.splice(0));
	if (out && merged.steps > 0)
		appendFileSync(
			out,
			JSON.stringify({
				file,
				...merged,
				unexplained: merged.unexplained.length,
				samples: merged.unexplained.slice(0, 30)
			}) + '\n'
		);
};
