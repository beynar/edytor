import { expect, type Page } from '@playwright/test';

import { test } from './editorTest';
import { setSelectionByTextIndex, waitForEditorReady } from './helpers';

/**
 * arch-v2 R3 — operations stop calling `flushMirror` (plan §9.3 R3, §8 F-O5
 * end to end): a range delete and a selected-block delete over 1,000
 * paragraphs, from the key to the next rendered frame, in the browser.
 *
 * CC-05: the rows assert operation counts (one change report; the index's
 * folds and recomputes the same at 1,000 paragraphs as at 100, its fold input
 * at most eleven times), never the wall clock, which a shared runner cannot
 * hold. The key-to-frame time (the former < 100 ms bound) is measured and
 * reported as the test's `F-O5 ms` annotation; the document half's timings
 * are `bench:crdt`'s `scale` workload.
 */

/** Open the editor on `paragraph 0` … `paragraph n-1` (inserted as one document write). */
const openParagraphs = async (page: Page, n: number) => {
	await page.goto('/test/dom?scenario=basic');
	await waitForEditorReady(page, { requireRuntime: true });
	await page.evaluate((n) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const old = edytor.facade.childrenIds(null);
		const specs = Array.from({ length: n }, (_, i) => ({
			id: `p${i}`,
			type: 'paragraph',
			content: [{ kind: 'text', text: `paragraph ${i}` }]
		}));
		edytor.facade.transact(() => {
			edytor.facade.insertBlocks({ parent: null, index: 0 }, specs);
			for (const id of old) edytor.facade.deleteBlock(id);
		});
	}, n);
	await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(n);
};

/** Milliseconds from the key's keydown to the frame after its render. */
const timeKey = async (page: Page, key: string) => {
	await page.evaluate(() => {
		const w = window as Window & { __R3__?: Promise<number> };
		w.__R3__ = new Promise<number>((resolve) => {
			const onKey = () => {
				document.removeEventListener('keydown', onKey, true);
				const t0 = performance.now();
				requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
			};
			document.addEventListener('keydown', onKey, true);
		});
	});
	await page.keyboard.press(key);
	return page.evaluate(() => (window as Window & { __R3__?: Promise<number> }).__R3__!);
};

const shown = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		return edytor.root.children.map((block: any) => block.firstText?.stringContent ?? '');
	});

type Work = { reports: number; folds: number; pairs: number; structs: number; recomputes: number };

/** From now on, count the change reports and the index's work (`runsView.debug`). */
const meter = (page: Page) =>
	page.evaluate(() => {
		const w = window as Window & { __EDYTOR__?: any; __R3_REPORTS__?: number };
		w.__EDYTOR__.facade.runsView.debug.reset();
		w.__R3_REPORTS__ = 0;
		w.__EDYTOR__.facade.onChange(() => (w.__R3_REPORTS__! += 1));
	});

const counted = (page: Page): Promise<Work> =>
	page.evaluate(() => {
		const w = window as Window & { __EDYTOR__?: any; __R3_REPORTS__?: number };
		const debug = w.__EDYTOR__.facade.runsView.debug;
		return {
			reports: w.__R3_REPORTS__!,
			folds: debug.folds,
			pairs: debug.foldedPairs,
			structs: debug.foldedStructs,
			recomputes: debug.recomputes
		};
	});

/**
 * Ten times the blocks: the same number of folds and recomputes (only the
 * block the command keeps renders again), at most eleven times the folds'
 * input (quadratic work would be a hundred times).
 */
const linear = (small: Work, large: Work) => {
	expect(small.pairs).toBeGreaterThan(0);
	expect(large.folds, 'folds').toBeLessThanOrEqual(small.folds);
	expect(large.recomputes, 'recomputes').toBeLessThanOrEqual(small.recomputes);
	expect(large.pairs, 'folded pairs').toBeLessThanOrEqual(11 * small.pairs);
	expect(large.structs, 'folded structs').toBeLessThanOrEqual(11 * small.structs);
};

const reportTime = (what: string, ms: number) => {
	console.log(`[F-O5] ${what} ${ms.toFixed(1)} ms`);
	test.info().annotations.push({ type: 'F-O5 ms', description: `${what}: ${ms.toFixed(1)}` });
};

test.describe('R3 — 1,000 paragraphs end to end (F-O5)', () => {
	const rangeDelete = async (page: Page, n: number) => {
		await openParagraphs(page, n);
		await setSelectionByTextIndex(page, 0, 1, n - 1, 1);
		await meter(page);
		const ms = await timeKey(page, 'Backspace');
		await expect.poll(() => shown(page)).toEqual([`paragraph ${n - 1}`]);
		return { ms, work: await counted(page) };
	};

	test('range delete p0@1 → p999@1: one report, work linear in the blocks removed', async ({
		page
	}) => {
		const small = await rangeDelete(page, 100);
		const large = await rangeDelete(page, 1000);
		reportTime('range delete', large.ms);
		expect(large.work.reports).toBe(1);
		linear(small.work, large.work);
	});

	const blockDelete = async (page: Page, n: number) => {
		await openParagraphs(page, n);
		await setSelectionByTextIndex(page, 0, 1);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(...edytor.root.children.slice(1));
		});
		await meter(page);
		const ms = await timeKey(page, 'Backspace');
		await expect.poll(() => shown(page)).toEqual(['paragraph 0']);
		return { ms, work: await counted(page) };
	};

	test('selected-block delete of 999 blocks: one report, work linear in the blocks removed', async ({
		page
	}) => {
		const small = await blockDelete(page, 100);
		const large = await blockDelete(page, 1000);
		reportTime('block delete', large.ms);
		expect(large.work.reports).toBe(1);
		linear(small.work, large.work);
	});
});
