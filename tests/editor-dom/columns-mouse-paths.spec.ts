import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns with a person's mouse (the 2026-10-04 round-2 review, R1 and R2):
 * the pointer goes from a block's text to its ⋮⋮ grip in small steps, and a
 * drag goes down the handle column row by row. A jump straight onto the grip
 * (Playwright's `hover()`/`dragTo`) skips the path a person takes, which is
 * where the regressions were: a handle that loses its hover on the way, a
 * resize strip under the grip in a column's gap, a beside band in the handle
 * column. Desktop engines (a pointer that hovers).
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Edytor = {
	value: { children: Node[] };
	selection: { selectedBlocks: Set<{ id: string }>; selectBlocks: (...blocks: unknown[]) => void };
	idToBlock: Map<string, unknown>;
};
type Node = { id: string; type: string; children?: Node[] };

const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=columns&handles=true');
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const openDemo = async (page: Page) => {
	await page.goto(`/?doc=mouse-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await waitForEditorReady(page);
	await expect(page.locator('[data-edytor-id="page-column-right-text"]')).toBeVisible();
};

const tree = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		const name = (b: Node) => (b.type === 'columns' ? 'L' : b.type === 'column' ? 'col' : b.id);
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [name(b), walk(b.children)] : name(b)));
		return walk(edytor.value.children);
	});

/** The demo's root blocks, in order, a layout as `L`. */
const demoRoots = (page: Page) =>
	page.evaluate(() =>
		Array.from(
			document.querySelectorAll<HTMLElement>('[contenteditable="true"] [data-edytor-block="true"]')
		)
			.filter((block) => !block.parentElement?.closest('[data-edytor-block="true"]'))
			.map((block) =>
				block.dataset.edytorType === 'columns' ? 'L' : (block.dataset.edytorId ?? '')
			)
	);

const selected = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks]
			.map((b) => b.id)
			.sort()
	);

const host = (page: Page, id: string) =>
	page.locator(`[data-edytor-block-handle-host][data-block-id="${id}"]`);
const grip = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
const indicator = (page: Page) => page.locator('[data-edytor-drop-indicator]');
/** The drop indicator's position now (no waiting), `null` when none shows. */
const shownPosition = (page: Page) =>
	page.evaluate(
		() =>
			document.querySelector<HTMLElement>('[data-edytor-drop-indicator]')?.dataset.position ?? null
	);

/**
 * Two animation frames: the drag library applies a pointer move on the next
 * frame, the overlay draws on the one after.
 */
const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);

/** What takes the pointer at a point: a block's handle, a column's resize strip, or else. */
const hitAt = (page: Page, x: number, y: number) =>
	page.evaluate(
		([x, y]) => {
			const hit = document.elementFromPoint(x, y);
			const handle = hit?.closest<HTMLElement>('[data-edytor-block-handle-host]');
			if (handle) return `handle:${handle.dataset.blockId}`;
			if (hit?.closest('[data-edytor-column-resize]')) return 'resize';
			if (hit?.closest('[data-edytor-block="true"]')) return 'block';
			return 'page';
		},
		[x, y]
	);

/**
 * From `id`'s text straight left to its grip's center, `step` px at a time
 * (a person's path, never a jump), the pointer resting there. Answers the
 * grip's center.
 */
const reachGrip = async (page: Page, id: string, step: number) => {
	const text = (await page
		.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`)
		.first()
		.boundingBox())!;
	await page.mouse.move(text.x + 20, text.y + Math.min(text.height, 24) / 2);
	await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
	const g = (await grip(page, id).boundingBox())!;
	const [gx, gy] = [g.x + g.width / 2, g.y + g.height / 2];
	await page.mouse.move(text.x + 20, gy);
	for (let x = text.x + 20 - step; x > gx; x -= step) await page.mouse.move(x, gy);
	await page.mouse.move(gx, gy);
	return { x: gx, y: gy };
};

test.describe('columns: a handle is reached by a person’s mouse path (R1)', () => {
	for (const id of ['A', 'A2', 'B', 'P', 'Z'])
		test(`from ${id}’s text to its grip, the handle stays and takes the pointer`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await open(page);
			const at = await reachGrip(page, id, 4);
			expect(await hitAt(page, at.x, at.y)).toBe(`handle:${id}`);
			await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
			await expect
				.poll(() => host(page, id).evaluate((node) => getComputedStyle(node).opacity))
				.toBe('1');
			// The press is the grip's, not a resize's: a click selects the block.
			await page.mouse.down();
			await page.mouse.up();
			await expect.poll(() => selected(page)).toEqual([id]);
			expect(await tree(page)).toEqual([
				'P',
				[
					'L',
					[
						['col', ['A', 'A2']],
						['col', ['B']]
					]
				],
				'Z'
			]);
			issues.assertClean();
		});

	test('the gap: the resize band its left part, then B’s handle box at its row (round 5)', async ({
		page
	}) => {
		await open(page);
		const [a, a2, b] = [
			await page.locator('[data-edytor-id="A"]').boundingBox(),
			await page.locator('[data-edytor-id="A2"]').boundingBox(),
			await page.locator('[data-edytor-id="B"]').boundingBox()
		];
		const gap = a!.x + a!.width + 5;
		// From column 1's text across the gap at B's row: its left 10px are the
		// band, the rest B's handle box (its + then its grip, flush with B).
		const y = b!.y + Math.min(b!.height, 24) / 2;
		const left = a!.x + a!.width + 2;
		await page.mouse.move(a!.x + a!.width - 10, y);
		for (let x = a!.x + a!.width - 10; x < left; x += 4) await page.mouse.move(x, y);
		await page.mouse.move(left, y);
		expect(await hitAt(page, left, y)).toBe('resize');
		await page.mouse.move(gap, y, { steps: 2 });
		expect(await hitAt(page, gap, y)).toBe('resize');
		await page.mouse.move(a!.x + a!.width + 14, y, { steps: 4 });
		expect(await hitAt(page, a!.x + a!.width + 14, y)).toBe('handle:B');
		await page.mouse.move(b!.x - 4, y, { steps: 4 });
		expect(await hitAt(page, b!.x - 4, y)).toBe('handle:B');
		await expect(host(page, 'B')).toHaveAttribute('data-visible', 'true');
		// Below B's row (A2's height), no handle is there: the band, the gap's left part.
		const low = a2!.y + a2!.height / 2;
		await page.mouse.move(gap, low, { steps: 6 });
		expect(await hitAt(page, gap, low)).toBe('resize');
	});

	test('a block dragged out of column 1 by its grip, reached along the path', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await reachGrip(page, 'A2', 3);
		await page.mouse.down();
		const z = (await page.locator('[data-edytor-id="Z"] [data-edytor-text]').boundingBox())!;
		await page.mouse.move(z.x + 10, z.y + z.height - 3, { steps: 16 });
		await page.mouse.move(z.x + 11, z.y + z.height - 3);
		await frames(page);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				[
					'L',
					[
						['col', ['A']],
						['col', ['B']]
					]
				],
				'Z',
				'A2'
			]);
		issues.assertClean();
	});

	test('a block dragged out of column 2 by its grip in the gap', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await reachGrip(page, 'B', 3);
		await page.mouse.down();
		const z = (await page.locator('[data-edytor-id="Z"] [data-edytor-text]').boundingBox())!;
		await page.mouse.move(z.x + 10, z.y + z.height - 3, { steps: 16 });
		await page.mouse.move(z.x + 11, z.y + z.height - 3);
		await frames(page);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect.poll(() => tree(page)).toEqual(['P', 'A', 'A2', 'Z', 'B']);
		issues.assertClean();
	});

	test('a selected layout dragged by a column block’s grip moves whole', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
			edytor.selection.selectBlocks(...['A', 'A2', 'B'].map((id) => edytor.idToBlock.get(id)));
		});
		await reachGrip(page, 'B', 3);
		await page.mouse.down();
		const z = (await page.locator('[data-edytor-id="Z"] [data-edytor-text]').boundingBox())!;
		await page.mouse.move(z.x + 10, z.y + z.height - 3, { steps: 16 });
		await page.mouse.move(z.x + 11, z.y + z.height - 3);
		await frames(page);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				'Z',
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
});

test.describe('the demo: a handle is reached by a person’s mouse path (R1)', () => {
	for (const id of ['page-column-left-text', 'page-column-right-text', 'page-quote'])
		for (const step of [2, 6, 12])
			test(`${id}, ${step}px steps: its grip opens the block menu`, async ({ page }) => {
				const issues = trackPageIssues(page);
				await openDemo(page);
				const at = await reachGrip(page, id, step);
				expect(await hitAt(page, at.x, at.y)).toBe(`handle:${id}`);
				await page.mouse.down();
				await page.mouse.up();
				await expect(page.locator('[data-edytor-block-menu]')).toHaveCount(1);
				issues.assertClean();
			});
});

test.describe('the demo: a drag straight down the handle column reorders (R2)', () => {
	test('task-one down the grip column to bullet-two’s lower half: after it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDemo(page);
		// Mid-viewport: the drag's auto-scroll (near the window's edges) stays still.
		await page
			.locator('[data-edytor-id="page-task-one"]')
			.evaluate((node) => node.scrollIntoView({ block: 'center' }));
		const before = await demoRoots(page);
		const at = await reachGrip(page, 'page-task-one', 4);
		await page.mouse.down();
		const target = (await page.locator('[data-edytor-id="page-bullet-two"]').boundingBox())!;
		const seen: Array<string | null> = [];
		for (let y = at.y + 6; y <= target.y + target.height - 3; y += 4) {
			await page.mouse.move(at.x, y);
			await frames(page);
			seen.push(await shownPosition(page));
		}
		await page.mouse.move(at.x, target.y + target.height - 3);
		await frames(page);
		// Never a beside band in the handle column; a reorder once past the source's own row.
		expect(seen.filter((position) => position === 'left' || position === 'right')).toEqual([]);
		await expect(indicator(page)).toHaveAttribute('data-position', 'after');
		// The bar under bullet-two, not under a row passed on the way.
		await expect
			.poll(async () => {
				const bar = (await indicator(page).boundingBox())!;
				return Math.abs(bar.y + bar.height / 2 - (target.y + target.height));
			})
			.toBeLessThanOrEqual(4);
		await page.mouse.up();
		const expected = before.filter((id) => id !== 'page-task-one');
		expected.splice(expected.indexOf('page-bullet-two') + 1, 0, 'page-task-one');
		await expect.poll(() => demoRoots(page)).toEqual(expected);
		issues.assertClean();
	});
});

test.describe('columns: every beside band along a person’s path (R2)', () => {
	/** Room left of the editor for a page margin past its handle column (the harness has 24px). */
	const pageMargin = (page: Page) =>
		page.getByTestId('editor-shell').evaluate((shell) => (shell.style.marginLeft = '160px'));
	const box = async (page: Page, id: string) =>
		(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
	/** Walk the pointer from `from` to `to` in `step` px moves, a frame after each. */
	const walk = async (
		page: Page,
		from: { x: number; y: number },
		to: { x: number; y: number },
		step = 6
	) => {
		const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
		for (let i = 1; i <= n; i++) {
			await page.mouse.move(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
			await frames(page);
		}
		return to;
	};

	test('up the handle column to P, then out past it into the page margin: left of P', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await pageMargin(page);
		const at = await reachGrip(page, 'Z', 4);
		await page.mouse.down();
		const p = await box(page, 'P');
		const row = p.y + Math.min(p.height, 24) / 2;
		await walk(page, at, { x: at.x, y: row });
		// In the handle column: a reorder.
		expect(await shownPosition(page)).toMatch(/^(before|after)$/);
		await walk(page, { x: at.x, y: row }, { x: p.x - 70, y: row });
		await expect(indicator(page)).toHaveAttribute('data-position', 'left');
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

	test('along P’s row out past the editor’s right edge: right of P', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await reachGrip(page, 'Z', 4);
		await page.mouse.down();
		const [p, z] = [await box(page, 'P'), await box(page, 'Z')];
		const row = p.y + Math.min(p.height, 24) / 2;
		const inside = await walk(page, at, { x: z.x + 40, y: row });
		await walk(page, inside, { x: p.x + p.width + 40, y: row });
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				[
					'L',
					[
						['col', ['P']],
						['col', ['Z']]
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

	test('across column 1’s text into the gap: a new column between', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const at = await reachGrip(page, 'Z', 4);
		await page.mouse.down();
		const [a, b] = [await box(page, 'A'), await box(page, 'B')];
		const row = a.y + Math.min(a.height, 24) / 2;
		const inside = await walk(page, at, { x: a.x + 30, y: row });
		await walk(page, inside, { x: (a.x + a.width + b.x) / 2, y: row });
		await expect(indicator(page)).toHaveAttribute('data-position', 'right');
		await page.mouse.up();
		await expect
			.poll(() => tree(page))
			.toEqual([
				'P',
				[
					'L',
					[
						['col', ['A', 'A2']],
						['col', ['Z']],
						['col', ['B']]
					]
				]
			]);
		issues.assertClean();
	});
});

test.describe('the block menu’s Turn into, by mouse, at 1280×720 (round-2 finding 4)', () => {
	test('over a low block, every flyout row is in the viewport: 5 columns is reached and clicked', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1280, height: 720 });
		await openDemo(page);
		// A block in the lower part of the viewport (the flyout below it would run off).
		await page
			.locator('[data-edytor-id="page-quote"]')
			.evaluate((node) => node.scrollIntoView({ block: 'end' }));
		await reachGrip(page, 'page-quote', 6);
		await page.mouse.down();
		await page.mouse.up();
		const menu = page.getByRole('menu', { name: 'Block actions' });
		await expect(menu).toBeVisible();
		// To the Turn into row, then right into its flyout, in small steps.
		const turn = (await page.getByTestId('block-menu-turn').boundingBox())!;
		await page.mouse.move(turn.x + 20, turn.y + turn.height / 2, { steps: 8 });
		const flyout = page.getByRole('menu', { name: 'Turn into' });
		await expect(flyout).toBeVisible();
		await frames(page);
		const box = (await flyout.boundingBox())!;
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height).toBeLessThanOrEqual(720);
		expect(box.x + box.width).toBeLessThanOrEqual(1280);
		const y = turn.y + turn.height / 2;
		for (let x = turn.x + 20; x < box.x + 40; x += 8) await page.mouse.move(x, y);
		await page.mouse.move(box.x + 40, y);
		await expect(flyout).toBeVisible();
		// The last row: scrolled to with the wheel inside the flyout if it is taller.
		const last = flyout.getByRole('menuitem', { name: '5 columns' });
		for (let i = 0; i < 20; i++) {
			const row = await last.boundingBox();
			if (row && row.y >= box.y && row.y + row.height <= box.y + box.height) break;
			await page.mouse.wheel(0, 80);
			await frames(page);
		}
		const row = (await last.boundingBox())!;
		expect(row.y).toBeGreaterThanOrEqual(0);
		expect(row.y + row.height).toBeLessThanOrEqual(720);
		await page.mouse.move(row.x + 30, row.y + row.height / 2, { steps: 6 });
		await page.mouse.click(row.x + 30, row.y + row.height / 2);
		const layout = page.locator('[data-edytor-columns]').filter({
			has: page.locator('[data-edytor-id="page-quote"]')
		});
		await expect(layout.locator('[data-edytor-column]')).toHaveCount(5);
		issues.assertClean();
	});
});
