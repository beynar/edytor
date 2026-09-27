import { expect, type Page } from '@playwright/test';

import { test } from './editorTest';
import { setSelectionByTextIndex, waitForEditorReady } from './helpers';

/**
 * arch-v2 R3 — operations stop calling `flushMirror` (plan §9.3 R3, §8 F-O5
 * end to end): a range delete and a selected-block delete over 1,000
 * paragraphs, from the key to the next rendered frame, in the browser. The
 * compare pass the row also counts is R6's (not in the budget yet).
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

test.describe('R3 — 1,000 paragraphs end to end (F-O5)', () => {
	test('range delete p0@1 → p999@1 renders in < 100 ms', async ({ page }) => {
		await openParagraphs(page, 1000);
		await setSelectionByTextIndex(page, 0, 1, 999, 1);
		const ms = await timeKey(page, 'Backspace');
		await expect.poll(() => shown(page)).toEqual(['paragraph 999']);
		console.log(`[F-O5] range delete ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThan(100);
	});

	test('selected-block delete of 999 blocks renders in < 100 ms', async ({ page }) => {
		await openParagraphs(page, 1000);
		await setSelectionByTextIndex(page, 0, 1);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(...edytor.root.children.slice(1));
		});
		const ms = await timeKey(page, 'Backspace');
		await expect.poll(() => shown(page)).toEqual(['paragraph 0']);
		console.log(`[F-O5] block delete ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThan(100);
	});
});
