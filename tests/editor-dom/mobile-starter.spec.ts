import { expect, test } from '@playwright/test';

/** The starter registry item at phone width: no horizontal scroll, the title and a property edit. */
test('the starter page fits a phone and edits there', async ({ page }) => {
	await page.goto('/test/starter');
	await page.waitForFunction(
		() => (window as unknown as { __edytor?: { synced: boolean } }).__edytor?.synced === true
	);
	await page.evaluate(() => {
		const view = (window as unknown as { __edytor: { data: Record<string, unknown> } }).__edytor;
		view.data.cover = {
			url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
			position: 50
		};
		view.data.icon = { emoji: '🌱' };
	});
	await expect(page.locator('[data-edytor-starter-cover]')).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	await page.getByRole('textbox', { name: 'Page title' }).tap();
	await page.keyboard.press('End');
	await page.keyboard.type('!');
	await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Starter page!');
	await page.locator('[data-edytor-starter-property="status"] [data-slot="select-trigger"]').tap();
	await page.getByRole('option', { name: 'Done' }).tap();
	const status = await page.evaluate(
		() =>
			(window as unknown as { __edytor: { data: { properties: { status: string } } } }).__edytor
				.data.properties.status
	);
	expect(status).toBe('done');
});
