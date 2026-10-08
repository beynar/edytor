import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Tables in real browsers (`table.*` in the delete contract, Notion's simple
 * table): the grid lays cells out side by side, a click places the caret in
 * a cell, Enter is a line break, Backspace at a cell's start stays, Tab and
 * the vertical arrows walk the cells, Tab in the last cell adds a row, the
 * chrome's grip menu and `+` add rows, and a column's band resizes it. The
 * jsdom rows are `src/tests/fixtures/dom/table-20261008.test.tsx`.
 *
 * `P "before", T{c1, c2}[R1[A "alpha", B "beta"], R2[C "gamma", D "delta"]], Z "after"`.
 */

type Edytor = {
	selection: { state: { startBlock?: { id: string }; yStart: number; isCollapsed: boolean } };
	facade: {
		tableGrid: (id: string) => { columns: string[]; rows: { cells: (string | null)[] }[] } | null;
		blockText: (id: string) => string;
		tableColumns: (id: string) => { id: string; width?: number }[] | null;
	};
};

const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=table');
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The table's grid as each cell's text, `_` for a padded cell. */
const grid = (page: Page) =>
	page.evaluate(() => {
		const { facade } = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		return facade
			.tableGrid('T')
			?.rows.map((row) => row.cells.map((c) => (c === null ? '_' : facade.blockText(c))));
	});

const caret = (page: Page) =>
	page.evaluate(() => {
		const { state } = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection;
		return { block: state.startBlock?.id ?? null, offset: state.yStart };
	});

/** The block holding the native selection's focus (what the projector displayed). */
const nativeBlock = (page: Page) =>
	page.evaluate(
		() =>
			getSelection()
				?.focusNode?.parentElement?.closest('[data-edytor-block]')
				?.getAttribute('data-edytor-id') ?? null
	);

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;

/** Click at the end of a cell's text: the caret lands there. */
const clickEnd = async (page: Page, id: string) => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const rect = (await text.boundingBox())!;
	await page.mouse.click(rect.x + rect.width - 1, rect.y + rect.height / 2);
	await expect.poll(() => nativeBlock(page)).toBe(id);
	await page.keyboard.press('End');
	await expect
		.poll(() => caret(page))
		.toEqual({ block: id, offset: (await text.innerText()).length });
};

test.describe('table: the grid', () => {
	test('cells lay out side by side, rows one under the other, in the columns’ widths', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const [a, b, c] = [await box(page, 'A'), await box(page, 'B'), await box(page, 'C')];
		expect(Math.abs(a.y - b.y)).toBeLessThan(1);
		expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
		expect(Math.abs(a.x - c.x)).toBeLessThan(1);
		expect(c.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
		expect(Math.round(a.width)).toBe(120);
		issues.assertClean();
	});
});

test.describe('table: keys in a cell', () => {
	test('typing and Enter stay in the cell: a line break, no new row', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await clickEnd(page, 'A');
		await page.keyboard.type('!');
		await page.keyboard.press('Enter');
		await page.keyboard.type('two');
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha!\ntwo', 'beta'],
				['gamma', 'delta']
			]);
		await expect.poll(() => caret(page)).toEqual({ block: 'A', offset: 10 });
		issues.assertClean();
	});

	test('Backspace at a cell’s start writes nothing and keeps the caret', async ({ page }) => {
		await open(page);
		await clickEnd(page, 'B');
		await page.keyboard.press('Home');
		await expect.poll(() => caret(page)).toEqual({ block: 'B', offset: 0 });
		await page.keyboard.press('Backspace');
		await expect.poll(() => caret(page)).toEqual({ block: 'B', offset: 0 });
		expect(await grid(page)).toEqual([
			['alpha', 'beta'],
			['gamma', 'delta']
		]);
	});

	test('Tab walks the cells; Tab in the last cell adds a row and types there', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await clickEnd(page, 'A');
		await page.keyboard.press('Tab');
		await expect.poll(() => caret(page)).toEqual({ block: 'B', offset: 4 });
		await page.keyboard.press('Tab');
		await expect.poll(() => caret(page)).toEqual({ block: 'C', offset: 5 });
		await page.keyboard.press('Shift+Tab');
		await expect.poll(() => caret(page)).toEqual({ block: 'B', offset: 4 });
		// The caret is displayed before the next press.
		await expect.poll(() => nativeBlock(page)).toBe('B');
		await clickEnd(page, 'D');
		await page.keyboard.press('Tab');
		await page.keyboard.type('new');
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha', 'beta'],
				['gamma', 'delta'],
				['new', '']
			]);
		issues.assertClean();
	});

	test('ArrowDown and ArrowUp go down and up the column', async ({ page }) => {
		await open(page);
		await clickEnd(page, 'A');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page)).toEqual({ block: 'C', offset: 5 });
		await page.keyboard.press('ArrowUp');
		await expect.poll(() => caret(page)).toEqual({ block: 'A', offset: 5 });
		await page.keyboard.type('x');
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alphax', 'beta'],
				['gamma', 'delta']
			]);
	});
});

test.describe('table: the chrome', () => {
	test('a row’s grip menu inserts a row below; the `+` under the table adds one at its end', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const a = await box(page, 'A');
		await page.mouse.move(a.x + 10, a.y + a.height / 2);
		const grip = page.locator('[data-edytor-table-grip="row"]');
		await expect(grip).toBeVisible();
		await grip.click();
		await page.locator('[data-testid="table-menu-insert-below"]').click();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha', 'beta'],
				['', ''],
				['gamma', 'delta']
			]);
		const d = await box(page, 'D');
		await page.mouse.move(d.x + 10, d.y + d.height / 2);
		const add = page.locator('[data-edytor-table-add="row"]');
		await add.hover();
		await add.click();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha', 'beta'],
				['', ''],
				['gamma', 'delta'],
				['', '']
			]);
		issues.assertClean();
	});

	test('dragging a column’s edge resizes it, one write at the release', async ({ page }) => {
		await open(page);
		const a = await box(page, 'A');
		await page.mouse.move(a.x + 10, a.y + a.height / 2);
		const band = page.locator('[data-edytor-table-resize="0"]');
		const edge = (await band.boundingBox())!;
		await page.mouse.move(edge.x + edge.width / 2, edge.y + 10);
		await page.mouse.down();
		await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + 10, { steps: 4 });
		await page.mouse.up();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.facade.tableColumns('T')?.[0]
							?.width
				)
			)
			.toBe(180);
		expect(Math.round((await box(page, 'A')).width)).toBe(180);
	});
});
