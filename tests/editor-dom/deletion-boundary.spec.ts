import { expect, test, type Page } from './editorTest';

import {
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type TestBlock = {
	content?: Array<{ data?: object; text?: string; type?: string }>;
	children?: TestBlock[];
};

const stripIds = <T>(value: T): T => {
	if (Array.isArray(value)) {
		return value.map(stripIds) as T;
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== 'id')
				.map(([key, nestedValue]) => [key, stripIds(nestedValue)])
		) as T;
	}

	return value;
};

const readBlocks = async (page: Page) => {
	const value = await readJsonByTestId<{ children: TestBlock[] }>(page, 'value');
	return stripIds(value.children);
};

const readBlockTexts = async (page: Page) => {
	const blocks = await readBlocks(page);
	return blocks.map(
		(block) => block.content?.map((part) => part.text ?? `[${part.type}]`).join('') ?? ''
	);
};

test.describe('Phase 6 deletion boundary contract', () => {
	test('DEL-03 guards Backspace at the start of an empty first document block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Backspace');

		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('DEL-05 removes the previous inline mention from a trailing text start', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');

		await expect
			.poll(() => readBlocks(page))
			.toMatchObject([
				{
					type: 'paragraph',
					content: [{ text: 'tail' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' end' }]
				}
			]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('DEL-11 merges a nested first child into its parent from text start', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');

		await expect
			.poll(() => readBlocks(page))
			.toMatchObject([
				{
					type: 'paragraph',
					content: [{ text: 'HelloNested child' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested tail' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'After' }]
				}
			]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 'Hello'.length,
			yEnd: 'Hello'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
