/**
 * Link UX (WU-25) and code block languages (WU-26) in real browsers: the
 * keys, the pointer and the lazy grammar load jsdom cannot prove. The rows
 * are the site's `link.*` and `code.language.*` rules, after Notion.
 */
import { expect, test } from './editorTest';
import type { Page } from '@playwright/test';

import {
	dispatchPasteAtCaret,
	gotoEditorRoute,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

type Run = { text: string; marks?: Record<string, unknown> };
type Value = {
	children: Array<{
		type: string;
		data?: Record<string, unknown>;
		content?: Run[];
		children?: Array<{ content?: Run[] }>;
	}>;
};

const URL = 'https://edytor.dev/docs';
const value = (page: Page) => readJsonByTestId<Value>(page, 'value');
const contentOf = async (page: Page, index: number) => (await value(page)).children[index]?.content;

test.describe('link UX', () => {
	test('link.autolink.typed: a URL typed before a space links; undo gives the text back', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 2, 0);
		await page.keyboard.type(`see ${URL} `);
		await expect
			.poll(() => contentOf(page, 2))
			.toEqual([{ text: 'see ' }, { text: URL, marks: { link: { href: URL } } }, { text: ' ' }]);
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => contentOf(page, 2)).toEqual([{ text: `see ${URL} ` }]);
		issues.assertClean();
	});

	test('link.autolink.pasted: a URL pasted at a caret lands linked', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 4);
		await dispatchPasteAtCaret(page, { blockIndex: 0, contentIndex: 0, yStart: 4, text: URL });
		await expect
			.poll(() => contentOf(page, 0))
			.toEqual([{ text: 'lead' }, { text: URL, marks: { link: { href: URL } } }]);
		issues.assertClean();
	});

	test('link.mod-k: Mod+K opens the link field; Enter links and gives the editor back', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+k`);
		const input = page.getByTestId('toolbar-link-input');
		await expect(input).toBeFocused();
		await page.keyboard.type(URL);
		await page.keyboard.press('Enter');
		await expect
			.poll(() => contentOf(page, 0))
			.toEqual([{ text: 'lead', marks: { link: { href: URL } } }]);
		await expect(input).toHaveCount(0);
		await expect(page.locator('[data-edytor]').first()).toBeFocused();
		issues.assertClean();
	});

	test('link.card: hovering a link shows its card; Remove unlinks it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+k`);
		await page.keyboard.type(URL);
		await page.keyboard.press('Enter');
		const anchor = page.locator('[data-edytor] a[href]').first();
		await anchor.hover();
		const card = page.getByTestId('link-card');
		await expect(card).toBeVisible();
		await expect(card).toContainText(URL);
		// The pointer crosses from the link onto the card without losing it.
		await card.getByTestId('link-card-remove').hover();
		await card.getByTestId('link-card-remove').click();
		await expect.poll(() => contentOf(page, 0)).toEqual([{ text: 'lead' }]);
		await expect(card).toHaveCount(0);
		issues.assertClean();
	});

	test('link.mod-click: Mod+click opens the link in a new tab', async ({ page, context }) => {
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+k`);
		await page.keyboard.type(URL);
		await page.keyboard.press('Enter');
		await context.route(URL, (route) => route.fulfill({ body: 'docs' }));
		const popup = context.waitForEvent('page');
		await page
			.locator('[data-edytor] a[href]')
			.first()
			.click({ modifiers: ['ControlOrMeta'] });
		await expect((await popup).url()).toBe(URL);
		expect(page.url()).toContain('/test/dom');
	});
});

test.describe('code block languages', () => {
	const tokens = (page: Page) =>
		page
			.locator('[data-edytor-type="code"] [data-edytor-mark="codeToken"] > span')
			.evaluateAll((spans) => spans.map((span) => [span.className, span.textContent]));

	test('code.language.picker: picking Python stores it and highlights with its grammar', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=code');
		const picker = page.locator('select[data-edytor-code-language]');
		await expect(picker).toHaveValue('javascript');
		await expect.poll(() => tokens(page)).toContainEqual(['th-keyword', 'const']);
		await picker.selectOption('python');
		await expect
			.poll(async () => (await value(page)).children[0]?.data)
			.toEqual({
				language: 'python'
			});
		// `return` is a Python keyword too: its grammar landed and the lines rendered again.
		await expect.poll(() => tokens(page)).toContainEqual(['th-keyword', 'return']);
		await expect.poll(() => tokens(page)).not.toContainEqual(['th-keyword', 'const']);
		const lines = (await value(page)).children[0]?.children?.map((line) => line.content);
		expect(lines).toEqual([[{ text: 'const a = 1;' }], [{ text: 'return a;' }]]);
		issues.assertClean();
	});
});
