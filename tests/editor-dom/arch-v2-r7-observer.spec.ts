import type { Page } from '@playwright/test';

import { expect, test } from './editorTest';
import {
	getTextLocators,
	gotoEditorRoute,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';
import { truthOf } from '../../src/tests/oracles/truth';

/**
 * arch-v2 R7 — the observer compares with truth (plan §9.3 R7, R12; answer
 * (e) to R6's questions). R6's shadow found a code line that vanished from
 * the DOM after Enter in a code block on a hydrated `/test/dom` page (class 7,
 * `missing-element-left-by-today`): the model kept the line, nothing restored
 * its element. R7 re-inserts a missing registered element from its record.
 * The truth invariant (`src/tests/oracles/truth.ts`) is read in the page.
 */

const truth = (page: Page) =>
	page.evaluate(`(${truthOf.toString()})((window).__EDYTOR__)`) as Promise<string[]>;

const settle = (page: Page) =>
	page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
	);

const open = (page: Page, scenario: string) =>
	gotoEditorRoute(page, `/test/dom?scenario=${scenario}&cells=shadow`, { requireRuntime: true });

const caretAtEnd = async (page: Page, index: number) => {
	const length = await getTextLocators(page)
		.nth(index)
		.evaluate((el) => (el.textContent ?? '').replaceAll('\u200B', '').length);
	await setSelectionByTextIndex(page, index, length);
};

test.describe('R7 — the host is the projection of its cells', () => {
	// Red on the reference (`arch-v2/ref-r7`): the line's element was gone, nothing restored it.
	test('(e) Enter in a code block after earlier scenarios keeps every code line', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, 'marks');
		await setSelectionByTextIndex(page, 0, 3);
		await page.keyboard.type('xy');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');

		await open(page, 'inline');
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.type('ab');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Enter');

		await open(page, 'lists');
		await caretAtEnd(page, 0);
		await page.keyboard.press('Enter');
		await page.keyboard.type('Inserted');
		await page.keyboard.press('Tab');

		await open(page, 'code');
		await setSelectionByTextIndex(page, 0, 5);
		await page.keyboard.press('Enter');
		await page.keyboard.type('let x = 2;');
		await settle(page);

		await expect.poll(() => truth(page)).toEqual([]);
		const lines = await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const code = edytor.root.children[0];
			return {
				model: code.children.map((line: { id: string }) => edytor.facade.blockText(line.id)),
				dom: code.children.map(
					(line: { node?: HTMLElement }) =>
						line.node?.isConnected &&
						(line.node.querySelector('[data-edytor-text]')?.textContent ?? '').replaceAll(
							'\u200B',
							''
						)
				)
			};
		});
		expect(lines.dom).toEqual(lines.model);
		issues.assertClean();
	});

	test('a code line a foreign script removes is re-inserted', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'code');
		const before = await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const line = edytor.root.children[0].children[0].node as HTMLElement;
			(window as Window & { __R7_LINE__?: HTMLElement }).__R7_LINE__ = line;
			line.remove();
			return edytor.value;
		});
		await settle(page);
		await expect.poll(() => truth(page)).toEqual([]);
		expect(
			await page.evaluate(
				() => (window as Window & { __R7_LINE__?: HTMLElement }).__R7_LINE__?.isConnected
			)
		).toBe(true);
		expect(
			await page.evaluate(() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__.value)
		).toEqual(before);
		issues.assertClean();
	});
});
