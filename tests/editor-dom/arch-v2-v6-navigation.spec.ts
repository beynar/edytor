/**
 * arch-v2 — checkpoint V6 rows, browser lane (three engines): one ordered
 * stream of caret stops for the horizontal navigation keys (R9, §2.4, §4.3
 * `session/navigation`, L53). The dom lane holds the model rows
 * (`src/tests/fixtures/dom/arch-v2-v6-navigation.test.tsx`); these need a
 * real engine: its computed direction (RTL), its native in-text movement,
 * and the display of the value the stream selected.
 *
 * - RTL rows: arrows and word keys resolve their logical direction once, from
 *   the focus text's computed direction — a word key moves visually like an
 *   arrow (the reference moved word keys logically: red).
 * - Skipping non-displayable content: a collapsed toggle's body is no stop.
 * - Atoms at block edges: a selected atom that ends a block extends across
 *   the edge.
 *
 * Expected values come from the plan rows and the key contract (K9, K10),
 * never from running the code.
 */
import { expect, test, type Page } from './editorTest';
import {
	getWordKey,
	setReverseSelectionByTextIndex,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type Part = string | '@';
const p = (...content: Part[]) => ({
	type: 'paragraph',
	content: content.map((part) => (part === '@' ? { type: 'mention', data: {} } : { text: part }))
});

const open = async (page: Page, children: unknown[], dir: 'ltr' | 'rtl' = 'ltr') => {
	await page.goto(
		`/test/dom?scenario=v6&dir=${dir}&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The selection as [block index in document order, display offset] (the plan's coordinates). */
const readStops = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const { kind, start, end, isCollapsed, isReversed } = edytor.selection.projection;
		const ids: string[] = edytor.facade.order();
		const at = (point: { block: string; offset: number } | null) =>
			point ? [ids.indexOf(point.block), point.offset] : null;
		return { kind, start: at(start), end: at(end), collapsed: isCollapsed, reversed: isReversed };
	});

const expectStops = (page: Page, expected: Record<string, unknown>) =>
	expect.poll(() => readStops(page)).toMatchObject(expected);

const caretAt = (block: number, offset: number) => ({
	kind: 'text',
	start: [block, offset],
	end: [block, offset],
	collapsed: true
});

/** Two RTL paragraphs: `אבג דהו` (words of 3 at 0–3 and 4–7), then `זחט`. */
const RTL = [p('אבג דהו'), p('זחט')];

test.describe('V6 — RTL: one logical direction per key, from the focus text', () => {
	test('a word key moves visually in an RTL paragraph (Left = forward)', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, RTL, 'rtl');
		const word = await getWordKey(page);
		await setSelectionByTextIndex(page, 0, 3);
		await expectStops(page, caretAt(0, 3));
		await page.keyboard.press(`${word}+ArrowLeft`);
		await expectStops(page, caretAt(0, 7));
		await page.keyboard.press(`${word}+ArrowRight`);
		await expectStops(page, caretAt(0, 4));
		issues.assertClean();
	});

	test('ArrowLeft at an RTL block end crosses forward; ArrowRight comes back', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, RTL, 'rtl');
		await setSelectionByTextIndex(page, 0, 7);
		await page.keyboard.press('ArrowLeft');
		await expectStops(page, caretAt(1, 0));
		await page.keyboard.press('ArrowRight');
		await expectStops(page, caretAt(0, 7));
		issues.assertClean();
	});

	test('Shift+ArrowLeft at an RTL range focus at the block end extends forward', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, RTL, 'rtl');
		await setSelectionByTextIndex(page, 0, 4, 0, 7);
		await expectStops(page, { start: [0, 4], end: [0, 7], collapsed: false });
		await page.keyboard.press('Shift+ArrowLeft');
		await expectStops(page, { kind: 'text', start: [0, 4], end: [1, 0], reversed: false });
		issues.assertClean();
	});
});

test.describe('V6 — the stream skips non-displayable content', () => {
	const TOGGLE = [
		p('before'),
		{ type: 'toggle', content: [{ text: 'sum' }], children: [p('one'), p('two')] },
		p('after')
	];

	test('ArrowRight at a collapsed toggle summary end lands after the toggle', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, TOGGLE);
		// Text elements in DOM order: before 0, sum 1, one 2, two 3, after 4.
		await setSelectionByTextIndex(page, 1, 3);
		await page.keyboard.press('ArrowRight');
		// Document order: before 0, toggle 1, one 2, two 3, after 4.
		await expectStops(page, caretAt(4, 0));
		await page.keyboard.press('ArrowLeft');
		await expectStops(page, caretAt(1, 3));
		issues.assertClean();
	});
});

test.describe('V6 — atoms at block edges', () => {
	const EDGES = [p('ab'), p('y', '@', ''), p('cd')];

	test('a selected atom that ends a block extends across the edge with Shift+ArrowRight', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, EDGES);
		// Text elements: ab 0, y 1, '' 2, cd 3.
		await setSelectionByTextIndex(page, 1, 1);
		await page.keyboard.press('Shift+ArrowRight');
		await expectStops(page, { kind: 'atom', start: [1, 1], end: [1, 2] });
		await page.keyboard.press('Shift+ArrowRight');
		await expectStops(page, { kind: 'text', start: [1, 1], end: [2, 0], reversed: false });
		issues.assertClean();
	});

	test('a reversed range focus after an atom that starts a block steps over it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [p('ab'), p('', '@', 'xy')]);
		// Text elements: ab 0, '' 1, xy 2.
		await setReverseSelectionByTextIndex(page, 2, 0, 2, 2);
		await expectStops(page, { start: [1, 1], end: [1, 3], reversed: true });
		await page.keyboard.press('Shift+ArrowLeft');
		await expectStops(page, { kind: 'text', start: [1, 0], end: [1, 3], reversed: true });
		await page.keyboard.press('Shift+ArrowLeft');
		await expectStops(page, { kind: 'text', start: [0, 2], end: [1, 3], reversed: true });
		issues.assertClean();
	});
});

/** V6 follow-up: vertical extension moves the focus; an atom selection keeps its anchor side. */
test.describe('V6 follow-up — focus-moving vertical extension, anchored atom selection', () => {
	test('Shift+ArrowDown then Shift+ArrowUp returns to the original caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [p('abcdef'), p('ghijkl'), p('mnopqr')]);
		await setSelectionByTextIndex(page, 1, 3);
		await page.keyboard.press('Shift+ArrowDown');
		await expectStops(page, { start: [1, 3], end: [2, 3], reversed: false });
		await page.keyboard.press('Shift+ArrowUp');
		await expectStops(page, caretAt(1, 3));
		await page.keyboard.press('Shift+ArrowUp');
		await expectStops(page, { start: [0, 3], end: [1, 3], reversed: true });
		issues.assertClean();
	});

	for (const [first, second, offset] of [
		['ArrowRight', 'ArrowLeft', 2],
		['ArrowLeft', 'ArrowRight', 3]
	] as const)
		test(`caret ${offset === 2 ? 'before' : 'after'} an atom: Shift+${first} selects it, Shift+${second} shrinks back`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await open(page, [p('ab', '@', 'cd')]);
			// Text elements: ab 0, cd 1.
			await setSelectionByTextIndex(page, offset === 2 ? 0 : 1, offset === 2 ? 2 : 0);
			await expectStops(page, caretAt(0, offset));
			await page.keyboard.press(`Shift+${first}`);
			await expectStops(page, { kind: 'atom', start: [0, 2], end: [0, 3] });
			await page.keyboard.press(`Shift+${second}`);
			await expectStops(page, caretAt(0, offset));
			issues.assertClean();
		});
});
