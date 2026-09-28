/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — undo grouping must not depend on timing (R7, O31, D36; DST seeds 8
 * and 19, `cross-browser-history-divergence`). The policy table coalesces an
 * insertion with the step before it within `captureTimeout`; that window may
 * only fuse an insertion that CONTINUES the step: one that starts where the
 * step left this view's selection. An insertion after the caret moved — a
 * click, an arrow key, a foreign change adopted elsewhere — starts its own
 * step however soon it follows.
 *
 * - H-G1 — type `a` @5 of `hello world`, move the caret to @0, type `b`: two
 *   steps, whether `b` comes 100 ms or 900 ms after `a`; one undo removes
 *   only `b`.
 * - H-G2 — type `a` @5, move the caret to @0, then a foreign script rewrites
 *   the text (no input event, adopted by the observer): two steps at once
 *   and 900 ms later.
 * - H-G3 (guard) — typing `a` then `b` at the caret `a` left, at once:
 *   one step (typing still coalesces).
 * - H-G4 — type `a` @5, then a foreign script inserts `!` right at the caret
 *   `a` left (no input event: no occurrence owns it): the foreign change is
 *   its own step, at once and 900 ms later — only a user's own insertion
 *   continues a step.
 *
 * The pause is simulated on the undo manager's clock: `lastChange` (a plain
 * field, plan §1.1) moves back by the pause; the rows themselves run well
 * inside `captureTimeout`.
 * Expected values come from the policy rows, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** `ms` pass on the undo manager's clock since its last change. */
const pause = (edytor: Edytor, ms: number) => {
	edytor.undoManager.lastChange -= ms;
};

const plainText = (edytor: Edytor) =>
	(edytor.value.children?.[0]?.content ?? [])
		.map((part) => ('text' in part ? part.text : '@'))
		.join('');

const mount = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>hello| world</paragraph>
		</root>
	);
	rendered.edytor.undoManager.stopCapturing();
	return rendered;
};

/** A user places the caret (a pointer gesture, then the native selection). */
const click = async (edytor: Edytor, editor: HTMLElement, offset: number) => {
	editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
	await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, offset);
	await flushDomUpdates();
};

const type = async (editor: HTMLElement, data: string) => {
	await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
	await flushDomUpdates();
};

describe('undo grouping does not depend on timing (R7, O31)', () => {
	for (const ms of [0, 900]) {
		it(`H-G1: an insertion after the caret moved is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			expect(plainText(edytor)).toBe('helloa world');
			await click(edytor, editor, 0);
			pause(edytor, ms);
			await type(editor, 'b');
			expect(plainText(edytor)).toBe('bhelloa world');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});

		it(`H-G2: a foreign change adopted after the caret moved is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			await click(edytor, editor, 0);
			pause(edytor, ms);
			const text = editor.querySelector('[data-edytor-text="true"]')!;
			const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode() as Text;
			leaf.data = `${leaf.data}!`;
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world!');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});
	}

	for (const ms of [0, 900]) {
		it(`H-G4: a foreign change at the caret typing left is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			pause(edytor, ms);
			const text = editor.querySelector('[data-edytor-text="true"]')!;
			const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode() as Text;
			leaf.data = `${leaf.data.slice(0, 6)}!${leaf.data.slice(6)}`;
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa! world');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});
	}

	it('H-G3: typing at the caret the last insertion left coalesces', async () => {
		const { edytor, editor } = await mount();
		await type(editor, 'a');
		await type(editor, 'b');
		expect(plainText(edytor)).toBe('helloab world');
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});
});
