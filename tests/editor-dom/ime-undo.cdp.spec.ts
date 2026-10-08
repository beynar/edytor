/**
 * arch-v2 phase 2 P1.2 — IME undo rows from the native review's browser
 * probes (`review-probes/browser/ime.probe.ts`), on the cdp lane: Chromium's
 * real IME path (`Input.imeSetComposition` / `Input.insertText`, see
 * `cdp.ts`).
 *
 * Contracts: plan F-I16 (a: undo after a commit gives the pre-composition
 * text; c: compose over a selected word, commit, undo → the word is back)
 * and `hist.capture-group` (the issuing view selects the step's recorded
 * `before` on undo).
 */
import { expect, test } from './editorTest';
import { openIme } from './cdp';
import { b, caret, domSelection, mod, open, selection, setDom, texts } from './probe-helpers';

const BASIC = [b('b0', 'first'), b('b1', 'note'), b('b2', 'tail')];
const PACE = 100;

test.describe('P1 — IME undo (review-probes/ime, F-I16)', () => {
	test('undo after a mid-word IME commit restores the text and the pre-composition caret', async ({
		page
	}) => {
		await open(page, BASIC);
		await caret(page, 'b1', 2); // no|te
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(PACE);
		await ime.compose('にほ');
		await page.waitForTimeout(PACE);
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(() => texts(page)).toEqual(['first', 'no日本te', 'tail']);
		await page.keyboard.press(`${mod}+z`);
		await expect.poll(() => texts(page)).toEqual(['first', 'note', 'tail']);
		await expect.poll(() => selection(page)).toMatchObject({ range: 'b1@2-b1@2', collapsed: true });
		expect(await domSelection(page)).toEqual({ dom: 'b1@2->b1@2', collapsed: true });
		await page.keyboard.press(`${mod}+Shift+z`);
		await expect.poll(() => texts(page)).toEqual(['first', 'no日本te', 'tail']);
	});

	test('undo after composing over a selected word restores the word and its selection', async ({
		page
	}) => {
		await open(page, BASIC);
		await setDom(page, ['b1', 0], ['b1', 4]);
		await expect
			.poll(() => selection(page))
			.toMatchObject({ range: 'b1@0-b1@4', collapsed: false });
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(PACE);
		await ime.commit('に');
		await ime.detach();
		await expect.poll(() => texts(page)).toEqual(['first', 'に', 'tail']);
		await page.keyboard.press(`${mod}+z`);
		await expect.poll(() => texts(page)).toEqual(['first', 'note', 'tail']);
		await expect
			.poll(() => selection(page))
			.toMatchObject({ range: 'b1@0-b1@4', collapsed: false });
		expect(await domSelection(page)).toEqual({ dom: 'b1@0->b1@4', collapsed: false });
	});
});
