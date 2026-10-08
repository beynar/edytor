import { expect, test, type Page } from './editorTest';

import {
	getCaretPoint,
	gotoEditorRoute,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

type Value = { children: Array<{ content?: Array<{ text: string }> }> };
const lines = async (page: Page) =>
	(await readJsonByTestId<Value>(page, 'value')).children.map(
		(block) => block.content?.map((part) => part.text).join('') ?? ''
	);

/** Press inside the selected text at `from`, drag with the real mouse, release at `to`. */
const dragText = async (
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	{ alt = false } = {}
) => {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	// A press held still starts a text drag (macOS engines wait ~150 ms; a quick
	// move after the press is a new selection instead).
	await page.waitForTimeout(400);
	await page.mouse.move(from.x + 4, from.y + 2, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 16 });
	if (alt) await page.keyboard.down('Alt');
	// One more move: the engine reads the modifier on the next dragover.
	await page.mouse.move(to.x + 1, to.y, { steps: 2 });
	await page.mouse.up();
	if (alt) await page.keyboard.up('Alt');
};

/**
 * WU-37 — a selected text range dragged with the mouse moves inside the
 * editor (Notion, every text editor): one command and one undo step; Alt
 * copies. The browser's own drag (no synthetic event): the engines start a
 * drag from a press inside a selection. The model rows are
 * `text-drag-20261008.test.tsx`.
 */
test.describe('dragging selected text', () => {
	test('moves it to another line; one undo gives both back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=words');
		// "beta " in "alpha beta gamma".
		await setSelectionByTextIndex(page, 0, 6, 0, 11);
		const from = await getCaretPoint(page, 0, 8);
		const to = await getCaretPoint(page, 1, 13);
		await dragText(page, from, to);

		await expect.poll(() => lines(page)).toEqual(['alpha gamma', 'delta epsilonbeta ']);
		// The moved text is selected.
		await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe('beta ');
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => lines(page)).toEqual(['alpha beta gamma', 'delta epsilon']);
		issues.assertClean();
	});

	test('moves it within its line', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=words');
		// "alpha " to the end of the line.
		await setSelectionByTextIndex(page, 0, 0, 0, 6);
		const from = await getCaretPoint(page, 0, 3);
		const to = await getCaretPoint(page, 0, 16);
		await dragText(page, from, to);

		await expect.poll(() => lines(page)).toEqual(['beta gammaalpha ', 'delta epsilon']);
		issues.assertClean();
	});

	test('with Alt held at the drop, copies it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=words');
		await setSelectionByTextIndex(page, 0, 6, 0, 10);
		const from = await getCaretPoint(page, 0, 8);
		const to = await getCaretPoint(page, 1, 13);
		await dragText(page, from, to, { alt: true });

		await expect.poll(() => lines(page)).toEqual(['alpha beta gamma', 'delta epsilonbeta']);
		issues.assertClean();
	});
});
