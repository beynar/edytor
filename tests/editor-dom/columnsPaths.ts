import { expect, type Page } from './editorTest';
import { waitForEditorReady } from './helpers';

/**
 * A person's mouse over a columns layout (the review rounds' paths): every
 * path moves in 2–12px steps, never a jump. Shared by the columns specs.
 */

type Block = { id: string; type: string; data?: { width?: number }; children?: Block[] };
export type ColumnsEdytor = {
	value: { children: Block[] };
	idToBlock: Map<string, { data: { width?: number } }>;
	selection: {
		value: { kind: string; ids?: string[]; anchor?: { b: string } };
		selectedBlocks: Set<{ id: string }>;
	};
	dispatcher: { last: { operation: string; status: string } | null };
};

export const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

/** Two animation frames: the overlay draws on the second. */
export const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);

/** A doc of `children`, the editor 160px in from the page's left. */
export const openDoc = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
	await page.getByTestId('editor-shell').evaluate((shell) => (shell.style.marginLeft = '160px'));
	await frames(page);
};

export const para = (id: string, text: string) => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

/** Three rows per column (the review's "full" layout). */
export const FULL = [
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

export const TEXTS = [
	'before',
	'left one',
	'left two',
	'left three',
	'right one',
	'right two',
	'right three',
	'after'
];

export const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
export const textBox = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first().boundingBox())!;

export type Point = { x: number; y: number };

/** The pointer from `from` to `to` in `step` px moves (a person's path), a frame every third. */
export const walk = async (
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

export const host = (page: Page, id: string) =>
	page.locator(`[data-edytor-block-handle-host][data-block-id="${id}"]`);
export const grip = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
export const plus = (page: Page, id: string) => host(page, id).getByTestId('block-add');

/** What takes the pointer at a point: a block's handle, a column's resize band, or else. */
export const hitAt = (page: Page, x: number, y: number) =>
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
export const guide = (page: Page) =>
	page.evaluate(() => {
		const band = document.querySelector<HTMLElement>('[data-edytor-column-resize]:hover');
		return band ? getComputedStyle(band, '::after').content !== 'none' : false;
	});

export const widths = async (page: Page) => [
	Math.round((await box(page, 'K1')).width),
	Math.round((await box(page, 'K2')).width)
];

export const gapOf = async (page: Page) => {
	const [k1, k2, c] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'C')];
	return { left: k1.x + k1.width, right: k2.x, mid: (k1.x + k1.width + k2.x) / 2, c };
};

export const overlap = (a: { x: number; width: number }, b: { x: number; width: number }) =>
	a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5;

/** The document's texts in order. */
export const texts = (page: Page) =>
	page.evaluate(() => {
		const out: string[] = [];
		const walk = (blocks: { content?: { text?: string }[]; children?: unknown[] }[] = []) => {
			for (const b of blocks) {
				out.push((b.content ?? []).map((part) => part.text ?? '').join(''));
				walk(b.children as never);
			}
		};
		walk((window as unknown as { __EDYTOR__: ColumnsEdytor }).__EDYTOR__.value.children as never);
		return out.filter(Boolean);
	});

export const valueKind = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __EDYTOR__: ColumnsEdytor }).__EDYTOR__.selection.value.kind
	);

export const selectionValue = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __EDYTOR__: ColumnsEdytor }).__EDYTOR__.selection.value
	);

export const lastStatus = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __EDYTOR__: ColumnsEdytor }).__EDYTOR__.dispatcher.last?.status
	);

/** From `id`'s text straight left to its grip; answers the grip's center. */
export const reachGrip = async (page: Page, id: string, step = 4) => {
	const text = await textBox(page, id);
	const start = { x: text.x + 20, y: text.y + Math.min(text.height, 24) / 2 };
	await page.mouse.move(start.x, start.y);
	await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
	const g = (await grip(page, id).boundingBox())!;
	const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
	await walk(page, start, { x: start.x, y: at.y }, step);
	return walk(page, { x: start.x, y: at.y }, at, step);
};

/** From A2's text to the gap's middle, then a press-drag of `dx`: a column resize. */
export const resize = async (page: Page, dx: number) => {
	const g = await gapOf(page);
	const a2 = await textBox(page, 'A2');
	const row = a2.y + a2.height / 2;
	const at = await walk(page, { x: a2.x + 30, y: row }, { x: g.mid, y: row });
	await page.mouse.down();
	await walk(page, at, { x: at.x + dx, y: row }, 5);
	await page.mouse.up();
	await frames(page);
};

/** From `id`'s text left to its `+`, and a click: the insert menu opens. */
export const clickPlus = async (page: Page, id: string) => {
	const t = await textBox(page, id);
	const row = t.y + Math.min(t.height, 24) / 2;
	await walk(page, { x: t.x + 40, y: row }, { x: t.x + 10, y: row }, 4);
	await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
	const add = (await plus(page, id).boundingBox())!;
	const at = await walk(
		page,
		{ x: t.x + 10, y: row },
		{ x: add.x + add.width / 2, y: add.y + add.height / 2 },
		3
	);
	await page.mouse.down();
	await page.mouse.up();
	return at;
};
