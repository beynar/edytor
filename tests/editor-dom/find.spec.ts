import { expect, test, type Page } from './editorTest';
import { modKey, readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Find and replace (WU-33, site `plugins/find`) in real browsers: Mod+F
 * opens the bar only when the plugin is listed, the highlights sit over the
 * matched text, a match in a closed toggle's body opens it, and Replace all
 * is one undo step. The jsdom rows are `find.test.tsx`.
 */

const children = [
	{ id: 'a', type: 'paragraph', content: [{ text: 'Hello world, hello World' }] },
	{
		id: 't',
		type: 'toggle',
		content: [{ text: 'Toggle' }],
		children: [{ id: 'h', type: 'paragraph', content: [{ text: 'hidden hello' }] }]
	},
	{ id: 'c', type: 'paragraph', content: [{ text: 'Goodbye' }] }
];

const open = async (page: Page, find = true) => {
	await page.goto(
		`/test/dom?scenario=dst${find ? '&find=true' : ''}&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page);
	// A caret at the start of the first line.
	const first = page.locator('[data-edytor-id="a"] [data-edytor-text="true"]').first();
	const box = (await first.boundingBox())!;
	await page.mouse.click(box.x + 1, box.y + box.height / 2);
};

const texts = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: { content?: { text: string }[]; children?: { content?: { text: string }[] }[] }[];
	}>(page, 'value');
	const line = (block: { content?: { text: string }[] }) =>
		(block.content ?? []).map((part) => part.text).join('');
	return [
		line(value.children[0]!),
		line(value.children[1]!.children![0]!),
		line(value.children[2]!)
	];
};

/** The rects of the text the `index`-th match covers in block `id`, and the current highlight's. */
const geometry = (page: Page, id: string, offset: number, length: number) =>
	page.evaluate(
		([id, offset, length]) => {
			const element = document.querySelector(`[data-edytor-id="${id}"] [data-edytor-text="true"]`)!;
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			const node = walker.nextNode()!;
			const range = document.createRange();
			range.setStart(node, offset);
			range.setEnd(node, offset + length);
			const text = range.getBoundingClientRect();
			const mark = document
				.querySelector('[data-edytor-find-match][data-current]')!
				.getBoundingClientRect();
			return { text: [text.left, text.top, text.width], mark: [mark.left, mark.top, mark.width] };
		},
		[id, offset, length] as const
	);

test.describe('find and replace', () => {
	test('Mod+F opens nothing of ours without the plugin', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, false);
		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator('[data-edytor-find]')).toHaveCount(0);
		issues.assertClean();
	});

	test('the bar searches, highlights over the text and opens a closed toggle', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.press(`${modKey}+f`);
		const query = page.locator('[data-edytor-find-query]');
		await expect(query).toBeFocused();
		await page.keyboard.type('hello');
		await expect(page.locator('[data-edytor-find-count]')).toHaveText('1/3');
		// Two shown matches; the closed toggle's body shows none.
		await expect(page.locator('[data-edytor-find-match]')).toHaveCount(2);
		await expect
			.poll(async () => {
				const { text, mark } = await geometry(page, 'a', 0, 5);
				return text.every((value, index) => Math.abs(value - mark[index]!) <= 2);
			})
			.toBe(true);

		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor-find-count]')).toHaveText('2/3');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor-find-count]')).toHaveText('3/3');
		await expect(page.locator('[data-edytor-id="t"]')).toHaveJSProperty('open', true);
		await expect(page.locator('[data-edytor-find-match]')).toHaveCount(3);
		await expect
			.poll(async () => {
				const { text, mark } = await geometry(page, 'h', 7, 5);
				return text.every((value, index) => Math.abs(value - mark[index]!) <= 2);
			})
			.toBe(true);

		// Escape selects the current match in the editor.
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-edytor-find]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('hello');
		issues.assertClean();
	});

	test('Replace all is one undo step', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.press(`${modKey}+f`);
		await page.keyboard.type('hello');
		await page.locator('[data-edytor-find-replacement]').fill('bye');
		await page.locator('[data-edytor-find-replace-all]').click();
		await expect.poll(() => texts(page)).toEqual(['bye world, bye World', 'hidden bye', 'Goodbye']);
		await expect(page.locator('[data-edytor-find-count]')).toHaveText('No results');

		await page.locator('[data-edytor-find-close]').click();
		await expect(page.locator('[data-edytor]').first()).toBeFocused();
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(() => texts(page))
			.toEqual(['Hello world, hello World', 'hidden hello', 'Goodbye']);
		issues.assertClean();
	});
});
