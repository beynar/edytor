/**
 * Triggers and input rules in real browsers (WU-15, WU-24): `@` and `[[`
 * menus at the caret, picked by keyboard and mouse, and an input rule, all
 * through real typing. Expectations come from the API's contract and Notion.
 */
import { expect, test } from './editorTest';
import {
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';
import type { Page } from '@playwright/test';

type Part = { text?: string; type?: string; data?: Record<string, unknown> };

/** The first block's content: text as is, an atom as `[type:label]`. */
const firstBlock = async (page: Page) => {
	const value = await readJsonByTestId<{ children: { content?: Part[] }[] }>(page, 'value');
	return (value.children[0]?.content ?? [])
		.map((part) =>
			part.type ? `[${part.type}:${part.data?.label ?? part.data?.title}]` : (part.text ?? '')
		)
		.join('');
};

const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=basic&empty=first&triggers=1');
	await waitForEditorReady(page);
	await setSelectionByTextIndex(page, 0, 0);
};

const menu = (page: Page) => page.getByTestId('trigger-menu');
const items = (page: Page) => page.getByTestId('trigger-menu-item');

test.describe('trigger menus', () => {
	test('@ opens the people menu, the query filters it, Enter inserts the mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.type('hi @');
		await expect(items(page)).toHaveCount(3);
		const editor = page.locator('[data-edytor]').first();
		await expect(editor).toHaveAttribute('aria-haspopup', 'listbox');
		const active = await editor.getAttribute('aria-activedescendant');
		await expect(items(page).first()).toHaveAttribute('id', active ?? '');
		await page.keyboard.type('tur');
		await expect(items(page)).toHaveCount(1);
		await page.keyboard.press('Enter');
		await expect(menu(page)).toHaveCount(0);
		await expect(page.locator('[data-edytor-mention]')).toHaveText('@Alan Turing');
		// The caret is after the atom: typing goes on there.
		await page.keyboard.type(' ok');
		await expect.poll(() => firstBlock(page)).toBe('hi [mention:Alan Turing] ok');
		issues.assertClean();
	});

	test('a click on a row picks it; Escape closes the menu and keeps the text', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.type('@gr');
		await expect(items(page)).toHaveCount(1);
		await items(page).first().click();
		await expect(page.locator('[data-edytor-mention]')).toHaveText('@Grace Hopper');
		await page.keyboard.type(' @ad');
		await expect(items(page)).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(menu(page)).toHaveCount(0);
		await expect.poll(() => firstBlock(page)).toBe('[mention:Grace Hopper] @ad');
		issues.assertClean();
	});

	test('[[ searches pages (an answer that comes later) and links one', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.type('see [[mee');
		await expect(items(page)).toHaveCount(1);
		await expect(items(page).first()).toContainText('Meeting notes');
		await page.keyboard.press('Enter');
		await expect(page.locator('a[data-edytor-page-link]')).toHaveAttribute('href', '/pages/p2');
		await expect.poll(() => firstBlock(page)).toBe('see [pageLink:Meeting notes]');
		issues.assertClean();
	});

	test('an input rule replaces :smile: as one undo step', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.type('hi :smile:');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄');
		await page.keyboard.type('!');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄!');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => firstBlock(page)).toBe('hi :smile');
		issues.assertClean();
	});
});
