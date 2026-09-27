/**
 * arch-v2 — checkpoint V5 rows, browser lane (chromium, firefox, webkit): the
 * `selectionchange` classifier (R10, L23) — F-S10.
 *
 * After settle the DOM caret equals the model caret:
 * - (a) a mark toggle over a selection (Gecko re-anchors the caret when the
 *   span under it is replaced);
 * - (b) a peer's format re-splits the text under a live caret (Gecko clamps,
 *   Blink keeps the offset);
 * - (c) a move with no gesture while our render is still unreconciled;
 * - (d) the IME post-commit jump (named rule): a move right after a
 *   composition commit, before any gesture, is reverted; after the rule's
 *   window a move with no gesture is a foreign write and is adopted.
 * And a foreign write is adopted (probe C4, O1): host code selecting after a
 * typed character, with no gesture.
 *
 * The Android post-delete snap-back is `mobile-arch-v2-v5-snapback.spec.ts`;
 * the IME post-commit rows on Chromium's real IME path are
 * `arch-v2-v5-post-commit.cdp.spec.ts`. Expected values come from the plan
 * rows, never from running the code.
 */
import { expect, test, type Page } from './editorTest';

import { readDomSelection } from './cdp';
import {
	dispatchComposition,
	expectSelection,
	modKey,
	readSelection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/** `lead`, an empty paragraph, `tail` (one text per block: text index = block index). */
const open = async (page: Page, empty = 'middle') => {
	await page.goto(`/test/dom?scenario=basic&empty=${empty}`);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The model selection and the DOM selection, in (text index, offset) coordinates. */
const both = async (page: Page) => {
	const model = await readSelection(page);
	const dom = await readDomSelection(page);
	return {
		model: [model.startBlockPath?.[0], model.yStart, model.endBlockPath?.[0], model.yEnd],
		dom: dom
			? dom.anchorTextIndex <= dom.focusTextIndex && dom.anchorOffset <= dom.focusOffset
				? [dom.anchorTextIndex, dom.anchorOffset, dom.focusTextIndex, dom.focusOffset]
				: [dom.focusTextIndex, dom.focusOffset, dom.anchorTextIndex, dom.anchorOffset]
			: null
	};
};

/** The DOM selection equals the model selection now, and still does after `ms` (no late drift). */
const expectSettled = async (page: Page, model: number[], ms = 150) => {
	await expect.poll(() => both(page)).toEqual({ model, dom: model });
	await page.waitForTimeout(ms);
	expect(await both(page)).toEqual({ model, dom: model });
};

/** Move the DOM selection from a page script: no pointer, key or focus event. */
const moveWithoutGesture = (page: Page, textIndex: number, start: number, end = start) =>
	page.evaluate(
		([index, from, to]) => {
			const element = document.querySelectorAll('[data-edytor-text="true"]')[index]!;
			const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
			window.getSelection()!.setBaseAndExtent(leaf, from, leaf, to);
		},
		[textIndex, start, end] as const
	);

test.describe('V5 classifier — F-S10 (after settle the DOM caret is the model caret)', () => {
	test('(a) a mark toggle over a selection', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 3);
		await expectSelection(page, { startBlockPath: [0], yStart: 1, yEnd: 3 });
		await page.keyboard.press(`${modKey}+b`);
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().locator('strong, b').count())
			.toBeGreaterThan(0);
		await expectSettled(page, [0, 1, 0, 3]);
		issues.assertClean();
	});

	test('(b) a peer format re-splits the text under the caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 3);
		await expectSelection(page, { startBlockPath: [0], yStart: 3, isCollapsed: true });
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const text = edytor.root.children[0].firstText;
			edytor.doc.transact(() => text.formatAt(0, 2, { bold: true }), 'remote-peer');
		});
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().locator('strong, b').count())
			.toBeGreaterThan(0);
		await expectSettled(page, [0, 3, 0, 3]);
		await page.keyboard.type('X');
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().textContent())
			.toBe('leaXd');
		issues.assertClean();
	});

	test('(c) a move with no gesture right after typing: DOM and model agree after settle', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, isCollapsed: true });
		await page.keyboard.type('X');
		await moveWithoutGesture(page, 0, 0);
		await page.waitForTimeout(200);
		const settled = await both(page);
		expect(settled.dom).toEqual(settled.model);
		issues.assertClean();
	});

	test('a foreign write after typing is adopted (C4)', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, { startBlockPath: [0], yStart: 2, isCollapsed: true });
		await page.keyboard.type('X');
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().textContent())
			.toBe('leXad');
		await page.waitForTimeout(200);
		await moveWithoutGesture(page, 0, 0, 3);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 3,
			isCollapsed: false
		});
		await expectSettled(page, [0, 0, 0, 3]);
		issues.assertClean();
	});
});

test.describe('V5 classifier — the IME post-commit jump (named rule)', () => {
	/** An empty first paragraph composed to `é`, with a page-script jump to 0 queued after the commit. */
	const commitWithJump = async (page: Page, jumpAfterMs: number | null) => {
		await open(page, 'first');
		await setSelectionByTextIndex(page, 0, 0);
		if (jumpAfterMs !== null) {
			await page.evaluate((delay) => {
				document.addEventListener(
					'compositionend',
					() =>
						setTimeout(() => {
							const element = document.querySelector('[data-edytor-text="true"]')!;
							const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
							window.getSelection()!.collapse(leaf ?? element, 0);
						}, delay),
					{ once: true, capture: true }
				);
			}, jumpAfterMs);
		}
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);
		await expect
			.poll(() => page.locator('[data-edytor-text="true"]').first().textContent())
			.toBe('é');
	};

	test('a jump right after the commit, with no gesture, is reverted', async ({ page }) => {
		const issues = trackPageIssues(page);
		await commitWithJump(page, 0);
		await page.waitForTimeout(100);
		await expectSettled(page, [0, 1, 0, 1]);
		issues.assertClean();
	});

	test('after the rule window, a move with no gesture is adopted', async ({ page }) => {
		const issues = trackPageIssues(page);
		await commitWithJump(page, null);
		await expectSettled(page, [0, 1, 0, 1]);
		await page.waitForTimeout(400);
		await moveWithoutGesture(page, 0, 0);
		await expectSettled(page, [0, 0, 0, 0]);
		issues.assertClean();
	});
});
