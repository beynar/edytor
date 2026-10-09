import { expect, test, type Page } from './editorTest';
import { modKey, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * The table's chrome in real browsers: a column's resize stops at the edge
 * of the table's place (`table.width.fit`), a table wider than its place
 * scrolls in its own box and shows its chrome over its visible part only
 * (`table.overflow`), and rows and columns drag by their grips
 * (`table.drag`, Pragmatic drag and drop's native drag). The jsdom rows are
 * `src/tests/fixtures/dom/table-drag.test.tsx`.
 *
 * `P "before", T{c1, c2}[R1[A "alpha", B "beta"], R2[C "gamma", D "delta"]], Z "after"`.
 */

type Edytor = {
	facade: {
		tableGrid: (id: string) => { columns: string[]; rows: { cells: (string | null)[] }[] } | null;
		blockText: (id: string) => string;
		tableColumns: (id: string) => { id: string; width?: number }[] | null;
	};
};

const cell = (id: string, column: string, text: string) => ({
	id,
	type: 'tableCell',
	data: { column },
	content: [{ text }]
});
const table = (widths: (number | undefined)[] = []) => ({
	id: 'T',
	type: 'table',
	data: {
		columns: ['c1', 'c2', 'c3']
			.slice(0, Math.max(2, widths.length))
			.map((id, i) => (widths[i] ? { id, width: widths[i] } : { id }))
	},
	children: [
		{
			id: 'R1',
			type: 'tableRow',
			children: [cell('A', 'c1', 'alpha'), cell('B', 'c2', 'beta')]
		},
		{
			id: 'R2',
			type: 'tableRow',
			children: [cell('C', 'c1', 'gamma'), cell('D', 'c2', 'delta')]
		}
	]
});
const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

const open = async (page: Page, children?: unknown[], query = '') => {
	const dst = children ? `&dst=${encodeURIComponent(JSON.stringify({ children }))}` : '';
	await page.goto(`/test/dom?scenario=table${dst}${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
	// A document column narrower than the window (the test page is as wide as its debug output).
	await page.addStyleTag({ content: '[data-edytor] { max-width: 640px; }' });
};

/** The table's grid as each cell's text. */
const grid = (page: Page) =>
	page.evaluate(() => {
		const { facade } = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		return facade
			.tableGrid('T')
			?.rows.map((row) => row.cells.map((c) => (c === null ? '_' : facade.blockText(c))));
	});

const box = async (page: Page, selector: string) =>
	(await page.locator(selector).first().boundingBox())!;
const blockBox = (page: Page, id: string) => box(page, `[data-edytor-id="${id}"]`);

/** The pointer over cell `id`: the chrome shows on its table, row and column. */
const hover = async (page: Page, id: string) => {
	const at = await blockBox(page, id);
	await page.mouse.move(at.x + 10, at.y + at.height / 2);
};

/** The table's scroller: its client box (what shows) and its content's width. */
const scroller = (page: Page) =>
	page.evaluate(() => {
		const node = document.querySelector<HTMLElement>(
			'[data-edytor-id="T"] [data-edytor-table-scroll]'
		)!;
		const rect = node.getBoundingClientRect();
		const grid = node.querySelector('[data-edytor-table-grid]')!.getBoundingClientRect();
		return {
			left: rect.left + node.clientLeft,
			right: rect.left + node.clientLeft + node.clientWidth,
			clientWidth: node.clientWidth,
			scrollWidth: node.scrollWidth,
			gridRight: grid.right
		};
	});

const storedWidths = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.facade
			.tableColumns('T')
			?.map((c) => c.width ?? null)
	);

/** Drag column `index`'s band to the viewport's right edge, then release. */
const resizeToEdge = async (page: Page, index: number, release = true) => {
	const band = await box(page, `[data-edytor-table-resize="${index}"]`);
	const x = band.x + band.width / 2;
	const y = band.y + 10;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(page.viewportSize()!.width - 4, y, { steps: 6 });
	if (release) await page.mouse.up();
};

test.describe('table.width.fit: a resize stops at the edge of the table’s place', () => {
	test('at the top level: the content column’s edge, in the preview and the written width', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await hover(page, 'B');
		await resizeToEdge(page, 1, false);
		// The preview, mid-drag: the grid fills the box and no more.
		await expect.poll(async () => (await scroller(page)).gridRight).toBeGreaterThan(0);
		const during = await scroller(page);
		expect(during.scrollWidth).toBeLessThanOrEqual(during.clientWidth);
		expect(during.gridRight).toBeLessThanOrEqual(during.right + 0.5);
		await page.mouse.up();
		const after = await scroller(page);
		await expect
			.poll(async () => (await storedWidths(page))?.[1])
			.toBeGreaterThan(after.clientWidth - 120 - 1 - 2);
		const [, written] = (await storedWidths(page))!;
		// The 1px border and the first column's 120px: the rest is the second's.
		expect(written! + 120 + 1).toBeLessThanOrEqual(after.clientWidth);
		expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);
		expect(after.gridRight).toBeLessThanOrEqual(after.right + 0.5);
		// The page's paragraph shares the content column: the table ends inside it.
		const p = await blockBox(page, 'P');
		expect(after.right).toBeLessThanOrEqual(p.x + p.width + 0.5);
		issues.assertClean();
	});

	test('table.width.neighbour: a full-width table’s first column grows into the second', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		// The second column fills the page: no free room left.
		await hover(page, 'B');
		await resizeToEdge(page, 1);
		await expect.poll(async () => (await storedWidths(page))?.[1]).not.toBeNull();
		const [, full] = (await storedWidths(page))!;
		await hover(page, 'A');
		const band = await box(page, '[data-edytor-table-resize="0"]');
		const y = band.y + 10;
		await page.mouse.move(band.x + band.width / 2, y);
		await page.mouse.down();
		await page.mouse.move(band.x + band.width / 2 + 100, y, { steps: 6 });
		await page.mouse.up();
		await expect.poll(async () => (await storedWidths(page))?.[0]).toBe(220);
		// The second gave the 100px: the table is no wider, still inside the page.
		expect((await storedWidths(page))![1]).toBe(full! - 100);
		const after = await scroller(page);
		expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);
		// One undo step puts both widths back.
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
		await expect.poll(() => storedWidths(page)).toEqual([null, full]);
		issues.assertClean();
	});

	test('inside a column layout: the column’s edge', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [
			paragraph('P', 'before'),
			{
				id: 'L',
				type: 'columns',
				children: [
					{ id: 'K1', type: 'column', children: [table()] },
					{ id: 'K2', type: 'column', children: [paragraph('Q', 'beside')] }
				]
			},
			paragraph('Z', 'after')
		]);
		await hover(page, 'B');
		await resizeToEdge(page, 1);
		await expect.poll(async () => (await storedWidths(page))?.[1]).not.toBeNull();
		const after = await scroller(page);
		const column = await blockBox(page, 'K1');
		const beside = await blockBox(page, 'K2');
		expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);
		expect(after.gridRight).toBeLessThanOrEqual(column.x + column.width + 0.5);
		expect(after.gridRight).toBeLessThan(beside.x);
		issues.assertClean();
	});
});

test.describe('table.overflow: a table wider than its place scrolls in its own box', () => {
	test('stored widths wider than the page: the box keeps to the content column; the chrome to the box', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [paragraph('P', 'before'), table([500, 500, 500]), paragraph('Z', 'after')]);
		const p = await blockBox(page, 'P');
		const t = await blockBox(page, 'T');
		expect(t.x + t.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
		const view = await scroller(page);
		expect(view.scrollWidth).toBeGreaterThan(view.clientWidth);
		expect(view.right).toBeLessThanOrEqual(p.x + p.width + 0.5);
		// Nothing was rewritten for the view.
		expect(await storedWidths(page)).toEqual([500, 500, 500]);
		await hover(page, 'A');
		await expect(page.locator('[data-edytor-table-grip="row"]')).toBeVisible();
		const bands = page.locator('[data-edytor-table-resize]');
		await expect(bands.first()).toBeAttached();
		for (const band of await bands.all()) {
			const b = (await band.boundingBox())!;
			expect(b.x + b.width / 2).toBeLessThanOrEqual(view.right + 1);
		}
		await expect(page.locator('[data-edytor-table-add="column"]')).toHaveCount(0);
		const add = await box(page, '[data-edytor-table-add="row"]');
		expect(add.x + add.width).toBeLessThanOrEqual(view.right + 0.5);
		// Scrolled to its end: the last column's band and the `+` beside it show.
		await page.evaluate(() => {
			const node = document.querySelector<HTMLElement>('[data-edytor-table-scroll]')!;
			node.scrollLeft = node.scrollWidth;
		});
		// The pointer over the last column's (padded) cell, now in view.
		const a = await blockBox(page, 'A');
		await page.mouse.move(view.right - 20, a.y + a.height / 2);
		await expect(page.locator('[data-edytor-table-add="column"]')).toBeVisible();
		await expect(page.locator('[data-edytor-table-resize="2"]')).toBeAttached();
		issues.assertClean();
	});
});

/**
 * Note the drag events the page receives (`dragenter`, `dragover`): in
 * Chromium the protocol's drag move is answered before the page handled it
 * (`dragTo` in `block-handles.spec.ts`).
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
type DragRecord = { __dragStarted?: boolean; __drag?: { type: string; at: [number, number] } };

/**
 * Move the pointer; in Chromium, wait until the page handled a drag event
 * there (a `dragover` with `over`).
 */
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

/** Press the `kind` grip of cell `id`'s row or column. */
const pressGrip = async (page: Page, kind: 'row' | 'column', id: string) => {
	await hover(page, id);
	const grip = page.locator(`[data-edytor-table-grip="${kind}"]`);
	await expect(grip).toBeVisible();
	const g = (await grip.boundingBox())!;
	const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
	await page.mouse.move(at.x, at.y);
	await recordDrag(page);
	await page.mouse.down();
	return at;
};

/**
 * Drag along `path` (a few steps from the grip), each point handled before
 * the next; the last one twice, a pixel apart: the drag library reads the
 * pointer from `dragover`, which Chromium's protocol sends only for a move
 * within the element entered.
 */
const dragAlong = async (page: Page, path: { x: number; y: number }[]) => {
	for (const point of path) await dragTo(page, point.x, point.y);
	const last = path[path.length - 1]!;
	await dragTo(page, last.x + 1, last.y, true);
};

test.describe('table.drag: rows and columns drag by their grips', () => {
	test('a row dragged under the last row moves there; Undo puts it back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await pressGrip(page, 'row', 'A');
		const d = await blockBox(page, 'D');
		await dragAlong(page, [
			{ x: at.x, y: at.y + 6 },
			{ x: at.x + 20, y: at.y + 12 },
			{ x: d.x + 20, y: d.y + d.height * 0.8 }
		]);
		const line = page.locator('[data-edytor-table-drop="row"]');
		await expect(line).toHaveAttribute('data-gap', '2');
		const bar = (await line.boundingBox())!;
		expect(Math.abs(bar.y + bar.height / 2 - (d.y + d.height))).toBeLessThanOrEqual(3);
		await page.mouse.up();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['gamma', 'delta'],
				['alpha', 'beta']
			]);
		await expect(line).toHaveCount(0);
		// The keys are the editor's: Undo right after the drop.
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha', 'beta'],
				['gamma', 'delta']
			]);
		issues.assertClean();
	});

	test('a column dragged past the last column moves there; its cells follow it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await pressGrip(page, 'column', 'A');
		const b = await blockBox(page, 'B');
		await dragAlong(page, [
			{ x: at.x + 6, y: at.y },
			{ x: at.x + 12, y: at.y + 20 },
			{ x: b.x + b.width * 0.8, y: b.y + b.height / 2 }
		]);
		await expect(page.locator('[data-edytor-table-drop="column"]')).toHaveAttribute(
			'data-gap',
			'2'
		);
		await page.mouse.up();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['beta', 'alpha'],
				['delta', 'gamma']
			]);
		const [a, b2, c, d] = [
			await blockBox(page, 'A'),
			await blockBox(page, 'B'),
			await blockBox(page, 'C'),
			await blockBox(page, 'D')
		];
		expect(b2.x).toBeLessThan(a.x);
		expect(Math.abs(a.x - c.x)).toBeLessThan(1);
		expect(Math.abs(b2.x - d.x)).toBeLessThan(1);
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(() => grid(page))
			.toEqual([
				['alpha', 'beta'],
				['gamma', 'delta']
			]);
		issues.assertClean();
	});

	test('a drop outside the table or at its own place writes nothing', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const before = await grid(page);
		let at = await pressGrip(page, 'row', 'A');
		const z = await blockBox(page, 'Z');
		await dragAlong(page, [
			{ x: at.x, y: at.y + 6 },
			{ x: at.x + 300, y: z.y + 200 }
		]);
		await expect(page.locator('[data-edytor-table-drop]')).toHaveCount(0);
		await page.mouse.up();
		at = await pressGrip(page, 'row', 'C');
		const c = await blockBox(page, 'C');
		await dragAlong(page, [
			{ x: at.x, y: at.y + 6 },
			{ x: c.x + 20, y: c.y + c.height * 0.7 }
		]);
		await expect(page.locator('[data-edytor-table-drop]')).toHaveCount(0);
		await page.mouse.up();
		expect(await grid(page)).toEqual(before);
		issues.assertClean();
	});

	test('a click on a grip with no drag opens its menu', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await hover(page, 'B');
		await page.locator('[data-edytor-table-grip="column"]').click();
		await expect(page.locator('[data-edytor-table-menu="column"]')).toBeVisible();
		await page.locator('[data-testid="table-menu-move-left"]').click();
		await expect
			.poll(() => grid(page))
			.toEqual([
				['beta', 'alpha'],
				['delta', 'gamma']
			]);
		issues.assertClean();
	});

	test('a readonly view shows no grip: nothing drags', async ({ page }) => {
		await open(page, undefined, '&readonly=true');
		const a = await blockBox(page, 'A');
		await hover(page, 'A');
		await expect(page.locator('[data-edytor-table-grip]')).toHaveCount(0);
		await page.mouse.move(a.x - 9, a.y + a.height / 2);
		await page.mouse.down();
		await page.mouse.move(a.x - 9, a.y + a.height * 3, { steps: 4 });
		await page.mouse.up();
		expect(await grid(page)).toEqual([
			['alpha', 'beta'],
			['gamma', 'delta']
		]);
	});
});
