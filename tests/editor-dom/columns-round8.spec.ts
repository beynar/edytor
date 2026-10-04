import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';
import {
	FULL,
	TEXTS,
	frames,
	gapOf,
	openDoc,
	selectionValue,
	textBox,
	texts,
	walk,
	type Point
} from './columnsPaths';

/**
 * Columns, Notion parity, the round-8 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump. A mouse text
 * selection that starts in a column and crosses into another column of the
 * same layout becomes a block selection of the blocks it covers, in reading
 * order (`sel.drag.across-columns`); back in its own column it is a text
 * range again. Desktop engines.
 */

type Value = { kind: string; ids?: string[]; anchor?: { b: string }; focus?: { b: string } };

/** The DOM selection's text, its whitespace folded. */
const selectedText = (page: Page) =>
	page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim());

/** The root marks a block selection: the native range's highlight is hidden under it. */
const rootMark = (page: Page) =>
	page.evaluate(
		() => document.querySelector('[data-edytor]')?.getAttribute('data-edytor-selection') ?? null
	);

/** The middle of `id`'s text row, `dx` px from its text's start (negative: from its end). */
const at = async (page: Page, id: string, dx: number): Promise<Point> => {
	const t = await textBox(page, id);
	const row = t.y + Math.min(t.height, 24) / 2;
	return { x: dx >= 0 ? t.x + dx : t.x + t.width + dx, y: row };
};

/** Approach `start` in 3px steps and press there: a drag-selection begins. */
const press = async (page: Page, start: Point) => {
	await walk(page, { x: start.x - 9, y: start.y - 6 }, start, 3);
	await page.mouse.down();
	return start;
};

/** Release, then two frames (the projector's pass). */
const release = async (page: Page) => {
	await page.mouse.up();
	await frames(page);
};

const value = async (page: Page) => (await selectionValue(page)) as Value;

test.describe('a mouse selection crossing into another column becomes a block selection (round 8)', () => {
	test('from A2 into the gap’s right half: the blocks from A2 in reading order, no native highlight', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		const gap = await gapOf(page);
		const kinds: string[] = [];
		await walk(
			page,
			from,
			{ x: gap.left + (gap.right - gap.left) * 0.75, y: from.y },
			4,
			async (p) => {
				if (p.x > gap.mid + 2) kinds.push((await value(page)).kind);
			}
		);
		// Live, under the button: a block selection, the native highlight hidden.
		const live = await value(page);
		expect(live.kind).toBe('blocks');
		expect(new Set(kinds)).toEqual(new Set(['blocks']));
		expect(await rootMark(page)).toBe('blocks');
		await release(page);
		const done = await value(page);
		expect(done.kind).toBe('blocks');
		expect([
			['A2', 'A3', 'B'],
			['A2', 'A3', 'B', 'B2']
		]).toContainEqual(done.ids);
		// No native range is left once the button is up.
		expect(await selectedText(page)).toBe('');
		await expect(page.locator('[data-edytor-id="A2"]')).toHaveAttribute(
			'data-edytor-selected',
			'true'
		);
		issues.assertClean();
	});

	test('from A2 into B2’s text: a block selection from A2 to B2', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		await walk(page, from, await at(page, 'B2', 30), 4);
		expect((await value(page)).kind).toBe('blocks');
		await release(page);
		expect(await value(page)).toMatchObject({ kind: 'blocks', ids: ['A2', 'A3', 'B', 'B2'] });
		expect(await selectedText(page)).toBe('');
		issues.assertClean();
	});

	test('into column 2 and back into column 1 in the same drag: a text range again', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		const b2 = await walk(page, from, await at(page, 'B2', 30), 4);
		expect((await value(page)).kind).toBe('blocks');
		await walk(page, b2, await at(page, 'A3', 30), 4);
		const back = await value(page);
		expect(back).toMatchObject({ kind: 'text', anchor: { b: 'A2' }, focus: { b: 'A3' } });
		expect(await rootMark(page)).toBe(null);
		await release(page);
		expect(await value(page)).toMatchObject({
			kind: 'text',
			anchor: { b: 'A2' },
			focus: { b: 'A3' }
		});
		// The native range shows it: A2's rest and A3's start.
		expect(await selectedText(page)).toMatch(/^ft two le/);
		issues.assertClean();
	});

	test('a full sweep from A’s start to the last column’s end: the layout is lifted', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A', 1));
		const b = await walk(page, from, await at(page, 'B', 20), 5);
		await walk(page, b, await at(page, 'B3', -1), 5);
		await release(page);
		expect(await value(page)).toMatchObject({
			kind: 'blocks',
			ids: ['A', 'A2', 'A3', 'B', 'B2', 'B3']
		});
		await expect(
			page.locator('[data-edytor-id="C"] [data-edytor-columns-selected="true"]')
		).toHaveCount(1);
		issues.assertClean();
	});

	test('Backspace after release deletes the blocks (the layout keeps a block per column); Mod+Z restores', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		await walk(page, from, await at(page, 'B2', 30), 4);
		await release(page);
		expect(await value(page)).toMatchObject({ kind: 'blocks', ids: ['A2', 'A3', 'B', 'B2'] });
		await page.keyboard.press('Backspace');
		await expect.poll(() => texts(page)).toEqual(['before', 'left one', 'right three', 'after']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => texts(page)).toEqual(TEXTS);
		issues.assertClean();
	});

	test('typing after release replaces the blocks in the first one’s slot (layout.flow-slot)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		await walk(page, from, await at(page, 'B2', 30), 4);
		await release(page);
		await page.keyboard.type('Q');
		await expect
			.poll(() => texts(page))
			.toEqual(['before', 'left one', 'Q', 'right three', 'after']);
		expect(await value(page)).toMatchObject({ kind: 'text' });
		issues.assertClean();
	});

	test('a drag starting above the layout into it stays a text range', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'P', 10));
		const a2 = await walk(page, from, await at(page, 'A2', 30), 4);
		expect((await value(page)).kind).toBe('text');
		await walk(page, a2, await at(page, 'B2', 30), 4);
		expect((await value(page)).kind).toBe('text');
		await release(page);
		expect(await value(page)).toMatchObject({ kind: 'text', anchor: { b: 'P' } });
		expect(await selectedText(page)).toContain('left three');
		issues.assertClean();
	});

	test('a Shift+click in another column extends the text range, in document order (D7)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A2', 15));
		await release(page);
		await walk(page, from, await at(page, 'B2', 20), 6);
		await page.keyboard.down('Shift');
		await page.mouse.down();
		await page.mouse.up();
		await page.keyboard.up('Shift');
		await frames(page);
		expect(await value(page)).toMatchObject({
			kind: 'text',
			anchor: { b: 'A2' },
			focus: { b: 'B2' }
		});
		expect(await selectedText(page)).toMatch(/^ft two left three right one ri/);
		issues.assertClean();
	});

	test('a drag inside one column stays a text range', async ({ page }) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const from = await press(page, await at(page, 'A', 3));
		const kinds = new Set<string>();
		await walk(page, from, await at(page, 'A3', -2), 4, async () => {
			kinds.add((await value(page)).kind);
		});
		await release(page);
		expect([...kinds]).toEqual(['text']);
		expect(await value(page)).toMatchObject({
			kind: 'text',
			anchor: { b: 'A' },
			focus: { b: 'A3' }
		});
		expect(await selectedText(page)).toMatch(/one left two left thre/);
		issues.assertClean();
	});
});
