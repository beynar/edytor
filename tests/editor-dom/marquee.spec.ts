import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * The marquee in real browsers (`sel.marquee`, `sel.marquee.blocks` in
 * docs/editor-delete-contract.md; Notion's rubber band): a press in the
 * editor's empty area — the page's margins (the route's editor shell, the
 * plugin's `container`), the space below the last block — and a drag past
 * 4px select, live, the blocks the rectangle meets. The jsdom rows (which
 * blocks a rectangle selects, the cost of a move) are
 * `src/tests/fixtures/dom/marquee.test.tsx`; touch is `mobile-marquee.spec.ts`.
 */
type Json = Record<string, unknown>;
const p = (id: string, text = `${id.toLowerCase()} text`): Json => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

const open = async (page: Page, children: Json[]) => {
	await page.goto(
		`/test/dom?scenario=dst&marquee=1&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The selected blocks' ids, in document order. */
const selected = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		return [...edytor.selection.selectedBlocks]
			.sort(edytor.compareBlocks)
			.map((block: { id: string }) => block.id);
	});

/** The selection's kind and the caret's block and offset. */
const value = (page: Page) =>
	page.evaluate(() => {
		const { selection } = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		const caret = selection.caret;
		return [selection.value.kind, caret?.block.id ?? null, caret?.offset ?? null];
	});

const ids = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { __EDYTOR__: any }).__EDYTOR__.value.children.map(
			(block: { id: string }) => block.id
		)
	);

const boxOf = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).boundingBox())!;

/** The middle of block `id`'s row: `x` from its left edge (negative: in the left margin). */
const at = async (page: Page, id: string, x: number) => {
	const box = await boxOf(page, id);
	return { x: box.x + x, y: box.y + box.height / 2 };
};

const drag = async (page: Page, from: { x: number; y: number }) => {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
};
const to = (page: Page, point: { x: number; y: number }) =>
	page.mouse.move(point.x, point.y, { steps: 6 });

const rectangle = (page: Page) => page.locator('[data-edytor-marquee]');

test.describe('the marquee (sel.marquee)', () => {
	test('from the left margin over three blocks: they are selected live, mid-drag, and stay', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [p('A'), p('B'), p('C'), p('D')]);
		await drag(page, await at(page, 'A', -40));
		await to(page, await at(page, 'B', 60));
		await expect.poll(() => selected(page)).toEqual(['A', 'B']);
		await expect(rectangle(page)).toBeVisible();
		await to(page, await at(page, 'C', 60));
		await expect.poll(() => selected(page)).toEqual(['A', 'B', 'C']);
		await page.mouse.up();
		await expect(rectangle(page)).toHaveCount(0);
		await expect.poll(() => selected(page)).toEqual(['A', 'B', 'C']);
		// No native range competes with the block selection.
		const range = await page.evaluate(() => document.getSelection()?.isCollapsed ?? true);
		expect(range).toBe(true);
		issues.assertClean();
	});

	test('from the right margin, leftwards', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C')]);
		const c = await boxOf(page, 'C');
		await drag(page, { x: c.x + c.width + 40, y: c.y + c.height / 2 });
		await to(page, await at(page, 'B', 60));
		await expect.poll(() => selected(page)).toEqual(['B', 'C']);
		await page.mouse.up();
		await expect.poll(() => selected(page)).toEqual(['B', 'C']);
	});

	test('from below the last block, upwards; nothing is written', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C')]);
		const c = await boxOf(page, 'C');
		await drag(page, { x: c.x + 120, y: c.y + c.height + 14 });
		await to(page, await at(page, 'B', 60));
		await expect.poll(() => selected(page)).toEqual(['B', 'C']);
		await page.mouse.up();
		await expect.poll(() => selected(page)).toEqual(['B', 'C']);
		expect(await ids(page)).toEqual(['A', 'B', 'C']);
	});

	test('a click below the last block still puts the caret in a trailing paragraph (nav.trailing.press)', async ({
		page
	}) => {
		await open(page, [p('A'), { id: 'T', type: 'toggle', content: [{ text: 'toggle' }] }]);
		const t = await boxOf(page, 'T');
		await page.mouse.click(t.x + 120, t.y + t.height + 14);
		await expect.poll(() => ids(page)).toHaveLength(3);
		const trailing = (await ids(page))[2];
		await expect.poll(() => value(page)).toEqual(['text', trailing, 0]);
		await page.keyboard.type('x');
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { __EDYTOR__: any }).__EDYTOR__.value.children[2].content
				)
			)
			.toEqual([{ text: 'x' }]);
	});

	test('a drag that starts in text stays a text selection', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C')]);
		await drag(page, await at(page, 'A', 4));
		await to(page, await at(page, 'C', 30));
		await page.mouse.up();
		await expect.poll(() => value(page)).toEqual(['text', null, null]);
		expect(await selected(page)).toEqual([]);
		await expect(rectangle(page)).toHaveCount(0);
	});

	test('Delete removes the selected blocks', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C'), p('D')]);
		await drag(page, await at(page, 'B', -40));
		await to(page, await at(page, 'C', 60));
		await page.mouse.up();
		await expect.poll(() => selected(page)).toEqual(['B', 'C']);
		await page.keyboard.press('Delete');
		await expect.poll(() => ids(page)).toEqual(['A', 'D']);
	});

	test('Escape mid-drag gives back the caret from before the press', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C')]);
		const b = page.locator('[data-edytor-id="B"] [data-edytor-text]');
		const box = (await b.boundingBox())!;
		await page.mouse.click(box.x + 2, box.y + box.height / 2);
		await expect.poll(() => value(page)).toEqual(['text', 'B', 0]);
		await drag(page, await at(page, 'A', -40));
		await to(page, await at(page, 'C', 60));
		await expect.poll(() => selected(page)).toEqual(['A', 'B', 'C']);
		await page.keyboard.press('Escape');
		await expect.poll(() => value(page)).toEqual(['text', 'B', 0]);
		await expect(rectangle(page)).toHaveCount(0);
		await to(page, await at(page, 'B', 60));
		await page.mouse.up();
		await expect.poll(() => value(page)).toEqual(['text', 'B', 0]);
	});

	test('Shift at the press adds to the block selection', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C'), p('D')]);
		await drag(page, await at(page, 'A', -40));
		await to(page, await at(page, 'A', 60));
		await page.mouse.up();
		await expect.poll(() => selected(page)).toEqual(['A']);
		await page.keyboard.down('Shift');
		await drag(page, await at(page, 'C', -40));
		await to(page, await at(page, 'D', 60));
		await page.mouse.up();
		await page.keyboard.up('Shift');
		await expect.poll(() => selected(page)).toEqual(['A', 'C', 'D']);
	});

	test('near the bottom of the viewport the page scrolls and the rectangle extends with it', async ({
		page
	}) => {
		await open(
			page,
			Array.from({ length: 80 }, (_, i) => p(`b${i}`))
		);
		await page.evaluate(() => window.scrollTo(0, 0));
		const height = page.viewportSize()!.height;
		const shown = await page.evaluate(
			(limit) =>
				[...document.querySelectorAll('[data-edytor-block="true"]')].filter(
					(node) => node.getBoundingClientRect().top < limit
				).length,
			height
		);
		const first = await at(page, 'b0', -40);
		await drag(page, first);
		await to(page, { x: first.x + 100, y: height - 4 });
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
		await page.mouse.up();
		const chosen = await selected(page);
		// The press's block stays in: the rectangle kept its start in the page.
		expect(chosen[0]).toBe('b0');
		// More blocks than the viewport showed at the press: the rectangle grew with the scroll.
		expect(chosen.length).toBeGreaterThan(shown);
	});
});

test.describe('sel.blocks.outside: a press outside the view ends its block selection', () => {
	/** Marquee-select A and B. */
	const selectAB = async (page: Page) => {
		await drag(page, await at(page, 'A', -40));
		await to(page, await at(page, 'B', 60));
		await page.mouse.up();
		await expect.poll(() => selected(page)).toEqual(['A', 'B']);
	};
	/** A point on the page outside the editor and its container: the viewport's right edge. */
	const outside = async (page: Page) => {
		const b = await boxOf(page, 'B');
		return { x: page.viewportSize()!.width - 4, y: b.y + b.height / 2 };
	};

	test('a click outside clears it; nothing is written', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [p('A'), p('B'), p('C')]);
		await selectAB(page);
		const point = await outside(page);
		await page.mouse.click(point.x, point.y);
		await expect.poll(() => selected(page)).toEqual([]);
		expect((await value(page))[0]).toBe('none');
		expect(await ids(page)).toEqual(['A', 'B', 'C']);
		issues.assertClean();
	});

	test('Shift, or an app element marked data-edytor-keep-selection, keeps it', async ({ page }) => {
		await open(page, [p('A'), p('B'), p('C')]);
		await selectAB(page);
		const point = await outside(page);
		await page.keyboard.down('Shift');
		await page.mouse.click(point.x, point.y);
		await page.keyboard.up('Shift');
		await expect.poll(() => selected(page)).toEqual(['A', 'B']);
		// An app's own toolbar acting on the selected blocks.
		await page.evaluate(() => {
			const button = document.createElement('button');
			button.textContent = 'App action';
			button.dataset.edytorKeepSelection = '';
			button.style.cssText = 'position: fixed; right: 0; bottom: 0; z-index: 9999';
			document.body.append(button);
		});
		await page.getByRole('button', { name: 'App action' }).click();
		await expect.poll(() => selected(page)).toEqual(['A', 'B']);
	});
});
