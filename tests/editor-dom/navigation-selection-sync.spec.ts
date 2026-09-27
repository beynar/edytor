import { expect, test, type Page } from './editorTest';

import {
	getPlaceholderLocators,
	expectSelection,
	modKey,
	readNativeSelectionDirection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const readBlockTexts = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
	}>(page, 'value');

	return value.children.map(
		(block) => block.content?.map((part) => part.text ?? `[${part.type}]`).join('') ?? ''
	);
};

test.describe('browser navigation selection sync', () => {
	test('syncs ArrowLeft after typing from a real placeholder click', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('abc');

		await expectSelection(page, {
			startBlockPath: [0],
			startTextPath: [0, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		await page.keyboard.press('ArrowLeft');

		await expectSelection(page, {
			startBlockPath: [0],
			startTextPath: [0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.keyboard.press('ArrowRight');

		await expectSelection(page, {
			startBlockPath: [0],
			startTextPath: [0, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('syncs serialized selection after native ArrowLeft and ArrowRight', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('abc');

		await expectSelection(page, { yStart: 3, yEnd: 3, isCollapsed: true });

		await page.keyboard.press('ArrowLeft');
		await expectSelection(page, { yStart: 2, yEnd: 2, isCollapsed: true });

		await page.keyboard.press('ArrowRight');
		await expectSelection(page, { yStart: 3, yEnd: 3, isCollapsed: true });

		issues.assertClean();
	});

	test('moves and extends horizontally across sibling block boundaries', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('ArrowRight');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 1, 'note'.length);
		await page.keyboard.press('Shift+ArrowRight');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			yStart: 'note'.length,
			yEnd: 0,
			isCollapsed: false,
			isReversed: false
		});

		await setSelectionByTextIndex(page, 2, 0);
		await page.keyboard.press('Shift+ArrowLeft');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			yStart: 'note'.length,
			yEnd: 0,
			isCollapsed: false,
			isReversed: true
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({ isBackward: true, isCollapsed: false });

		issues.assertClean();
	});

	test('extends horizontally from parent text into its nested child', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=navigation');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 'Parent'.length);
		await page.keyboard.press('Shift+ArrowRight');

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1, 0],
			yStart: 'Parent'.length,
			yEnd: 0,
			isCollapsed: false,
			isReversed: false
		});

		issues.assertClean();
	});

	test('deletes a selected block seam without deleting adjacent text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 'note'.length);
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.press('Backspace');

		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'notetail']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'note'.length,
			yEnd: 'note'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses the ArrowLeft-synced caret for immediate forward deletion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('abc');

		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Delete');

		await expect.poll(() => readBlockTexts(page)).toEqual(['ab', 'note', 'tail']);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true });

		issues.assertClean();
	});

	test('uses the ArrowLeft-synced caret for immediate paragraph splitting', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('abc');

		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Enter');

		await expect.poll(() => readBlockTexts(page)).toEqual(['ab', 'c', 'note', 'tail']);
		await expectSelection(page, { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true });

		issues.assertClean();
	});

	test('uses the ArrowLeft-synced caret for middle mention insertion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('abc');

		await page.keyboard.press('ArrowLeft');
		await page.keyboard.type('@');

		await expect.poll(() => readBlockTexts(page)).toEqual(['ab[mention]c', 'note', 'tail']);
		await expectSelection(page, { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true });

		issues.assertClean();
	});

	test('syncs serialized selection after native command-arrow movement', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('abc');
		await setSelectionByTextIndex(page, 0, 2);

		await page.keyboard.press(`${modKey}+ArrowLeft`);
		await expect
			.poll(() => readJsonByTestId<{ yStart: number; yEnd: number }>(page, 'selection'))
			.toMatchObject({
				yStart: 0,
				yEnd: 0
			});

		await page.keyboard.press(`${modKey}+ArrowRight`);
		await expect
			.poll(() => readJsonByTestId<{ yStart: number; yEnd: number }>(page, 'selection'))
			.toMatchObject({
				yStart: 3,
				yEnd: 3
			});

		issues.assertClean();
	});
});
