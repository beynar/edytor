/**
 * Contract `sel.blocks.exact` + `del.blocks.promote` (2026-09-28, "preserve
 * content the user did not remove") in real browsers: what the user sees
 * selected is exactly what a delete removes. A block selection is exactly its
 * members — a handle click or the ladder's block step selects one block, the
 * selected attribute marks only the members, and the demo's highlight paints
 * only them — and deleting a selected parent promotes its unselected children
 * to its slot; undo puts them back under it. Expected values are the
 * contract's (docs/editor-delete-contract.md), hand-written.
 */
import { expect, test, type Page } from './editorTest';
import { b, model, open } from './p1-helpers';

const FAMILY = [
	b('P', 'parent', { children: [b('C', 'child'), b('D', 'second')] }),
	b('Z', 'after')
];

/** Ids whose element carries `data-edytor-selected`, in DOM order. */
const marked = (page: Page) =>
	page
		.locator('[data-edytor-selected="true"]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-edytor-id')));

const shape = async (page: Page) =>
	(await model(page)).map((row) => `${'  '.repeat(row.depth)}${row.id}:${row.text}`);

const caretIn = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first().click();

test.describe('sel.blocks.exact + del.blocks.promote', () => {
	test('a handle click selects the parent alone; Backspace promotes its children; undo restores them under it', async ({
		page
	}) => {
		await open(page, FAMILY, '&handles=true');
		await page.locator('[data-edytor-id="P"]').first().hover();
		await page.locator('[data-testid="block-handle"][data-block-id="P"]').click();
		await expect.poll(() => marked(page)).toEqual(['P']);
		// The handle lives in the overlay beside the host: the key goes to the editor.
		await page.locator('[data-edytor]').press('Backspace');
		await expect.poll(() => shape(page)).toEqual(['C:child', 'D:second', 'Z:after']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect
			.poll(() => shape(page))
			.toEqual(['P:parent', '  C:child', '  D:second', 'Z:after']);
	});

	test('Shift+ArrowUp from a child adds the parent and keeps the child; Backspace removes both', async ({
		page
	}) => {
		await open(page, FAMILY);
		await caretIn(page, 'C');
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ControlOrMeta+a');
		await expect.poll(() => marked(page)).toEqual(['C']);
		await page.keyboard.press('Shift+ArrowUp');
		await expect.poll(() => marked(page)).toEqual(['P', 'C']);
		await page.keyboard.press('Backspace');
		await expect.poll(() => shape(page)).toEqual(['D:second', 'Z:after']);
	});

	test('select-all marks every block, nested ones included, and deletes them all', async ({
		page
	}) => {
		await open(page, FAMILY);
		await caretIn(page, 'D');
		for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+a');
		await expect.poll(() => marked(page)).toEqual(['P', 'C', 'D', 'Z']);
		await page.keyboard.press('Backspace');
		await expect.poll(async () => (await model(page)).map((row) => row.text)).toEqual(['']);
	});

	test('demo: a selected parent is highlighted, its unselected child is not, and the child survives the delete', async ({
		page
	}) => {
		await page.goto('/?doc=contracts-block-selection');
		const one = page.locator('[data-edytor-id="page-bullet-one"]');
		const two = page.locator('[data-edytor-id="page-bullet-two"]');
		await expect(two).toBeVisible();
		// Nest bullet two under bullet one (Tab), then select bullet one (the ladder's block step).
		await caretIn(page, 'page-bullet-two');
		await page.keyboard.press('Tab');
		await expect(one.locator('[data-edytor-id="page-bullet-two"]')).toHaveCount(1);
		await caretIn(page, 'page-bullet-one');
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ControlOrMeta+a');
		await expect.poll(() => marked(page)).toEqual(['page-bullet-one']);
		const background = (id: string) =>
			page
				.locator(`[data-edytor-id="${id}"]`)
				.evaluate((node) => getComputedStyle(node).backgroundColor);
		expect(await background('page-bullet-one')).toBe('rgb(232, 230, 223)');
		expect(await background('page-bullet-two')).toBe('rgb(255, 255, 255)');
		await page.keyboard.press('Backspace');
		await expect(one).toHaveCount(0);
		await expect(two).toBeVisible();
		expect(
			await two.evaluate((node) => node.parentElement?.closest('[data-edytor-block="true"]'))
		).toBeNull();
	});
});
