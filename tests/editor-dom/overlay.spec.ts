import { expect, test, type Page } from './editorTest';
import { gotoEditorRoute, setSelectionByTextIndex, trackPageIssues } from './helpers';

/**
 * arch-v2 — checkpoint R5 rows (browser lane): chrome lives in an overlay
 * outside the contenteditable host, positioned once per frame over the
 * visible set and invalidated by commits, resizes, any scroll container,
 * readonly and peers (plan R11, §2.4 "Overlay geometry", §8.6 F-T8, §11.1 K9).
 */

/** Rows red on the reference (`arch-v2/ref-r5`); green since R5c. */
const REF_RED = false;

const TOLERANCE_PX = 3;

/** Each handle's vertical offset from its block's first text row, and its horizontal side. */
const readHandleRows = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="block-handle"]')).map(
			(handle) => {
				const id = handle.dataset.blockId;
				const block = document.querySelector<HTMLElement>(
					`[data-edytor-block="true"][data-edytor-id="${id}"]`
				);
				const text = block?.querySelector('[data-edytor-text="true"]');
				const row = text?.getClientRects()[0];
				const rect = handle.getBoundingClientRect();
				const blockRect = block?.getBoundingClientRect();
				return {
					id,
					dy: row ? rect.top + rect.height / 2 - (row.top + row.height / 2) : Infinity,
					leftOfBlock: blockRect ? rect.right <= blockRect.left + 1 : false
				};
			}
		)
	);

const expectHandlesAligned = async (page: Page, count: number) => {
	await expect
		.poll(async () => {
			const rows = await readHandleRows(page);
			return (
				rows.length === count &&
				rows.every((row) => Math.abs(row.dy) <= TOLERANCE_PX && row.leftOfBlock)
			);
		})
		.toBe(true);
};

const showAllHandles = (page: Page) =>
	page.addStyleTag({
		content: '[data-edytor-block-handle-host] { opacity: 1 !important; }'
	});

test.describe('R5 overlay', () => {
	test('F-T8 an idle remote caret stays on its anchor while the page scrolls', async ({ page }) => {
		test.fail(REF_RED, 'F-T8: red on the reference (C12, fixed viewport geometry)');
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=selection', { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 5);
		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					return Object.keys(edytor?.awareness.getLocalState()?.selections ?? {}).length;
				})
			)
			.toBe(1);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const selections = edytor.awareness.getLocalState()?.selections;
			edytor.awareness.states.set(9001, {
				user: { name: 'Ada', color: '#dc2626' },
				selections: { 'view-1': Object.values(selections)[0] }
			});
			edytor.awareness.emit('change', [{ added: [9001], updated: [], removed: [] }, 'test']);
			edytor.awareness.emit('update', [{ added: [9001], updated: [], removed: [] }, 'test']);
			document.body.style.paddingBottom = '3000px';
		});
		const cursor = page.locator('[data-edytor-remote-cursor][data-client-id="9001"]');
		await expect(cursor).toBeVisible();

		/** The remote caret's offset from where the anchor (text 0, offset 5) is drawn now. */
		const offsetFromAnchor = () =>
			page.evaluate(() => {
				const caret = document
					.querySelector('[data-edytor-remote-cursor][data-client-id="9001"]')!
					.getBoundingClientRect();
				const text = document.querySelectorAll('[data-edytor-text="true"]')[0]!;
				const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
				let left = 5;
				let node = walker.nextNode();
				while (node && (node.textContent?.length ?? 0) < left) {
					left -= node.textContent?.length ?? 0;
					node = walker.nextNode();
				}
				const range = document.createRange();
				range.setStart(node!, left);
				range.collapse(true);
				const anchor = range.getBoundingClientRect();
				return { dx: caret.left - anchor.left, dy: caret.top - anchor.top };
			});

		const before = await offsetFromAnchor();
		await page.evaluate(() => window.scrollBy(0, 150));
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
		await expect
			.poll(async () => {
				const after = await offsetFromAnchor();
				return Math.abs(after.dx - before.dx) + Math.abs(after.dy - before.dy);
			})
			.toBeLessThanOrEqual(1);
		issues.assertClean();
	});

	test('block handles render outside the contenteditable host', async ({ page }) => {
		test.fail(REF_RED, 'R11: handle hosts are inserted inside the host on the reference');
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&handles=true', { requireRuntime: true });
		await expect(page.getByTestId('block-handle')).toHaveCount(3);
		await expect(page.locator('[data-edytor] [data-testid="block-handle"]')).toHaveCount(0);
		await expect(page.locator('[data-edytor] [data-edytor-plugin-chrome]')).toHaveCount(0);
		await showAllHandles(page);
		await expectHandlesAligned(page, 3);
		issues.assertClean();
	});

	test('K9 handles stay on their rows in a scrolled container around the editor', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&handles=true', { requireRuntime: true });
		await showAllHandles(page);
		await page.evaluate(() => {
			const shell = document.querySelector<HTMLElement>('[data-testid="editor-shell"]')!;
			shell.style.height = '70px';
			shell.style.overflow = 'auto';
			shell.style.paddingLeft = '40px';
			document.querySelector<HTMLElement>('[data-edytor]')!.style.paddingBottom = '600px';
		});
		await expectHandlesAligned(page, 3);
		await page.evaluate(() => {
			document.querySelector<HTMLElement>('[data-testid="editor-shell"]')!.scrollTop = 30;
		});
		await expectHandlesAligned(page, 3);
		issues.assertClean();
	});

	test('K9 handles stay on their rows when the host itself scrolls', async ({ page }) => {
		test.fail(REF_RED, 'K9: a handle host inside a scrolling host keeps its unscrolled position');
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&handles=true', { requireRuntime: true });
		await showAllHandles(page);
		await page.evaluate(() => {
			const shell = document.querySelector<HTMLElement>('[data-testid="editor-shell"]')!;
			shell.style.paddingLeft = '40px';
			const host = document.querySelector<HTMLElement>('[data-edytor]')!;
			host.style.height = '60px';
			host.style.overflow = 'auto';
			host.style.paddingBottom = '600px';
		});
		await expectHandlesAligned(page, 3);
		await page.evaluate(() => {
			document.querySelector<HTMLElement>('[data-edytor]')!.scrollTop = 20;
		});
		await expectHandlesAligned(page, 3);
		issues.assertClean();
	});

	test('handles realign after a commit moves the blocks below it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&handles=true', { requireRuntime: true });
		await showAllHandles(page);
		await expectHandlesAligned(page, 3);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await expectHandlesAligned(page, 5);
		issues.assertClean();
	});
});
