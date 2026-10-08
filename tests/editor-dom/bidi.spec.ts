/**
 * Bidi in a real engine (WU-29, F14): in a left-to-right page, a line that
 * opens with Hebrew or Arabic takes its own direction (`dir` on its block,
 * from its first strong character), so its caret and its selection behave as in a
 * right-to-left page: the arrows move visually (Left = forward, the RTL rows
 * of `arch-v2-v6-navigation.spec.ts`), Shift extends the same way, and an
 * English word typed or selected inside it lands at its logical offset. A
 * line that opens with English stays left to right; an empty line keeps the
 * page's direction. Expected values come from the Unicode bidi algorithm
 * (UAX #9: the first strong character decides) and the key contract (K9),
 * never from a run.
 */
import { expect, test, type Page } from './editorTest';
import { setSelectionByTextIndex, trackPageIssues, waitForEditorReady } from './helpers';

const p = (text: string) => ({ type: 'paragraph', content: text ? [{ text }] : [] });

/** Hebrew then English, Arabic then English, English then Hebrew, an empty line. */
const MIXED = [p('שלום world'), p('مرحبا hello'), p('hello שלום'), p('')];

const open = async (page: Page, dir: 'ltr' | 'rtl' = 'ltr') => {
	await page.goto(
		`/test/dom?scenario=v6&dir=${dir}&dst=${encodeURIComponent(JSON.stringify({ children: MIXED }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The selection as [block index in document order, display offset]. */
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
const directions = (page: Page) =>
	page
		.locator('[data-testid="editor-shell"] [data-edytor-text]')
		.evaluateAll((texts) => texts.map((text) => getComputedStyle(text).direction));

test.describe('bidi: each line takes the direction of its first strong character', () => {
	test('Hebrew and Arabic lines are right to left in a left-to-right page; English and empty ones are not', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await expect.poll(() => directions(page)).toEqual(['rtl', 'rtl', 'ltr', 'ltr']);
		issues.assertClean();
	});

	test('an empty line keeps a right-to-left page’s direction', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'rtl');
		await expect.poll(() => directions(page)).toEqual(['rtl', 'rtl', 'ltr', 'rtl']);
		issues.assertClean();
	});

	test('the arrows move visually in a Hebrew line: Left is forward, Right comes back', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1);
		await expectStops(page, caretAt(0, 1));
		await page.keyboard.press('ArrowLeft');
		await expectStops(page, caretAt(0, 2));
		await page.keyboard.press('ArrowRight');
		await expectStops(page, caretAt(0, 1));
		issues.assertClean();
	});

	test('Left at a Hebrew line’s end crosses forward to the next line', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 10);
		await page.keyboard.press('ArrowLeft');
		await expectStops(page, caretAt(1, 0));
		issues.assertClean();
	});

	test('Shift+Left at an Arabic line’s end extends the selection forward, into the next line', async ({
		page
	}) => {
		// The editor's own step (a block edge, K9). Inside a line a Shift step is
		// the engine's: Firefox extends logically there (`bidi.edit.caret_movement_style`).
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 1, 6, 1, 11);
		await expectStops(page, { start: [1, 6], end: [1, 11], collapsed: false });
		await page.keyboard.press('Shift+ArrowLeft');
		await expectStops(page, { kind: 'text', start: [1, 6], end: [2, 0], reversed: false });
		issues.assertClean();
	});

	test('an English-first line keeps Right as forward', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 2, 1);
		await page.keyboard.press('ArrowRight');
		await expectStops(page, caretAt(2, 2));
		issues.assertClean();
	});

	test('Shift+End selects a Hebrew line to its logical end; the selection reads in logical order', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await page.keyboard.press('Shift+End');
		await expectStops(page, { kind: 'text', start: [0, 2], end: [0, 10], collapsed: false });
		await expect
			.poll(() => page.evaluate(() => window.getSelection()?.toString()))
			.toBe('ום world');
		issues.assertClean();
	});

	test('English typed inside a Hebrew line lands at its logical offset', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await page.keyboard.type('ab');
		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					return edytor.value.children[0].content[0].text;
				})
			)
			.toBe('שלabום world');
		await expectStops(page, caretAt(0, 4));
		await expect(
			page.locator('[data-testid="editor-shell"] [data-edytor-block]').first()
		).toHaveAttribute('dir', 'rtl');
		issues.assertClean();
	});
});
