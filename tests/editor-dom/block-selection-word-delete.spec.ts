/**
 * DR-rest-1 (rescore-9 follow-up): a word or line delete chord over a block
 * selection deletes the blocks as Backspace does in every engine — the
 * `onDeleteSelectedBlocks` hook runs first (a plugin may keep them), and a
 * selected parent alone goes with its children promoted. Chromium sends a
 * `beforeinput` over the range; Firefox and WebKit send none, so the chord is
 * claimed at its keydown. Expected values are hand-written.
 */
import { expect, test, type Page } from './editorTest';
import { b, model, open } from './p1-helpers';

const shape = async (page: Page) =>
	(await model(page)).map((row) => `${'  '.repeat(row.depth)}${row.id}:${row.text}`);

const caretIn = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first().click();

const marked = (page: Page) =>
	page
		.locator('[data-edytor-selected="true"]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-edytor-id')));

const CHORDS = ['Alt+Backspace', 'ControlOrMeta+Backspace', 'Alt+Delete'];

test.describe('word and line deletes over a block selection', () => {
	for (const chord of CHORDS) {
		test(`${chord} over two selected blocks runs onDeleteSelectedBlocks, which keeps them`, async ({
			page
		}) => {
			await open(page, [b('A', 'alpha beta'), b('B', 'gamma'), b('C', 'after')]);
			await page.evaluate(() => {
				const w = window as Window & { __EDYTOR__?: any; __KEPT__?: number };
				w.__KEPT__ = 0;
				w.__EDYTOR__.plugins.push({
					onDeleteSelectedBlocks: ({ prevent }: { prevent: () => void }) => {
						w.__KEPT__!++;
						prevent();
					}
				});
			});
			await caretIn(page, 'B');
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.press('Shift+ArrowUp');
			await expect.poll(() => marked(page)).toEqual(['A', 'B']);
			await page.keyboard.press(chord);
			await expect.poll(() => page.evaluate(() => (window as any).__KEPT__)).toBe(1);
			expect(await page.evaluate(() => (window as any).__EDYTOR__.dispatcher.last?.status)).toBe(
				'refused'
			);
			expect(await shape(page)).toEqual(['A:alpha beta', 'B:gamma', 'C:after']);
		});

		test(`${chord} over a selected parent alone promotes its child`, async ({ page }) => {
			await open(page, [b('P', 'parent', { children: [b('K', 'kid')] }), b('Z', 'after')]);
			await caretIn(page, 'P');
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.press('ControlOrMeta+a');
			await expect.poll(() => marked(page)).toEqual(['P']);
			await page.keyboard.press(chord);
			await expect.poll(() => shape(page)).toEqual(['K:kid', 'Z:after']);
		});
	}
});
