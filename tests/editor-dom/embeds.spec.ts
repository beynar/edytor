import { expect, test } from './editorTest';

import {
	dispatchPaste,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type Value = {
	children: Array<{
		type: string;
		data?: Record<string, unknown>;
		content?: Array<{ text: string; marks?: unknown }>;
	}>;
};

const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const linked = [{ text: YOUTUBE, marks: { link: { href: YOUTUBE } } }];
const first = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	(await readJsonByTestId<Value>(page, 'value')).children[0];

/**
 * WU-22 — pasting a URL on an empty line (Notion): the URL lands as a link
 * and a menu offers Link / Embed / Bookmark; Embed makes a sandboxed embed
 * of the provider's player, undo gives the link back; Escape keeps the link.
 */
test.describe('pasting a URL on an empty line', () => {
	test('Embed turns the line into a sandboxed player; undo gives the link back', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic&media=1');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, { text: YOUTUBE });

		await expect.poll(async () => (await first(page))?.content).toEqual(linked);
		const menu = page.locator('[data-edytor-url-paste-menu]');
		await expect(menu).toBeVisible();
		await expect(menu.locator('[data-edytor-url-paste-option]')).toHaveText([
			/Link/,
			/Embed/,
			/Bookmark/
		]);

		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await first(page))?.type).toBe('embed');
		expect((await first(page))?.data).toEqual({ url: YOUTUBE });
		await expect(menu).toHaveCount(0);
		const frame = page.locator('[data-edytor-embed] iframe');
		await expect(frame).toHaveAttribute(
			'src',
			'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
		);
		await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
		expect(await frame.getAttribute('srcdoc')).toBeNull();

		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(async () => (await first(page))?.content).toEqual(linked);
		expect((await first(page))?.type).toBe('paragraph');
		issues.assertClean();
	});

	test('Escape closes the menu and keeps the link', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic&media=1');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, { text: YOUTUBE });
		const menu = page.locator('[data-edytor-url-paste-menu]');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await expect.poll(async () => (await first(page))?.content).toEqual(linked);
		issues.assertClean();
	});
});
