/**
 * arch-v2 R6 — the observer shadow in the browser lanes (plan §9.3 R6, §9.1
 * rule 3). With `OBSERVER_SHADOW_REPORT=/abs/file.jsonl`, every page gets the
 * surface observer's log sink before its scripts run; at the end of the test
 * (or DST schedule) each live view compares every content once more (the
 * settle check), and the page's log feeds the census
 * (`src/tests/oracles/observer-shadow.ts`, Node-side), one line per page.
 * Without the variable nothing is installed. Temporary: removed at R7.
 */
import { appendFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { createObserverCensus, type ShadowEntry } from '../src/tests/oracles/observer-shadow';

const REPORT = process.env.OBSERVER_SHADOW_REPORT;

export const installObserverShadow = async (page: Page) => {
	if (!REPORT) return;
	await page.addInitScript(() => {
		type Any = any;
		const target = window as Any;
		const log: unknown[] = [];
		const views = new Set<Any>();
		target.__EDYTOR_OBSERVER_SHADOW_LOG__ = log;
		target.__EDYTOR_OBSERVER_SHADOW_VIEWS__ = views;
		target.__EDYTOR_OBSERVER_SHADOW__ = ({ edytor, ...entry }: Any) => {
			views.add(edytor);
			log.push(entry);
		};
	});
};

/** Settle every live view, compare once more, and add the page's log to the report. */
export const collectObserverShadow = async (page: Page, label: string) => {
	if (!REPORT || page.isClosed()) return;
	let entries: ShadowEntry[] | null;
	try {
		entries = await page.evaluate(async () => {
			type Any = any;
			const target = window as Any;
			const views: Set<Any> | undefined = target.__EDYTOR_OBSERVER_SHADOW_VIEWS__;
			if (!views) return null;
			const live = () =>
				[...views].filter((edytor) => !edytor.destroyed && edytor.node?.isConnected);
			const busy = () =>
				live().some(
					(edytor) => edytor.observer?.pending() || edytor.attempts.busy || edytor.composition.live
				);
			for (let waited = 0; waited < 400 && busy(); waited += 20)
				await new Promise((resolve) => setTimeout(resolve, 20));
			for (const edytor of live()) edytor.surface.check();
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
			return target.__EDYTOR_OBSERVER_SHADOW_LOG__.splice(0);
		});
	} catch {
		return;
	}
	if (!entries) return;
	const census = createObserverCensus();
	for (const entry of entries) census.push(entry);
	census.end();
	const summary = census.summary();
	appendFileSync(
		REPORT,
		JSON.stringify({
			file: label,
			...summary,
			unexplained: summary.unexplained.length,
			samples: summary.unexplained.slice(0, 20),
			differences: census.differences.slice(0, 50)
		}) + '\n'
	);
};
