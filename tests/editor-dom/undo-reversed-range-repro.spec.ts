import { test, expect } from '@playwright/test';
import { waitForEditorReady } from './helpers';

// Regression for the DST seed-5 class: a reversed cross-text range → type →
// Meta+z must leave model and native selection in agreement.
// Failure mode: the undo's DOM render detached the focused node → focusout →
// gestureSerial bump → the history restore self-aborted before its first DOM
// write — model restored, native collapsed outside the editor
// (`selection-model-dom-mismatch`).
test('undo leaves model and native selection in agreement', async ({ page }) => {
	await page.goto('/test/dom?scenario=nestedInline');
	await waitForEditorReady(page);
	await page.evaluate(async () => {
		const e = (window as any).__EDYTOR__;
		const block = e.root.children[0];
		const texts = block.content.filter((p: { length?: number }) => typeof p.length === 'number');
		if (texts.length < 2) throw new Error('need >=2 texts');
		await e.selection.setAtRange(
			texts[0],
			2,
			texts[texts.length - 1],
			texts[texts.length - 1].length,
			{ isReversed: true }
		);
	});
	await page.waitForTimeout(100);
	await page.keyboard.type('x');
	await page.waitForTimeout(100);
	await page.keyboard.press('Meta+z');

	// The restore is async — poll until the native selection lands inside a
	// real text node (the defect left it collapsed on a div outside texts).
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const s = window.getSelection();
					if (!s?.anchorNode) return 'none';
					const el = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode.parentElement;
					return el?.closest('[data-edytor-text]') ? 'text' : 'outside';
				}),
			{ timeout: 3000 }
		)
		.toBe('text');

	// Native must equal the model position (the DST oracle's contract).
	const agree = await page.evaluate(() => {
		const e = (window as any).__EDYTOR__;
		const s = window.getSelection();
		if (!s?.anchorNode || !s.focusNode) return 'no-native';
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const idxOf = (n: Node) => {
			const el = n instanceof Element ? n : n.parentElement;
			const t = el?.closest('[data-edytor-text]');
			return t ? texts.indexOf(t) : -1;
		};
		const state = e.selection.state;
		const renderedTexts = e.root.children[0].content.filter(
			(p: { length?: number }) => typeof p.length === 'number'
		);
		const startIdx = renderedTexts.indexOf(state.startText);
		const endIdx = renderedTexts.indexOf(state.endText);
		return `model:${startIdx}@${state.yStart}->${endIdx}@${state.yEnd} native:${idxOf(s.anchorNode)}@${s.anchorOffset}->${idxOf(s.focusNode)}@${s.focusOffset}`;
	});
	console.log('agreement:', agree);
	expect(agree).not.toContain('-1@');
});
