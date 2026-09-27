import { expect, type Page } from '@playwright/test';

import { test } from './editorTest';
import {
	getTextLocators,
	gotoEditorRoute,
	readSelection,
	setSelectionByTextIndex,
	waitForEditorReady
} from './helpers';

/**
 * arch-v2 R2 — components render from cells (plan §9.3 R2): no DOM remount
 * under the caret while typing, and one Tab re-parents one subtree without
 * remounting the editor root (F-P9, reader `tab-remount`).
 */

const settle = (page: Page) =>
	page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
	);

/** Tag the text element at `index`, its caret text node and the editor root, to compare after. */
const tag = (page: Page, index: number) =>
	getTextLocators(page)
		.nth(index)
		.evaluate((element) => {
			const selection = document.getSelection();
			const w = window as Window & { __R2__?: Record<string, Node | null> };
			w.__R2__ = {
				element,
				node: selection?.anchorNode ?? null,
				root: document.querySelector('[data-edytor]')
			};
		});

const kept = (page: Page, index: number) =>
	getTextLocators(page)
		.nth(index)
		.evaluate((element) => {
			const w = window as Window & { __R2__?: Record<string, Node | null> };
			const tagged = w.__R2__!;
			const selection = document.getSelection();
			return {
				element: tagged.element === element && element.isConnected,
				node: tagged.node === selection?.anchorNode && Boolean(tagged.node?.isConnected),
				root: tagged.root === document.querySelector('[data-edytor]')
			};
		});

test.describe('R2 components render from cells', () => {
	test('typing keeps the text element and the text node under the caret', async ({ page }) => {
		await gotoEditorRoute(page, '/test/dom?scenario=basic', { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 2);
		await settle(page);
		await tag(page, 1);
		await page.keyboard.type('book');
		await settle(page);
		expect(await kept(page, 1)).toEqual({ element: true, node: true, root: true });
	});

	// Red on the reference (`arch-v2/ref-r2`): three whole-editor remounts.
	test('Tab nests one block without remounting the editor root (F-P9)', async ({ page }) => {
		await gotoEditorRoute(page, '/test/dom?scenario=basic', { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 1);
		await settle(page);
		await tag(page, 0);
		await page.keyboard.press('Tab');
		await settle(page);
		const after = await kept(page, 0);
		expect([after.element, after.root]).toEqual([true, true]);
		await page.keyboard.type('x');
		await settle(page);
		const typed = await getTextLocators(page)
			.nth(1)
			.evaluate((el) => (el.textContent ?? '').replaceAll('​', ''));
		expect(typed.at(1)).toBe('x');
	});

	// Merge M11 (R2 × V5): the re-parented block's old element leaves the DOM
	// caret on its parent's element boundary; only a point inside the text's
	// own element shows the value, so the display writes the caret into the new
	// element and the boundary's selectionchange is an echo, not a foreign move.
	test('Shift+Tab on an empty nested block keeps the caret in it (DST seed 2)', async ({
		page
	}) => {
		const dst = {
			children: [
				{
					type: 'paragraph',
					id: 'a',
					content: [{ text: '' }],
					children: [{ type: 'paragraph', id: 'b', content: [{ text: '' }] }]
				}
			]
		};
		const query = new URLSearchParams({ scenario: 'dst', dst: JSON.stringify(dst) });
		await page.goto(`/test/dom?${query}`);
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Shift+Tab');
		await settle(page);
		await expect.poll(async () => (await readSelection(page))?.startTextPath).toEqual([1, 0]);
	});
});
