import { expect, test } from './editorTest';

import {
	dispatchPaste,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type Value = { children: Array<{ content?: Array<{ text: string; marks?: unknown }> }> };

const URL = 'https://edytor.dev/docs';

/**
 * Pasting a URL over selected text links the text (Notion): the rich text
 * plugin's `onPaste` writes the `link` mark instead of replacing the range.
 */
test.describe('pasting a URL over selected text', () => {
	test('links the selected text, which stays selected; undo gives it back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1, 1, 3);
		await dispatchPaste(page, { text: URL, html: `<a href="${URL}">${URL}</a>` });

		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children[1]?.content)
			.toEqual([{ text: 'n' }, { text: 'ot', marks: { link: { href: URL } } }, { text: 'e' }]);
		await expect(page.locator(`[data-edytor] a[href="${URL}"]`)).toHaveText('ot');
		expect(await page.evaluate(() => getSelection()?.toString())).toBe('ot');

		await page.keyboard.press('ControlOrMeta+z');
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children[1]?.content)
			.toEqual([{ text: 'note' }]);
		issues.assertClean();
	});

	test('text that is not one URL replaces the selection as before', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1, 1, 3);
		await dispatchPaste(page, { text: 'see edytor.dev' });
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children[1]?.content)
			.toEqual([{ text: 'nsee edytor.deve' }]);
		issues.assertClean();
	});
});
