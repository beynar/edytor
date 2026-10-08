import { expect, test, type Page } from './editorTest';

import {
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

type Value = {
	children: Array<{
		type: string;
		data?: Record<string, unknown>;
		content?: Array<{ text?: string; type?: string; data?: Record<string, unknown> }>;
	}>;
};
const value = (page: Page) => readJsonByTestId<Value>(page, 'value');

/**
 * WU-23 — equations drawn by KaTeX, loaded lazily (Notion): a click on one
 * opens its TeX source under it, each keystroke redraws it, Enter closes
 * it; `$$…$$` typed in text is an inline equation. The model rows are
 * `equation-20261008.test.tsx`.
 */
test.describe('equations', () => {
	test('KaTeX draws them; a click edits the source live; Enter closes', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=equation&equation=1');
		await expect.poll(async () => (await value(page)).children[1]?.type).toBe('equation');
		const block = page.locator('[data-edytor-equation]');
		await expect(block.locator('.katex-display')).toBeVisible();
		await expect(page.locator('[data-edytor-inline-equation] .katex')).toBeVisible();

		await block.click();
		const field = page.locator('[data-edytor-equation-editor] textarea');
		await expect(field).toBeFocused();
		await expect(field).toHaveValue('a+b');
		await page.keyboard.type('+c');
		await expect(block.locator('annotation')).toHaveText('a+b+c');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor-equation-editor]')).toHaveCount(0);
		await expect
			.poll(async () => (await value(page)).children[1]?.data)
			.toEqual({ expression: 'a+b+c' });
		issues.assertClean();
	});

	test('an inline equation opens on a click; $$…$$ typed in text makes one', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=equation&equation=1');
		await page.locator('[data-edytor-inline-equation]').click();
		const field = page.locator('[data-edytor-equation-editor] textarea');
		await expect(field).toHaveValue('x^2');
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-edytor-equation-editor]')).toHaveCount(0);

		// "tail": the last text.
		await setSelectionByTextIndex(page, 2, 4);
		await page.keyboard.type(' $$y_1$$');
		await expect
			.poll(async () => (await value(page)).children[2]?.content)
			.toEqual([
				{ text: 'tail ' },
				expect.objectContaining({ type: 'inlineEquation', data: { expression: 'y_1' } })
			]);
		await expect(page.locator('[data-edytor-inline-equation] .katex')).toHaveCount(2);
		issues.assertClean();
	});
});
