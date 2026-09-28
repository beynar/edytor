import { expect } from '@playwright/test';

import { test } from './editorTest';
import {
	getTextLocators,
	gotoEditorRoute,
	readJsonByTestId,
	readSelection,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

const textIndexOf = async (page: Parameters<typeof getTextLocators>[0], text: string) => {
	const index = await getTextLocators(page).evaluateAll(
		(elements, needle) =>
			elements.findIndex((element) => element.textContent?.replaceAll('​', '') === needle),
		text
	);
	if (index === -1) {
		throw new Error(`Missing rendered text "${text}"`);
	}
	return index;
};

const readBlockTexts = async (page: Parameters<typeof getTextLocators>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{
			type: string;
			content?: Array<{ text?: string }>;
			children?: Array<{ type: string; content?: Array<{ text?: string }> }>;
		}>;
	}>(page, 'value');
	return value;
};

test.describe('structural key behavior', () => {
	test('Enter splits a code line instead of inserting a soft break', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=code', { requireRuntime: true });
		const index = await textIndexOf(page, 'const a = 1;');
		await setSelectionByTextIndex(page, index, 5);

		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readBlockTexts(page);
				return value.children[0]?.children?.map(
					(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
				);
			})
			.toEqual(['const', ' a = 1;', 'return a;']);

		issues.assertClean();
	});

	test('Enter splits a list item at the caret', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=lists', { requireRuntime: true });
		const index = await textIndexOf(page, 'First');
		await setSelectionByTextIndex(page, index, 3);

		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ children?: Array<{ content?: Array<{ text?: string }> }> }>;
				}>(page, 'value');
				return value.children[0]?.children?.map(
					(item) => item.content?.map((part) => part.text ?? '').join('') ?? ''
				);
			})
			.toEqual(['Fir', 'st', 'Second']);

		issues.assertClean();
	});

	test('Enter at the start of a nested child splits before it', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=nested', { requireRuntime: true });
		const index = await textIndexOf(page, 'Nested child');
		await setSelectionByTextIndex(page, index, 0);

		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text?: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.map(
					(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
				);
			})
			.toEqual(['', 'Nested child', 'Nested tail']);

		issues.assertClean();
	});

	test('mod+a escalates block content, block selection, then all blocks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=nestedInline', { requireRuntime: true });
		const index = await textIndexOf(page, 'One');
		await setSelectionByTextIndex(page, index, 1);

		// Stage 1: range over the current block's content.
		await page.keyboard.press(`${modKey}+A`);
		await expect
			.poll(async () => {
				const selection = await readSelection(page);
				return {
					startBlockPath: selection.startBlockPath,
					isCollapsed: selection.isCollapsed,
					yStart: selection.yStart,
					yEnd: selection.yEnd,
					selected: selection.selectedBlockPaths
				};
			})
			.toEqual({
				startBlockPath: [0, 0],
				isCollapsed: false,
				yStart: 0,
				yEnd: 3,
				selected: []
			});

		// Stage 2: in-house block selection of the current block.
		await page.keyboard.press(`${modKey}+A`);
		await expect.poll(async () => (await readSelection(page)).selectedBlockPaths).toEqual([[0, 0]]);

		// Stage 3: every block, nested ones included (a block selection is exactly its members).
		await page.keyboard.press(`${modKey}+A`);
		await expect
			.poll(async () =>
				(await readSelection(page)).selectedBlockPaths.map((path) => path.join('.')).sort()
			)
			.toEqual(['0', '0.0', '1']);

		issues.assertClean();
	});
});
