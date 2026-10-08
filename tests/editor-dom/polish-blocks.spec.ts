import { expect, test, type Page } from './editorTest';

import { readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * WU-31, WU-32 in real browsers (Notion): the block menu's Color paints a
 * block from the palette tokens, `> ` then `# ` makes a toggle heading, a
 * table of contents scrolls to a heading, and a page block opens its page.
 */
type Value = { children: Array<{ id?: string; type: string; data?: Record<string, unknown> }> };
const ROUTE = '/test/dom?scenario=polish&polish=1&handles=true';
const block = (page: Page, id: string) => page.locator(`[data-edytor-id="${id}"]`);
const blockOf = async (page: Page, id: string) =>
	(await readJsonByTestId<Value>(page, 'value')).children.find((b) => b.id === id);

const openBlockMenu = async (page: Page, id: string) => {
	await block(page, id).hover();
	await page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`).click();
	await expect(page.getByRole('menu', { name: 'Block actions' })).toBeVisible();
};

test.describe('block colours, toggle headings, table of contents, page block', () => {
	test('Color › Red background paints the block; undo takes it back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		await openBlockMenu(page, 'intro');
		await page.getByTestId('block-menu-color').hover();
		const flyout = page.getByRole('menu', { name: 'Color' });
		await expect(flyout).toBeVisible();
		await flyout.getByRole('menuitemradio', { name: 'Red background' }).click();

		await expect(block(page, 'intro')).toHaveAttribute('data-edytor-background', 'red');
		await expect(block(page, 'intro')).toHaveCSS('background-color', 'rgb(252, 233, 231)');
		expect((await blockOf(page, 'intro'))?.data).toEqual({ background: 'red' });
		await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0);
		// The block stays selected (Notion); Mod+Z takes the colour back.
		await expect(block(page, 'intro')).toHaveAttribute('data-edytor-selected', 'true');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(block(page, 'intro')).not.toHaveAttribute('data-edytor-background', /.*/);
		issues.assertClean();
	});

	test('"> " then "# " at a line’s start makes a toggle heading 1', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		const text = block(page, 'intro').locator('[data-edytor-text]').first();
		await text.click();
		await page.keyboard.press('Home');
		await page.keyboard.type('> # ');
		await expect.poll(async () => (await blockOf(page, 'intro'))?.type).toBe('toggle-heading');
		expect((await blockOf(page, 'intro'))?.data).toEqual({ level: 'h1' });
		await expect(block(page, 'intro').locator(':scope > summary > h1')).toHaveText('Paint me');
		issues.assertClean();
	});

	test('a table of contents lists the headings and scrolls to one', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		const entries = block(page, 'toc').locator('[data-edytor-toc-entry]');
		await expect(entries).toHaveText(['Overview', 'Questions', 'Far below']);
		await expect(block(page, 'last')).not.toBeInViewport();
		await entries.filter({ hasText: 'Far below' }).click();
		await expect(block(page, 'last')).toBeInViewport();
		issues.assertClean();
	});

	test('a page block opens its page; /page creates one', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		const opened = () =>
			page.evaluate(
				() => (window as unknown as { __EDYTOR_OPENED_PAGE__?: string }).__EDYTOR_OPENED_PAGE__
			);
		await block(page, 'sub').getByRole('button', { name: 'Roadmap' }).click();
		await expect.poll(opened).toBe('page-2');

		// A new line after the intro, then the slash menu's "Page".
		const text = block(page, 'intro').locator('[data-edytor-text]').first();
		await text.click();
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.type('/page');
		await expect(page.getByRole('option', { name: /^Page/ }).first()).toBeVisible();
		await page.keyboard.press('Enter');
		await expect.poll(opened).toBe('page-new');
		const value = await readJsonByTestId<Value>(page, 'value');
		const index = value.children.findIndex((b) => b.id === 'intro');
		expect(value.children[index + 1]).toMatchObject({ type: 'page', data: { pageId: 'page-new' } });
		issues.assertClean();
	});

	test('a modified click opens the page in a new tab; Enter over it selected alone opens it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		const opened = () =>
			page.evaluate(() => {
				const seen = window as unknown as {
					__EDYTOR_OPENED_PAGE__?: string;
					__EDYTOR_OPENED_IN_TAB__?: boolean;
				};
				return [seen.__EDYTOR_OPENED_PAGE__, seen.__EDYTOR_OPENED_IN_TAB__];
			});
		await block(page, 'sub')
			.getByRole('button', { name: 'Roadmap' })
			.click({ modifiers: ['ControlOrMeta'] });
		await expect.poll(opened).toEqual(['page-2', true]);
		await page.evaluate(() => {
			const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
			edytor.node.focus();
			edytor.selection.selectBlocks(edytor.idToBlock.get('sub'));
		});
		await page.evaluate(() =>
			Object.assign(window, {
				__EDYTOR_OPENED_PAGE__: undefined,
				__EDYTOR_OPENED_IN_TAB__: undefined
			})
		);
		await page.keyboard.press('Enter');
		await expect.poll(opened).toEqual(['page-2', false]);
		issues.assertClean();
	});

	test('/red paints the caret’s block red; undo gives /red back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto(ROUTE);
		await waitForEditorReady(page);
		const text = block(page, 'intro').locator('[data-edytor-text]').first();
		await text.click();
		await page.keyboard.press('End');
		await page.keyboard.type(' /red');
		await expect(page.getByRole('option', { name: 'Red text' })).toBeVisible();
		await expect(page.getByRole('option', { name: 'Red background' })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(block(page, 'intro')).toHaveAttribute('data-edytor-color', 'red');
		await expect(block(page, 'intro')).toHaveCSS('color', 'rgb(207, 81, 72)');
		await expect(text).toHaveText('Paint me ');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(block(page, 'intro')).not.toHaveAttribute('data-edytor-color', /.*/);
		await expect(text).toHaveText('Paint me /red');
		issues.assertClean();
	});
});
