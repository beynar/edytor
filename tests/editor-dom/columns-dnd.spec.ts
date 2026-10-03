import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns by drag and drop, and their resize, in real browsers
 * (docs/columns-plan.md §5 "DnD" and "Resize", C3/C4): a block dragged to
 * the right or left edge of another block goes beside it (a new layout, or
 * a new column of the layout that block is in); the gap between two
 * columns adds a column between them; the indicator is a vertical 4px bar;
 * a refused band shows nothing; one undo restores the document and the
 * selection held before the drag. The strip at the left of a gap resizes
 * its two columns on release only, one undo step, never under the minimum
 * width; there is none when readonly or stacked. The jsdom rows are
 * `src/tests/fixtures/dom/columns-dnd.test.tsx` and `columns-resize.test.tsx`.
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Block = { id: string; type: string; data?: { width?: number }; children?: Block[] };
type Edytor = {
	value: { children: Block[] };
	idToBlock: Map<string, { data: { width?: number } }>;
	selection: {
		state: { startBlock?: { id: string }; yStart: number; isCollapsed: boolean };
		selectedBlocks: Set<{ id: string }>;
		selectBlocks: (...blocks: unknown[]) => void;
	};
};

/** The page's grid grows with its JSON dump: the editor gets a fixed width. */
const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page, query = '') => {
	await page.goto(`/test/dom?scenario=columns&handles=true${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const openDoc = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;

/** The displayed tree: a layout or a column as its kind, any other block as its id. */
const shape = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		const walk = (blocks: Block[] = []): unknown[] =>
			blocks.map((b) => {
				const name = b.type === 'columns' || b.type === 'column' ? b.type : b.id;
				return b.children?.length ? [name, walk(b.children)] : name;
			});
		return walk(edytor.value.children);
	});

const selectedIds = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks].map(
			(b) => b.id
		)
	);

const caret = (page: Page) =>
	page.evaluate(() => {
		const { state } = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection;
		return {
			block: state.startBlock?.id ?? null,
			offset: state.yStart,
			collapsed: state.isCollapsed
		};
	});

const LAYOUT = [
	'columns',
	[
		['column', ['A', 'A2']],
		['column', ['B']]
	]
];

const indicator = (page: Page) => page.locator('[data-edytor-drop-indicator]');

/**
 * Press `id`'s grip and drag to `to`, moving there in two legs (the drag
 * library ignores the events of the frame the drag starts in). The button
 * stays down: the caller checks the indicator, then releases.
 */
const dragTo = async (page: Page, id: string, to: { x: number; y: number }) => {
	await page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().hover();
	const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
	await expect(grip).toBeVisible();
	const g = (await grip.boundingBox())!;
	await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x - 12, to.y, { steps: 12 });
	await moveTo(page, to);
};

/**
 * Move the pressed pointer to `to`, then 1px further: Chromium applies a
 * drag's last move only with the next one (the drag library reads the
 * previous dragover's input), so the pointer settles where asked.
 */
const moveTo = async (page: Page, to: { x: number; y: number }) => {
	await page.mouse.move(to.x - 1, to.y, { steps: 6 });
	await page.mouse.move(to.x, to.y);
};

/** Over a block's right band: 12px in from its right edge, its first row's middle. */
const rightOf = async (page: Page, id: string) => {
	const b = await box(page, id);
	return { x: b.x + b.width - 12, y: b.y + Math.min(b.height, 28) / 2 };
};

/** The indicator as a vertical bar: its box. */
const verticalBar = async (page: Page) => {
	const bar = (await indicator(page).boundingBox())!;
	expect(Math.round(bar.width)).toBe(4);
	expect(bar.height).toBeGreaterThan(bar.width);
	return bar;
};

test.describe('columns by drag and drop', () => {
	test("a root block dropped on another's right edge: a new two-column layout, in order; one undo restores it and the caret", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.locator('[data-edytor-id="A"] [data-edytor-text]').click();
		await page.keyboard.press('End');
		const before = await caret(page);
		expect(before.block).toBe('A');
		await dragTo(page, 'Z', await rightOf(page, 'P'));
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		const [bar, p] = [await verticalBar(page), await box(page, 'P')];
		expect(Math.abs(bar.x + bar.width / 2 - (p.x + p.width))).toBeLessThanOrEqual(2);
		expect(Math.abs(bar.y - p.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(bar.height - p.height)).toBeLessThanOrEqual(1);
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				[
					'columns',
					[
						['column', ['P']],
						['column', ['Z']]
					]
				],
				LAYOUT
			]);
		expect(await selectedIds(page)).toEqual(['Z']);
		// Side by side.
		const [np, nz] = [await box(page, 'P'), await box(page, 'Z')];
		expect(Math.abs(np.y - nz.y)).toBeLessThanOrEqual(1);
		expect(nz.x).toBeGreaterThan(np.x + np.width);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => shape(page)).toEqual(['P', LAYOUT, 'Z']);
		await expect.poll(() => caret(page)).toEqual(before);
		issues.assertClean();
	});

	test('the same from the left edge: the dragged block first', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const p = await box(page, 'P');
		const mid = p.y + Math.min(p.height, 28) / 2;
		await dragTo(page, 'Z', { x: p.x + p.width / 2, y: mid });
		// Out of the row to its left, into the 20px it keeps.
		await moveTo(page, { x: p.x - 10, y: mid });
		await expect(indicator(page)).toHaveAttribute('data-position', 'left');
		const bar = await verticalBar(page);
		expect(Math.abs(bar.x + bar.width / 2 - p.x)).toBeLessThanOrEqual(2);
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				[
					'columns',
					[
						['column', ['Z']],
						['column', ['P']]
					]
				],
				LAYOUT
			]);
		issues.assertClean();
	});

	test("beside a column's block: a new column next to that column, the bar spanning the layout", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await dragTo(page, 'Z', await rightOf(page, 'B'));
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		const [bar, c] = [await verticalBar(page), await box(page, 'C')];
		expect(Math.abs(bar.y - c.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(bar.height - c.height)).toBeLessThanOrEqual(1);
		expect(Math.abs(bar.x + bar.width / 2 - (c.x + c.width))).toBeLessThanOrEqual(2);
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'columns',
					[
						['column', ['A', 'A2']],
						['column', ['B']],
						['column', ['Z']]
					]
				]
			]);
		issues.assertClean();
	});

	test('the gap between two columns: a new column between them', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const [k1, k2, b] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'B')];
		const gap = { x: (k1.x + k1.width + k2.x) / 2, y: b.y + b.height / 2 };
		await dragTo(page, 'Z', gap);
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		const bar = await verticalBar(page);
		expect(Math.abs(bar.x + bar.width / 2 - gap.x)).toBeLessThanOrEqual(2);
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'columns',
					[
						['column', ['A', 'A2']],
						['column', ['Z']],
						['column', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test("a column's only block dragged beside a root block: the layout it leaves dissolves", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await dragTo(page, 'B', await rightOf(page, 'Z'));
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				'A',
				'A2',
				[
					'columns',
					[
						['column', ['Z']],
						['column', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('beside a list item: the layout wraps the whole list', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, [
			{
				id: 'L',
				type: 'unordered-list',
				children: [
					{ id: 'i1', type: 'list-item', content: [{ text: 'one' }] },
					{ id: 'i2', type: 'list-item', content: [{ text: 'two' }] }
				]
			},
			{ id: 'X', type: 'paragraph', content: [{ text: 'moved' }] }
		]);
		await dragTo(page, 'X', await rightOf(page, 'i2'));
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		const [bar, l] = [await verticalBar(page), await box(page, 'L')];
		expect(Math.abs(bar.y - l.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(bar.height - l.height)).toBeLessThanOrEqual(1);
		await page.mouse.up();
		await expect
			.poll(() => shape(page))
			.toEqual([
				[
					'columns',
					[
						['column', [['L', ['i1', 'i2']]]],
						['column', ['X']]
					]
				]
			]);
		issues.assertClean();
	});

	test('a refused band shows nothing: a whole layout beside a root block (no layout in a column)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (
				window as unknown as { __EDYTOR__: Edytor & { idToBlock: Map<string, unknown> } }
			).__EDYTOR__;
			edytor.selection.selectBlocks(...['A', 'A2', 'B'].map((id) => edytor.idToBlock.get(id)));
		});
		const z = await box(page, 'Z');
		await dragTo(page, 'B', { x: z.x + 16, y: z.y + z.height * 0.75 });
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await moveTo(page, { x: z.x + z.width - 12, y: z.y + z.height * 0.75 });
		await expect(indicator(page)).toHaveCount(0);
		await expect(page.locator('[data-edytor-block-drop-position]')).toHaveCount(0);
		await page.mouse.up();
		await expect.poll(() => shape(page)).toEqual(['P', LAYOUT, 'Z']);
		issues.assertClean();
	});

	test('a stacked layout (under 480px) offers no band', async ({ page }) => {
		await open(page);
		await fit(page, 400);
		await dragTo(page, 'Z', await rightOf(page, 'P'));
		// The hitbox's placements (the pointer far right nests): no beside.
		await expect(indicator(page)).toHaveAttribute('data-position', /before|after|inside/);
		await page.mouse.up();
		// Z moved, and still the one layout: no new one.
		await expect.poll(async () => JSON.stringify(await shape(page))).not.toMatch(/^\["P",/);
		expect(JSON.stringify(await shape(page)).match(/"columns"/g)).toHaveLength(1);
	});
});

test.describe('resizing columns', () => {
	const strip = (page: Page) => page.locator('[data-edytor-column-resize]');
	const weights = (page: Page) =>
		page.evaluate(() => {
			const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
			return ['K1', 'K2'].map((id) => edytor.idToBlock.get(id)!.data.width ?? null);
		});

	test('dragging the strip resizes on release only, keeping the sum; one undo restores; the minimum width holds', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.locator('[data-edytor-id="A"] [data-edytor-text]').click();
		await expect(strip(page)).toHaveCount(1);
		const s = (await strip(page).boundingBox())!;
		const [k1, k2] = [await box(page, 'K1'), await box(page, 'K2')];
		// Over the whole gap, the layout's height.
		expect(Math.abs(s.width - (k2.x - (k1.x + k1.width)))).toBeLessThanOrEqual(1);
		expect(Math.abs(s.x - (k1.x + k1.width))).toBeLessThanOrEqual(1);
		expect(await strip(page).evaluate((node) => getComputedStyle(node).cursor)).toBe('col-resize');
		const at = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
		await page.mouse.move(at.x, at.y);
		await page.mouse.down();
		await page.mouse.move(at.x + 100, at.y, { steps: 10 });
		await expect(page.locator('[data-edytor-column-resize-guide]')).toHaveCount(1);
		// Nothing written, nothing resized, while the pointer drags.
		expect(await weights(page)).toEqual([null, null]);
		expect(Math.abs((await box(page, 'K1')).width - k1.width)).toBeLessThanOrEqual(0.5);
		await page.mouse.up();
		await expect(page.locator('[data-edytor-column-resize-guide]')).toHaveCount(0);
		await expect.poll(async () => Math.round((await box(page, 'K1')).width - k1.width)).toBe(100);
		const [w1, w2] = (await weights(page)) as number[];
		expect(w1! + w2!).toBeCloseTo(2, 6);
		expect(Math.abs((await box(page, 'K2')).width - (k2.width - 100))).toBeLessThanOrEqual(1);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => weights(page)).toEqual([null, null]);
		// The strip is measured again once the undo's widths are laid out (under
		// load that takes a frame or more): wait for it over the restored gap.
		await expect
			.poll(async () => {
				const [one, now] = [await box(page, 'K1'), await strip(page).boundingBox()];
				return (
					now !== null &&
					Math.abs(now.x - (one.x + one.width)) <= 1 &&
					Math.abs(one.width - k1.width) <= 1
				);
			})
			.toBe(true);
		// Past column 2's minimum (it is under 400px wide): it stops at 10% of the layout.
		const c = await box(page, 'C');
		const again = (await strip(page).boundingBox())!;
		await page.mouse.move(again.x + 4, again.y + again.height / 2);
		await page.mouse.down();
		await page.mouse.move(again.x + 350, again.y + again.height / 2, { steps: 10 });
		await page.mouse.up();
		await expect
			.poll(async () => Math.round((await box(page, 'K2')).width))
			.toBe(Math.round(c.width * 0.1));
		issues.assertClean();
	});

	test('no strip when readonly', async ({ page }) => {
		await open(page, '&readonly=true');
		await page.locator('[data-edytor-id="A"] [data-edytor-text]').hover();
		await page.waitForTimeout(100);
		await expect(strip(page)).toHaveCount(0);
	});

	test('no strip when the layout stacks', async ({ page }) => {
		await open(page);
		await fit(page, 400);
		await page.locator('[data-edytor-id="A"] [data-edytor-text]').hover();
		await page.waitForTimeout(100);
		await expect(strip(page)).toHaveCount(0);
	});
});
