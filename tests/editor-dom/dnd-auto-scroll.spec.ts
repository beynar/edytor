import { expect, test, type Page } from './editorTest';
import { gotoEditorRoute, trackPageIssues } from './helpers';

/**
 * A block drag scrolls the page, and any scrolling container around the
 * editor, when the pointer nears an edge: Atlassian's auto-scroll
 * (`@atlaskit/pragmatic-drag-and-drop-auto-scroll`), not only the browser's
 * built-in drag scrolling at the window's very edge.
 */
/** The demo page (its real layout and handles) with a long fresh document. */
const open = (page: Page) =>
	gotoEditorRoute(page, `/?blocks=80&doc=auto-scroll-${Date.now()}-${Math.random()}`);

/** Press the first block's grip and drag to `(x, y)`, holding there for `ms`. */
const dragFirstTo = async (page: Page, x: number, y: number, ms: number) => {
	const first = page.locator('[data-edytor] > [data-edytor-block="true"]').first();
	await first.hover();
	const id = await first.getAttribute('data-edytor-id');
	const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
	await expect(grip).toBeVisible();
	const box = (await grip.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(x, y, { steps: 10 });
	// Drag events keep firing while the pointer rests; nudge to keep them coming.
	const end = Date.now() + ms;
	while (Date.now() < end) {
		await page.mouse.move(x, y + 1);
		await page.mouse.move(x, y);
		await page.waitForTimeout(50);
	}
};

/** A point over the editor's text column, at height `y`. */
const column = async (page: Page) => {
	const editor = (await page.locator('[data-edytor]').first().boundingBox())!;
	return editor.x + Math.min(200, editor.width / 2);
};

test.describe('drag auto-scroll', () => {
	test('a drag near the bottom of the window scrolls it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 900, height: 500 });
		await open(page);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		await dragFirstTo(page, await column(page), 490, 1500);
		const scrolled = await page.evaluate(() => window.scrollY);
		await page.mouse.up();
		expect(scrolled).toBeGreaterThan(150);
		issues.assertClean();
	});

	test('a drag near the bottom of a scrolling container around the editor scrolls it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 900, height: 700 });
		await open(page);
		// The page's own container scrolls instead of the window.
		await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]')!;
			const scroller = editor.parentElement!;
			scroller.dataset.testScroller = '';
			Object.assign(scroller.style, { height: '300px', overflow: 'auto', paddingLeft: '48px' });
		});
		const shell = page.locator('[data-test-scroller]');
		const area = (await shell.boundingBox())!;
		await dragFirstTo(page, area.x + 200, area.y + area.height - 6, 1500);
		const scrolled = await shell.evaluate((node) => node.scrollTop);
		await page.mouse.up();
		expect(scrolled).toBeGreaterThan(150);
		issues.assertClean();
	});
});
