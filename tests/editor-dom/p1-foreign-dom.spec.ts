/**
 * arch-v2 phase 2 P1.2 — foreign DOM mutation, from the native review's
 * browser probes (`review-probes/browser/robustness.probe.ts`), re-targeted
 * at arch-v2's test route (three engines).
 *
 * Contract: docs/editor-delete-contract.md "Host DOM ownership (D-25)" and
 * plan F-I14. Strict regions (a block's own text/atom run, every text
 * element) are the editor's: a foreign node there is removed, structure is
 * restored from the cell, foreign text inside a content is browser input and
 * is adopted. A kind's own markup or an extension's node beside the slots is
 * tolerated and never shifts model offsets.
 */
import { expect, test } from './editorTest';
import { b, caret, domSelection, domTexts, open, selection, texts } from './p1-helpers';

const BASIC = [b('b0', 'first'), b('b1', 'note'), b('b2', 'tail')];

test.describe('P1 — foreign DOM (review-probes/robustness, D-25)', () => {
	/**
	 * DIVERGENCE (pinned): the native probe expects the span dropped and its
	 * text discarded. arch-v2's D-25 adopts foreign text inside a content as
	 * browser input (and removes the foreign node) — the rule
	 * `dom-mutation.spec.ts` pins for an unmanaged wrapper.
	 */
	test('a span injected inside a text element: its text is adopted, the node removed; typing lands at the caret', async ({
		page
	}) => {
		await open(page, BASIC);
		await page.evaluate(() => {
			const text = document.querySelector('[data-edytor-id="b1"] [data-edytor-text="true"]')!;
			const span = document.createElement('span');
			span.setAttribute('data-p1-foreign', '');
			span.textContent = 'INJ';
			text.insertBefore(span, text.firstChild);
		});
		await expect.poll(() => texts(page)).toEqual(['first', 'INJnote', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'INJnote', 'tail']);
		await expect(page.locator('[data-p1-foreign]')).toHaveCount(0);
		await caret(page, 'b1', 5); // INJno|te
		await page.keyboard.type('X');
		await expect.poll(() => texts(page)).toEqual(['first', 'INJnoXte', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'INJnoXte', 'tail']);
	});

	test('a removed block element is restored from its cell', async ({ page }) => {
		await open(page, BASIC);
		await page.evaluate(() => document.querySelector('[data-edytor-id="b2"]')!.remove());
		await expect.poll(() => domTexts(page)).toEqual(['first', 'note', 'tail']);
		await caret(page, 'b1', 4);
		await page.keyboard.type('!');
		await expect.poll(() => texts(page)).toEqual(['first', 'note!', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'note!', 'tail']);
	});

	test('an extension node beside the text element does not shift model offsets', async ({
		page
	}) => {
		await open(page, BASIC);
		await page.evaluate(() => {
			const text = document.querySelector('[data-edytor-id="b1"] [data-edytor-text="true"]')!;
			const ext = document.createElement('span');
			ext.setAttribute('data-grammarly', '');
			ext.contentEditable = 'false';
			ext.textContent = '✓✓';
			text.parentNode!.insertBefore(ext, text);
		});
		await page.waitForTimeout(150);
		expect(await texts(page)).toEqual(['first', 'note', 'tail']);
		await caret(page, 'b1', 2);
		await page.keyboard.type('X');
		await expect.poll(() => texts(page)).toEqual(['first', 'noXte', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'noXte', 'tail']);
	});

	test('a foreign script rewriting text inside a block is adopted as input (F-I14)', async ({
		page
	}) => {
		await open(page, BASIC);
		await page.evaluate(() => {
			const text = document.querySelector('[data-edytor-id="b1"] [data-edytor-text="true"]')!;
			document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!.textContent = 'NOTE';
		});
		await expect.poll(() => texts(page)).toEqual(['first', 'NOTE', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'NOTE', 'tail']);
		await caret(page, 'b1', 4);
		await page.keyboard.type('!');
		await expect.poll(() => texts(page)).toEqual(['first', 'NOTE!', 'tail']);
		await expect.poll(() => domTexts(page)).toEqual(['first', 'NOTE!', 'tail']);
	});
});

/**
 * A foreign line beside a block's slots (D-25 tolerates it) is no caret stop
 * (R9, `session/navigation`): a plain vertical key the browser moves onto it
 * still moves the caret — to the key's line stop — and the DOM shows the value.
 * DST seed 1 (`move-produced-no-effect`, ArrowDown from an empty first block).
 */
test.describe('P1 — a foreign line between blocks does not swallow vertical keys', () => {
	const appendForeignLine = (page: import('@playwright/test').Page, id: string) =>
		page.evaluate((id) => {
			const block = document.querySelector(`[data-edytor-block="true"][data-edytor-id="${id}"]`)!;
			const span = document.createElement('span');
			span.setAttribute('data-p1-foreign-line', '');
			span.textContent = 'foreign';
			block.appendChild(span);
		}, id);
	/** The native caret sits inside a text element (a stop), not on the foreign line. */
	const caretInText = (page: import('@playwright/test').Page) =>
		page.evaluate(() => {
			const node = window.getSelection()?.anchorNode ?? null;
			const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
			return Boolean(element?.closest('[data-edytor-text="true"]'));
		});

	for (const first of ['', 'first']) {
		test(`ArrowDown from ${first ? 'a' : 'an empty'} first block reaches the next block`, async ({
			page
		}) => {
			await open(page, [b('b0', first), b('b1', 'note')]);
			await appendForeignLine(page, 'b0');
			await caret(page, 'b0', 0);
			await page.keyboard.press('ArrowDown');
			await expect.poll(() => selection(page)).toMatchObject({ collapsed: true });
			await expect.poll(async () => (await selection(page)).range).toMatch(/^b1@\d+-b1@\d+$/);
			const { range } = await selection(page);
			const at = range.split('-')[0];
			await expect.poll(() => domSelection(page)).toEqual({ dom: `${at}->${at}`, collapsed: true });
			expect(await caretInText(page)).toBe(true);
			expect(await texts(page)).toEqual([first, 'note']);
		});
	}

	test('ArrowUp from the second block reaches the first block', async ({ page }) => {
		await open(page, [b('b0', 'first'), b('b1', 'note')]);
		await appendForeignLine(page, 'b0');
		await caret(page, 'b1', 0);
		await page.keyboard.press('ArrowUp');
		await expect.poll(async () => (await selection(page)).range).toMatch(/^b0@\d+-b0@\d+$/);
		const { range } = await selection(page);
		const at = range.split('-')[0];
		await expect.poll(() => domSelection(page)).toEqual({ dom: `${at}->${at}`, collapsed: true });
		expect(await caretInText(page)).toBe(true);
	});
});
