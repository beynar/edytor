import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * A block drag reaches past the editor's content column (the delete
 * contract's `dnd.reach`): within the editor's height, a pointer left of the
 * content (the handle column, then the page margin past it) or right of it,
 * up to `--edytor-drop-reach` (240px by default) past the handle column and
 * past the content's right edge, drops on the row at its height:
 *
 * - left: before or after that row, as the handle column does (the
 *   outermost level it ends; never inside);
 * - right: as at the content's right edge (the same before, after or
 *   inside: nothing jumps when the pointer leaves the content);
 * - in a layout, the row of the column nearest the pointer (left: the first
 *   column, right: the last), never another;
 * - with a layout kind, the first 120px of each margin stay the beside
 *   bands (a new column); past them, the reorder;
 * - past the reach, nothing: released there, the drag moves nothing.
 *
 * The jsdom rows are `src/tests/fixtures/dom/columns-dnd.test.tsx`
 * ("the drop reach"), the zones `src/tests/drop-reach.test.ts`.
 */

type Node = { id: string; children?: Node[] };

/** The editor 330px in from the page's left (room for the left margin), 520px wide. */
const LEFT = 330;
const WIDTH = 520;

const para = (id: string, text: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ text }],
	...(children && { children })
});

const PARAGRAPHS = [
	para('P1', 'one paragraph'),
	para('P2', 'two paragraph'),
	para('P3', 'three paragraph'),
	para('P4', 'four paragraph')
];

const LAYOUT = [
	para('P', 'before'),
	{
		id: 'C',
		type: 'columns',
		children: [
			{ id: 'K1', type: 'column', children: [para('A', 'left one'), para('A2', 'left two')] },
			{ id: 'K2', type: 'column', children: [para('B', 'right')] }
		]
	},
	para('Z', 'after')
];

/** `columns: false`: the columns plugin is not listed (no layout kind, no beside band). */
const openDoc = async (page: Page, children: unknown[], { columns = true } = {}) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true${columns ? '' : '&columns=0'}&dst=${encodeURIComponent(
			JSON.stringify({ children })
		)}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await page
		.getByTestId('editor-shell')
		.evaluate(
			(shell, [left, width]) =>
				Object.assign(shell.style, { marginLeft: `${left}px`, width: `${width}px` }),
			[LEFT, WIDTH]
		);
};

/** The editor's content column: where its blocks' boxes start and end. */
const content = (page: Page) =>
	page.evaluate(() => {
		const root = (window as unknown as { __EDYTOR__: { node: HTMLElement } }).__EDYTOR__.node;
		const style = getComputedStyle(root);
		const rect = root.getBoundingClientRect();
		return {
			start: rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
			end: rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
		};
	});

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;

/** A height in `id`'s first row: `at` 0 its top … 1 its bottom (24px rows). */
const rowY = async (page: Page, id: string, at: number) => {
	const b = await box(page, id);
	return b.y + Math.min(b.height, 24) * at;
};

/** The displayed tree, as ids. */
const tree = (page: Page) =>
	page.evaluate(() => {
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [b.id, walk(b.children)] : b.id));
		return walk(
			(window as unknown as { __EDYTOR__: { value: { children: Node[] } } }).__EDYTOR__.value
				.children
		);
	});

/** The placement shown: its position and the block it is relative to, or `null`. */
const shown = async (page: Page) => {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	return page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');
		const at = document.querySelector<HTMLElement>('[data-edytor-block-drop-position]');
		return bar ? `${bar.dataset.position} ${at?.dataset.edytorId}` : null;
	});
};

/**
 * Move the pressed pointer to `to`, then 1px further (a drag's last move
 * applies with the next one); in Chromium, which answers a drag move before
 * the page saw it, wait until the page handled a drag event there.
 */
const moveTo = async (page: Page, to: { x: number; y: number }) => {
	await page.mouse.move(to.x - 1, to.y, { steps: 6 });
	await page.mouse.move(to.x, to.y);
	if (page.context().browser()?.browserType().name() !== 'chromium') return;
	await page.waitForFunction(({ x, y }) => {
		const seen = window as unknown as { __dragX?: number; __dragY?: number };
		return (
			Math.abs((seen.__dragX ?? -Infinity) - x) <= 1 &&
			Math.abs((seen.__dragY ?? -Infinity) - y) <= 1
		);
	}, to);
};

/** Press `id`'s grip and start its drag toward `to` (the button stays down). */
const dragTo = async (page: Page, id: string, to: { x: number; y: number }) => {
	await page.evaluate(() => {
		const seen = window as unknown as { __dragX?: number; __dragY?: number };
		for (const type of ['dragenter', 'dragover'])
			window.addEventListener(
				type,
				(event) => {
					seen.__dragX = (event as DragEvent).clientX;
					seen.__dragY = (event as DragEvent).clientY;
				},
				{ capture: true }
			);
	});
	await page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().hover();
	const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
	await expect(grip).toBeVisible();
	const g = (await grip.boundingBox())!;
	await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x - 12, to.y, { steps: 12 });
	await moveTo(page, to);
};

test.describe('the drop reach (dnd.reach): a block drag outside the content column', () => {
	test('no layout kind: 40px left of the content (the handle column), before the row there', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, PARAGRAPHS, { columns: false });
		const { start } = await content(page);
		await dragTo(page, 'P4', { x: start - 40, y: await rowY(page, 'P2', 0.25) });
		await expect.poll(() => shown(page)).toBe('before P2');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P1', 'P4', 'P2', 'P3']);
		issues.assertClean();
	});

	test('no layout kind: 90px left of the content (past the handle column), the row’s halves', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, PARAGRAPHS, { columns: false });
		const { start } = await content(page);
		await dragTo(page, 'P4', { x: start - 90, y: await rowY(page, 'P1', 0.75) });
		await expect.poll(() => shown(page)).toBe('after P1');
		await moveTo(page, { x: start - 90, y: await rowY(page, 'P2', 0.25) });
		await expect.poll(() => shown(page)).toBe('before P2');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P1', 'P4', 'P2', 'P3']);
		issues.assertClean();
	});

	test('no layout kind: 60px right of the content, between two root blocks', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, PARAGRAPHS, { columns: false });
		const { end } = await content(page);
		await dragTo(page, 'P1', { x: end + 60, y: await rowY(page, 'P3', 0.25) });
		await expect.poll(() => shown(page)).toBe('before P3');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P2', 'P1', 'P3', 'P4']);
		issues.assertClean();
	});

	test('a nested block: right of the content, the placement the content’s right edge shows, the same all the way out', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(
			page,
			[
				para('P', 'parent', [para('N1', 'nested one'), para('N2', 'nested two')]),
				para('Q', 'last')
			],
			{ columns: false }
		);
		const { end } = await content(page);
		const lower = await rowY(page, 'N2', 0.75);
		await dragTo(page, 'Q', { x: end - 8, y: lower });
		const inContent = await shown(page);
		// Past one nesting step right of N2's text, its lower half nests (`zones`).
		expect(inContent).toBe('inside N2');
		for (const x of [end + 10, end + 30, end + 60, end + 150]) {
			await moveTo(page, { x, y: lower });
			expect(await shown(page)).toBe(inContent);
		}
		await moveTo(page, { x: end + 60, y: await rowY(page, 'N1', 0.25) });
		await expect.poll(() => shown(page)).toBe('before N1');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual([['P', ['Q', 'N1', 'N2']]]);
		issues.assertClean();
	});

	test('a nested block: left of the content, its row’s halves at the outermost level it ends (the handle column’s)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(
			page,
			[
				para('P', 'parent', [para('N1', 'nested one'), para('N2', 'nested two')]),
				para('Q', 'last')
			],
			{ columns: false }
		);
		const { start } = await content(page);
		await dragTo(page, 'Q', { x: start - 90, y: await rowY(page, 'N2', 0.25) });
		await expect.poll(() => shown(page)).toBe('before N2');
		await moveTo(page, { x: start - 200, y: await rowY(page, 'N1', 0.75) });
		await expect.poll(() => shown(page)).toBe('after N1');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual([['P', ['N1', 'Q', 'N2']]]);
		issues.assertClean();
	});

	test('a layout, far right (past the beside band): the last column’s row there, never another column', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, LAYOUT);
		const { end } = await content(page);
		// At A2's height column 2 shows no row of its own: its last block's (B's
		// lower half), as just inside the content's right edge.
		const low = await rowY(page, 'A2', 0.5);
		await dragTo(page, 'Z', { x: end - 8, y: low });
		const inContent = await shown(page);
		expect(inContent).toMatch(/ B$/);
		await moveTo(page, { x: end + 180, y: low });
		expect(await shown(page)).toBe(inContent);
		await moveTo(page, { x: end + 180, y: await rowY(page, 'B', 0.25) });
		await expect.poll(() => shown(page)).toBe('before B');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['Z', 'B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('a layout, far left (past the beside band): the first column’s row there', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, LAYOUT);
		const { start } = await content(page);
		await dragTo(page, 'Z', { x: start - 46 - 180, y: await rowY(page, 'A2', 0.25) });
		await expect.poll(() => shown(page)).toBe('before A2');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'Z', 'A2']],
						['K2', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('with a layout kind the beside bands keep the margins’ first 120px: a new column', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, LAYOUT);
		const { end } = await content(page);
		await dragTo(page, 'Z', { x: end + 60, y: await rowY(page, 'P', 0.5) });
		await expect.poll(() => shown(page)).toBe('right P');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					expect.any(String),
					[
						[expect.any(String), ['P']],
						[expect.any(String), ['Z']]
					]
				],
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('the left band past the handle column still makes a column; past it, the reorder', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, LAYOUT);
		const { start } = await content(page);
		const y = await rowY(page, 'P', 0.25);
		await dragTo(page, 'Z', { x: start - 46 - 60, y });
		await expect.poll(() => shown(page)).toBe('left P');
		await moveTo(page, { x: start - 46 - 180, y });
		await expect.poll(() => shown(page)).toBe('before P');
		await moveTo(page, { x: start - 46 - 60, y });
		await expect.poll(() => shown(page)).toBe('left P');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					expect.any(String),
					[
						[expect.any(String), ['Z']],
						[expect.any(String), ['P']]
					]
				],
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['B']]
					]
				]
			]);
		issues.assertClean();
	});

	test('past the reach (240px), nothing: released there, nothing moves', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, PARAGRAPHS, { columns: false });
		const { start, end } = await content(page);
		const y = await rowY(page, 'P2', 0.25);
		await dragTo(page, 'P4', { x: end + 100, y });
		await expect.poll(() => shown(page)).toBe('before P2');
		await moveTo(page, { x: end + 300, y });
		await expect.poll(() => shown(page)).toBeNull();
		await moveTo(page, { x: start - 46 - 300, y });
		await expect.poll(() => shown(page)).toBeNull();
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P1', 'P2', 'P3', 'P4']);
		issues.assertClean();
	});

	test('--edytor-drop-reach widens the reach', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, PARAGRAPHS, { columns: false });
		await page
			.getByTestId('editor-shell')
			.evaluate((shell) => shell.style.setProperty('--edytor-drop-reach', '400px'));
		const { end } = await content(page);
		await dragTo(page, 'P4', { x: end + 300, y: await rowY(page, 'P2', 0.25) });
		await expect.poll(() => shown(page)).toBe('before P2');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P1', 'P4', 'P2', 'P3']);
		issues.assertClean();
	});
});
