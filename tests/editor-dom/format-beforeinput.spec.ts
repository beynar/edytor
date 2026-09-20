import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type FormatCase = {
	inputType: string;
	mark: string;
};

const nativeFormatCases: FormatCase[] = [
	{ inputType: 'formatItalic', mark: 'italic' },
	{ inputType: 'formatUnderline', mark: 'underline' },
	{ inputType: 'formatStrikeThrough', mark: 'strike' },
	{ inputType: 'formatSuperscript', mark: 'superscript' },
	{ inputType: 'formatSubscript', mark: 'subscript' }
];

test.describe('native format beforeinput behavior', () => {
	for (const { inputType, mark } of nativeFormatCases) {
		test(`routes native format inputTypes through model marks: ${inputType}`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=basic&empty=last');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 0, 1, 4);

			const prevented = await dispatchBeforeInput(page, { inputType });

			expect(prevented).toBe(true);
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ marks?: Record<string, unknown> }> }>;
					}>(page, 'value');
					return [value.children[0]?.content?.[0]?.marks, value.children[1]?.content?.[0]?.marks];
				})
				.toEqual([{ [mark]: true }, { [mark]: true }]);

			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [1],
				yStart: 0,
				yEnd: 4,
				isCollapsed: false
			});

			issues.assertClean();
		});
	}

	test('routes native format inputTypes to pending marks at a collapsed caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const formatPrevented = await dispatchBeforeInput(page, {
			inputType: 'formatUnderline'
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(formatPrevented).toBe(true);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'le' }, { text: 'x', marks: { underline: true } }, { text: 'ad' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('clears pending marks for future text when native formatRemove fires at a collapsed caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const formatPrevented = await dispatchBeforeInput(page, {
			inputType: 'formatUnderline'
		});
		const removePrevented = await dispatchBeforeInput(page, {
			inputType: 'formatRemove'
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(formatPrevented).toBe(true);
		expect(removePrevented).toBe(true);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'lexad' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses formatRemove target ranges across mixed marks and inline atoms', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'formatRemove',
			targetRange: {
				startIndex: 1,
				startOffset: 0,
				endIndex: 3,
				endOffset: 3
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ marks?: Record<string, unknown>; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return {
					markedBlock: value.children[1]?.content,
					inlineBlock: value.children[2]?.content
				};
			})
			.toEqual({
				markedBlock: [{ text: 'Marked middle' }],
				inlineBlock: [
					{ text: 'lead ' },
					expect.objectContaining({ type: 'mention' }),
					{ text: ' tail' }
				]
			});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const editor = document.querySelector('[data-edytor]');
					const inlineAtoms = Array.from(
						editor?.querySelectorAll<HTMLElement>('[data-edytor-inline-block]') ?? []
					).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
					return {
						boldCount: editor?.querySelectorAll('[data-edytor-mark="bold"]').length ?? 0,
						italicCount: editor?.querySelectorAll('[data-edytor-mark="italic"]').length ?? 0,
						mentionCount: inlineAtoms.length
					};
				})
			)
			.toEqual({
				boldCount: 0,
				italicCount: 0,
				mentionCount: 1
			});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			startTextPath: [1, 0],
			endTextPath: [2, 2],
			yStart: 0,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('does not leave stale DOM clones when native format removes an existing mark', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'formatBold'
		});
		expect(prevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alpha beta' }]);
		await expect
			.poll(() => page.locator('[data-edytor-type="paragraph"]').first().locator('p').textContent())
			.toBe('Alpha beta');

		issues.assertClean();
	});
});
