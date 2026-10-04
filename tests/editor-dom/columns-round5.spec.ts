import { expect, test, type Page } from './editorTest';
import { getWordKey, trackPageIssues } from './helpers';
import {
	FULL,
	TEXTS,
	clickPlus,
	frames,
	gapOf,
	hitAt,
	lastStatus,
	openDoc,
	resize,
	selectionValue,
	textBox,
	texts,
	valueKind,
	walk
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
	test('from column 1’s first row right into the gap left of column 2: column 2’s block is never selected', async ({
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
		expect(value.kind).toBe('text');
		expect(await selectedText(page)).not.toContain('right');
		// Released, the chrome takes the pointer again.
		await page.mouse.move(g.right - 1, row - 2);
		await frames(page);
		expect(await hitAt(page, g.right - 1, row - 2)).toMatch(/^(handle|resize)/);
		issues.assertClean();
	});
});
