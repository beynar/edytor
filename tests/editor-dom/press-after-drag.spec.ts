import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';
import {
	box,
	frames,
	openDoc,
	para,
	reachGrip,
	selectionValue,
	textBox,
	texts,
	valueKind,
	walk,
	type Point
} from './columnsPaths';

/**
 * The first press after a handle drag-and-drop (round 6). WebKit fires no
 * `pointercancel` at a native `dragstart` and, believing the button still
 * down, no `pointerdown` for the next press: only its `mousedown` (WebKit
 * bugs 202287, 222632, 279749). That `mousedown` is the press: the click
 * places the caret where it lands, replacing the dropped block's selection,
 * and the caret types. A person's mouse: 2–12px steps, never a jump.
 */

const DOC = [para('P', 'before'), para('A', 'alpha'), para('B', 'bravo'), para('Z', 'after')];

/** B's grip pressed, dragged in 6px steps beside A (A's right edge), and released. */
const dropBesideA = async (page: Page) => {
	const from = await reachGrip(page, 'B', 4);
	await page.mouse.down();
	const a = await box(page, 'A');
	await walk(page, from, { x: a.x + a.width - 10, y: a.y + a.height / 2 }, 6);
	await page.mouse.up();
	await frames(page);
};

/** B's grip pressed, dragged in 6px steps below Z's lower half, and released. */
const dropAfterZ = async (page: Page) => {
	const from = await reachGrip(page, 'B', 4);
	await page.mouse.down();
	const z = await textBox(page, 'Z');
	await walk(page, from, { x: z.x + 30, y: z.y + z.height - 3 }, 6);
	await page.mouse.up();
	await frames(page);
};

/** The pointer walks to the end of `id`'s text and clicks there (a press, then its release). */
const clickEnd = async (page: Page, id: string) => {
	const t = await textBox(page, id);
	const at: Point = { x: t.x + t.width - 1, y: t.y + t.height / 2 };
	await walk(page, { x: at.x - 19, y: at.y - 6 }, at, 3);
	await page.mouse.down();
	await page.mouse.up();
	await frames(page);
};

const anchorBlock = async (page: Page) => {
	const value = (await selectionValue(page)) as { kind: string; anchor?: { b: string } };
	return value.kind === 'text' ? value.anchor?.b : value.kind;
};

test.describe('the first press after a handle drag-and-drop is a press (round 6)', () => {
	for (const [label, drop, moved] of [
		['beside A (a new layout)', dropBesideA, ['before', 'alpha', 'bravo', 'after']],
		['after Z (a reorder)', dropAfterZ, ['before', 'alpha', 'after', 'bravo']]
	] as const)
		for (const target of ['P', 'A', 'Z'])
			test(`a drop ${label}, then a click at the end of ${target}: the caret is there, and typing writes there`, async ({
				page
			}) => {
				const issues = trackPageIssues(page);
				await openDoc(page, DOC);
				await drop(page);
				await expect.poll(() => texts(page)).toEqual(moved);
				expect(await selectionValue(page)).toMatchObject({ kind: 'blocks', ids: ['B'] });
				await clickEnd(page, target);
				await expect.poll(() => anchorBlock(page)).toBe(target);
				await page.keyboard.type('Q');
				const text = { P: 'before', A: 'alpha', Z: 'after' }[target];
				await expect.poll(() => texts(page)).toEqual(moved.map((t) => (t === text ? `${t}Q` : t)));
				issues.assertClean();
			});

	for (const [label, drop] of [
		['beside A', dropBesideA],
		['after Z', dropAfterZ]
	] as const)
		test(`a drop ${label}, Mod+Z, then a click at the end of P: the first click types`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, DOC);
			await drop(page);
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => texts(page)).toEqual(['before', 'alpha', 'bravo', 'after']);
			expect(await valueKind(page)).toBe('none');
			await clickEnd(page, 'P');
			await expect.poll(() => anchorBlock(page)).toBe('P');
			await page.keyboard.type('Q');
			await expect.poll(() => texts(page)).toEqual(['beforeQ', 'alpha', 'bravo', 'after']);
			issues.assertClean();
		});
});
