import { expect, test, type Page } from './editorTest';
import { waitForEditorReady } from './helpers';

/**
 * Leaving a code block by keyboard in real browsers. Enter in the code
 * block's empty last line leaves it (the line goes); ArrowDown in its last
 * line goes below it, creating a paragraph when nothing follows. The jsdom
 * rows are `src/tests/fixtures/dom/code-exit-20261003.test.tsx`.
 */
const code = (...lines: string[]) => ({
	id: 'c',
	type: 'code',
	children: lines.map((text, i) => ({ id: `l${i + 1}`, type: 'codeLine', content: [{ text }] }))
});

const open = async (page: Page, children: unknown[]) => {
	await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children }))}`);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The type of the block holding the model caret. */
const caretKind = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __EDYTOR__: any }).__EDYTOR__.selection.state.startBlock?.type
	);

const shape = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		return edytor.value.children.map((block: any) =>
			block.type === 'code'
				? `code[${block.children.map((l: any) => l.content?.[0]?.text ?? '').join('|')}]`
				: `${block.type}:${(block.content ?? []).map((p: any) => p.text ?? '@').join('')}`
		);
	});

/** Click at the end of code line `id`. */
const endOf = async (page: Page, id: string) => {
	const box = (await page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).boundingBox())!;
	await page.mouse.click(box.x + box.width + 2, box.y + box.height / 2);
};

test.describe('leaving a code block', () => {
	test('Enter twice at the end of the code leaves it; typing goes below', async ({ page }) => {
		await open(page, [code('let a = 1;')]);
		await endOf(page, 'l1');
		await page.keyboard.press('Enter');
		await expect.poll(() => shape(page)).toEqual(['code[let a = 1;|]']);
		await page.keyboard.press('Enter');
		await page.keyboard.type('after');
		await expect.poll(() => shape(page)).toEqual(['code[let a = 1;]', 'paragraph:after']);
	});

	test('ArrowDown on the last line with nothing after creates a paragraph', async ({ page }) => {
		await open(page, [code('a', 'bc')]);
		await endOf(page, 'l2');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caretKind(page)).toBe('paragraph');
		await page.keyboard.type('x');
		await expect.poll(() => shape(page)).toEqual(['code[a|bc]', 'paragraph:x']);
	});

	test('ArrowDown on the last line goes to the block after', async ({ page }) => {
		await open(page, [
			code('a', 'bc'),
			{ id: 'p', type: 'paragraph', content: [{ text: 'next' }] }
		]);
		await endOf(page, 'l2');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caretKind(page)).toBe('paragraph');
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual(expect.arrayContaining(['code[a|bc]', expect.stringMatching(/^paragraph:.*x/)]));
		expect((await shape(page)).length).toBe(2);
	});
});
