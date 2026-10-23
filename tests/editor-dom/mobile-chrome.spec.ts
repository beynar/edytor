import { expect, test, type Page } from './editorTest';
import {
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * The block chrome under a finger (`Pixel 5`, `iPhone 13`): a phone has no
 * hover, so the handle of the block the selection is in shows, and no other
 * (a hidden one takes no tap); a tap on a grip selects its block and opens
 * the block menu, whose Move down moves it (one undo step); a tap on a `+`
 * opens the insert menu; a text selection shows the toolbar, whose Bold a
 * tap applies; a code block's Copy shows without a hover (a touch that
 * revealed it would cost the tap: iOS Safari takes it for a hover and sends
 * no click, the language button's included). A finger drag on a grip is the platform's long-press drag
 * and drop, which only a device runs (Platform support).
 */

const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
const DOC = [para('A', 'alpha'), para('B', 'bravo'), para('C', 'charlie')];

const open = async (page: Page, children: unknown[] = DOC) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&polish=1&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

type Value = { children: { id: string; content?: { text: string; marks?: unknown }[] }[] };
const ids = async (page: Page) =>
	(await readJsonByTestId<Value>(page, 'value')).children.map((block) => block.id);
/** `locator`'s box inside the phone's viewport: no chrome cut off at its edge. */
const expectInView = async (page: Page, locator: ReturnType<Page['locator']>) => {
	const box = (await locator.boundingBox())!;
	const width = await page.evaluate(() => innerWidth);
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(width);
};
const grip = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);

test.describe('the block chrome under a finger', () => {
	test("the caret block's handle shows, no other; the grip tapped opens the menu, Move down moves the block", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1);
		await expect(grip(page, 'A')).toBeVisible();
		// A handle fades (a transition): read it once the fade ended.
		const shown = (id: string) =>
			grip(page, id).evaluate(async (node) => {
				const host = node.closest<HTMLElement>('[data-edytor-block-handle-host]')!;
				await Promise.all(host.getAnimations().map((animation) => animation.finished));
				const style = getComputedStyle(host);
				return [style.opacity, style.pointerEvents];
			});
		await expect.poll(() => shown('A')).toEqual(['1', 'auto']);
		expect(await shown('B')).toEqual(['0', 'none']);
		// The caret moves on: its block's handle shows instead.
		await setSelectionByTextIndex(page, 1, 1);
		await expect.poll(() => shown('B')).toEqual(['1', 'auto']);
		expect(await shown('A')).toEqual(['0', 'none']);
		await setSelectionByTextIndex(page, 0, 1);
		await expect.poll(() => shown('A')).toEqual(['1', 'auto']);
		await grip(page, 'A').tap();
		await expect(page.getByTestId('block-menu')).toBeVisible();
		await expectInView(page, page.getByTestId('block-menu'));
		await page.getByRole('menuitem', { name: /Move down/ }).tap();
		await expect.poll(() => ids(page)).toEqual(['B', 'A', 'C']);
		// A touch leaves a hover behind: it shows no handle (iOS Safari takes a touch whose
		// hover reveals content as a hover only, and sends no click).
		await page.locator('[data-edytor-text="true"]').nth(2).hover();
		await expect
			.poll(() =>
				page
					.locator('[data-edytor-block-handle-host][data-block-id="C"][data-visible="true"]')
					.count()
			)
			.toBe(1);
		expect(await shown('C')).toEqual(['0', 'none']);
		issues.assertClean();
	});

	test('the + tapped opens the insert menu', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1);
		await page.locator('[data-testid="block-add"]').first().tap();
		await expect(page.getByRole('listbox').or(page.getByRole('menu')).first()).toBeVisible();
		issues.assertClean();
	});

	test('a text selection shows the toolbar; Bold tapped bolds it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 1, 0, 1, 5);
		const bold = page.getByRole('button', { name: /^Bold/ });
		await expect(bold).toBeVisible();
		await expectInView(page, bold);
		await bold.tap();
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children[1]?.content)
			.toEqual([{ text: 'bravo', marks: { bold: true } }]);
		issues.assertClean();
	});

	test("a code block's Copy shows without a hover", async ({ page }) => {
		const issues = trackPageIssues(page);
		const code = {
			id: 'K',
			type: 'code',
			children: [{ id: 'L', type: 'codeLine', content: [{ text: 'let x = 1;' }] }]
		};
		await open(page, [...DOC, code]);
		const copy = page.locator('[data-edytor-code-copy]');
		await expect(copy).toBeAttached();
		const opacity = await copy.evaluate(async (node) => {
			await Promise.all(node.getAnimations().map((animation) => animation.finished));
			return getComputedStyle(node).opacity;
		});
		expect(opacity).toBe('1');
		issues.assertClean();
	});
});
