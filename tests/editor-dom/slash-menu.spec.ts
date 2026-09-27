import { expect, test } from './editorTest';

import {
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

test.describe('browser slash menu', () => {
	test('filters and runs a command from real typing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('/h2');

		const item = page.getByTestId('slash-menu-item');
		await expect(item).toHaveCount(1);
		await expect(item).toHaveText('Heading 2');
		await expect(page.getByTestId('slash-menu-query')).toHaveText('/h2');

		await page.keyboard.press('Enter');

		await expect(page.getByTestId('slash-menu')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await page.keyboard.type('Title');
		await expect(page.locator('h2')).toHaveText('Title');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; data?: Record<string, unknown>; content?: unknown[] }>;
				}>(page, 'value');
				const firstBlock = value.children[0];
				return {
					type: firstBlock?.type,
					level: firstBlock?.data?.level,
					text: firstBlock?.content
						?.map((part) => ('text' in Object(part) ? String((part as { text: string }).text) : ''))
						.join('')
				};
			})
			.toEqual({
				type: 'heading',
				level: 'h2',
				text: 'Title'
			});
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('opens from a real placeholder click before command execution', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'Write something here ...' }).click();
		await page.keyboard.type('/h2');

		await expect(page.getByTestId('slash-menu-item')).toHaveText('Heading 2');
		await expect(page.getByTestId('slash-menu-query')).toHaveText('/h2');

		await page.keyboard.press('Enter');
		await page.keyboard.type('Title');

		await expect(page.locator('h2')).toHaveText('Title');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; data?: Record<string, unknown>; content?: unknown[] }>;
				}>(page, 'value');
				const firstBlock = value.children[0];
				return {
					type: firstBlock?.type,
					level: firstBlock?.data?.level,
					text: firstBlock?.content
						?.map((part) => ('text' in Object(part) ? String((part as { text: string }).text) : ''))
						.join('')
				};
			})
			.toEqual({
				type: 'heading',
				level: 'h2',
				text: 'Title'
			});

		issues.assertClean();
	});
	// S6: the code kind's record is a slash command wherever the code
	// extension is loaded — the test route, not only the demo.
	test('lists and runs the code kind from its record', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('/code');

		const item = page.getByTestId('slash-menu-item');
		await expect(item).toHaveCount(1);
		await expect(item).toHaveText('Code');
		await expect(item).toHaveAttribute('data-icon', '</>');
		await page.keyboard.press('Enter');
		await page.keyboard.type('hello');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				const first = value.children[0];
				return { type: first?.type, line: first?.children?.[0]?.content?.[0]?.text };
			})
			.toEqual({ type: 'code', line: 'hello' });

		issues.assertClean();
	});
});
