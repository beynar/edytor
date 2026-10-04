import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns, Notion parity (the 2026-10-04 review): a block selection in a
 * column is replaced in place by typing and pasting (`layout.flow-slot`);
 * the block-selection arrows never select a column; the gap between two
 * columns shows a resize guide on hover; a block in a column has its `+`
 * (Alt+click: a new column to the right); a block selection made with a
 * grip takes Backspace and Shift+arrows. The jsdom rows are
 * `src/tests/fixtures/dom/columns-*.test.tsx`.
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Edytor = {
	value: { children: Array<{ id: string; type: string; children?: unknown[] }> };
	selection: {
		state: { startBlock?: { id: string }; yStart: number; isCollapsed: boolean };
		selectedBlocks: Set<{ id: string }>;
	};
};

const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page, query = '') => {
	await page.goto(`/test/dom?scenario=columns&handles=true${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;

const KNOWN = ['P', 'C', 'K1', 'K2', 'A', 'A2', 'B', 'Z'];

/** Root blocks as ids, a layout as its columns' blocks; a block an op minted is `NEW`. */
const shape = (page: Page) =>
	page.evaluate((known) => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		type Node = { id: string; children?: Node[] };
		const name = (id: string) => (known.includes(id) ? id : 'NEW');
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [name(b.id), walk(b.children)] : name(b.id)));
		return walk(edytor.value.children as Node[]);
	}, KNOWN);

const selected = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks]
			.map((b) => b.id)
			.sort()
	);

const caretBlock = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.state.startBlock?.id ??
			null
	);

const textOf = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().innerText();

const clickAt = async (page: Page, id: string, edge: 'start' | 'end') => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const rect = (await text.boundingBox())!;
	await page.mouse.click(
		edge === 'start' ? rect.x + 1 : rect.x + rect.width - 1,
		rect.y + rect.height / 2
	);
	await page.keyboard.press(edge === 'start' ? 'Home' : 'End');
	await expect.poll(() => caretBlock(page)).toBe(id);
};

/** Mod+A twice in `id`: its block selected. */
const selectBlock = async (page: Page, id: string) => {
	await clickAt(page, id, 'end');
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ControlOrMeta+a');
	await expect.poll(() => selected(page)).toEqual([id]);
};

const LAYOUT = [
	'C',
	[
		['K1', ['A', 'A2']],
		['K2', ['B']]
	]
];

test.describe('columns: a block selection replaced in place (layout.flow-slot)', () => {
	test("typing over a column's only block keeps the column and the layout", async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await selectBlock(page, 'B');
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['NEW']]
					]
				],
				'Z'
			]);
		await expect(page.locator('[data-edytor-id="K2"] [data-edytor-text]').first()).toHaveText('x');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => shape(page)).toEqual(['P', LAYOUT, 'Z']);
		issues.assertClean();
	});

	for (const id of ['B', 'Z']) {
		test(`Mod+V over block-selected ${id}: the pasted line takes its place`, async ({
			page,
			context,
			browserName
		}) => {
			test.skip(browserName !== 'chromium', 'clipboard permissions: Chromium only');
			await context.grantPermissions(['clipboard-read', 'clipboard-write']);
			await open(page);
			await page.evaluate(() => navigator.clipboard.writeText('pasted'));
			await selectBlock(page, id);
			await page.keyboard.press('ControlOrMeta+v');
			await expect
				.poll(() => shape(page))
				.toEqual(
					id === 'B'
						? [
								'P',
								[
									'C',
									[
										['K1', ['A', 'A2']],
										['K2', ['NEW']]
									]
								],
								'Z'
							]
						: ['P', LAYOUT, 'NEW']
				);
			expect(await textOf(page, 'P')).toBe('before');
		});
	}
});

test.describe('columns: the block-selection arrows never select a column', () => {
	test("Shift+ArrowDown from column 1's last block extends to column 2's first; Backspace deletes what shows", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await selectBlock(page, 'A2');
		await page.keyboard.press('Shift+ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B']);
		await page.keyboard.press('Shift+ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B', 'Z']);
		await page.keyboard.press('Shift+ArrowUp');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B']);
		await page.keyboard.press('Backspace');
		await expect.poll(() => shape(page)).toEqual(['P', 'A', 'Z']);
		issues.assertClean();
	});

	test("ArrowDown over a selected block steps over the column onto the next column's block", async ({
		page
	}) => {
		await open(page);
		await selectBlock(page, 'A2');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['B']);
		await page.keyboard.press('ArrowUp');
		await expect.poll(() => selected(page)).toEqual(['A2']);
	});
});

test.describe('columns: the resize affordance', () => {
	const strip = (page: Page) => page.locator('[data-edytor-column-resize]');
	/** The hover guide's opacity (the strip's `::after`). */
	const guide = (page: Page) =>
		strip(page).evaluate((node) => Number(getComputedStyle(node, '::after').opacity));
	/** What takes the pointer at `x, y`. */
	const hit = (page: Page, x: number, y: number) =>
		page.evaluate(
			([x, y]) => {
				const at = document.elementFromPoint(x!, y!);
				return at?.closest('[data-edytor-column-resize]')
					? 'strip'
					: at?.closest('[data-edytor-block-handle-host]')
						? 'handle'
						: (at?.closest('[data-edytor-id]')?.getAttribute('data-edytor-id') ?? null);
			},
			[x, y]
		);

	test('the whole gap resizes where no handle shows; hovered, it shows a gray guide; dragging, the blue one', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const [k1, k2, b, a2] = [
			await box(page, 'K1'),
			await box(page, 'K2'),
			await box(page, 'B'),
			await box(page, 'A2')
		];
		const gap = { left: k1.x + k1.width, right: k2.x };
		// Over A2's row, below column 2's only block: the gap is the strip's.
		await page.mouse.move(a2.x + 10, a2.y + a2.height / 2);
		await expect(strip(page)).toHaveCount(1);
		const s = (await strip(page).boundingBox())!;
		expect(Math.abs(s.x - gap.left)).toBeLessThanOrEqual(1);
		expect(Math.abs(s.x + s.width - gap.right)).toBeLessThanOrEqual(1);
		for (const x of [gap.left + 2, (gap.left + gap.right) / 2, gap.right - 2])
			expect(await hit(page, x, a2.y + a2.height / 2)).toBe('strip');
		// Over B's row while B is not hovered, its handle takes nothing either.
		expect(await hit(page, gap.left + 4, b.y + Math.min(b.height, 24) / 2)).toBe('strip');
		expect(await guide(page)).toBe(0);
		await page.mouse.move((gap.left + gap.right) / 2, a2.y + a2.height / 2);
		await expect.poll(() => guide(page)).toBe(1);
		expect(await strip(page).evaluate((node) => getComputedStyle(node).cursor)).toBe('col-resize');
		// Dragging: the blue guide, the gray one hidden.
		await page.mouse.down();
		await page.mouse.move((gap.left + gap.right) / 2 + 40, a2.y + a2.height / 2, { steps: 5 });
		await expect(page.locator('[data-edytor-column-resize-guide]')).toHaveCount(1);
		await expect.poll(() => guide(page)).toBe(0);
		await page.mouse.up();
		await expect(page.locator('[data-edytor-column-resize-guide]')).toHaveCount(0);
		issues.assertClean();
	});

	test("a hovered block's shown handle takes the pointer over its part of the gap", async ({
		page
	}) => {
		await open(page);
		await page.locator('[data-edytor-id="B"] [data-edytor-text]').first().hover();
		const handle = page.locator('[data-edytor-block-handle-host][data-block-id="B"]');
		await expect(handle).toHaveAttribute('data-visible', 'true');
		const g = (await page
			.locator('[data-testid="block-handle"][data-block-id="B"]')
			.boundingBox())!;
		expect(await hit(page, g.x + g.width / 2, g.y + g.height / 2)).toBe('handle');
		await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
		await expect(handle).toHaveCSS('opacity', '1');
	});
});

test.describe("columns: a column block's +", () => {
	test("Alt+click on the + of column 1's block, then a pick: a new column right of column 1", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.locator('[data-edytor-id="A2"] [data-edytor-text]').first().hover();
		const add = page.locator(
			'[data-edytor-block-handle-host][data-block-id="A2"] [data-testid="block-add"]'
		);
		await expect(add).toBeVisible();
		// The + and the grip fit in the gap, left of column 2.
		const [plus, k1] = [(await add.boundingBox())!, await box(page, 'K1')];
		expect(plus.x).toBeLessThan(k1.x);
		await add.click({ modifiers: ['Alt'] });
		await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible();
		await page.keyboard.type('text');
		await page.keyboard.press('Enter');
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['NEW', ['NEW']],
						['K2', ['B']]
					]
				],
				'Z'
			]);
		await page.keyboard.type('new');
		const fresh = page
			.locator('[data-edytor-id="C"] > [data-edytor-children] > [data-edytor-block]')
			.nth(1);
		await expect(fresh.locator('[data-edytor-text]').first()).toHaveText('new');
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => shape(page)).toEqual(['P', LAYOUT, 'Z']);
		issues.assertClean();
	});

	test("a column 2 block's + and grip sit in the gap, left of its column", async ({ page }) => {
		await open(page);
		await page.locator('[data-edytor-id="B"] [data-edytor-text]').first().hover();
		const host = page.locator('[data-edytor-block-handle-host][data-block-id="B"]');
		await expect(host.locator('[data-testid="block-add"]')).toBeVisible();
		const [h, k1, k2] = [(await host.boundingBox())!, await box(page, 'K1'), await box(page, 'K2')];
		expect(h.x).toBeGreaterThanOrEqual(k1.x + k1.width - 1);
		expect(h.x + h.width).toBeLessThanOrEqual(k2.x + 1);
	});
});

test.describe('columns: slash commands', () => {
	for (const [query, n] of [
		['/col3', 3],
		['/columns5', 5]
	] as const)
		test(`${query} then Enter inserts ${n} columns (Notion)`, async ({ page }) => {
			await open(page);
			await clickAt(page, 'Z', 'end');
			await page.keyboard.press('Enter');
			await page.keyboard.type(query);
			await expect(page.locator('[data-testid="slash-menu-item"]')).toHaveText([`${n} columns`]);
			await page.keyboard.press('Enter');
			await expect(page.locator('[data-edytor-columns]')).toHaveCount(2);
			await expect(
				page.locator('[data-edytor-columns]').nth(1).locator('[data-edytor-column]')
			).toHaveCount(n);
		});

	test('/2 col inside a column (the layout commands disabled there): the query matches nothing, so it is prose — the menu closes, Enter starts a new line, a later / opens it again', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await clickAt(page, 'B', 'end');
		const menu = page.locator('[data-testid="slash-menu"]');
		await page.keyboard.type(' /2 ');
		// "2 columns" is disabled in a column (D2): "Heading 2" still matches.
		await expect(page.locator('[data-testid="slash-menu-item"]')).toHaveText(['Heading 2']);
		await page.keyboard.type('c');
		await expect(menu).toHaveCount(0);
		await page.keyboard.type('ol');
		await expect(menu).toHaveCount(0);
		await page.keyboard.press('Enter');
		await expect.poll(() => caretBlock(page)).not.toBe('B');
		await expect(textOf(page, 'B')).resolves.toBe('right /2 col');
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['B', 'NEW']]
					]
				],
				'Z'
			]);
		// Nothing dangles: a new / opens the menu with every enabled command.
		await page.keyboard.type(' /');
		await expect(menu).toHaveCount(1);
		await expect(page.locator('[data-testid="slash-menu-item"]').first()).toHaveText('Text');
		await page.keyboard.press('Escape');
		issues.assertClean();
	});
});

test.describe('columns: Turn into N columns (demo)', () => {
	test('two selected blocks, the block menu’s 2 columns: one layout, one block per column; undo restores', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await expect(page.locator('[data-edytor-id="page-section-intro"]')).toBeVisible();
		const text = page.locator('[data-edytor-id="page-section-intro"] [data-edytor-text]').first();
		await text.click();
		await page.keyboard.press('End');
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('Shift+ArrowDown');
		await expect(page.locator('[data-edytor-id="page-task-one"]')).toHaveAttribute(
			'data-edytor-selected',
			'true'
		);
		await text.hover();
		await page.locator('[data-testid="block-handle"][data-block-id="page-section-intro"]').click();
		await expect(page.getByRole('menu', { name: 'Block actions' })).toBeVisible();
		// The menu's search lists the Turn into rows it names (the flyout's last
		// rows sit below a desktop viewport here).
		await page.keyboard.type('2 col');
		await expect(
			page.getByRole('menu', { name: 'Block actions' }).getByRole('menuitem', { name: '2 columns' })
		).toBeVisible();
		await page.keyboard.press('Enter');
		const layout = page.locator('[data-edytor-columns]').filter({
			has: page.locator('[data-edytor-id="page-section-intro"]')
		});
		await expect(layout).toHaveCount(1);
		await expect(layout.locator('[data-edytor-column]')).toHaveCount(2);
		await expect(
			layout.locator('[data-edytor-column]').nth(1).locator('[data-edytor-id="page-task-one"]')
		).toHaveCount(1);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(layout).toHaveCount(0);
		issues.assertClean();
	});

	test('one block, the block menu’s 3 columns: it is column 1, two empty columns beside it; undo restores', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		const intro = page.locator('[data-edytor-id="page-section-intro"]');
		await expect(intro).toBeVisible();
		await intro.locator('[data-edytor-text]').first().hover();
		await page.locator('[data-testid="block-handle"][data-block-id="page-section-intro"]').click();
		await expect(page.getByRole('menu', { name: 'Block actions' })).toBeVisible();
		await page.keyboard.type('3 col');
		await expect(
			page.getByRole('menu', { name: 'Block actions' }).getByRole('menuitem', { name: '3 columns' })
		).toBeVisible();
		await page.keyboard.press('Enter');
		const layout = page.locator('[data-edytor-columns]').filter({ has: intro });
		await expect(layout).toHaveCount(1);
		const columns = layout.locator('[data-edytor-column]');
		await expect(columns).toHaveCount(3);
		await expect(columns.nth(0).locator('[data-edytor-id="page-section-intro"]')).toHaveCount(1);
		for (const index of [1, 2]) {
			const blocks = columns.nth(index).locator('[data-edytor-block="true"]');
			await expect(blocks).toHaveCount(1);
			await expect(blocks.first()).toHaveAttribute('data-edytor-type', 'paragraph');
			await expect(blocks.first().locator('[data-edytor-text]').first()).toHaveText('');
		}
		// The block stays selected.
		await expect(intro).toHaveAttribute('data-edytor-selected', 'true');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(layout).toHaveCount(0);
		await expect(page.locator('[data-edytor-columns]')).toHaveCount(1);
		issues.assertClean();
	});
});

/** Open the dom harness on `children` (the `dst` scenario's document). */
const openDoc = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};
const para = (id: string, text: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ text }],
	...(children && { children })
});
/** Press `id`'s grip and drag to `to`, the button kept down. */
const dragTo = async (page: Page, id: string, to: { x: number; y: number }) => {
	await page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().hover();
	const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
	await expect(grip).toBeVisible();
	const g = (await grip.boundingBox())!;
	await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x - 12, to.y, { steps: 12 });
	await page.mouse.move(to.x - 1, to.y, { steps: 6 });
	await page.mouse.move(to.x, to.y);
};
const indicator = (page: Page) => page.locator('[data-edytor-drop-indicator]');
const tree = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		type Node = { id: string; type: string; children?: Node[] };
		const name = (b: Node) => (b.type === 'columns' ? 'L' : b.type === 'column' ? 'col' : b.id);
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [name(b), walk(b.children)] : name(b)));
		return walk(edytor.value.children as Node[]);
	});

test.describe('columns: beside a block inside a toggle', () => {
	test("dropped on a toggle child's right edge: the layout is made inside the toggle", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, [
			{
				id: 'T',
				type: 'toggle',
				data: {},
				content: [{ text: 'toggle' }],
				children: [para('T1', 'inside one'), para('T2', 'inside two')]
			},
			para('Z', 'after')
		]);
		// The browser owns a toggle's open state (`viewState`): open it as a click would.
		await page.evaluate(() =>
			document.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true))
		);
		await expect(page.locator('[data-edytor-id="T1"] [data-edytor-text]').first()).toBeVisible();
		const t1 = await box(page, 'T1');
		await dragTo(page, 'Z', { x: t1.x + t1.width - 12, y: t1.y + Math.min(t1.height, 28) / 2 });
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		// The bar runs along the toggle child's own edge, not the toggle's.
		const bar = (await indicator(page).boundingBox())!;
		expect(Math.abs(bar.y - t1.y)).toBeLessThanOrEqual(4);
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					'T',
					[
						[
							'L',
							[
								['col', ['T1']],
								['col', ['Z']]
							]
						],
						'T2'
					]
				]
			]);
		issues.assertClean();
	});
});

test.describe('columns: beside zones in the page margins', () => {
	/** Room left of the editor for a page margin past its handle column (the harness has 24px). */
	const pageMargin = (page: Page) =>
		page.getByTestId('editor-shell').evaluate((shell) => (shell.style.marginLeft = '160px'));

	/** Drag `id` by its grip along `path` (the button kept down). */
	const dragAlong = async (page: Page, id: string, path: { x: number; y: number }[]) => {
		await page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().hover();
		const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
		await expect(grip).toBeVisible();
		const g = (await grip.boundingBox())!;
		await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
		await page.mouse.down();
		for (const to of path) {
			await page.mouse.move(to.x - 1, to.y, { steps: 8 });
			await page.mouse.move(to.x, to.y);
		}
	};

	test('the page margin past the handle column, entered from outside the row, within its height: left of it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await pageMargin(page);
		const [p, z] = [await box(page, 'P'), await box(page, 'Z')];
		// Out to the margin below the document, then up into P's row from outside.
		await dragAlong(page, 'Z', [
			{ x: p.x - 70, y: z.y + z.height + 30 },
			{ x: p.x - 70, y: p.y + p.height / 2 }
		]);
		await expect(indicator(page)).toHaveAttribute('data-position', 'left');
		// At P's row, not the layout's below it (the last move lands before the release).
		await expect
			.poll(async () => Math.abs(((await indicator(page).boundingBox())?.y ?? Infinity) - p.y))
			.toBeLessThanOrEqual(4);
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					'L',
					[
						['col', ['Z']],
						['col', ['P']]
					]
				],
				[
					'L',
					[
						['col', ['A', 'A2']],
						['col', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('the margin right of a row, past the editor’s edge, within its height: right of it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const z = await box(page, 'Z');
		await dragAlong(page, 'P', [
			{ x: z.x + z.width + 60, y: z.y + z.height + 40 },
			{ x: z.x + z.width + 60, y: z.y + z.height / 2 }
		]);
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		await expect
			.poll(async () => Math.abs(((await indicator(page).boundingBox())?.y ?? Infinity) - z.y))
			.toBeLessThanOrEqual(4);
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					'L',
					[
						['col', ['A', 'A2']],
						['col', ['B']]
					]
				],
				[
					'L',
					[
						['col', ['Z']],
						['col', ['P']]
					]
				]
			]);
		issues.assertClean();
	});

	test('in the page margin beside column 1’s block: a new first column', async ({ page }) => {
		await open(page);
		await pageMargin(page);
		const [a, z] = [await box(page, 'A'), await box(page, 'Z')];
		await dragAlong(page, 'Z', [
			{ x: a.x - 70, y: z.y + z.height + 30 },
			{ x: a.x - 70, y: a.y + a.height / 2 }
		]);
		await expect(indicator(page)).toHaveAttribute('data-position', 'left');
		await expect
			.poll(async () => Math.abs(((await indicator(page).boundingBox())?.y ?? Infinity) - a.y))
			.toBeLessThanOrEqual(4);
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				[
					'L',
					[
						['col', ['Z']],
						['col', ['A', 'A2']],
						['col', ['B']]
					]
				]
			]);
	});
});

test.describe('a grip click with no menu answering (Notion)', () => {
	test('the keys act on the selected block: Shift+ArrowDown extends, Backspace deletes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.locator('[data-edytor-id="P"] [data-edytor-text]').first().hover();
		await page.locator('[data-testid="block-handle"][data-block-id="P"]').click();
		await expect.poll(() => selected(page)).toEqual(['P']);
		await page.keyboard.press('Shift+ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['A', 'P']);
		await page.keyboard.press('Backspace');
		await expect
			.poll(() => shape(page))
			.toEqual([
				[
					'C',
					[
						['K1', ['A2']],
						['K2', ['B']]
					]
				],
				'Z'
			]);
		issues.assertClean();
	});
});
