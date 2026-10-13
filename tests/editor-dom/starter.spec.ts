import { expect, test, type Page } from '@playwright/test';

/**
 * `edytor/starter` in real browsers (`/test/starter`): the server render
 * hydrates without a warning, and the main flows (title into the first
 * block, icon, cover, a property, readonly) write the document's data.
 */
const open = async (page: Page, query = '') => {
	const warnings: string[] = [];
	page.on('console', (message) => {
		if (/hydrat|\[svelte\]/i.test(message.text())) warnings.push(message.text());
	});
	await page.goto(`/test/starter${query}`);
	await page.waitForFunction(() => {
		const view = (window as unknown as { __edytor?: { synced: boolean } }).__edytor;
		return view?.synced === true;
	});
	return warnings;
};
const data = (page: Page) =>
	page.evaluate(() =>
		JSON.parse(JSON.stringify((window as unknown as { __edytor: { data: object } }).__edytor.data))
	);

test('the server render hydrates without a warning', async ({ page }) => {
	const warnings = await open(page);
	await expect(page.locator('[data-edytor-starter-title] textarea')).toHaveValue('Starter page');
	expect(warnings).toEqual([]);
});

test('the title: typing writes the data, Enter moves into the first block', async ({ page }) => {
	await open(page);
	const title = page.getByRole('textbox', { name: 'Page title' });
	await title.click();
	await page.keyboard.press('End');
	await page.keyboard.type(' two');
	await page.keyboard.press('Enter');
	await page.keyboard.type('X');
	await expect(page.locator('[data-edytor]')).toContainText('XFirst block');
	expect((await data(page)).title).toBe('Starter page two');
});

test('the icon and the cover, with the keyboard', async ({ page }) => {
	await open(page);
	await page.locator('[data-edytor-starter-add-icon]').focus();
	await page.keyboard.press('Enter');
	const picker = page.getByRole('dialog', { name: 'Icon options' });
	await expect(picker).toBeVisible();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await expect(picker).toBeHidden();
	expect((await data(page)).icon).toEqual({ emoji: '📝' });
	await expect(page.locator('[data-edytor-starter-icon] button')).toBeFocused();

	await page.locator('[data-edytor-starter-add-cover]').focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-edytor-starter-cover] img')).toBeVisible();
	await page.locator('[data-edytor-starter-reposition]').click();
	const slider = page.getByRole('slider', { name: 'Reposition' });
	await expect(slider).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	expect((await data(page)).cover.position).toBe(48);

	await page.locator('[data-edytor-starter-change-cover]').click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Cover options' })).toBeHidden();
	await expect(page.locator('[data-edytor-starter-change-cover]')).toBeFocused();
});

test('a property: a select and an added one', async ({ page }) => {
	await open(page);
	await page.locator('[data-edytor-starter-property="status"] select').selectOption('done');
	await page.locator('[data-edytor-starter-add-property]').click();
	await page
		.getByRole('dialog', { name: 'Add a property' })
		.getByRole('button', { name: 'Notes' })
		.click();
	const notes = page.locator('[data-edytor-starter-property="notes"] input');
	await notes.fill('hello');
	const page_ = await data(page);
	expect(page_.properties).toMatchObject({ status: 'done', notes: 'hello' });
	expect(page_.shownProperties).toEqual({ notes: true });
	// The view's undo takes the last step back.
	await page.evaluate(() =>
		(window as unknown as { __edytor: { historyUndo(): void } }).__edytor.historyUndo()
	);
	await expect.poll(async () => (await data(page)).properties.notes).toBeUndefined();
});

test('readonly shows the values only', async ({ page }) => {
	const warnings = await open(page, '?readonly=1');
	await expect(page.locator('[data-edytor-starter-title]')).toHaveText('Starter page');
	await expect(
		page.locator('[data-edytor-starter] textarea, [data-edytor-starter] input')
	).toHaveCount(0);
	await expect(page.locator('[data-edytor-starter-add-icon]')).toHaveCount(0);
	await expect(page.locator('[data-edytor-starter-property="status"]')).toContainText('Doing');
	expect(warnings).toEqual([]);
});
