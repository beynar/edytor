import { expect, test, type Page } from './editorTest';
import {
	dispatchComposition,
	dispatchPaste,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * Wave 14 (`docs/reviews/2026-09-30-rescore-11.md`), leaving a block
 * selection in every engine. EW-06: Escape over a lone selected divider
 * puts the caret at the start of the next line, and typing, Enter and a
 * paste land there, never in the divider. EW-01: a composition over a block
 * selection starts in the empty paragraph that replaces it — the DOM caret
 * is there before the IME writes — and the commit lands there alone (the
 * real-IME rows are `ime-baseline.cdp.spec.ts`). Expected states are
 * hand-authored.
 */

type Block = { type: string; content?: { text?: string }[] };

const lines = async (page: Page) =>
	(await readJsonByTestId<{ children: Block[] }>(page, 'value')).children.map(
		(block) => `${block.type}:${(block.content ?? []).map((part) => part.text ?? '').join('')}`
	);

const selectedBlocks = (page: Page) =>
	page.evaluate(() => (window as any).__EDYTOR__.selection.selectedBlocks.size as number);

/** `[first, divider, after]`, the divider selected with Backspace from `|after`. */
const selectDivider = async (page: Page) => {
	await page.goto('/test/dom?scenario=divider');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 1, 0); // |after divider
	await page.keyboard.press('Backspace');
	await expect.poll(() => selectedBlocks(page)).toBe(1);
};

test.describe('Escape over a lone selected divider (EW-06)', () => {
	for (const [name, act, expected] of [
		[
			'typing',
			(page: Page) => page.keyboard.type('Z'),
			['paragraph:before divider', 'divider:', 'paragraph:Zafter divider']
		],
		[
			'Enter',
			async (page: Page) => {
				await page.keyboard.press('Enter');
				await page.keyboard.type('E');
			},
			['paragraph:before divider', 'divider:', 'paragraph:', 'paragraph:Eafter divider']
		],
		[
			'a paste',
			(page: Page) => dispatchPaste(page, { text: 'P' }),
			['paragraph:before divider', 'divider:', 'paragraph:Pafter divider']
		]
	] as const) {
		test(`${name} after Escape lands at the start of the next line`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await selectDivider(page);
			await page.keyboard.press('Escape');
			await expect.poll(() => selectedBlocks(page)).toBe(0);
			await act(page);
			await expect.poll(() => lines(page)).toEqual(expected);
			issues.assertClean();
		});
	}
});

test.describe('a composition over a block selection (EW-01)', () => {
	test('starts in the paragraph that replaces the blocks; the commit lands there alone', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await selectDivider(page);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		// The IME has a caret in the new, empty paragraph before it writes.
		const caret = await page.evaluate(() => {
			const selection = document.getSelection();
			const node = selection?.focusNode;
			const element = (
				node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
			)?.closest('[data-edytor-block]');
			const blocks = [...document.querySelectorAll('[data-edytor-block]')];
			return { rangeCount: selection?.rangeCount, block: element ? blocks.indexOf(element) : -1 };
		});
		expect(caret).toEqual({ rangeCount: 1, block: 1 });
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に', cancelable: false },
			{ type: 'compositionend', data: '日' }
		]);
		await expect
			.poll(() => lines(page))
			.toEqual(['paragraph:before divider', 'paragraph:日', 'paragraph:after divider']);
		issues.assertClean();
	});

	test('after an earlier composition: the session stays live and the commit lands (DR-behavior-1)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=divider');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'before divider'.length);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'x', cancelable: false },
			{ type: 'compositionend', data: 'x' }
		]);
		await expect.poll(() => lines(page)).toContain('paragraph:before dividerx');
		// Past the composition's tail.
		await page.waitForTimeout(600);
		await setSelectionByTextIndex(page, 1, 0); // |after divider
		await page.keyboard.press('Backspace');
		await expect.poll(() => selectedBlocks(page)).toBe(1);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		expect(await page.evaluate(() => (window as any).__EDYTOR__.composition.phase)).toBe('live');
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に', cancelable: false },
			{ type: 'compositionend', data: '日' }
		]);
		await expect
			.poll(() => lines(page))
			.toEqual(['paragraph:before dividerx', 'paragraph:日', 'paragraph:after divider']);
		expect(await page.evaluate(() => (window as any).__EDYTOR__.composition.host)).toBeNull();
		issues.assertClean();
	});
});
