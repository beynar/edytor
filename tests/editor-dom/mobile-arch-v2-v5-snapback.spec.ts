/**
 * arch-v2 — checkpoint V5 row, mobile lane: the Android post-delete snap-back
 * (named, counted, time-bounded rule; plan §9.1 rule 5, F-S10).
 *
 * Android Chrome mutates the DOM after a canceled `deleteContentBackward` and
 * reports the caret one position right of the model's merge point. After a
 * model-owned Backspace merge, a caret at merge + 1 with no gesture since,
 * inside the rule's window, is displayed back at the merge point on Android
 * Chrome (mobile-chromium: Pixel 5); elsewhere (mobile-webkit: iPhone) the
 * same move is a foreign write and is adopted. The move is injected by a page
 * script once the merge's own render is reconciled (≈60 ms), so the row
 * isolates the named rule from the drift rule.
 */
import { expect, test, type Page } from './editorTest';

import { readDomSelection } from './cdp';
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
		model: [model.startBlockPath?.[0], model.yStart],
		dom: dom ? [dom.focusTextIndex, dom.focusOffset] : null
	};
};

test('a +1 caret after a model-owned Backspace merge: snapped back on Android Chrome only', async ({
	page
}, testInfo) => {
	const issues = trackPageIssues(page);
	await page.goto('/test/dom?scenario=basic&empty=middle');
	await waitForEditorReady(page, { requireRuntime: true });
	// `lead`, `ab`, `tail`.
	await setSelectionByTextIndex(page, 1, 0);
	await page.keyboard.type('ab');
	await expect
		.poll(() => page.locator('[data-edytor-text="true"]').nth(1).textContent())
		.toBe('ab');
	await setSelectionByTextIndex(page, 2, 0);
	await expectSelection(page, { startBlockPath: [2], yStart: 0, isCollapsed: true });
	await page.evaluate(() => {
		document.addEventListener(
			'beforeinput',
			(event) => {
				if ((event as InputEvent).inputType !== 'deleteContentBackward') return;
				setTimeout(() => {
					const element = document.querySelectorAll('[data-edytor-text="true"]')[1]!;
					const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
					window.getSelection()!.collapse(leaf, 3);
				}, 60);
			},
			{ once: true, capture: true }
		);
	});
	await page.keyboard.press('Backspace');
	await expect
		.poll(() => page.locator('[data-edytor-text="true"]').nth(1).textContent())
		.toBe('abtail');
	await page.waitForTimeout(200);
	const android = testInfo.project.name === 'mobile-chromium';
	const expected = android ? [1, 2] : [1, 3];
	await expect.poll(() => both(page)).toEqual({ model: expected, dom: expected });
	issues.assertClean();
});
