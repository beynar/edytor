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

	const button = (page: Page) => page.locator('button[data-edytor-code-language]');
	const menu = (page: Page) => page.locator('[data-edytor-code-language-menu]');
	const field = (page: Page) => menu(page).locator('input');
	const languageOf = async (page: Page) => (await value(page)).children[0]?.data;
	const caretInCode = async (page: Page) =>
		page.locator('[data-edytor-type="codeLine"] [data-edytor-text]').first().click();

	test('code.language.picker: a click opens the languages; a click on Python stores it and highlights with its grammar', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=code');
		await expect(button(page)).toHaveText('JavaScript');
		await expect.poll(() => tokens(page)).toContainEqual(['th-keyword', 'const']);
		await button(page).click();
		await expect(menu(page)).toBeVisible();
		await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(field(page)).toBeFocused();
		await menu(page).getByRole('option', { name: 'Python' }).click();
		await expect(menu(page)).toHaveCount(0);
		await expect.poll(() => languageOf(page)).toEqual({ language: 'python' });
		await expect(button(page)).toHaveText('Python');
		// `return` is a Python keyword too: its grammar landed and the lines rendered again.
		await expect.poll(() => tokens(page)).toContainEqual(['th-keyword', 'return']);
		await expect.poll(() => tokens(page)).not.toContainEqual(['th-keyword', 'const']);
		const lines = (await value(page)).children[0]?.children?.map((line) => line.content);
		expect(lines).toEqual([[{ text: 'const a = 1;' }], [{ text: 'return a;' }]]);
		// One undo step gives JavaScript back.
		await caretInCode(page);
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(async () => (await languageOf(page)) ?? {}).toEqual({});
		await expect(button(page)).toHaveText('JavaScript');
		issues.assertClean();
	});

	test('code.language.picker: the keys alone — Alt+F10, Enter, a query, the arrows, Enter', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=code');
		await caretInCode(page);
		await page.keyboard.press('End');
		await page.keyboard.press('Alt+F10');
		await expect(button(page)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(field(page)).toBeFocused();
		await page.keyboard.type('script');
		await expect(menu(page).getByRole('option')).toHaveText(['JavaScript', 'TypeScript']);
		await page.keyboard.press('ArrowDown');
		await expect(menu(page).getByRole('option', { selected: true })).toHaveText('TypeScript');
		await page.keyboard.press('Enter');
		await expect(menu(page)).toHaveCount(0);
		await expect.poll(() => languageOf(page)).toEqual({ language: 'typescript' });
		// The keys go back to the button, then Escape gives them to the code line.
		await expect(button(page)).toBeFocused();
		await expect(button(page)).toHaveText('TypeScript');
		await page.keyboard.press('Escape');
		await expect(button(page)).not.toBeFocused();
		await page.keyboard.type('x');
		await expect
			.poll(async () => (await value(page)).children[0]?.children?.[0]?.content)
			.toEqual([{ text: 'const a = 1;x' }]);
		issues.assertClean();
	});

	test('code.language.picker: Escape and a press outside close the list and write nothing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=code');
		await button(page).click();
		// The list renders at the overlay's next frame, its field then taking the keys.
		await expect(field(page)).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Escape');
		await expect(menu(page)).toHaveCount(0);
		await button(page).click();
		await expect(field(page)).toBeFocused();
		// A press beside the list (it covers the blocks under the header).
		const viewport = page.viewportSize()!;
		await page.mouse.click(viewport.width - 10, viewport.height - 10);
		await expect(menu(page)).toHaveCount(0);
		expect((await languageOf(page)) ?? {}).toEqual({});
		issues.assertClean();
	});
});
