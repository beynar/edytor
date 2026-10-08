/**
 * Custom chrome in a real engine: the block menu, the slash menu (`/` and
 * `+`) and the toolbar each drawn by an app's snippet that uses the
 * controllers' attachments (`/test/custom`, `src/tests/dom/CustomChrome.svelte`)
 * are driven by the keyboard alone, and keep the built-in ARIA: the element
 * holding the keyboard names the open popup and its highlighted row, the
 * root names the popup, the opener is expanded (WAI-ARIA 1.2), and each
 * state passes an axe audit (WCAG 2.2 A/AA). Expected values come from the
 * default markup's rows (`a11y.spec.ts`, `slash-menu.spec.ts`,
 * `toolbar.spec.ts`), never from a run of the custom one.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './editorTest';
import { modKey, setSelectionByTextIndex, trackPageIssues, waitForEditorReady } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The grip's 18px target, a known gap (site `editor/accessibility`). */
const KNOWN_GAPS = ['target-size'];

const audit = async (page: Page) => {
	const { violations } = await new AxeBuilder({ page })
		.include('main')
		.withTags(TAGS)
		.disableRules(KNOWN_GAPS)
		.analyze();
	expect(violations.map(({ id, nodes }) => `${id}: ${nodes.length}`)).toEqual([]);
};

const open = async (page: Page) => {
	await page.goto('/test/custom');
	await waitForEditorReady(page);
};

const root = (page: Page) => page.getByRole('textbox', { name: 'Custom chrome' });
/** The element an IDREF names. */
const named = (page: Page, id: string | null) => page.locator(`[id="${id}"]`);
const text = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
/** The view's blocks, as the document holds them. */
const blocks = (page: Page) =>
	page.evaluate(() =>
		(
			(
				window as unknown as {
					__EDYTOR__: { value: { children?: Array<Record<string, unknown>> } };
				}
			).__EDYTOR__.value.children ?? []
		).map((block) => ({ id: block.id, type: block.type, content: block.content }))
	);

test.describe('custom chrome snippets keep the keyboard and ARIA', () => {
	test('the block menu: its field walks the rows, → opens Turn into, Enter turns the block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const grip = page.locator('[data-testid="block-handle"][data-block-id="two"]');
		await text(page, 'two').hover();
		await grip.click();
		const field = page.getByTestId('custom-block-menu-field');
		await expect(field).toBeFocused();
		await expect(grip).toHaveAttribute('aria-expanded', 'true');
		const menu = named(page, await field.getAttribute('aria-controls'));
		await expect(menu).toHaveRole('menu');
		await expect(root(page)).toHaveAttribute('aria-controls', (await menu.getAttribute('id'))!);
		const rows = page.getByTestId('custom-block-menu-row');
		await expect(field).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(0).getAttribute('id'))!
		);
		await page.keyboard.press('ArrowDown');
		await expect(field).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(1).getAttribute('id'))!
		);
		await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
		await audit(page);

		// Back to Turn into, → opens its flyout; the field now names it.
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowRight');
		const flyout = page.getByTestId('custom-block-menu-flyout');
		await expect(flyout).toBeVisible();
		await expect(field).toHaveAttribute('aria-controls', (await flyout.getAttribute('id'))!);
		await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
		// The arrows walk the kinds down to Heading 1.
		const kinds = flyout.getByRole('menuitem');
		const at = (await kinds.allTextContents()).indexOf('Heading 1');
		expect(at).toBeGreaterThan(0);
		for (let step = 0; step < at; step++) await page.keyboard.press('ArrowDown');
		const heading = kinds.nth(at);
		await expect(heading).toHaveAttribute('data-selected', 'true');
		await expect(field).toHaveAttribute(
			'aria-activedescendant',
			(await heading.getAttribute('id'))!
		);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('custom-block-menu')).toHaveCount(0);
		await expect(grip).not.toHaveAttribute('aria-expanded', /./);
		await expect.poll(async () => (await blocks(page))[1]?.type).toBe('heading');
		issues.assertClean();
	});

	test('the block menu: typing filters the rows, Enter runs Delete, Escape closes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await text(page, 'three').hover();
		await page.locator('[data-testid="block-handle"][data-block-id="three"]').click();
		await expect(page.getByTestId('custom-block-menu-field')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('custom-block-menu')).toHaveCount(0);
		await expect(root(page)).not.toHaveAttribute('aria-controls', /./);

		await text(page, 'three').hover();
		await page.locator('[data-testid="block-handle"][data-block-id="three"]').click();
		await page.keyboard.type('delete');
		await expect(page.getByTestId('custom-block-menu-row')).toHaveText(['Delete']);
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => (await blocks(page)).map((block) => block.id))
			.toEqual(['one', 'two']);
		issues.assertClean();
	});

	test('the `/` menu: the root names the highlighted row; the arrows and Enter run it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 11);
		await page.keyboard.type(' /head');
		const listbox = page.getByTestId('custom-slash-menu').getByRole('listbox');
		await expect(listbox).toBeVisible();
		await expect(root(page)).toHaveAttribute('aria-controls', (await listbox.getAttribute('id'))!);
		await expect(root(page)).toHaveAttribute('aria-haspopup', 'listbox');
		const rows = page.getByTestId('custom-slash-row');
		await expect(rows.first()).toHaveText('Heading 1');
		await expect(root(page)).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(0).getAttribute('id'))!
		);
		await audit(page);
		await page.keyboard.press('ArrowDown');
		await expect(rows.nth(1)).toHaveText('Heading 2');
		await expect(root(page)).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(1).getAttribute('id'))!
		);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('custom-slash-menu')).toHaveCount(0);
		await expect(root(page)).not.toHaveAttribute('aria-activedescendant', /./);
		await expect.poll(async () => (await blocks(page))[0]?.type).toBe('heading');
		await expect(page.locator('h2')).toHaveText('hello world');
		issues.assertClean();
	});

	test('the `+` menu: its own field takes the keys; typing filters, Enter adds the block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await text(page, 'one').hover();
		const plus = page.locator(
			'[data-edytor-block-handle-host][data-block-id="one"] [data-testid="block-add"]'
		);
		await plus.click();
		const field = page.getByTestId('custom-slash-field');
		await expect(field).toBeFocused();
		await expect(plus).toHaveAttribute('aria-expanded', 'true');
		const rows = page.getByTestId('custom-slash-row');
		await expect(field).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(0).getAttribute('id'))!
		);
		await audit(page);
		await page.keyboard.type('quote');
		await expect(rows.first()).toHaveText('Quote');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('custom-slash-menu')).toHaveCount(0);
		await expect(plus).not.toHaveAttribute('aria-expanded', /./);
		await expect
			.poll(async () => (await blocks(page)).map((block) => block.type))
			.toEqual(['paragraph', 'quote', 'paragraph', 'paragraph']);

		// Escape closes it, nothing added.
		await text(page, 'two').hover();
		await page
			.locator('[data-edytor-block-handle-host][data-block-id="two"] [data-testid="block-add"]')
			.click();
		await expect(page.getByTestId('custom-slash-field')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('custom-slash-menu')).toHaveCount(0);
		await expect.poll(async () => (await blocks(page)).length).toBe(4);
		issues.assertClean();
	});

	test('the toolbar: Alt+F10 reaches it, the arrows walk it, Enter formats, Escape returns', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);
		const toolbar = page.getByTestId('custom-toolbar');
		await expect(toolbar).toBeVisible();
		await expect(toolbar).toHaveRole('toolbar');
		await expect(root(page)).toHaveAttribute('aria-controls', (await toolbar.getAttribute('id'))!);
		await expect(root(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+F10');
		await audit(page);

		await page.keyboard.press('Alt+F10');
		const buttons = toolbar.getByRole('button');
		await expect(buttons.first()).toBeFocused();
		await expect(buttons.first()).toHaveAttribute('tabindex', '0');
		await page.keyboard.press('ArrowRight');
		await expect(buttons.nth(1)).toBeFocused();
		await expect(buttons.nth(1)).toHaveAttribute('tabindex', '0');
		await expect(buttons.first()).toHaveAttribute('tabindex', '-1');
		await page.keyboard.press('ArrowLeft');
		await expect(buttons.first()).toBeFocused();
		// The first mark is bold: Enter presses it.
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => (await blocks(page))[0]?.content)
			.toEqual([{ text: 'hello', marks: { bold: true } }, { text: ' world' }]);
		await page.keyboard.press('Escape');
		await expect(root(page)).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('hello');

		// Mod+K: the custom link field takes the focus; Enter links the selection.
		await page.keyboard.press(`${modKey}+k`);
		const field = page.getByTestId('custom-toolbar-link-field');
		await expect(field).toBeFocused();
		await expect(page.locator(`label[for="${await field.getAttribute('id')}"]`)).toHaveCount(1);
		await page.keyboard.type('https://edytor.dev');
		await page.keyboard.press('Enter');
		await expect(root(page)).toBeFocused();
		await expect
			.poll(async () => (await blocks(page))[0]?.content)
			.toEqual([
				{ text: 'hello', marks: { bold: true, link: { href: 'https://edytor.dev' } } },
				{ text: ' world' }
			]);
		issues.assertClean();
	});
});
