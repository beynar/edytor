import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';
import {
	FULL,
	box,
	frames,
	gapOf,
	openDoc,
	reachGrip,
	resize,
	selectionValue,
	textBox,
	texts,
	walk,
	widths,
	type Point
} from './columnsPaths';

/**
 * Columns, Notion parity, the round-7 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump. Desktop engines.
 */

/** The DOM selection's text, its whitespace folded. */
const selectedText = (page: Page) =>
	page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim());

/** A text selection from 15px into A2's text, dragged right in 4px steps to `x` on its row. */
const selectFromA2 = async (page: Page, x: (gap: Awaited<ReturnType<typeof gapOf>>) => number) => {
	const a2 = await textBox(page, 'A2');
	const row = a2.y + a2.height / 2;
	const start: Point = { x: a2.x + 15, y: row };
	await walk(page, { x: start.x - 9, y: row - 6 }, start, 3);
	await page.mouse.down();
	const gap = await gapOf(page);
	const trail: string[] = [];
	await walk(page, start, { x: x(gap), y: row }, 4, async (at) => {
		if (at.x >= gap.left) trail.push(await selectedText(page));
	});
	const live = await selectedText(page);
	await page.mouse.up();
	await frames(page);
	return { live, trail, value: (await selectionValue(page)) as SelectionValue };
};

type SelectionValue = {
	kind: string;
	ids?: string[];
	anchor?: { b: string };
	focus?: { b: string };
};

test.describe('a text selection dragged over the bare gap keeps to the nearest column (round 7, issue 1)', () => {
	test('from A2 into the gap’s left half: the selection stays in A2’s row, in column 1', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const { live, trail, value } = await selectFromA2(
			page,
			(gap) => gap.left + (gap.right - gap.left) * 0.4
		);
		// At every step over the gap's left half: A2's rest only.
		expect(trail.length).toBeGreaterThan(2);
		expect(new Set(trail)).toEqual(new Set(['ft two']));
		expect(live).toBe('ft two');
		expect(value).toMatchObject({ kind: 'text', anchor: { b: 'A2' }, focus: { b: 'A2' } });
		issues.assertClean();
	});

	// Past the gap's middle the drag enters column 2: a block selection since round 8
	// (`sel.drag.across-columns`, columns-round8.spec.ts), no longer a text range.
	test('from A2 into the gap’s right half: column 2 is reached, as a block selection from A2 (round 8)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const { live, value } = await selectFromA2(
			page,
			(gap) => gap.left + (gap.right - gap.left) * 0.75
		);
		// The native range under the drag is not the value (its highlight is hidden).
		expect(live).toContain('left three');
		expect(live).not.toContain('right two');
		expect(value.kind).toBe('blocks');
		expect([
			['A2', 'A3', 'B'],
			['A2', 'A3', 'B', 'B2']
		]).toContainEqual(value.ids);
		issues.assertClean();
	});

	test('from A2 straight into B2’s text: a block selection from A2 to B2 (round 8)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const b2 = await textBox(page, 'B2');
		const { value } = await selectFromA2(page, () => b2.x + 30);
		expect(value).toMatchObject({ kind: 'blocks', ids: ['A2', 'A3', 'B', 'B2'] });
		issues.assertClean();
	});
});

/** Z's grip pressed, dragged in 6px steps onto P's top edge, and released: Z moves above P. */
const dropZAboveP = async (page: Page) => {
	const from = await reachGrip(page, 'Z', 4);
	await page.mouse.down();
	const p = await box(page, 'P');
	await walk(page, from, { x: p.x + 30, y: p.y + 3 }, 6);
	await page.mouse.up();
	await frames(page);
};

test.describe('the first press after a handle drag-and-drop, on the chrome (round 7, issue 2)', () => {
	test('a drop, then one press on the resize band and a drag of 60px left: the columns resize', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		await dropZAboveP(page);
		await expect
			.poll(() => texts(page))
			.toEqual([
				'after',
				'before',
				'left one',
				'left two',
				'left three',
				'right one',
				'right two',
				'right three'
			]);
		const [left, right] = await widths(page);
		await resize(page, -60);
		await expect.poll(() => widths(page)).toEqual([left - 60, right + 60]);
		// One undo step gives the widths back.
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => widths(page)).toEqual([left, right]);
		issues.assertClean();
	});

	test('the block menu open, a drop, then one press outside it: the menu closes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1280, height: 1000 });
		await page.goto(`/?doc=round7-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await waitForEditorReady(page);
		await reachGrip(page, 'page-quote', 4);
		await page.mouse.down();
		await page.mouse.up();
		const menu = page.locator('[data-edytor-block-menu]');
		await expect(menu).toHaveCount(1);
		// A drag by another block's grip: the menu stays open over it.
		const from = await reachGrip(page, 'page-section-intro', 4);
		await page.mouse.down();
		const intro = await textBox(page, 'page-intro');
		await walk(page, from, { x: intro.x + 30, y: intro.y + 3 }, 6);
		await page.mouse.up();
		await frames(page);
		await expect(menu).toHaveCount(1);
		// The first press after the drop, at the end of a paragraph's text.
		const t = await textBox(page, 'page-intro');
		const end: Point = { x: t.x + t.width - 1, y: t.y + t.height / 2 };
		await walk(page, { x: end.x - 19, y: end.y - 6 }, end, 3);
		await page.mouse.down();
		await page.mouse.up();
		await expect(menu).toHaveCount(0);
		issues.assertClean();
	});
});
