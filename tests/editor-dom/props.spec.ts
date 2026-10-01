/**
 * Properties (0.1.0-next.6) in real browsers: an input bound to a block's
 * `data` inside the editor keeps focus and receives every keystroke while
 * each one is a `patchData` command re-rendering the block; the editor's
 * caret is never written back over it.
 */
import { expect, test } from './editorTest';
import { skipUnlessBrowser } from './browserExpectations';
import { modKey, readJsonByTestId, setSelectionByTextIndex, waitForEditorReady } from './helpers';

type Value = { children: Array<{ type: string; data?: Record<string, unknown> }> };
const card = async (page: import('@playwright/test').Page) =>
	(await readJsonByTestId<Value>(page, 'value')).children.find((b) => b.type === 'card')?.data;

test.describe('bound inputs edit block properties', () => {
	test('typing into a bound field keeps its focus and writes each keystroke', async ({ page }) => {
		await page.goto('/test/dom?scenario=props');
		await waitForEditorReady(page, { requireRuntime: true });
		// The editor holds a caret first, as it does when the user clicks out of the text.
		await setSelectionByTextIndex(page, 0, 2);
		const title = page.locator('[data-card-title]');
		await title.click();
		await page.keyboard.type('Plan', { delay: 20 });
		await expect(title).toHaveValue('Plan');
		await expect(title).toBeFocused();
		await expect.poll(() => card(page)).toMatchObject({ title: 'Plan' });
		await page.locator('[data-card-done]').click();
		await expect.poll(() => card(page)).toMatchObject({ title: 'Plan', done: true });
		// The editor's text is untouched.
		expect(await page.locator('[data-edytor-text]').first().textContent()).toBe('note');
	});

	test('paste, copy and cut in a bound field are the field’s (DR-props-2)', async ({
		page,
		context,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-stable-native-clipboard-permissions',
			because: 'Playwright clipboard-read/write permissions are stable only in Chromium here'
		});
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/test/dom?scenario=props');
		await waitForEditorReady(page, { requireRuntime: true });
		// An editor range over "no" of "note", then focus in the field.
		await setSelectionByTextIndex(page, 0, 0, 0, 2);
		const title = page.locator('[data-card-title]');
		await title.click();
		await page.evaluate(() => navigator.clipboard.writeText('Pasted'));
		await page.keyboard.press(`${modKey}+V`);
		await expect(title).toHaveValue('Pasted');
		await expect.poll(() => card(page)).toMatchObject({ title: 'Pasted' });
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+X`);
		await expect(title).toHaveValue('');
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Pasted');
		expect(await page.locator('[data-edytor-text]').first().textContent()).toBe('note');
	});

	test('a date field keeps its keys over a block selection (DR-props-2)', async ({
		page,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-date-field-segment-keys',
			because:
				'typing a date segment by segment is engine- and locale-specific; Chromium en-US here'
		});
		await page.goto('/test/dom?scenario=props');
		await waitForEditorReady(page, { requireRuntime: true });
		const due = page.locator('[data-card-due]');
		await due.focus();
		// The paragraph is selected as a block while the date field holds focus.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(edytor.root.children[0]);
		});
		// Day and month alike, so the segment order of the locale does not matter.
		await page.keyboard.type('01012026', { delay: 20 });
		await page.keyboard.press('Backspace');
		await page.keyboard.type('2027', { delay: 20 });
		await expect(due).toHaveValue('2027-01-01');
		await expect(due).toBeFocused();
		await expect.poll(() => card(page)).toMatchObject({ due: '2027-01-01' });
		// Backspace in the field never deleted the selected paragraph.
		const value = await readJsonByTestId<Value>(page, 'value');
		expect(value.children.map((b) => b.type)).toEqual(['paragraph', 'card']);
		expect(await page.locator('[data-edytor-text]').first().textContent()).toBe('note');
	});
});
