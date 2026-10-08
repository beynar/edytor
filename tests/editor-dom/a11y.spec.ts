/**
 * Accessibility in a real engine (WU-27, F7): an axe-core audit of the demo
 * editor and its chrome in each state a user meets (idle, the `/` menu, the
 * `+` menu, the block menu, the toolbar, a focused column band), against
 * WCAG 2.2 A and AA, and the keyboard paths the jsdom rows cannot prove
 * (`src/tests/fixtures/dom/a11y.test.tsx`): Alt+F10 into the
 * toolbar and back, a column band resized from the keyboard, a move
 * announced in the live region. Expected values come from WAI-ARIA 1.2 and
 * the WCAG rules, never from a run.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './editorTest';
import { setSelectionByTextIndex, trackPageIssues, waitForEditorReady } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/**
 * A known gap, on the Accessibility page: the grip (and a column block's `+`)
 * is Notion's 18px wide, under WCAG 2.2's 24px target size (2.5.8).
 */
const KNOWN_GAPS = ['target-size'];

/**
 * A popup the focused element names (`aria-controls` and
 * `aria-activedescendant`): its rows are reached, and scrolled into view,
 * from that element (WAI-ARIA's active-descendant pattern), so its own
 * scroll region needs no tab stop.
 */
const ownedByFocus = (page: Page, selector: string) =>
	page.evaluate((selector) => {
		const region = document.querySelector(selector);
		const owner = document.activeElement;
		return Boolean(
			region?.id &&
			owner?.getAttribute('aria-controls') === region.id &&
			owner.hasAttribute('aria-activedescendant')
		);
	}, selector);

/** The editor, its overlay (handles, menus, bands, live region): no WCAG A/AA violation. */
const audit = async (page: Page) => {
	// Colors are read once the menus' fade-in is over.
	await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
	const { violations } = await new AxeBuilder({ page })
		.include('.page-editor')
		.withTags(TAGS)
		.disableRules(KNOWN_GAPS)
		.analyze();
	const found: string[] = [];
	for (const { id, nodes } of violations) {
		const targets: string[] = [];
		for (const { target } of nodes) {
			const selector = target.join(' ');
			if (id === 'scrollable-region-focusable' && (await ownedByFocus(page, selector))) continue;
			targets.push(selector);
		}
		if (targets.length) found.push(`${id}: ${targets.join(' | ')}`);
	}
	expect(found).toEqual([]);
};

const open = async (page: Page) => {
	await page.goto('/');
	await waitForEditorReady(page);
};

const root = (page: Page) => page.getByRole('textbox', { name: 'A calmer place to think' });
/** The element an IDREF attribute of `locator` names. */
const named = (page: Page, id: string | null) => page.locator(`[id="${id}"]`);
const text = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();

test.describe('the demo editor passes an axe audit (WCAG 2.2 A/AA)', () => {
	test('idle: the root textbox is named, every handle labelled', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await expect(root(page)).toBeVisible();
		await expect(
			page.locator('[data-testid="block-handle"][data-block-id="page-section"]')
		).toHaveAttribute('aria-label', /^Heading \d block: drag to move, click for actions$/);
		await audit(page);
		issues.assertClean();
	});

	test('the / menu: the root names the listbox and its highlighted option', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await text(page, 'page-intro').click();
		await page.keyboard.press('End');
		await page.keyboard.type(' /');
		const listbox = page.getByRole('listbox', { name: 'Block commands' });
		await expect(listbox).toBeVisible();
		await expect(root(page)).toHaveAttribute('aria-controls', (await listbox.getAttribute('id'))!);
		const active = await root(page).getAttribute('aria-activedescendant');
		await expect(named(page, active)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('ArrowDown');
		await expect(root(page)).not.toHaveAttribute('aria-activedescendant', active!);
		await audit(page);
		await page.keyboard.press('Escape');
		await expect(root(page)).not.toHaveAttribute('aria-controls', /./);
		issues.assertClean();
	});

	test('the + menu: its field names the listbox; the + is expanded', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await text(page, 'page-intro').hover();
		const plus = page.locator(
			'[data-edytor-block-handle-host][data-block-id="page-intro"] [data-testid="block-add"]'
		);
		await plus.click();
		const field = page.getByRole('combobox', { name: 'Filter block commands' });
		await expect(field).toBeFocused();
		await expect(plus).toHaveAttribute('aria-expanded', 'true');
		await audit(page);
		await page.keyboard.press('Escape');
		await expect(plus).not.toHaveAttribute('aria-expanded', /./);
		issues.assertClean();
	});

	test('the block menu: its field names the highlighted item; the grip is expanded', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const grip = page.locator('[data-testid="block-handle"][data-block-id="page-section-intro"]');
		await text(page, 'page-section-intro').hover();
		await grip.click();
		const menu = page.getByRole('menu', { name: 'Block actions' });
		await expect(menu).toBeVisible();
		await expect(grip).toHaveAttribute('aria-expanded', 'true');
		const field = page.getByRole('textbox', { name: 'Search actions' });
		await expect(field).toBeFocused();
		await expect(named(page, await field.getAttribute('aria-activedescendant'))).toHaveRole(
			'menuitem'
		);
		await audit(page);
		issues.assertClean();
	});

	test('the toolbar: Alt+F10 moves the focus into it, Escape gives it back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const index = await text(page, 'page-section-intro').evaluate((node) =>
			[...document.querySelectorAll('[data-edytor-text]')].indexOf(node)
		);
		await setSelectionByTextIndex(page, index, 0, index, 5);
		const toolbar = page.getByRole('toolbar', { name: 'Text formatting' });
		await expect(toolbar).toBeVisible();
		await expect(root(page)).toHaveAttribute('aria-controls', (await toolbar.getAttribute('id'))!);
		await expect(root(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+F10');
		await audit(page);

		await page.keyboard.press('Alt+F10');
		const buttons = toolbar.getByRole('button');
		await expect(buttons.first()).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(buttons.nth(1)).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(root(page)).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length)).toBe(5);
		issues.assertClean();
	});
});

test.describe('keyboard paths', () => {
	test('a column band is a focusable separator the arrows resize', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		// The caret in a column: its layout's band is in the page.
		await text(page, 'page-column-left-text').click();
		const band = page.getByRole('separator', { name: 'Resize columns' });
		await expect(band).toHaveCount(1);
		await band.focus();
		const before = Number(await band.getAttribute('aria-valuenow'));
		await page.keyboard.press('Shift+ArrowRight');
		await expect
			.poll(async () => Number(await band.getAttribute('aria-valuenow')))
			.toBeGreaterThan(before);
		await expect(band).toBeFocused();
		await audit(page);
		await page.keyboard.press('ControlOrMeta+z');
		issues.assertClean();
	});

	test('a block move is announced in the polite live region', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await text(page, 'page-section-intro').click();
		await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
		const live = page.locator('[data-edytor-live]');
		await expect(live).toHaveAttribute('aria-live', 'polite');
		await expect(live).toHaveText('Moved Text block down');
		issues.assertClean();
	});
});
