/** @jsxImportSource ../../jsx */
/**
 * Selection ownership under later user intent — adversarial review
 * 2026-09-23 (P1-2, P1-3, P2-6).
 *
 * Every deferred restore/repair must yield to newer user intent:
 * - P1-2: a delayed blurred-selection repair must not steal focus back
 *   after the user returns to the editor.
 * - P1-3: delayed undo-restore timers must not move the model caret
 *   after a newer caret move — model and native selection must agree.
 * - P2-6: an async range write must not apply a stale direction over a
 *   newer selection on the same endpoints.
 */
import { describe, expect, test } from 'vitest';
import {
	expectNativeSelection,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const firstText = (edytor: { root?: { children: { firstText: any }[] } }) =>
	edytor.root!.children[0]!.firstText;

describe('P1-2 — delayed blurred-selection repair yields to user return', () => {
	test('the deferred retry does not refocus an external element after the user returns', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const outsideButton = document.createElement('button');
		document.body.append(outsideButton);
		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		// A FOREIGN-origin model write while blurred touches the caret's
		// text — `restoreRelativePosition` only fires for changes whose
		// origin is not the view's own transaction (`edytor.transact`
		// would make this pin vacuous). The blurred-selection repair
		// captures the external element and arms retries at tick/+0/+50ms.
		const block = edytor.root!.children[0]!;
		edytor.facade.insertText(block.id, 0, 'X');

		// The user returns BEFORE the deferred retries land — an inside
		// pointer gesture plus a fresh caret. Focus lands on the
		// contenteditable root (the text leaf's parent is a
		// `contenteditable=false` span — not itself focusable).
		editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		outsideButton.blur();
		const text = firstText(edytor);
		await setNativeSelection(edytor, text, 2);
		edytor.node!.focus();

		await sleep(80); // past the 50ms retry window
		expect(document.activeElement).not.toBe(outsideButton); // retry must not steal focus back
		expect(edytor.node!.contains(document.activeElement)).toBe(true);
		// The user's fresh DOM selection survives too — the retry must not
		// run its stale-selection clear.
		const anchor = window.getSelection()?.anchorNode;
		expect(anchor && edytor.node!.contains(anchor)).toBe(true);
		outsideButton.remove();
	});

	test('the deferred retry yields even when focus returns without a pointer gesture', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const outsideButton = document.createElement('button');
		document.body.append(outsideButton);
		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		// Foreign-origin write arms the repair against the external element.
		const block = edytor.root!.children[0]!;
		edytor.facade.insertText(block.id, 0, 'X');

		// Focus returns via a programmatic focus() + caret placement — the
		// path a real app takes when e.g. a dialog closes back into the
		// editor. The focusin clears the outside-gesture flag; the armed
		// retries must read that and stand down.
		const text = firstText(edytor);
		await setNativeSelection(edytor, text, 1);
		edytor.node!.focus();

		await sleep(80);
		expect(document.activeElement).not.toBe(outsideButton);
		expect(edytor.node!.contains(document.activeElement)).toBe(true);
		const anchor = window.getSelection()?.anchorNode;
		expect(anchor && edytor.node!.contains(anchor)).toBe(true);
		outsideButton.remove();
	});
});

describe('P1-3 — undo-restore timers yield to a newer caret move', () => {
	test('a caret move after undo is not overwritten by a delayed range restore', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const text = block.firstText;

		// Establish a range and delete it — undo restores the range snapshot.
		await setNativeSelection(edytor, text, 1, text, 4);
		edytor.transact(() => edytor.facade.deleteText(block.id, 1, 4));
		edytor.historyUndo();
		await sleep(80); // let the restore settle

		// Sanity: the undo restored a range (the end anchor resolves
		// through dead-backing fallback — 4 vs 5 is resolution accuracy,
		// not the ownership defect under test).
		expect(edytor.selection.state.isCollapsed).toBe(false);

		// The user moves the caret to 0 — model and DOM must agree there
		// AND STAY there once any stray restore timers fire.
		editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		await setNativeSelection(edytor, text, 0);
		expect(edytor.selection.state.yStart).toBe(0);

		await sleep(60); // stray 0/30ms restore timers land inside this window
		expect(edytor.selection.state.yStart).toBe(0); // FAILS — stale restore wrote 1/3
		expect(edytor.selection.state.isCollapsed).toBe(true);
		expectNativeSelection({ collapsed: true, anchorOffset: 0 });
	});
});

describe('P2-6 — async range writes include direction in the staleness guard', () => {
	test('a stale forward write does not overwrite a newer backward range on the same endpoints', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const text = firstText(edytor);
		const selection = edytor.selection;

		// The older write awaits endpoint nodes; while it is in flight a
		// newer BACKWARD write over the same endpoints lands.
		const staleWrite = selection.setAtRange(text, 1, text, 3, { isReversed: false });
		selection.state = {
			...selection.state,
			startText: text,
			endText: text,
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			isReversed: true
		};
		await staleWrite;
		await flushDomUpdates();

		expect(selection.state.isReversed).toBe(true); // FAILS — stale write flipped it forward
	});
});
