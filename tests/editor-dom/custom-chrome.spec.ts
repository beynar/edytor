/**
 * Custom chrome in a real engine: the block handle, the block menu, the
 * slash menu (`/` and `+`), the toolbar, a table's grips and menu and a code
 * block's header and language list, each drawn by an app's snippet that
 * uses the controllers' attachments (`/test/custom`, `?doc=table`,
 * `?doc=code`; `src/tests/dom/CustomChrome.svelte`), are driven by the
 * keyboard alone (a custom table grip still drags its row), and keep the
 * built-in ARIA: the element
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

/** The fixture page: three paragraphs, or a table (`table`) or a code block (`code`) between two. */
const open = async (page: Page, doc?: 'table' | 'code') => {
	await page.goto(`/test/custom${doc ? `?doc=${doc}` : ''}`);
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
		const grip = page.locator('[data-testid="custom-grip"][data-block-id="two"]');
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
		await page.locator('[data-testid="custom-grip"][data-block-id="three"]').click();
		await expect(page.getByTestId('custom-block-menu-field')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('custom-block-menu')).toHaveCount(0);
		await expect(root(page)).not.toHaveAttribute('aria-controls', /./);

		await text(page, 'three').hover();
		await page.locator('[data-testid="custom-grip"][data-block-id="three"]').click();
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
		const plus = page.locator('[data-testid="custom-add"][data-block-id="one"]');
		await plus.click();
		const field = page.getByTestId('custom-slash-field');
		await expect(field).toBeFocused();
		await expect(plus).toHaveAttribute('aria-expanded', 'true');
		// The handle's `add(alt, anchor)`: the menu opens under the custom `+`, not the block.
		const at = (await plus.boundingBox())!;
		await expect
			.poll(async () => (await page.locator('[data-edytor-slash-menu-host]').boundingBox())?.x)
			.toBeCloseTo(at.x, 0);
		const menuTop = (await page.locator('[data-edytor-slash-menu-host]').boundingBox())!.y;
		expect(menuTop).toBeGreaterThanOrEqual(at.y + at.height);
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
		await page.locator('[data-testid="custom-add"][data-block-id="two"]').click();
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

/** The table's grid as each cell's text. */
const grid = (page: Page) =>
	page.evaluate(() => {
		const { facade } = (
			window as unknown as {
				__EDYTOR__: {
					facade: {
						tableGrid: (id: string) => { rows: { cells: (string | null)[] }[] } | null;
						blockText: (id: string) => string;
					};
				};
			}
		).__EDYTOR__;
		return facade
			.tableGrid('T')
			?.rows.map((row) => row.cells.map((c) => (c === null ? '_' : facade.blockText(c))));
	});
const cellBox = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
/** The pointer over cell `id`: the table's chrome shows on its row and column. */
const overCell = async (page: Page, id: string) => {
	const at = await cellBox(page, id);
	await page.mouse.move(at.x + 10, at.y + at.height / 2);
};
const tableGrip = (page: Page, kind: 'row' | 'column') =>
	page.locator(`[data-testid="custom-table-grip"][data-kind="${kind}"]`);

type DragRecord = { __dragStarted?: boolean; __drag?: { type: string; at: [number, number] } };
/**
 * Note the drag events the page receives: in Chromium the protocol's drag
 * move is answered before the page handled it (`dragTo` in
 * `block-handles.spec.ts`, `table-drag.spec.ts`).
 */
const recordDrag = (page: Page) =>
	page.evaluate(() => {
		const record = window as unknown as DragRecord;
		record.__dragStarted = false;
		window.addEventListener('dragstart', () => (record.__dragStarted = true), { capture: true });
		for (const type of ['dragenter', 'dragover'])
			window.addEventListener(
				type,
				(event) => {
					const { clientX, clientY } = event as DragEvent;
					record.__drag = { type, at: [clientX, clientY] };
				},
				{ capture: true }
			);
	});
/** Move the pointer; in Chromium, wait until the page handled a drag event there. */
const dragTo = async (page: Page, x: number, y: number, over = false) => {
	await page.mouse.move(x, y);
	if (page.context().browser()?.browserType().name() !== 'chromium') return;
	await page.waitForFunction(
		([x, y, over]) => {
			const { __dragStarted, __drag } = window as unknown as DragRecord;
			if (!__dragStarted) return true;
			if (!__drag || (over && __drag.type !== 'dragover')) return false;
			return Math.abs(__drag.at[0] - x) <= 1 && Math.abs(__drag.at[1] - y) <= 1;
		},
		[x, y, over] as const
	);
};

test.describe('custom table and code chrome keep the keyboard and ARIA', () => {
	test('a table grip’s menu by the keyboard: ArrowDown opens it, the arrows walk it, Enter runs, Escape returns', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, 'table');
		await overCell(page, 'c');
		const grip = tableGrip(page, 'row');
		await expect(grip).toBeVisible();
		await expect(grip).toHaveAttribute('aria-haspopup', 'menu');
		await expect(grip).toHaveAttribute('aria-expanded', 'false');
		await expect(grip).toHaveAttribute('aria-label', 'Row options');
		await grip.focus();
		await page.keyboard.press('ArrowDown');
		const menu = page.getByTestId('custom-table-menu');
		await expect(menu).toBeFocused();
		await expect(menu).toHaveRole('menu');
		await expect(menu).toHaveAttribute('aria-label', 'Row options');
		await expect(grip).toHaveAttribute('aria-expanded', 'true');
		await expect(grip).toHaveAttribute('aria-controls', (await menu.getAttribute('id'))!);
		await expect(root(page)).toHaveAttribute('aria-controls', (await menu.getAttribute('id'))!);
		const rows = page.getByTestId('custom-table-row');
		await expect(menu).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(0).getAttribute('id'))!
		);
		await audit(page);
		await page.keyboard.press('End');
		await expect(menu).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(4).getAttribute('id'))!
		);
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowDown');
		const below = rows.nth(1);
		await expect(below).toHaveAttribute('data-row', 'insert-below');
		await expect(below).toHaveAttribute('data-selected', 'true');
		await expect(menu).toHaveAttribute('aria-activedescendant', (await below.getAttribute('id'))!);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(root(page)).not.toHaveAttribute('aria-controls', /./);
		await expect
			.poll(() => grid(page))
			.toEqual([
				['a', 'b'],
				['c', 'd'],
				['', ''],
				['e', 'f']
			]);

		// Escape closes it: the keys go back to the editor, nothing written.
		await overCell(page, 'a');
		await tableGrip(page, 'row').click();
		await expect(menu).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await expect(root(page)).toBeFocused();
		await expect.poll(async () => (await grid(page))?.length).toBe(4);
		issues.assertClean();
	});

	test('a custom grip still drags its row: dropped under the last row, the row moves there', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, 'table');
		await overCell(page, 'a');
		const grip = tableGrip(page, 'row');
		await expect(grip).toBeVisible();
		await expect(grip).toHaveAttribute('draggable', 'true');
		const g = (await grip.boundingBox())!;
		const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
		await page.mouse.move(at.x, at.y);
		await recordDrag(page);
		await page.mouse.down();
		const f = await cellBox(page, 'f');
		for (const point of [
			{ x: at.x, y: at.y + 6 },
			{ x: at.x + 20, y: at.y + 12 },
			{ x: f.x + 20, y: f.y + f.height * 0.8 }
		])
			await dragTo(page, point.x, point.y);
		await dragTo(page, f.x + 21, f.y + f.height * 0.8, true);
		await expect(page.locator('[data-edytor-table-drop="row"]')).toHaveAttribute('data-gap', '3');
		await page.mouse.up();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['c', 'd'],
				['e', 'f'],
				['a', 'b']
			]);
		issues.assertClean();
	});

	test('a code header and its language list by the keyboard: Alt+F10, ArrowDown, a query, Enter, Escape', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, 'code');
		await text(page, 'l0').click();
		await page.keyboard.press('Alt+F10');
		const button = page.getByTestId('custom-code-language');
		await expect(button).toBeFocused();
		await expect(button).toHaveText('SQL');
		await expect(button).toHaveAttribute('aria-haspopup', 'listbox');
		await expect(button).toHaveAttribute('aria-label', 'Code language: SQL');
		await page.keyboard.press('ArrowDown');
		const field = page.getByTestId('custom-language-field');
		await expect(field).toBeFocused();
		await expect(field).toHaveRole('combobox');
		const list = named(page, await field.getAttribute('aria-controls'));
		await expect(list).toHaveRole('listbox');
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		await expect(root(page)).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
		const sql = page.locator('[data-testid="custom-language-row"][data-language="sql"]');
		await expect(sql).toHaveAttribute('aria-selected', 'true');
		await expect(field).toHaveAttribute('aria-activedescendant', (await sql.getAttribute('id'))!);
		await audit(page);
		await page.keyboard.type('script');
		const rows = page.getByTestId('custom-language-row');
		await expect(rows).toHaveText(['JavaScript', 'TypeScript']);
		await page.keyboard.press('ArrowDown');
		await expect(field).toHaveAttribute(
			'aria-activedescendant',
			(await rows.nth(1).getAttribute('id'))!
		);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('custom-language-menu')).toHaveCount(0);
		// Opened by the keys: they go back to the button, which names the new language.
		await expect(button).toBeFocused();
		await expect(button).toHaveText('TypeScript');
		await expect
			.poll(() =>
				page.evaluate(() =>
					(
						window as unknown as {
							__EDYTOR__: { facade: { blockDataOf: (id: string) => unknown } };
						}
					).__EDYTOR__.facade.blockDataOf('code')
				)
			)
			.toEqual({ language: 'typescript' });
		await page.keyboard.press('Escape');
		await expect(root(page)).toBeFocused();
		issues.assertClean();
	});
});
