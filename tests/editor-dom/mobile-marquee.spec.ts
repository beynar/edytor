/**
 * The marquee on a phone (`sel.marquee`; mobile lane): a touch never starts
 * one — a finger in the margins scrolls the page, and a tap below the last
 * block stays the browser's. The desktop rows are `marquee.spec.ts`.
 */
import { expect, test, type Page } from './editorTest';
import { waitForEditorReady } from './helpers';

const p = (id: string) => ({ id, type: 'paragraph', content: [{ text: `${id} text` }] });

const open = async (page: Page) => {
	const children = [p('A'), p('B'), p('C')];
	await page.goto(
		`/test/dom?scenario=dst&marquee=1&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

const selected = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		return [...edytor.selection.selectedBlocks].map((block: { id: string }) => block.id);
	});

test('a touch drag from the margin or from below the last block selects no block', async ({
	page
}) => {
	await open(page);
	const a = (await page.locator('[data-edytor-id="A"]').boundingBox())!;
	const c = (await page.locator('[data-edytor-id="C"]').boundingBox())!;
	// The browser's touch pointer events, as a finger's drag sends them.
	const swipe = (target: string, from: { x: number; y: number }, to: { x: number; y: number }) =>
		page.evaluate(
			({ target, from, to }) => {
				const node = document.querySelector(target)!;
				const init = (point: { x: number; y: number }, buttons: number) => ({
					bubbles: true,
					cancelable: true,
					button: 0,
					buttons,
					isPrimary: true,
					pointerType: 'touch',
					clientX: point.x,
					clientY: point.y
				});
				node.dispatchEvent(new PointerEvent('pointerdown', init(from, 1)));
				for (let i = 1; i <= 6; i++) {
					const point = {
						x: from.x + ((to.x - from.x) * i) / 6,
						y: from.y + ((to.y - from.y) * i) / 6
					};
					document.dispatchEvent(new PointerEvent('pointermove', init(point, 1)));
				}
				document.dispatchEvent(new PointerEvent('pointerup', init(to, 0)));
			},
			{ target, from, to }
		);
	await swipe(
		'[data-testid="editor-shell"]',
		{ x: a.x - 20, y: a.y + a.height / 2 },
		{ x: a.x + 80, y: c.y + c.height / 2 }
	);
	await swipe(
		'[data-edytor]',
		{ x: c.x + 60, y: c.y + c.height + 14 },
		{ x: c.x + 20, y: a.y + a.height / 2 }
	);
	expect(await selected(page)).toEqual([]);
	await expect(page.locator('[data-edytor-marquee]')).toHaveCount(0);

	// A tap below the last block: the browser's (no trailing paragraph is written).
	await page.touchscreen.tap(c.x + 60, c.y + c.height + 14);
	expect(await selected(page)).toEqual([]);
	const count = await page.evaluate(
		() => (window as unknown as { __EDYTOR__: any }).__EDYTOR__.value.children.length
	);
	expect(count).toBe(3);
	await expect(page.locator('[data-edytor-marquee]')).toHaveCount(0);
});
