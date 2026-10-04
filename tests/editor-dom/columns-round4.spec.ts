import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns, Notion parity, the round-4 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump. Desktop engines.
 */

type Block = { id: string; type: string; data?: { width?: number }; children?: Block[] };
type Edytor = {
	value: { children: Block[] };
	idToBlock: Map<string, { data: { width?: number } }>;
	selection: { value: { kind: string }; selectedBlocks: Set<{ id: string }> };
};

const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

/** Two animation frames: the overlay draws on the second. */
const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);

/** A doc of `children`, the editor 160px in from the page's left. */
const openDoc = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
	await page.getByTestId('editor-shell').evaluate((shell) => (shell.style.marginLeft = '160px'));
	await frames(page);
};
const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
/** Three rows per column (the review's "full" layout). */
const FULL = [
	para('P', 'before'),
	{
		id: 'C',
		type: 'columns',
		children: [
			{
				id: 'K1',
				type: 'column',
				children: [para('A', 'left one'), para('A2', 'left two'), para('A3', 'left three')]
			},
			{
				id: 'K2',
				type: 'column',
				children: [para('B', 'right one'), para('B2', 'right two'), para('B3', 'right three')]
			}
		]
	},
	para('Z', 'after')
];

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
const textBox = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first().boundingBox())!;

type Point = { x: number; y: number };

/** The pointer from `from` to `to` in `step` px moves (a person's path), a frame every third. */
const walk = async (
	page: Page,
	from: Point,
	to: Point,
	step = 4,
	each?: (at: Point) => unknown
) => {
	const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
	for (let i = 1; i <= n; i++) {
		const at = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
		await page.mouse.move(at.x, at.y);
		if (each) {
			await frames(page);
			await each(at);
		} else if (i % 3 === 0) await frames(page);
	}
	await frames(page);
	return to;
};

const host = (page: Page, id: string) =>
	page.locator(`[data-edytor-block-handle-host][data-block-id="${id}"]`);
const grip = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
const plus = (page: Page, id: string) => host(page, id).getByTestId('block-add');

/** What takes the pointer at a point: a block's handle, a column's resize band, or else. */
const hitAt = (page: Page, x: number, y: number) =>
	page.evaluate(
		([x, y]) => {
			const hit = document.elementFromPoint(x, y);
			const handle = hit?.closest<HTMLElement>('[data-edytor-block-handle-host]');
			if (handle) return `handle:${handle.dataset.blockId}`;
			if (hit?.closest('[data-edytor-column-resize]')) return 'resize';
			const block = hit?.closest<HTMLElement>('[data-edytor-block="true"]');
			return block ? `block:${block.dataset.edytorId}` : 'page';
		},
		[x, y]
	);

/** Whether the gray hover guide shows: the band under the pointer is hovered, its guide drawn. */
const guide = (page: Page) =>
	page.evaluate(() => {
		const band = document.querySelector<HTMLElement>('[data-edytor-column-resize]:hover');
		return band ? getComputedStyle(band, '::after').content !== 'none' : false;
	});

const widths = async (page: Page) => [
	Math.round((await box(page, 'K1')).width),
	Math.round((await box(page, 'K2')).width)
];

const gapOf = async (page: Page) => {
	const [k1, k2, c] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'C')];
	return { left: k1.x + k1.width, right: k2.x, mid: (k1.x + k1.width + k2.x) / 2, c };
};

const overlap = (a: { x: number; width: number }, b: { x: number; width: number }) =>
	a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5;

test.describe('the resize guide is where a press resizes (round 4, issue 1)', () => {
	for (const step of [3, 8])
		test(`straight down the gap’s middle, ${step}px steps: the guide at every height, block rows included`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, FULL);
			const g = await gapOf(page);
			const p = await textBox(page, 'P');
			const z = await textBox(page, 'Z');
			const start = { x: p.x + 30, y: p.y + p.height / 2 };
			await page.mouse.move(start.x, start.y);
			await walk(page, start, { x: g.mid, y: start.y });
			const misses: string[] = [];
			let inside = false;
			await walk(
				page,
				{ x: g.mid, y: start.y },
				{ x: g.mid, y: z.y + z.height / 2 },
				step,
				async ({ x, y }) => {
					const was = inside;
					inside = y > g.c.y + 1 && y < g.c.y + g.c.height - 1;
					if (!inside) return;
					const hit = await hitAt(page, x, y);
					// The guide is a hover style: WebKit restyles it at the next move over a band
					// that appeared under a still pointer (the layout's first one shows it).
					const shows = !was || (await guide(page));
					if (hit !== 'resize' || !shows) misses.push(`${Math.round(y - g.c.y)}:${hit}:${shows}`);
				}
			);
			expect(misses).toEqual([]);
			issues.assertClean();
		});

	for (const id of ['B', 'B2', 'B3'])
		test(`at ${id}’s row, from column 1’s text to the gap’s middle: the guide, and a press there resizes`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, FULL);
			const g = await gapOf(page);
			const t = await textBox(page, id);
			const row = t.y + t.height / 2;
			const a = await textBox(page, id.replace('B', 'A'));
			const at = await walk(page, { x: a.x + 30, y: row }, { x: g.mid, y: row }, 4);
			expect(await hitAt(page, at.x, at.y)).toBe('resize');
			expect(await guide(page)).toBe(true);
			const cursor = await page.evaluate(
				([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
				[at.x, at.y]
			);
			expect(cursor).toBe('col-resize');
			const before = await widths(page);
			await page.mouse.down();
			await walk(page, at, { x: at.x + 60, y: row + 1 }, 4);
			await expect.poll(() => widths(page)).toEqual([before[0]! + 60, before[1]! - 60]);
			await page.mouse.up();
			await expect.poll(() => widths(page)).toEqual([before[0]! + 60, before[1]! - 60]);
			issues.assertClean();
		});

	test('the band sits at the gap’s middle, above the handles; the + and the grip beside it, never under it', async ({
		page
	}) => {
		await openDoc(page, FULL);
		const g = await gapOf(page);
		for (const id of ['B', 'B2', 'B3']) {
			const t = await textBox(page, id);
			const row = t.y + t.height / 2;
			await walk(page, { x: t.x + 30, y: row }, { x: t.x + 6, y: row });
			await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
			const band = (await page.locator('[data-edytor-column-resize]').boundingBox())!;
			expect(band.width).toBeGreaterThanOrEqual(8);
			expect(band.width).toBeLessThanOrEqual(10);
			expect(Math.abs(band.x + band.width / 2 - g.mid)).toBeLessThanOrEqual(1);
			expect(Math.abs(band.y - g.c.y)).toBeLessThanOrEqual(1);
			expect(Math.abs(band.height - g.c.height)).toBeLessThanOrEqual(1);
			const [add, move] = [
				(await plus(page, id).boundingBox())!,
				(await grip(page, id).boundingBox())!
			];
			for (const button of [add, move]) {
				expect(overlap(button, band)).toBe(false);
				expect(button.x).toBeGreaterThanOrEqual(g.left - 0.5);
				expect(button.x + button.width).toBeLessThanOrEqual(g.right + 0.5);
				expect(await hitAt(page, button.x + button.width / 2, row)).toBe(`handle:${id}`);
			}
			// The + left of the guide, the grip right of it, flush with the block (Notion).
			expect(add.x + add.width).toBeLessThanOrEqual(band.x + 0.5);
			expect(move.x).toBeGreaterThanOrEqual(band.x + band.width - 0.5);
			expect(Math.abs(move.x + move.width - g.right)).toBeLessThanOrEqual(1);
			expect(await hitAt(page, g.mid, row)).toBe('resize');
		}
	});

	test('from B2’s text left over the grip and the guide to the +: the + opens the insert menu', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const t = await textBox(page, 'B2');
		const row = t.y + t.height / 2;
		await page.mouse.move(t.x + 30, row);
		await frames(page);
		const add = (await plus(page, 'B2').boundingBox())!;
		const at = await walk(page, { x: t.x + 30, y: row }, { x: add.x + add.width / 2, y: row }, 3);
		expect(await hitAt(page, at.x, at.y)).toBe('handle:B2');
		await expect(host(page, 'B2')).toHaveAttribute('data-visible', 'true');
		await page.mouse.down();
		await page.mouse.up();
		await expect(page.locator('[data-testid="slash-menu-item"]').first()).toBeVisible();
		issues.assertClean();
	});
});
