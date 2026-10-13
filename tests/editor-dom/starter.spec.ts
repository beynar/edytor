import { expect, test, type Page } from '@playwright/test';

/**
 * The starter registry item in real browsers (`/test/starter`): the server
 * render hydrates without a warning, and the main flows (title into the
 * first block, icon, cover, the shadcn property controls, the date picker,
 * hidden properties, comments, readonly) write the document's data; under
 * shadcn's `.dark` the page and the menus turn dark together.
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
	await page
		.locator('[data-edytor-starter-property="status"] [data-slot="select-trigger"]')
		.click();
	await page.getByRole('option', { name: 'Done' }).click();
	await page.locator('[data-edytor-starter-add-property]').click();
	await page
		.locator('[data-edytor-starter-add-menu]')
		.getByRole('option', { name: 'Notes' })
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

test('a date: shown in the locale, picked from the calendar, stored as ISO', async ({ page }) => {
	const warnings = await open(page);
	const due = page.locator('[data-edytor-starter-property="due"]');
	await expect(due.locator('time')).toHaveText('Oct 13, 2026');
	await expect(due.locator('time')).toHaveAttribute('datetime', '2026-10-13');
	await due.locator('[data-edytor-starter-date]').click();
	const calendar = page.locator('[data-edytor-starter-calendar="due"]');
	await expect(calendar).toBeVisible();
	await calendar.locator('[data-bits-day]:not([data-outside-month])', { hasText: /^20$/ }).click();
	await expect(calendar).toBeHidden();
	expect((await data(page)).properties.due).toBe('2026-10-20');
	await expect(due.locator('time')).toHaveText('Oct 20, 2026');
	expect(warnings).toEqual([]);
});

test('hiding a property keeps its value, under the hidden properties', async ({ page }) => {
	await open(page);
	const status = page.locator('[data-edytor-starter-property="status"]');
	await status.hover();
	await status.locator('[data-edytor-starter-hide-property]').click();
	const page_ = await data(page);
	expect(page_.shownProperties.status).toBe(false);
	expect(page_.properties.status).toBe('doing');
	await page.locator('[data-edytor-starter-hidden-toggle]').click();
	const hidden = page.locator(
		'[data-edytor-starter-hidden-properties] [data-edytor-starter-property="status"]'
	);
	await expect(hidden).toContainText('Doing');
	await hidden.locator('[data-edytor-starter-show-property]').click();
	await expect(
		page.locator('[data-edytor-starter-property="status"]:not([data-hidden])')
	).toContainText('Doing');
});

test('dark: `.dark` flips the page and the menus to the dark tokens', async ({ page }) => {
	await open(page, '?theme=dark');
	const background = (selector: string) =>
		page
			.locator(selector)
			.first()
			.evaluate((node) => getComputedStyle(node).backgroundColor);
	// A colour's lightness, 0 to 255: the average of sRGB channels, or an OK space's L.
	const lightness = (color: string) => {
		const [first, ...rest] = color.match(/[\d.]+/g)!.map(Number);
		if (/^ok(lch|lab)/.test(color)) return first! * 255;
		return (first! + rest[0]! + rest[1]!) / 3;
	};
	expect(lightness(await background('[data-edytor-starter]'))).toBeLessThan(60);
	await page.locator('[data-edytor] [data-edytor-block]').last().click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('/');
	await expect(page.getByTestId('slash-menu')).toBeVisible();
	expect(lightness(await background('[data-testid="slash-menu"]'))).toBeLessThan(80);
	const text = await page
		.getByTestId('slash-menu-item')
		.first()
		.evaluate((node) => getComputedStyle(node).color);
	expect(lightness(text)).toBeGreaterThan(180);
	await page.keyboard.press('Escape');
	// The select's popup too.
	await page
		.locator('[data-edytor-starter-property="status"] [data-slot="select-trigger"]')
		.click();
	expect(lightness(await background('[data-slot="select-content"]'))).toBeLessThan(80);
});

test('comments: a thread on selected text, its card beside the page', async ({ page }) => {
	await open(page, '?comments=1');
	await page.locator('[data-edytor]').getByText('First block').dblclick();
	await page.getByTestId('toolbar-comment').click();
	const field = page.locator('[data-edytor-comment-new] textarea');
	await expect(field).toBeFocused();
	await page.keyboard.type('Looks good');
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-edytor-comment-card]').first()).toContainText('Looks good');
	await expect(page.locator('[data-edytor-comment-card]').first()).toContainText('Ada Lovelace');
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
