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
});
