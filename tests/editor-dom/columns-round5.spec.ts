import { expect, test, type Page } from './editorTest';
import { getWordKey, trackPageIssues } from './helpers';
import {
	FULL,
	TEXTS,
	clickPlus,
	frames,
	gapOf,
	grip,
	guide,
	hitAt,
	host,
	lastStatus,
	openDoc,
	overlap,
	plus,
	resize,
	selectionValue,
	textBox,
	texts,
	valueKind,
	walk,
	widths
} from './columnsPaths';

/**
 * Columns, Notion parity, the round-5 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump. Desktop engines.
 */

/** A click at the end of `id`'s text, then `typed`: it lands there. */
const clickThenType = async (page: Page, id: string, typed: string) => {
	const t = await textBox(page, id);
	await page.mouse.move(t.x + t.width - 12, t.y + t.height / 2 - 6);
	await page.mouse.move(t.x + t.width - 6, t.y + t.height / 2 - 2);
	await page.mouse.click(t.x + t.width - 1, t.y + t.height / 2);
	await page.keyboard.type(typed);
};

test.describe('typing with no caret does nothing, whatever key came before (round 5, issue 1)', () => {
	const paths: [string, (page: Page) => Promise<void>][] = [
		[
			'a resize, Mod+Z',
			async (page) => {
				await resize(page, -50);
				await page.keyboard.press('ControlOrMeta+z');
			}
		],
		[
			'a resize, Mod+Z, Mod+Shift+Z',
			async (page) => {
				await resize(page, -50);
				await page.keyboard.press('ControlOrMeta+z');
				await frames(page);
				await page.keyboard.press('ControlOrMeta+Shift+z');
			}
		],
		[
			'a resize, Escape',
			async (page) => {
				await resize(page, 40);
				await page.keyboard.press('Escape');
			}
		],
		[
			'the + menu, Escape',
			async (page) => {
				await clickPlus(page, 'B2');
				await expect(page.locator('[data-testid="slash-menu-item"]').first()).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(page.locator('[data-testid="slash-menu-item"]')).toHaveCount(0);
			}
		]
	];
	for (const [label, run] of paths)
		test(`fresh page, ${label}, then "j": nothing is written; a click then types`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, FULL);
			await run(page);
			await frames(page);
			expect(await valueKind(page)).toBe('none');
			for (const key of ['j', 'Enter', 'Backspace', 'Delete']) {
				await page.keyboard.press(key);
				await frames(page);
				expect(await texts(page), key).toEqual(TEXTS);
				expect(await valueKind(page), key).toBe('none');
				expect(await lastStatus(page), key).toBe('refused');
			}
			// A click places the caret: typing goes there.
			await clickThenType(page, 'B', 'k');
			await expect
				.poll(() => texts(page))
				.toEqual(TEXTS.map((t) => (t === 'right one' ? 'right onek' : t)));
			issues.assertClean();
		});
});

/** Record each keydown (captured first, read once dispatched): whether it was claimed (the browser then moves nothing). */
const recordKeys = (page: Page) =>
	page.evaluate(() => {
		const seen: KeyboardEvent[] = [];
		(window as unknown as { __KEYS__: KeyboardEvent[] }).__KEYS__ = seen;
		window.addEventListener('keydown', (event) => seen.push(event), { capture: true });
	});
const keysSeen = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { __KEYS__: KeyboardEvent[] }).__KEYS__
			.splice(0)
			.map((event) => `${event.key}:${event.defaultPrevented}`)
	);

/** Whether the DOM holds a range inside the editor. */
const domCaret = (page: Page) =>
	page.evaluate(() => {
		const host = document.querySelector('[data-edytor]');
		const selection = getSelection();
		return Boolean(selection?.rangeCount && host?.contains(selection.anchorNode));
	});

test.describe('navigation keys with no caret do nothing (round 5, issue 3)', () => {
	for (const key of [
		'ArrowDown',
		'ArrowUp',
		'ArrowLeft',
		'ArrowRight',
		'Home',
		'End',
		'Shift+ArrowDown',
		'Shift+ArrowRight',
		'ControlOrMeta+ArrowDown',
		'Word+ArrowRight'
	])
		test(`a resize, then ${key}: claimed, no caret, and typing then writes nothing`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, FULL);
			await resize(page, -50);
			expect(await valueKind(page)).toBe('none');
			await recordKeys(page);
			await page.keyboard.press(key.replace('Word', await getWordKey(page)));
			await frames(page);
			const name = key.split('+').at(-1)!;
			expect(await keysSeen(page)).toContain(`${name}:true`);
			expect(await valueKind(page)).toBe('none');
			expect(await domCaret(page)).toBe(false);
			await page.keyboard.type('q');
			await frames(page);
			expect(await texts(page)).toEqual(TEXTS);
			expect(await valueKind(page)).toBe('none');
			issues.assertClean();
		});

	test('a resize, then Mod+A: every block is selected (Notion); typing replaces them', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		await resize(page, -50);
		expect(await valueKind(page)).toBe('none');
		await page.keyboard.press('ControlOrMeta+a');
		await frames(page);
		const value = await selectionValue(page);
		expect(value.kind).toBe('blocks');
		expect(value.ids).toEqual(expect.arrayContaining(['P', 'A', 'A2', 'A3', 'B', 'B2', 'B3', 'Z']));
		await page.keyboard.type('q');
		await expect.poll(() => texts(page)).toEqual(['q']);
		issues.assertClean();
	});
});

/** The DOM selection's text, and the hit under the pointer (chrome or block). */
const selectedText = (page: Page) =>
	page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim());

test.describe('a text selection dragged into a gap stops at the column (round 5, issue 4)', () => {
	// Round 8 (`sel.drag.across-columns`): past the gap's middle the drag enters
	// column 2 and selects blocks; up to it, the text range stays in column 1.
	test('from column 1’s first row right into the gap left of column 2: no text of column 2 is selected; past the middle, blocks', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const a = await textBox(page, 'A');
		const g = await gapOf(page);
		const row = a.y + a.height / 2;
		const start = { x: a.x + 20, y: row };
		await page.mouse.move(start.x - 8, row - 6);
		await page.mouse.move(start.x, row);
		await page.mouse.down();
		const trail: string[] = [];
		await walk(page, start, { x: g.right - 1, y: row }, 4, async ({ x }) => {
			if (x < g.left) return;
			trail.push(
				`${Math.round(x - g.left)}:${await hitAt(page, x, row)}:${await selectedText(page)}`
			);
		});
		await page.mouse.up();
		await frames(page);
		// The chrome took no pointer while the selection ran: the handles and the band.
		expect(trail.filter((t) => /:(handle|resize)/.test(t))).toEqual([]);
		expect(trail.filter((t) => t.includes('right'))).toEqual([]);
		const value = await selectionValue(page);
		expect(value.kind).toBe('blocks');
		expect(value.ids?.slice(0, 4)).toEqual(['A', 'A2', 'A3', 'B']);
		expect(await selectedText(page)).toBe('');
		// Released, the chrome takes the pointer again.
		await page.mouse.move(g.right - 1, row - 2);
		await frames(page);
		expect(await hitAt(page, g.right - 1, row - 2)).toMatch(/^(handle|resize)/);
		issues.assertClean();
	});
});

test.describe('the + and the grip stay together, the band left of them (round 5, issue 5)', () => {
	test('at each column-2 row: band 10 | + 18 | grip 18, the pair flush with the block; each takes its own press', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const g = await gapOf(page);
		expect(Math.round(g.right - g.left)).toBe(46);
		for (const id of ['B', 'B2', 'B3']) {
			const t = await textBox(page, id);
			const row = t.y + t.height / 2;
			await walk(page, { x: t.x + 30, y: row }, { x: t.x + 6, y: row });
			await expect(host(page, id)).toHaveAttribute('data-visible', 'true');
			const band = (await page.locator('[data-edytor-column-resize]').boundingBox())!;
			const add = (await plus(page, id).boundingBox())!;
			const move = (await grip(page, id).boundingBox())!;
			// The band is the gap's left part, the layout's height.
			expect(Math.abs(band.x - g.left)).toBeLessThanOrEqual(0.5);
			expect(Math.round(band.width)).toBe(10);
			expect(Math.abs(band.height - g.c.height)).toBeLessThanOrEqual(1);
			// The pair together, right of the band, flush with the block (Notion's "+ ⋮⋮").
			expect(Math.round(add.width)).toBe(18);
			expect(Math.round(move.width)).toBe(18);
			expect(add.x).toBeGreaterThanOrEqual(band.x + band.width - 0.5);
			expect(Math.abs(move.x - (add.x + add.width))).toBeLessThanOrEqual(1);
			expect(Math.abs(move.x + move.width - g.right)).toBeLessThanOrEqual(1);
			expect(overlap(add, band) || overlap(move, band)).toBe(false);
			expect(await hitAt(page, band.x + band.width / 2, row)).toBe('resize');
			expect(await hitAt(page, add.x + add.width / 2, row)).toBe(`handle:${id}`);
			expect(await hitAt(page, move.x + move.width / 2, row)).toBe(`handle:${id}`);
		}
		issues.assertClean();
	});

	test('from B2’s text left over the grip and the + to the band: the guide shows there, and a press resizes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		const g = await gapOf(page);
		const t = await textBox(page, 'B2');
		const row = t.y + t.height / 2;
		const at = await walk(page, { x: t.x + 30, y: row }, { x: g.left + 5, y: row }, 3);
		expect(await hitAt(page, at.x, at.y)).toBe('resize');
		expect(await guide(page)).toBe(true);
		const before = await widths(page);
		await page.mouse.down();
		await walk(page, at, { x: at.x + 40, y: row + 1 }, 4);
		await page.mouse.up();
		await expect.poll(() => widths(page)).toEqual([before[0]! + 40, before[1]! - 40]);
		issues.assertClean();
	});
});
