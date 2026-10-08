/**
 * arch-v2 — checkpoint V5 rows, cdp lane: the IME post-commit jump (named,
 * counted, time-bounded rule; plan §9.1 rule 5, F-S10, BI-10) on Chromium's
 * real IME path (`Input.imeSetComposition` / `Input.insertText`).
 *
 * - After a real commit mid-word, the DOM caret equals the model caret after
 *   settle, and stays there.
 * - A jump right after the commit (a page-script move queued by
 *   `compositionend`, no gesture) is reverted to the commit caret.
 * - After the rule's window, a move with no gesture is a foreign write and is
 *   adopted.
 */
import { openIme, readDomSelection } from './cdp';
import { expect, test, type Page } from './editorTest';
import {
	expectSelection,
	readSelection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const both = async (page: Page) => {
	const model = await readSelection(page);
	const dom = await readDomSelection(page);
	return {
		model: [model.startBlockPath?.[0], model.yStart, model.isCollapsed],
		dom: dom ? [dom.focusTextIndex, dom.focusOffset, dom.isCollapsed] : null
	};
};

const expectSettled = async (page: Page, expected: unknown[]) => {
	await expect.poll(() => both(page)).toEqual({ model: expected, dom: expected });
	await page.waitForTimeout(150);
	expect(await both(page)).toEqual({ model: expected, dom: expected });
};

/** `no|te` composed to `noかte` through the real IME; `jumpAfterMs` queues a page-script jump to 0. */
const commitMidWord = async (page: Page, jumpAfterMs: number | null) => {
	await page.goto('/test/dom?scenario=basic');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 1, 2);
	await expectSelection(page, { startBlockPath: [1], yStart: 2, isCollapsed: true });
	if (jumpAfterMs !== null) {
		await page.evaluate((delay) => {
			document.addEventListener(
				'compositionend',
				() =>
					setTimeout(() => {
						const element = document.querySelectorAll('[data-edytor-text="true"]')[1]!;
						const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
						window.getSelection()!.collapse(leaf, 0);
					}, delay),
				{ once: true, capture: true }
			);
		}, jumpAfterMs);
	}
	const ime = await openIme(page);
	await ime.compose('ｋ');
	await page.waitForTimeout(100);
	await ime.compose('か');
	await page.waitForTimeout(100);
	await ime.commit('か');
	await ime.detach();
	await expect
		.poll(() => page.locator('[data-edytor-text="true"]').nth(1).textContent())
		.toBe('noかte');
};

test.describe('cdp — the IME post-commit jump (V5, F-S10)', () => {
	test('after a real commit the DOM caret is the model caret, and stays', async ({ page }) => {
		const issues = trackPageIssues(page);
		await commitMidWord(page, null);
		await expectSettled(page, [1, 3, true]);
		issues.assertClean();
	});

	test('a jump right after the commit, with no gesture, is reverted', async ({ page }) => {
		const issues = trackPageIssues(page);
		await commitMidWord(page, 0);
		await page.waitForTimeout(100);
		await expectSettled(page, [1, 3, true]);
		issues.assertClean();
	});

	test('after the rule window, a move with no gesture is adopted', async ({ page }) => {
		const issues = trackPageIssues(page);
		await commitMidWord(page, null);
		await expectSettled(page, [1, 3, true]);
		await page.waitForTimeout(400);
		await page.evaluate(() => {
			const element = document.querySelectorAll('[data-edytor-text="true"]')[1]!;
			const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
			window.getSelection()!.collapse(leaf, 1);
		});
		await expectSettled(page, [1, 1, true]);
		issues.assertClean();
	});
});
