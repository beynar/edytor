import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns, Notion parity, the round-3 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump (Playwright's
 * `hover()`/`dragTo` skip the path a person takes). Desktop engines.
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Block = { id: string; type: string; data?: { width?: number }; children?: Block[] };
type Edytor = {
	value: { children: Block[] };
	idToBlock: Map<string, { data: { width?: number } }>;
	facade: { version: number };
	selection: { value: { kind: string }; selectedBlocks: Set<{ id: string }> };
};

const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=columns&handles=true');
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
const textBox = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first().boundingBox())!;

/** The displayed tree: a layout `L`, a column `col`, any other block its id. */
const tree = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		const name = (b: Block) => (b.type === 'columns' ? 'L' : b.type === 'column' ? 'col' : b.id);
		const walk = (blocks: Block[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [name(b), walk(b.children)] : name(b)));
		return walk(edytor.value.children);
	});

const weights = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		return ['K1', 'K2'].map((id) => edytor.idToBlock.get(id)!.data.width ?? null);
	});

const selected = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks]
			.map((b) => b.id)
			.sort()
	);

/** The selection value's kind, whether the editor holds the focus, and the DOM range count in it. */
const keys = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor & { node: HTMLElement } }).__EDYTOR__;
		const dom = getSelection();
		return {
			kind: edytor.selection.value.kind,
			focused: document.activeElement === edytor.node,
			ranges: dom?.anchorNode && edytor.node.contains(dom.anchorNode) ? dom.rangeCount : 0
		};
	});

/** Two animation frames: the drag library applies a move on the next, the overlay draws on the one after. */
const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);

type Point = { x: number; y: number };

/** The pointer from `from` to `to` in `step` px moves (a person's path), a frame every third. */
const walk = async (page: Page, from: Point, to: Point, step = 4) => {
	const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
	for (let i = 1; i <= n; i++) {
		await page.mouse.move(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
		if (i % 3 === 0) await frames(page);
	}
	await frames(page);
	return to;
};

const host = (page: Page, id: string) =>
	page.locator(`[data-edytor-block-handle-host][data-block-id="${id}"]`);
const grip = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
const indicator = (page: Page) => page.locator('[data-edytor-drop-indicator]');

/** From `id`'s text straight left to its grip (the handle shows on the way); answers the grip's center. */
const reachGrip = async (page: Page, id: string, step = 4) => {
	const text = await textBox(page, id);
	const start = { x: text.x + 20, y: text.y + Math.min(text.height, 24) / 2 };
	await page.mouse.move(start.x, start.y);
	await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
	const g = (await grip(page, id).boundingBox())!;
	const at = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
	await walk(page, start, { x: start.x, y: at.y }, step);
	return walk(page, { x: start.x, y: at.y }, at, step);
};

/** The gap between the two columns, and A2's row (column 2 has no block there). */
const gap = async (page: Page) => {
	const [k1, k2, a2] = [await box(page, 'K1'), await box(page, 'K2'), await box(page, 'A2')];
	return { left: k1.x + k1.width, right: k2.x, low: a2.y + a2.height / 2, k1, k2 };
};

/** From A2's text right into the gap's middle at A2's row, where the resize strip is. */
const reachStrip = async (page: Page) => {
	const g = await gap(page);
	const a2 = await textBox(page, 'A2');
	const start = { x: a2.x + 20, y: g.low };
	await page.mouse.move(start.x, start.y);
	const at = await walk(page, start, { x: (g.left + g.right) / 2, y: g.low });
	await expect(page.locator('[data-edytor-column-resize]')).toHaveCount(1);
	return at;
};

const LAYOUT = [
	'L',
	[
		['col', ['A', 'A2']],
		['col', ['B']]
	]
];

test.describe('undo and redo right after a mouse-only gesture (round 3, gap 1)', () => {
	test('a resize by the gap, then Mod+Z and Mod+Shift+Z', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await reachStrip(page);
		await page.mouse.down();
		await walk(page, at, { x: at.x + 80, y: at.y });
		await page.mouse.up();
		await expect.poll(() => weights(page)).not.toEqual([null, null]);
		const resized = await weights(page);
		// The editor holds the keys, and no caret shows (none was there).
		await expect.poll(() => keys(page)).toEqual({ kind: 'none', focused: true, ranges: 0 });
		// No click into the text first.
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => weights(page)).toEqual([null, null]);
		await expect.poll(() => keys(page)).toEqual({ kind: 'none', focused: true, ranges: 0 });
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => weights(page)).toEqual(resized);
		issues.assertClean();
	});

	test('P dragged below Z by its grip, then Mod+Z and Mod+Shift+Z', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await reachGrip(page, 'P');
		await page.mouse.down();
		const z = await textBox(page, 'Z');
		await walk(page, at, { x: z.x + 8, y: z.y + z.height * 0.85 }, 6);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual([LAYOUT, 'Z', 'P']);
		await expect.poll(() => keys(page)).toEqual({ kind: 'blocks', focused: true, ranges: 0 });
		expect(await selected(page)).toEqual(['P']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => tree(page)).toEqual(['P', LAYOUT, 'Z']);
		await expect.poll(() => keys(page)).toEqual({ kind: 'none', focused: true, ranges: 0 });
		// The undo gave back "no selection" (the drag's start): the keys stay the editor's.
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => tree(page)).toEqual([LAYOUT, 'Z', 'P']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => tree(page)).toEqual(['P', LAYOUT, 'Z']);
		issues.assertClean();
	});

	test('B dragged out of its column (the layout dissolves), then Mod+Z and Mod+Shift+Z', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await reachGrip(page, 'B');
		await page.mouse.down();
		const z = await textBox(page, 'Z');
		await walk(page, at, { x: z.x + 8, y: z.y + z.height * 0.85 }, 6);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P', 'A', 'A2', 'Z', 'B']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => tree(page)).toEqual(['P', LAYOUT, 'Z']);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => tree(page)).toEqual(['P', 'A', 'A2', 'Z', 'B']);
		issues.assertClean();
	});
});

/** What takes the pointer at a point: a block's handle, a column's resize strip, or else. */
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

test.describe('a column-2 block’s grip, reached from anywhere (round 3, gap 2)', () => {
	for (const from of ['A', 'A2', 'P', 'Z'])
		for (const step of [2, 6, 12])
			test(`from ${from}’s text straight to B’s grip in the gap, ${step}px steps`, async ({
				page
			}) => {
				const issues = trackPageIssues(page);
				await open(page);
				const text = await textBox(page, from);
				const start = { x: text.x + Math.min(text.width - 4, 40), y: text.y + text.height / 2 };
				await page.mouse.move(start.x, start.y);
				await frames(page);
				// The grip's place (its handle is mounted, transparent, near the viewport).
				const g = (await grip(page, 'B').boundingBox())!;
				const at = await walk(page, start, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, step);
				expect(await hitAt(page, at.x, at.y)).toBe('handle:B');
				await expect(host(page, 'B')).toHaveAttribute('data-visible', 'true');
				await page.mouse.down();
				await page.mouse.up();
				await expect.poll(() => selected(page)).toEqual(['B']);
				expect(await tree(page)).toEqual(['P', LAYOUT, 'Z']);
				issues.assertClean();
			});

	test('the handle’s box is the gap’s right part at its row; the strip takes the rest of the gap', async ({
		page
	}) => {
		await open(page);
		const g = await gap(page);
		const b = await box(page, 'B');
		const row = b.y + b.height / 2;
		// From column 1's text into the gap at B's row (B not hovered on the way).
		const a = await textBox(page, 'A');
		await walk(page, { x: a.x + 30, y: row }, { x: g.left + 2, y: row });
		expect(await hitAt(page, g.left + 2, row)).toBe('resize');
		const h = (await host(page, 'B').boundingBox())!;
		// Flush with B, as wide as the measured handle, the row's height.
		expect(Math.abs(h.x + h.width - b.x)).toBeLessThanOrEqual(1);
		expect(h.width).toBeLessThan(g.right - g.left);
		for (const x of [h.x + 1, (h.x + g.right) / 2, g.right - 1])
			for (const y of [b.y + 1, row, b.y + b.height - 1])
				expect(await hitAt(page, x, y)).toBe('handle:B');
		// Below B's row (A2's), no column-2 block: the whole gap resizes.
		for (const x of [g.left + 2, (g.left + g.right) / 2, g.right - 2])
			expect(await hitAt(page, x, g.low)).toBe('resize');
	});

	test('a resize from the gap’s left part at B’s row', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const g = await gap(page);
		const b = await box(page, 'B');
		const row = b.y + b.height / 2;
		const a = await textBox(page, 'A');
		const at = await walk(page, { x: a.x + 30, y: row }, { x: g.left + 2, y: row });
		await page.mouse.down();
		await walk(page, at, { x: at.x - 60, y: row });
		await page.mouse.up();
		await expect.poll(async () => Math.round((await box(page, 'K1')).width - g.k1.width)).toBe(-60);
		issues.assertClean();
	});
});

test.describe('a live resize (round 3, gap 3)', () => {
	/** Commits that changed the document since `count` started (`facade.onChange`). */
	const count = (page: Page) =>
		page.evaluate(() => {
			const edytor = (
				window as unknown as {
					__EDYTOR__: Edytor & { facade: { onChange: (cb: () => void) => void } };
				}
			).__EDYTOR__;
			const w = window as unknown as { __changes: number };
			w.__changes = 0;
			edytor.facade.onChange(() => w.__changes++);
		});
	const changes = (page: Page) =>
		page.evaluate(() => (window as unknown as { __changes: number }).__changes);
	const widths = async (page: Page) => [
		(await box(page, 'K1')).width,
		(await box(page, 'K2')).width
	];

	test('both columns follow the pointer; nothing is written until the release, which writes once', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const g = await gap(page);
		await count(page);
		const at = await reachStrip(page);
		await page.mouse.down();
		let x = at.x;
		for (const by of [20, 40, 80]) {
			x = (await walk(page, { x, y: at.y }, { x: at.x + by, y: at.y })).x;
			await expect
				.poll(async () => (await widths(page)).map((w) => Math.round(w)))
				.toEqual([Math.round(g.k1.width + by), Math.round(g.k2.width - by)]);
			expect(await weights(page)).toEqual([null, null]);
			expect(await changes(page)).toBe(0);
		}
		// Back left past the start: they follow both ways.
		x = (await walk(page, { x, y: at.y }, { x: at.x - 30, y: at.y })).x;
		await expect
			.poll(async () => Math.round((await widths(page))[0]!))
			.toBe(Math.round(g.k1.width - 30));
		await walk(page, { x, y: at.y }, { x: at.x + 80, y: at.y });
		await page.mouse.up();
		await expect.poll(() => changes(page)).toBe(1);
		const [w1, w2] = (await weights(page)) as number[];
		expect(w1! + w2!).toBeCloseTo(2, 6);
		// The widths stay where the drag left them (no jump on release).
		const [k1, k2] = await widths(page);
		expect(Math.abs(k1! - (g.k1.width + 80))).toBeLessThanOrEqual(1);
		expect(Math.abs(k2! - (g.k2.width - 80))).toBeLessThanOrEqual(1);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => weights(page)).toEqual([null, null]);
		await expect
			.poll(async () => Math.round((await widths(page))[0]!))
			.toBe(Math.round(g.k1.width));
		issues.assertClean();
	});

	test('Escape mid-drag puts the widths back and writes nothing', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const g = await gap(page);
		await count(page);
		const at = await reachStrip(page);
		await page.mouse.down();
		await walk(page, at, { x: at.x + 60, y: at.y });
		await expect
			.poll(async () => Math.round((await widths(page))[0]!))
			.toBe(Math.round(g.k1.width + 60));
		await page.keyboard.press('Escape');
		await expect
			.poll(async () => (await widths(page)).map((w) => Math.round(w)))
			.toEqual([Math.round(g.k1.width), Math.round(g.k2.width)]);
		await walk(page, { x: at.x + 60, y: at.y }, { x: at.x + 90, y: at.y });
		await page.mouse.up();
		expect(await weights(page)).toEqual([null, null]);
		expect(await changes(page)).toBe(0);
		expect((await widths(page)).map((w) => Math.round(w))).toEqual([
			Math.round(g.k1.width),
			Math.round(g.k2.width)
		]);
		issues.assertClean();
	});

	test('the live widths stop at the minimum (10% of the layout)', async ({ page }) => {
		await open(page);
		const c = await box(page, 'C');
		const at = await reachStrip(page);
		await page.mouse.down();
		await walk(page, at, { x: at.x + 400, y: at.y }, 8);
		await expect
			.poll(async () => Math.round((await box(page, 'K2')).width))
			.toBe(Math.round(c.width * 0.1));
		await page.mouse.up();
		await expect
			.poll(async () => Math.round((await box(page, 'K2')).width))
			.toBe(Math.round(c.width * 0.1));
	});
});

/** A doc of `children`, the editor 160px in from the page's left (room for a page margin). */
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
const MIXED = [
	para('P1', 'first paragraph'),
	{
		id: 'UL',
		type: 'unordered-list',
		children: [
			{ id: 'I1', type: 'list-item', content: [{ text: 'container item one' }] },
			{ id: 'I2', type: 'list-item', content: [{ text: 'container item two' }] }
		]
	},
	{
		id: 'L1',
		type: 'bulleted-list-item',
		content: [{ text: 'list one' }],
		children: [{ id: 'L1a', type: 'bulleted-list-item', content: [{ text: 'nested item' }] }]
	},
	{
		id: 'C',
		type: 'columns',
		children: [
			{ id: 'K1', type: 'column', children: [para('A', 'col a')] },
			{ id: 'K2', type: 'column', children: [para('B', 'col b')] }
		]
	},
	para('Z', 'last paragraph')
];
/** The placement shown now: its position and the block it is relative to. */
const shown = (page: Page) =>
	page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');
		const at = document.querySelector<HTMLElement>('[data-edytor-block-drop-position]');
		return bar ? `${bar.dataset.position} ${at?.dataset.edytorId}` : null;
	});

test.describe('the handle column reorders at the pointer’s row (round 3, gaps 4 and 5)', () => {
	test('P1 down the handle column past a nested list item to the layout: the layout’s row, never a held “before L1a”', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, MIXED);
		const at = await reachGrip(page, 'P1');
		const x = (await textBox(page, 'P1')).x - 12;
		await page.mouse.down();
		await walk(page, at, { x, y: at.y + 12 });
		const [l1, c] = [await box(page, 'L1'), await box(page, 'C')];
		const seen: Array<[number, string | null]> = [];
		for (let y = at.y + 12; y <= c.y + c.height * 0.75; y += 4) {
			await page.mouse.move(x, y);
			await frames(page);
			seen.push([Math.round(y - l1.y), await shown(page)]);
		}
		// Over L1a's own row, its placements; over the layout's row, the row there (A's).
		const l1a = await box(page, 'L1a');
		const overLayout = seen.filter(([dy]) => dy + l1.y > c.y + 2).map(([, s]) => s);
		expect(overLayout.length).toBeGreaterThan(0);
		expect(overLayout.filter((s) => !/^(before|after) A$/.test(s ?? ''))).toEqual([]);
		const overL1a = seen
			.filter(([dy]) => dy + l1.y > l1a.y + 2 && dy + l1.y < l1a.y + l1a.height - 2)
			.map(([, s]) => s);
		expect(overL1a.filter((s) => !/ L1a$|after L1$/.test(s ?? ''))).toEqual([]);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				['UL', ['I1', 'I2']],
				['L1', ['L1a']],
				[
					'L',
					[
						['col', ['A', 'P1']],
						['col', ['B']]
					]
				],
				'Z'
			]);
		issues.assertClean();
	});

	for (const half of [0.25, 0.75])
		test(`Z up the handle column to a list’s first item (${half === 0.25 ? 'upper' : 'lower'} half): never inside it`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, MIXED);
			const at = await reachGrip(page, 'Z');
			const x = (await textBox(page, 'Z')).x - 12;
			await page.mouse.down();
			await walk(page, at, { x, y: at.y - 12 });
			const i1 = await box(page, 'I1');
			const seen: Array<string | null> = [];
			for (let y = at.y - 12; y >= i1.y + i1.height * half; y -= 4) {
				await page.mouse.move(x, y);
				await frames(page);
				seen.push(await shown(page));
			}
			await page.mouse.move(x, i1.y + i1.height * half);
			await frames(page);
			seen.push(await shown(page));
			expect(seen.filter((s) => s?.startsWith('inside'))).toEqual([]);
			await page.mouse.up();
			await frames(page);
			// Never nested under the item.
			expect(JSON.stringify(await tree(page))).not.toContain('["I1",[');
			issues.assertClean();
		});
});
