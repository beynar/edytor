import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type TestDoc = {
	children: Array<{
		content?: Array<{ text?: string; marks?: Record<string, unknown> } | { type: string }>;
	}>;
};

const getBlockText = async (page: Page, index: number) => {
	const value = await readJsonByTestId<TestDoc>(page, 'value');
	return (
		value.children[index]?.content?.map((part) => ('text' in part ? part.text : '')).join('') ?? ''
	);
};

test.describe('advanced delete beforeinput behavior', () => {
	const rangeDeleteCases = [
		{
			inputType: 'deleteWordBackward',
			targetRange: { startIndex: 0, startOffset: 6, endOffset: 11 },
			expectedText: 'First ',
			expectedOffset: 6
		},
		{
			inputType: 'deleteWordForward',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 5 },
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteSoftLineBackward',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 5 },
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteSoftLineForward',
			targetRange: { startIndex: 0, startOffset: 6, endOffset: 11 },
			expectedText: 'First ',
			expectedOffset: 6
		},
		{
			inputType: 'deleteHardLineBackward',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 5 },
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteHardLineForward',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 11 },
			expectedText: '',
			expectedOffset: 0
		}
	];

	for (const { inputType, targetRange, expectedText, expectedOffset } of rangeDeleteCases) {
		test(`routes ${inputType} through model deletion using beforeinput target ranges`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 2, 0);

			const prevented = await dispatchBeforeInput(page, {
				inputType,
				targetRange
			});

			expect(prevented).toBe(true);
			await expect.poll(() => getBlockText(page, 0)).toBe(expectedText);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: expectedOffset,
				yEnd: expectedOffset,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	for (const inputType of ['deleteByCut', 'deleteByDrag', 'deleteByComposition']) {
		test(`routes ${inputType} through model deletion using beforeinput target ranges`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 0, 0, 5);

			const prevented = await dispatchBeforeInput(page, {
				inputType,
				targetRange: {
					startIndex: 0,
					startOffset: 0,
					endOffset: 5
				}
			});

			expect(prevented).toBe(true);
			await expect.poll(() => getBlockText(page, 0)).toBe(' block');
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 0,
				yEnd: 0,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	test('routes deleteContent through model deletion using beforeinput target ranges', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContent',
			targetRange: {
				startIndex: 0,
				startOffset: 0,
				endOffset: 5
			}
		});

		expect(prevented).toBe(true);
		await expect.poll(() => getBlockText(page, 0)).toBe(' block');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes deleteEntireSoftLine through model deletion using beforeinput target ranges', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteEntireSoftLine',
			targetRange: {
				startIndex: 0,
				startOffset: 0,
				endOffset: 11
			}
		});

		expect(prevented).toBe(true);
		await expect.poll(() => getBlockText(page, 0)).toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('falls back to model word deletion when target ranges are unavailable', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 11);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteWordBackward'
		});

		expect(prevented).toBe(true);
		await expect.poll(() => getBlockText(page, 0)).toBe('First ');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes an emoji as one user-perceived character with real Backspace', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=unicode');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'A 🚀'.length);
		await page.keyboard.press('Backspace');

		await expect.poll(() => getBlockText(page, 0)).toBe('A  é Z');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'A '.length,
			yEnd: 'A '.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes a combining-accent character as one grapheme with real Delete', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=unicode');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'A 🚀 '.length);
		await page.keyboard.press('Delete');

		await expect.poll(() => getBlockText(page, 0)).toBe('A 🚀  Z');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'A 🚀 '.length,
			yEnd: 'A 🚀 '.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps target-range-free Backspace grapheme-safe', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=unicode');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'A 🚀'.length);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward'
		});

		expect(prevented).toBe(true);
		await expect.poll(() => getBlockText(page, 0)).toBe('A  é Z');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'A '.length,
			yEnd: 'A '.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps target-range-free Delete grapheme-safe', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=unicode');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'A 🚀 '.length);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward'
		});

		expect(prevented).toBe(true);
		await expect.poll(() => getBlockText(page, 0)).toBe('A 🚀  Z');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'A 🚀 '.length,
			yEnd: 'A 🚀 '.length,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
