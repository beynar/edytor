import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns in real browsers (docs/columns-plan.md §5, D5–D7): a layout's
 * columns sit side by side with the gap between them, sized by their
 * weights, and stack in a layout under 480px wide; a block in a column
 * shows only its grip, in the gap, where it takes the click; Backspace and
 * Delete at the column edges are the document's merges (`layout.merge`);
 * the vertical arrows stay the browser's (D7), pinned per engine below.
 * The jsdom rows are `src/tests/fixtures/dom/columns-*.test.tsx`.
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Edytor = {
	value: { children: Array<{ id: string; type: string; children?: unknown[] }> };
	selection: {
		state: { startBlock?: { id: string }; yStart: number };
		selectedBlocks: Set<{ id: string }>;
	};
};

/** The page's grid grows with its JSON dump: the editor gets a viewport-sized width. */
const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page, query = '') => {
	await page.goto(`/test/dom?scenario=columns&handles=true${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).boundingBox())!;

/** Root blocks as ids, a layout as its columns' blocks. */
const shape = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		type Node = { id: string; children?: Node[] };
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [b.id, walk(b.children)] : b.id));
		return walk(edytor.value.children as Node[]);
	});

const caretBlock = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.state.startBlock?.id ??
			null
	);

const textOf = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().innerText();

/** Click at the start or the end of block `id`'s text. */
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

const LAYOUT = [
	'C',
	[
		['K1', ['A', 'A2']],
		['K2', ['B']]
	]
];

test.describe('columns', () => {
	test('the columns sit side by side, the gap between them, equal weights equal widths', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const [k1, k2, c] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'C')];
		test.info().annotations.push({ type: 'boxes', description: JSON.stringify({ k1, k2, c }) });
		expect(Math.abs(k1.y - k2.y)).toBeLessThanOrEqual(1);
		expect(Math.round(k2.x - (k1.x + k1.width))).toBe(46);
		expect(Math.abs(k1.width - k2.width)).toBeLessThanOrEqual(1);
		expect(Math.round(k1.x)).toBe(Math.round(c.x));
		expect(Math.round(k2.x + k2.width)).toBe(Math.round(c.x + c.width));
		// The blocks of column 2 start at its left edge: no nesting indent.
		const b = await box(page, 'B');
		expect(Math.round(b.x)).toBe(Math.round(k2.x));
		issues.assertClean();
	});

	test('a column grows by its weight', async ({ page }) => {
		const doc = {
			children: [
				{
					id: 'C',
					type: 'columns',
					children: [
						{
							id: 'K1',
							type: 'column',
							data: { width: 2 },
							children: [{ id: 'A', type: 'paragraph', content: [{ text: 'wide' }] }]
						},
						{
							id: 'K2',
							type: 'column',
							children: [{ id: 'B', type: 'paragraph', content: [{ text: 'narrow' }] }]
						}
					]
				}
			]
		};
		await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify(doc))}`);
		await waitForEditorReady(page, { requireRuntime: true });
		await fit(page);
		const [k1, k2] = [await box(page, 'K1'), await box(page, 'K2')];
		expect(Math.abs(k1.width / k2.width - 2)).toBeLessThan(0.02);
	});

	test('in a layout under 480px wide the columns stack', async ({ page }) => {
		await open(page);
		await fit(page, 400);
		await expect
			.poll(async () => {
				const [k1, k2] = [await box(page, 'K1'), await box(page, 'K2')];
				return [Math.round(k2.x - k1.x), k2.y >= k1.y + k1.height - 1];
			})
			.toEqual([0, true]);
		const [k1, k2, c] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'C')];
		expect(Math.round(k1.width)).toBe(Math.round(c.width));
		expect(Math.round(k2.width)).toBe(Math.round(c.width));
	});

	test('a block in column 2 shows only its grip, in the gap, and the grip takes the click', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.locator('[data-edytor-id="B"] [data-edytor-text]').hover();
		const host = page.locator('[data-edytor-block-handle-host][data-block-id="B"]');
		await expect(host).toHaveAttribute('data-visible', 'true');
		await expect(host.getByTestId('block-add')).toHaveCount(0);
		await expect(page.locator('[data-edytor-block-handle-host][data-block-id="C"]')).toHaveCount(0);
		await expect(page.locator('[data-edytor-block-handle-host][data-block-id="K2"]')).toHaveCount(
			0
		);
		const grip = host.getByTestId('block-handle');
		const [g, k1, k2] = [(await grip.boundingBox())!, await box(page, 'K1'), await box(page, 'K2')];
		// Wholly inside the 46px gap between the columns.
		expect(g.x).toBeGreaterThanOrEqual(k1.x + k1.width);
		expect(g.x + g.width).toBeLessThanOrEqual(k2.x);
		const center = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
		const hit = await page.evaluate(
			({ x, y }) =>
				document
					.elementFromPoint(x, y)
					?.closest('[data-testid="block-handle"]')
					?.getAttribute('data-block-id') ?? null,
			center
		);
		expect(hit).toBe('B');
		await page.mouse.move(center.x, center.y);
		await page.mouse.click(center.x, center.y);
		await expect
			.poll(() =>
				page.evaluate(() =>
					[
						...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks
					].map((b) => b.id)
				)
			)
			.toEqual(['B']);
		issues.assertClean();
	});

	test("Backspace at column 2's first block joins column 1's last line; the layout dissolves", async ({
		page
	}) => {
		await open(page);
		await clickAt(page, 'B', 'start');
		await page.keyboard.press('Backspace');
		await expect.poll(() => shape(page)).toEqual(['P', 'A', 'A2', 'Z']);
		await page.keyboard.type('|');
		await expect.poll(() => textOf(page, 'A2')).toBe('left two|right');
	});

	test("Delete at column 1's last line pulls column 2's first line; the layout dissolves", async ({
		page
	}) => {
		await open(page);
		await clickAt(page, 'A2', 'end');
		await page.keyboard.press('Delete');
		await expect.poll(() => shape(page)).toEqual(['P', 'A', 'A2', 'Z']);
		await page.keyboard.type('|');
		await expect.poll(() => textOf(page, 'A2')).toBe('left two|right');
	});

	test("Backspace at column 1's first block joins the line before the layout", async ({ page }) => {
		await open(page);
		await clickAt(page, 'A', 'start');
		await page.keyboard.press('Backspace');
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A2']],
						['K2', ['B']]
					]
				],
				'Z'
			]);
		await page.keyboard.type('|');
		await expect.poll(() => textOf(page, 'P')).toBe('before|left one');
	});

	test('native vertical arrows across columns, pinned per engine (D7)', async ({
		page,
		browserName
	}) => {
		await open(page);
		const step = async (from: string, edge: 'start' | 'end', key: 'ArrowDown' | 'ArrowUp') => {
			await clickAt(page, from, edge);
			await page.keyboard.press(key);
			// The model adopts the browser's move.
			await page.waitForTimeout(50);
			return caretBlock(page);
		};
		const recorded = {
			downFromA2: await step('A2', 'end', 'ArrowDown'),
			downFromB: await step('B', 'end', 'ArrowDown'),
			upFromZ: await step('Z', 'start', 'ArrowUp'),
			upFromB: await step('B', 'start', 'ArrowUp'),
			downFromP: await step('P', 'end', 'ArrowDown')
		};
		test.info().annotations.push({ type: browserName, description: JSON.stringify(recorded) });
		expect(recorded).toEqual(ARROWS[browserName]);
		expect(await shape(page)).toEqual(['P', LAYOUT, 'Z']);
	});
});

/**
 * What each engine's native ArrowUp/ArrowDown does around the layout
 * (recorded 2026-10-03, D7: the editor leaves them to the browser). Chromium
 * and WebKit step between the columns' lines in document order (the end of
 * column 1 goes down into column 2, the block after the layout up into its
 * last column); Firefox moves visually (down from column 1's last line, or
 * from column 2, to the block below the layout; up from it into column 1,
 * the taller one under the caret; up from column 2's top line to the line
 * above the layout).
 */
const ARROWS: Record<string, Record<string, string | null>> = {
	chromium: { downFromA2: 'B', downFromB: 'Z', upFromZ: 'B', upFromB: 'A2', downFromP: 'A' },
	webkit: { downFromA2: 'B', downFromB: 'Z', upFromZ: 'B', upFromB: 'A2', downFromP: 'A' },
	firefox: { downFromA2: 'Z', downFromB: 'Z', upFromZ: 'A2', upFromB: 'P', downFromP: 'A' }
};
