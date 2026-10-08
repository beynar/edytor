import { expect, test, type Page } from './editorTest';
import {
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * The block chrome under a finger (`Pixel 5`, `iPhone 13`): a phone has no
 * hover, so every handle shows; a tap on a grip selects its block and opens
 * the block menu, whose Move down moves it (one undo step); a tap on a `+`
 * opens the insert menu; a text selection shows the toolbar, whose Bold a
 * tap applies. A finger drag on a grip is the platform's long-press drag
 * and drop, which only a device runs (Platform support).
 */

const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
const DOC = [para('A', 'alpha'), para('B', 'bravo'), para('C', 'charlie')];

const open = async (page: Page) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&polish=1&dst=${encodeURIComponent(JSON.stringify({ children: DOC }))}`
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
	test('every handle shows without hover; the grip tapped opens the menu, Move down moves the block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1);
		await expect(grip(page, 'A')).toBeVisible();
		const opacity = await grip(page, 'A').evaluate(
			(node) => getComputedStyle(node.closest('[data-edytor-block-handle-host]')!).opacity
		);
		expect(opacity).toBe('1');
		await grip(page, 'A').tap();
		await expect(page.getByTestId('block-menu')).toBeVisible();
		await expectInView(page, page.getByTestId('block-menu'));
		await page.getByRole('menuitem', { name: /Move down/ }).tap();
		await expect.poll(() => ids(page)).toEqual(['B', 'A', 'C']);
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
});
