/**
 * Input rules and trigger menus under mobile emulation (Android Chrome and
 * iOS Safari user agents, touch). Typing is both the emulated keyboard's
 * keys and a soft keyboard's bare `insertText` (no key event before it), as
 * a phone's keyboard sends a character outside a composition. A word an
 * Android keyboard composes commits as an IME does, which no rule checks
 * (site `plugins/input-rules`); real devices are not covered here.
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

/** A soft keyboard's characters: one bare `insertText` each, no key event. */
const softType = async (page: Page, text: string) => {
	for (const char of text) await page.keyboard.insertText(char);
};

const items = (page: Page) => page.getByTestId('trigger-menu-item');

test.describe('mobile input rules and trigger menus', () => {
	test('an input rule replaces :smile: typed with keys', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.keyboard.type('hi :smile:');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄');
		await page.keyboard.type('!');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄!');
		issues.assertClean();
	});

	test("an input rule replaces :smile: typed by a soft keyboard's bare insertions", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await softType(page, 'hi :smile:');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄');
		await softType(page, ' ok');
		await expect.poll(() => firstBlock(page)).toBe('hi 😄 ok');
		issues.assertClean();
	});

	test('@ from a soft keyboard opens the people menu; a tap on a row inserts the mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await softType(page, 'hi @tur');
		await expect(items(page)).toHaveCount(1);
		await items(page).first().tap();
		await expect(page.locator('[data-edytor-mention]')).toHaveText('@Alan Turing');
		await expect.poll(() => firstBlock(page)).toBe('hi [mention:Alan Turing]');
		issues.assertClean();
	});
});
