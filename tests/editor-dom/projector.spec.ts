/**
 * arch-v2 — checkpoint V4 rows, browser lane (chromium, firefox, webkit): the
 * display projector is the only writer of the DOM selection (R10).
 *
 * - F-S6 — a forward native selection whose focus is `(textElement,
 *   childCount)` reads forward, 1 → end.
 * - F-S9 — (a) our own render detaches the focused node: the caret is
 *   displayed and the editor keeps focus; (b) the user focused an outside
 *   `<input>`; (c) the user selected text in non-focusable page content
 *   outside the editor: a remote apply updates the model only, and the user's
 *   focus and selection are kept (BI-14).
 * - F-S11 — (a) ArrowRight while a remote update is applied in a microtask of
 *   the keydown's capture listener (before its `selectionchange`); (b) a mouse
 *   drag with remote updates at 60 Hz; (c) `setBaseAndExtent` from a page
 *   script racing a remote apply: the user's move survives (BI-3).
 *
 * The remote apply is a same-page write under a foreign origin (the view did
 * not issue it). Expected values come from the plan rows. Red on the
 * reference (`arch-v2/ref-v4`): F-S9 (a) and F-S11 (c) on all three engines,
 * F-S11 (a) on firefox.
 */
import { expect, test, type Page } from './editorTest';

import {
	expectSelection,
	getCaretPoint,
	readSelection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/** `lead`, an empty paragraph, `tail`. */
const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=basic&empty=middle');
	await waitForEditorReady(page, { requireRuntime: true });
};

/** Insert `value` at `offset` of text element `textIndex`, under a foreign origin. */
const remoteInsert = (page: Page, textIndex: number, offset: number, value: string) =>
	page.evaluate(
		([index, at, text]) => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[index];
			edytor.doc.transact(() => block.firstText.insertAt(at, text), 'remote-peer');
		},
		[textIndex, offset, value] as const
	);

const activeInsideEditor = (page: Page) =>
	page.evaluate(() => {
		const editor = document.querySelector('[data-edytor]');
		return Boolean(editor && document.activeElement && editor.contains(document.activeElement));
	});

/** The live DOM selection, as (text index, offset) of both ends, or where it is. */
const readDom = (page: Page) =>
	page.evaluate(() => {
		const selection = window.getSelection();
		const editor = document.querySelector('[data-edytor]');
		const texts = Array.from(document.querySelectorAll('[data-edytor-text="true"]'));
		const point = (node: Node | null, offset: number) => {
			if (!node) return null;
			const index = texts.findIndex((text) => text.contains(node));
			if (index === -1) return { inside: Boolean(editor?.contains(node)), index, offset: -1 };
			const walker = document.createTreeWalker(texts[index]!, NodeFilter.SHOW_TEXT);
			let at = 0;
			for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
				if (leaf === node) return { inside: true, index, offset: at + offset };
				at += leaf.textContent?.length ?? 0;
			}
			return { inside: true, index, offset: node === texts[index] ? offset : -1 };
		};
		return {
			anchor: point(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
			focus: point(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
			text: selection?.toString() ?? ''
		};
	});

test.describe('V4 projector — F-S6', () => {
	test('a node-bound focus keeps the native direction: forward 1 → end', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const element = document.querySelectorAll('[data-edytor-text="true"]')[0] as HTMLElement;
			const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
			edytor.markUserGesture();
			element.closest<HTMLElement>('[data-edytor]')!.focus();
			window.getSelection()!.setBaseAndExtent(leaf, 1, element, element.childNodes.length);
		});
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 4,
			isCollapsed: false,
			isReversed: false
		});
		issues.assertClean();
	});
});

test.describe('V4 projector — F-S9 focus verdict', () => {
	// R7 rewrite (L39): our render re-creates the caret's text element (no
	// whole-editor remount exists); the caret is displayed in it, focus kept.
	test('(a) our render detaches the caret’s node: the caret is displayed, focus kept', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, isCollapsed: true });
		expect(await activeInsideEditor(page)).toBe(true);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.cells.remount(edytor.root.children[0].id);
		});
		await expect
			.poll(() => readDom(page))
			.toMatchObject({
				anchor: { inside: true, index: 0, offset: 2 },
				focus: { inside: true, index: 0, offset: 2 }
			});
		expect(await activeInsideEditor(page)).toBe(true);
		await page.keyboard.type('X');
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().textContent())
			.toBe('leXad');
		issues.assertClean();
	});

	test('(b) an outside <input> keeps focus through a remote apply', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, isCollapsed: true });
		await page.evaluate(() => {
			const input = document.createElement('input');
			input.dataset.testid = 'outside-input';
			document.body.append(input);
		});
		await page.getByTestId('outside-input').click();
		await expect(page.getByTestId('outside-input')).toBeFocused();
		await remoteInsert(page, 0, 0, 'ZZ');
		await expectSelection(page, { startBlockPath: [0], yStart: 4, isCollapsed: true });
		await page.waitForTimeout(100);
		await expect(page.getByTestId('outside-input')).toBeFocused();
		expect((await readDom(page)).anchor?.inside ?? false).toBe(false);
		issues.assertClean();
	});

	test('(c) a selection in page content outside the editor is kept through a remote apply', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, isCollapsed: true });
		await page.evaluate(() => {
			const outside = document.createElement('p');
			outside.dataset.testid = 'outside-text';
			outside.textContent = 'outside words';
			document.body.append(outside);
		});
		await page.getByTestId('outside-text').dblclick();
		await expect.poll(async () => (await readDom(page)).text.trim()).toMatch(/^(outside|words)$/);
		const selected = (await readDom(page)).text;
		await remoteInsert(page, 0, 0, 'ZZ');
		await expectSelection(page, { startBlockPath: [0], yStart: 4, isCollapsed: true });
		await page.waitForTimeout(100);
		const dom = await readDom(page);
		expect(dom.text).toBe(selected);
		expect(dom.anchor?.inside ?? false).toBe(false);
		issues.assertClean();
	});
});

test.describe('V4 projector — F-S11 the user’s move survives a remote apply (BI-3)', () => {
	test('(a) ArrowRight with a remote update applied before its selectionchange', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1);
		await expectSelection(page, { startBlockPath: [0], yStart: 1, isCollapsed: true });
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			document.addEventListener(
				'keydown',
				() =>
					queueMicrotask(() =>
						edytor.doc.transact(
							() => edytor.root.children[0].firstText.insertAt(0, 'Z'),
							'remote-peer'
						)
					),
				{ capture: true, once: true }
			);
		});
		await page.keyboard.press('ArrowRight');
		// `lead`, caret 1 → the peer's `Z` before it (2) → one step right (3).
		await expectSelection(page, { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true });
		await expect
			.poll(() => readDom(page))
			.toMatchObject({ anchor: { index: 0, offset: 3 }, focus: { index: 0, offset: 3 } });
		issues.assertClean();
	});

	test('(b) a mouse drag survives remote updates at 60 Hz', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const start = await getCaretPoint(page, 0, 0);
		const end = await getCaretPoint(page, 0, 4);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const timer = setInterval(
				() =>
					edytor.doc.transact(
						() => edytor.root.children[2].firstText.insertAt(0, 'r'),
						'remote-peer'
					),
				16
			);
			(window as Window & { __STOP__?: () => void }).__STOP__ = () => clearInterval(timer);
		});
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 1, start.y, { steps: 3 });
		await page.mouse.move(end.x, end.y, { steps: 24 });
		await page.waitForTimeout(60);
		await page.mouse.up();
		await page.evaluate(() => (window as Window & { __STOP__?: () => void }).__STOP__?.());
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});
		expect((await readDom(page)).text).toBe('lead');
		issues.assertClean();
	});

	test('(c) setBaseAndExtent from a page script racing a remote apply', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 0);
		await expectSelection(page, { startBlockPath: [0], yStart: 0, isCollapsed: true });
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const element = document.querySelectorAll('[data-edytor-text="true"]')[0] as HTMLElement;
			const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
			window.getSelection()!.setBaseAndExtent(leaf, 1, leaf, 3);
			edytor.doc.transact(() => edytor.root.children[0].firstText.insertAt(0, 'Z'), 'remote-peer');
		});
		// `lead`, 1 → 3 (`ea`), the peer's `Z` before it: 2 → 4.
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 4,
			isCollapsed: false
		});
		await expect.poll(async () => (await readDom(page)).text).toBe('ea');
		expect(await readSelection(page)).toMatchObject({ yStart: 2, yEnd: 4 });
		issues.assertClean();
	});
});
