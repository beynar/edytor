import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Tables in real browsers (`table.*` in the delete contract, Notion's simple
 * table): the grid lays cells out side by side, a click places the caret in
 * a cell, Enter is a line break, Backspace at a cell's start stays, Tab and
 * the vertical arrows walk the cells, Tab in the last cell adds a row, the
 * chrome's grip menu and `+` add rows, and a column's band resizes it. The
 * jsdom rows are `src/tests/fixtures/dom/table.test.tsx`.
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

/**
 * Click at the end of a cell's text: the caret lands there. The click is
 * adopted before the next key (Chromium may deliver its `selectionchange`
 * after a key pressed at once, which then acts from the caret before it).
 */
const clickEnd = async (page: Page, id: string) => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const rect = (await text.boundingBox())!;
	await page.mouse.click(rect.x + rect.width - 1, rect.y + rect.height / 2);
	await expect.poll(() => nativeBlock(page)).toBe(id);
	await expect.poll(async () => (await caret(page)).block).toBe(id);
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
		await page.keyboard.press('Home');
		await expect.poll(() => caret(page)).toEqual({ block: 'A', offset: 0 });
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page)).toEqual({ block: 'C', offset: 0 });
		await page.keyboard.press('ArrowUp');
		await expect.poll(() => caret(page)).toEqual({ block: 'A', offset: 0 });
		await page.keyboard.type('x');
		await expect
			.poll(() => grid(page))
			.toEqual([
				['xalpha', 'beta'],
				['gamma', 'delta']
			]);
	});

	// Where the lines wrap depends on the font: the page's, and a monospace one
	// whose first line is shorter than the caret's x coming up from the end, so
	// the browser shows the caret at its wrap offset at that line's end (the
	// offset that is also the next line's start). Linux's fonts wrap the page's
	// that way too: shown there, the browser's own ArrowUp left the cell for
	// the row's other cell (DOM order).
	for (const font of ['', 'monospace'])
		test(`a wrapped cell: the arrows move through its lines, and leave it only from its edge lines${font ? ` (${font})` : ''}`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await open(page);
			if (font) await page.addStyleTag({ content: `[data-edytor-table] { font-family: ${font} }` });
			await clickEnd(page, 'C');
			await page.keyboard.type(' and then a long sentence that wraps over several lines here');
			/** The offsets where `id`'s line boxes start (the first at 0), from its characters' boxes. */
			const starts = () =>
				page.evaluate(() => {
					const text = document.querySelector('[data-edytor-id="C"] [data-edytor-text]')!;
					const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
					const range = document.createRange();
					const out: number[] = [];
					let top = -Infinity;
					let at = 0;
					for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
						const length = (leaf as CharacterData).length;
						for (let i = 0; i < length; i++) {
							range.setStart(leaf, i);
							range.setEnd(leaf, i + 1);
							const rect = range.getClientRects()[0];
							if (rect && rect.top > top + rect.height / 2) {
								out.push(at + i);
								top = rect.top;
							}
						}
						at += length;
					}
					return out;
				});
			const lines = await starts();
			expect(lines.length).toBeGreaterThan(2);
			// ArrowUp from the end: it stays in the cell, line by line, until its first line.
			let presses = 0;
			let last = await caret(page);
			for (; presses < 20; presses++) {
				await page.keyboard.press('ArrowUp');
				await expect.poll(() => caret(page)).not.toEqual(last);
				const now = await caret(page);
				if (now.block !== 'C') break;
				expect(now.offset).toBeLessThan(last.offset);
				last = now;
			}
			expect((await caret(page)).block).toBe('A');
			expect(presses).toBeGreaterThanOrEqual(lines.length - 1);
			// It left from the first line (an offset at its end is on it too).
			expect(last.offset).toBeLessThanOrEqual(lines[1]!);
			// ArrowDown from `A`: the first line of `C`, then the next one, still in `C`.
			await page.keyboard.press('ArrowDown');
			await expect.poll(async () => (await caret(page)).block).toBe('C');
			const first = await caret(page);
			expect(first.offset).toBeLessThanOrEqual(lines[1]!);
			await page.keyboard.press('ArrowDown');
			await expect.poll(async () => (await caret(page)).offset).toBeGreaterThan(first.offset);
			const second = await caret(page);
			expect(second.block).toBe('C');
			expect(second.offset).toBeGreaterThanOrEqual(lines[1]!);
			expect(second.offset).toBeLessThanOrEqual(lines[2]!);
			issues.assertClean();
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
