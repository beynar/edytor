/** @jsxImportSource ../../jsx */
/**
 * The projector holds back a display it was not asked for while a user-input
 * handler runs (`isHandlingUserInput`), and that flag is no reactive source:
 * when the window closes, the held pass runs (`Projector.inputHandled`).
 *
 * Regression (Firefox, `hotkeys.spec.ts` "routes native format beforeinput
 * events through editor marks"): `formatRemove` over `lead|` → `note|`
 * re-renders both texts (the bold elements go) without asking for a display.
 * The render's flush landed inside the async handler's window, so the pass
 * waited and nothing ran it again; the range the removal moved (Firefox keeps
 * it where the removed `<strong>` stood, the text's end) was then adopted as
 * the gesture's: the range started at 4 instead of 0.
 *
 * Expected values come from the selection contract (the projector displays
 * the value after the render; a render never moves the value).
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

const range = (edytor: Edytor) => {
	const { start, end, isCollapsed } = edytor.selection.projection;
	return { start: start?.offset, end: end?.offset, isCollapsed };
};

/** The live DOM selection's ends as (text element index, text-node offset). */
const domEnds = (edytor: Edytor) => {
	const selection = window.getSelection()!;
	const texts = [...edytor.node!.querySelectorAll('[data-edytor-text]')];
	const at = (node: Node | null) => texts.findIndex((text) => text.contains(node));
	return {
		anchor: [at(selection.anchorNode), selection.anchorOffset],
		focus: [at(selection.focusNode), selection.focusOffset],
		textLeaves:
			selection.anchorNode?.nodeType === Node.TEXT_NODE &&
			selection.focusNode?.nodeType === Node.TEXT_NODE
	};
};

const mount = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>
				<bold>lead</bold>
			</paragraph>
			<paragraph>
				<bold>note</bold>
			</paragraph>
		</root>
	);
	const { edytor } = rendered;
	// jsdom does not focus a contenteditable: a tabindex lets the host hold focus.
	edytor.node!.tabIndex = -1;
	edytor.node!.focus();
	const [first, second] = edytor.root!.children;
	await setNativeSelection(edytor, first!.firstText, 0, second!.firstText, 4);
	expect(range(edytor)).toEqual({ start: 0, end: 4, isCollapsed: false });
	return { ...rendered, first: first!, second: second! };
};

const plain = [[{ text: 'lead' }], [{ text: 'note' }]];

describe('a display held back by the user-input window runs when it closes', () => {
	it('marks removed under a range inside a window that outlives every flush: 0 → 4 is displayed at its end', async () => {
		const { edytor, first, second } = await mount();
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		// An occurrence's handler that is still running (awaited work) when its
		// render's flushes have all landed.
		void edytor.userInput(async () => {
			first.firstText!.removeMarksFromText({ start: 0, end: 4 });
			second.firstText!.removeMarksFromText({ start: 0, end: 4 });
			await held;
		});
		await flushDomUpdates();
		expect(edytor.value.children.map((block) => block.content)).toEqual(plain);
		release();
		await flushDomUpdates();
		expect(domEnds(edytor)).toEqual({ anchor: [0, 0], focus: [1, 4], textLeaves: true });

		// The browser reports the range the render left: it shows the value, an echo.
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toEqual({ start: 0, end: 4, isCollapsed: false });
	});

	it('formatRemove over a range across two blocks: the DOM range and the value stay 0 → 4', async () => {
		const { edytor, editor } = await mount();
		await dispatchDomBeforeInput(editor, { inputType: 'formatRemove' });
		expect(edytor.value.children.map((block) => block.content)).toEqual(plain);
		expect(domEnds(edytor)).toEqual({ anchor: [0, 0], focus: [1, 4], textLeaves: true });
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toEqual({ start: 0, end: 4, isCollapsed: false });
	});
});
