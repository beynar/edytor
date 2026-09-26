import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

const readBlockTexts = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string }> }>;
	}>(page, 'value');
	return value.children.map((child) => child.content?.map((part) => part.text).join('') ?? '');
};

const focusForeignInput = async (page: Page) => {
	await page.evaluate(() => {
		document.querySelector('[data-testid="foreign-undo-input"]')?.remove();
		const input = document.createElement('input');
		input.dataset.testid = 'foreign-undo-input';
		// Fixed to a corner: appended at body end it sits below the live
		// debug dumps, which re-render on every model/selection change and
		// shift layout mid-click — Playwright can then land the trusted
		// click on the editor instead of the input (focus never transfers).
		input.style.position = 'fixed';
		input.style.top = '0';
		input.style.right = '0';
		input.style.zIndex = '9999';
		document.body.append(input);
	});
	// A trusted click moves focus in every engine — a bare `input.focus()`
	// inside evaluate is ignored by headless Firefox when the window is not
	// considered focused.
	await page.getByTestId('foreign-undo-input').click();
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.tagName ?? null))
		.toBe('INPUT');
};

test.describe('history beforeinput scope', () => {
	// Undo-scope walk (Lexical #6714): when a control OUTSIDE the editor
	// exhausts its own undo stack, Chromium/WebKit re-dispatch
	// historyUndo/historyRedo at the contenteditable root. Those events are
	// not editor-owned — consuming them would steal the document's undo
	// history while the user's intent targets the foreign control.
	test('ignores historyUndo dispatched while a foreign control is focused', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(() => readBlockTexts(page)).toEqual(['alead', 'note', '']);

		await focusForeignInput(page);

		const prevented = await dispatchBeforeInput(page, { inputType: 'historyUndo' });

		expect(prevented).toBe(false);
		await expect.poll(() => readBlockTexts(page)).toEqual(['alead', 'note', '']);

		issues.assertClean();
	});

	test('ignores historyRedo dispatched while a foreign control is focused', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(() => readBlockTexts(page)).toEqual(['alead', 'note', '']);

		const undoPrevented = await dispatchBeforeInput(page, { inputType: 'historyUndo' });
		expect(undoPrevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		await focusForeignInput(page);

		const prevented = await dispatchBeforeInput(page, { inputType: 'historyRedo' });

		expect(prevented).toBe(false);
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('editor-owned historyUndo still runs while the editor holds the selection', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(() => readBlockTexts(page)).toEqual(['alead', 'note', '']);

		const prevented = await dispatchBeforeInput(page, { inputType: 'historyUndo' });

		expect(prevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});
});
