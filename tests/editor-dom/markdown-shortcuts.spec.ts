import { expect, test } from './editorTest';

import {
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type SerializedBlock = {
	type: string;
	data?: Record<string, unknown>;
	content?: Array<{ text: string }>;
};

const readFirstBlock = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{ children: SerializedBlock[] }>(page, 'value');
	const block = value.children[0];
	if (!block) {
		throw new Error('Expected a first editor block');
	}
	return {
		type: block.type,
		level: block.data?.level,
		checked: block.data?.checked,
		text: block.content?.map((part) => part.text).join('') ?? ''
	};
};

test.describe('browser markdown shortcuts', () => {
	test('converts block prefixes through real typing', async ({ page }) => {
		const issues = trackPageIssues(page);
		const cases = [
			{
				name: 'heading 2',
				keys: '## Title',
				expected: { checked: undefined, level: 'h2', text: 'Title', type: 'heading' },
				selector: 'h2'
			},
			{
				name: 'bulleted list item',
				keys: '- Item',
				expected: {
					checked: undefined,
					level: undefined,
					text: 'Item',
					type: 'bulleted-list-item'
				},
				selector: '[data-edytor-type="bulleted-list-item"]'
			},
			{
				name: 'numbered list item',
				keys: '1. Item',
				expected: {
					checked: undefined,
					level: undefined,
					text: 'Item',
					type: 'numbered-list-item'
				},
				selector: '[data-edytor-type="numbered-list-item"]'
			},
			{
				name: 'todo item',
				keys: '[] Task',
				expected: { checked: false, level: undefined, text: 'Task', type: 'todo-item' },
				selector: '[data-edytor-type="todo-item"]'
			},
			{
				name: 'quote',
				keys: '> Quote',
				expected: { checked: undefined, level: undefined, text: 'Quote', type: 'quote' },
				selector: '[data-edytor-type="quote"]'
			}
		];

		for (const scenario of cases) {
			await test.step(scenario.name, async () => {
				await page.goto('/test/dom?scenario=basic&empty=first');
				await waitForEditorReady(page);
				await setSelectionByTextIndex(page, 0, 0);
				await page.keyboard.type(scenario.keys);

				await expect.poll(async () => readFirstBlock(page)).toEqual(scenario.expected);
				await expect(page.locator(scenario.selector)).toHaveText(scenario.expected.text);
			});
		}

		issues.assertClean();
	});

	test('renders a shortcut conversion when it is the only document block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await page.evaluate(() => {
			const edytor = (
				window as Window & {
					__EDYTOR__?: { clear: () => void };
				}
			).__EDYTOR__;
			edytor?.clear();
		});
		await page.locator('[data-edytor-text-placeholder]').first().click();
		await page.keyboard.type('## Title');

		await expect
			.poll(async () => readFirstBlock(page))
			.toEqual({
				checked: undefined,
				level: 'h2',
				text: 'Title',
				type: 'heading'
			});
		await expect(page.locator('h2')).toHaveText('Title');

		issues.assertClean();
	});
});
