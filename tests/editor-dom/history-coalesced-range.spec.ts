import { expect, test } from './editorTest';

import {
	expectSelection,
	modKey,
	readJsonByTestId,
	readNativeSelectionDirection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

test.describe('coalesced history range restoration', () => {
	test('restores a marked range after undoing a delete and replacement captured together', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const document = encodeURIComponent(
			JSON.stringify({
				children: [{ type: 'paragraph', content: [{ text: '' }] }]
			})
		);

		await page.goto(`/test/dom?dst=${document}`);
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press(`${modKey}+E`);
		await page.keyboard.type('.');
		await setSelectionByTextIndex(page, 0, 0, 0, 1);
		await page.keyboard.press('Delete');
		await page.keyboard.type('!');
		await page.keyboard.press(`${modKey}+Z`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.map(({ text, marks }) => ({ text, marks }));
			})
			.toEqual([{ text: '.', marks: { code: true } }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 1,
			isCollapsed: false,
			isReversed: false
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				anchorOffset: 0,
				focusOffset: 1,
				isBackward: false,
				isCollapsed: false,
				text: '.'
			});

		issues.assertClean();
	});
});
