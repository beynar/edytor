import { expect, test, type Page } from './editorTest';
import { modKey, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * The handle's `+` adds nothing until the user picks what to insert: its
 * menu takes the typing, and the picked kind lands after the block, the
 * caret in it, as one undo step.
 */
const topBlocks = (page: Page) => page.locator('[data-edytor] > [data-edytor-block="true"]');

const openPlus = async (page: Page, id: string) => {
	await page.locator(`[data-edytor-id="${id}"]`).hover();
	await page
		.locator(`[data-edytor-block-handle-host][data-block-id="${id}"] [data-testid="block-add"]`)
		.click();
};

test('the + inserts nothing until a kind is picked, then one heading after the block', async ({
	page
}) => {
	const issues = trackPageIssues(page);
	await page.goto('/');
	await waitForEditorReady(page);
	await page.locator('[data-edytor-id="page-end"] p').click();
	await page.keyboard.type('One');
	const count = await topBlocks(page).count();

	await openPlus(page, 'page-end');
	const field = page.getByTestId('slash-menu').locator('input');
	await expect(field).toBeFocused();
	await page.keyboard.type('head');
	await expect(field).toHaveValue('head');
	// The typing went to the menu: the document is as it was.
	await expect(topBlocks(page)).toHaveCount(count);
	await expect(page.locator('[data-edytor-id="page-end"]')).toHaveText('One');

	await page.keyboard.press('Enter');
	await expect(page.getByTestId('slash-menu')).toHaveCount(0);
	await expect(topBlocks(page)).toHaveCount(count + 1);
	const added = page.locator('[data-edytor-id="page-end"] + [data-edytor-block="true"]');
	await expect(added).toHaveAttribute('data-edytor-type', 'heading');
	await expect(added.locator(':scope > h1')).toHaveCount(1);

	// One undo step takes the insertion back; redo gives it back with its caret.
	await page.keyboard.press(`${modKey}+Z`);
	await expect(topBlocks(page)).toHaveCount(count);
	await expect(page.locator('[data-edytor-id="page-end"]')).toHaveText('One');
	await page.keyboard.press(`${modKey}+Shift+Z`);
	await expect(added).toHaveAttribute('data-edytor-type', 'heading');
	await expect(added.locator(':scope > h1')).toHaveCount(1);
	await page.keyboard.type('Title');
	await expect(added.locator(':scope > h1')).toHaveText('Title');
	await expect(page.locator('[data-edytor-id="page-end"]')).toHaveText('One');
	issues.assertClean();
});
