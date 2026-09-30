import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './editorTest';
import { readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * SW19 — a heading's nested blocks render outside its `h1`–`h3` (the block
 * element is a `div`; the tag wraps the heading's own text). Page-level
 * heading rules and the Notion theme's heading sizes never reach a nested
 * paragraph, and the caret still maps into the title. Expected states are
 * hand-authored. The structure rows are `heading-children-structure.test.tsx`.
 */

const kid = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
const children = [
	{
		id: 'T',
		type: 'heading',
		data: { level: 'h1' },
		content: [{ text: 'Title' }],
		children: [kid('a', 'nested')]
	},
	{
		id: 'S',
		type: 'heading',
		data: { level: 'h2' },
		content: [{ text: 'Section' }],
		children: [kid('b', 'body')]
	},
	{ id: 'Q', type: 'quote', content: [{ text: 'Said' }], children: [kid('c', 'quoted')] }
];

const open = async (page: Page) => {
	await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children }))}`);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The Notion theme, its class on the editor itself (the theme's documented alternative). */
const notionTheme = async (page: Page) => {
	await page.addStyleTag({
		content: readFileSync(new URL('../../src/lib/themes/notion.css', import.meta.url), 'utf8')
	});
	await page.locator('[data-edytor]').evaluate((node) => node.classList.add('edytor-notion'));
};

const styleOf = (page: Page, selector: string) =>
	page.locator(selector).evaluate((node) => {
		const style = getComputedStyle(node);
		return {
			fontFamily: style.fontFamily,
			letterSpacing: style.letterSpacing,
			fontSize: style.fontSize,
			fontWeight: style.fontWeight
		};
	});

test.describe('a heading with children', () => {
	test('a page-level h1 rule styles the title, not the nested paragraph', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.addStyleTag({ content: 'h1 { letter-spacing: -2px; font-family: serif }' });
		const title = await styleOf(page, '[data-edytor-id="T"] > h1');
		const nested = await styleOf(page, '[data-edytor-id="a"] p');
		expect([title.letterSpacing, title.fontFamily]).toEqual(['-2px', 'serif']);
		expect(nested.letterSpacing).not.toBe('-2px');
		expect(nested.fontFamily).not.toBe('serif');
		expect(await page.locator(':is(h1, h2, h3, blockquote) [data-edytor-block]').count()).toBe(0);
		issues.assertClean();
	});

	test('the Notion theme: heading styles stop at the heading text; page rules stay out', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.addStyleTag({
			content: 'h1 { letter-spacing: -2px } blockquote { margin: 20px; border-left: 5px solid red }'
		});
		await notionTheme(page);
		expect(await styleOf(page, '[data-edytor-id="T"] > h1')).toMatchObject({
			fontSize: '40px',
			fontWeight: '700',
			letterSpacing: 'normal'
		});
		expect(
			await page
				.locator('[data-edytor-id="Q"] > blockquote')
				.evaluate((node) => [
					getComputedStyle(node).marginLeft,
					getComputedStyle(node).borderLeftWidth
				])
		).toEqual(['0px', '0px']);
		expect(await styleOf(page, '[data-edytor-id="S"] > h2')).toMatchObject({
			fontSize: '24px',
			fontWeight: '600'
		});
		for (const id of ['a', 'b', 'c'])
			expect(await styleOf(page, `[data-edytor-id="${id}"] p`)).toMatchObject({
				fontSize: '16px',
				fontWeight: '400'
			});
		issues.assertClean();
	});

	for (const themed of [false, true])
		test(`clicking the title end and typing edits the heading, not its child${themed ? ' (Notion theme)' : ''}`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await open(page);
			if (themed) await notionTheme(page);
			const title = page.locator('[data-edytor-id="T"] > h1');
			const box = (await title.boundingBox())!;
			const text = await title.evaluate((node) => {
				const range = document.createRange();
				range.selectNodeContents(node);
				const rect = range.getBoundingClientRect();
				return { right: rect.right, middle: rect.top + rect.height / 2 };
			});
			expect(text.right).toBeLessThan(box.x + box.width);
			await page.mouse.click(text.right + 20, text.middle);
			await page.keyboard.type('!');
			const value = await readJsonByTestId<{ children: typeof children }>(page, 'value');
			expect(value.children[0]).toMatchObject({
				type: 'heading',
				content: [{ text: 'Title!' }],
				children: [{ type: 'paragraph', content: [{ text: 'nested' }] }]
			});
			await expect(title).toHaveText('Title!');
			issues.assertClean();
		});
});
