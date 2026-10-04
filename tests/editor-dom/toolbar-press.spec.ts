import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';
import { frames, openDoc, para, selectionValue, textBox, texts, walk } from './columnsPaths';

/**
 * The formatting toolbar's chrome never takes focus on press (round 8): a
 * press on its own background (not a button) keeps the editor focused and
 * its selection, so the next typing replaces the selected text. Firefox and
 * WebKit dropped focus there. A person's mouse, in 2–12px steps.
 */

/** Whether focus is inside the editor. */
const focusInEditor = (page: Page) =>
	page.evaluate(() => {
		const root = document.querySelector('[data-edytor]');
		return Boolean(root && document.activeElement && root.contains(document.activeElement));
	});

/** A point on the toolbar bar's own background: no button, no field under it. */
const barBackground = (page: Page) =>
	page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('[data-edytor-toolbar-bar]')!;
		const box = bar.getBoundingClientRect();
		const y = box.top + box.height / 2;
		for (let x = box.left + 1; x < box.right; x++) {
			const hit = document.elementFromPoint(x, y);
			if (hit && bar.contains(hit) && !hit.closest('button, input, select, textarea, a'))
				return { x, y };
		}
		return null;
	});

test.describe('a press on the toolbar’s background keeps the editor’s focus (round 8)', () => {
	test('select a word, press the bar’s background, type: the typing replaces the word', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, [para('P', 'hello world'), para('Z', 'after')]);
		const t = await textBox(page, 'P');
		const row = t.y + t.height / 2;
		// "hello" selected by a drag from the text's start.
		const start = { x: t.x + 1, y: row };
		await walk(page, { x: start.x + 8, y: row - 6 }, start, 3);
		await page.mouse.down();
		const word = await page.evaluate(() => {
			const text = document.querySelector('[data-edytor-id="P"] [data-edytor-text="true"]')!;
			const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!;
			const range = document.createRange();
			range.setStart(leaf, 0);
			range.setEnd(leaf, 5);
			return range.getBoundingClientRect().right;
		});
		const end = await walk(page, start, { x: word, y: row }, 4);
		await page.mouse.up();
		await frames(page);
		await expect(page.getByTestId('selection-toolbar')).toBeVisible();
		expect(await page.evaluate(() => getSelection()?.toString())).toBe('hello');
		// Onto the bar's background, and a press there.
		const background = await barBackground(page);
		expect(background).not.toBeNull();
		await walk(page, end, background!, 6);
		await page.mouse.down();
		await page.mouse.up();
		await frames(page);
		expect(await focusInEditor(page)).toBe(true);
		expect(await selectionValue(page)).toMatchObject({ kind: 'text' });
		await page.keyboard.type('Q');
		await expect.poll(() => texts(page)).toEqual(['Q world', 'after']);
		expect(await focusInEditor(page)).toBe(true);
		issues.assertClean();
	});
});
