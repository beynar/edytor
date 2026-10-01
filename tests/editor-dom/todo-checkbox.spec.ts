import { expect, test, type Page } from './editorTest';
import { gotoEditorRoute, trackPageIssues } from './helpers';

/**
 * Block data written by this view is visible in this view, not only on peers.
 * A to-do click toggles `data.checked` (a data command) and the box shows it.
 * Regression: the click was canceled, and the browser reverts a canceled
 * checkbox click after its handlers, over the re-render the write already
 * made, so the local box stayed unchecked while peers saw it checked.
 */
const doc = {
	children: [
		{ type: 'todo-item', id: 'task', data: { checked: false }, content: [{ text: 'task' }] }
	]
};

const open = (page: Page) =>
	gotoEditorRoute(page, `/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify(doc))}`, {
		requireRuntime: true
	});

const box = (page: Page) => page.locator('[data-edytor-todo-checkbox]').first();

const modelChecked = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		return edytor.idToBlock.block('task').data.checked ?? false;
	});

test.describe('to-do checkbox', () => {
	test('a click checks and unchecks the box in this view', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await expect(box(page)).not.toBeChecked();

		await box(page).click();
		await expect.poll(() => modelChecked(page)).toBe(true);
		await expect(box(page)).toBeChecked();

		await box(page).click();
		await expect.poll(() => modelChecked(page)).toBe(false);
		await expect(box(page)).not.toBeChecked();
		issues.assertClean();
	});

	test('a data write from code shows in this view', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.idToBlock.block('task').data.checked = true;
		});
		await expect(box(page)).toBeChecked();
		issues.assertClean();
	});

	test('a readonly view keeps the box as the document holds it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.readonly = true;
		});
		await box(page).click({ force: true });
		await page.waitForTimeout(200);
		expect(await modelChecked(page)).toBe(false);
		await expect(box(page)).not.toBeChecked();
		issues.assertClean();
	});
});
