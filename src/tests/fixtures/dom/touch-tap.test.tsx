/** @jsxImportSource ../../jsx */
/**
 * A touch press leaves its caret and its word to the platform
 * (`sel.press.touch`): a text never re-places a tap's caret at the pointer.
 * iOS selects the word at a double tap's second tap and sends that tap's
 * click with `detail` 1 (it counts taps one by one): re-placing it collapsed
 * the word. iOS also puts a single tap's caret at the word's edge, its own
 * convention. A mouse click still places the caret at the pointer.
 *
 * Expected values come from the rule, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** A press, release or click from `pointerType` at the text's top-left corner. */
const pointer = (type: string, node: Element, pointerType: 'touch' | 'mouse') => {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		clientX: 1,
		clientY: 1,
		detail: type === 'click' ? 1 : 0
	});
	Object.defineProperty(event, 'pointerType', { value: pointerType });
	node.dispatchEvent(event);
};

/** The browser selects `from`–`to` of the first text node (iOS's word at a double tap). */
const nativeRange = (element: Element, from: number, to: number) => {
	const node = [...element.childNodes].find((child) => child.nodeType === Node.TEXT_NODE)!;
	window.getSelection()!.setBaseAndExtent(node, from, node, to);
	document.dispatchEvent(new Event('selectionchange'));
};

const range = (edytor: Edytor) => {
	const { start, end, isCollapsed } = edytor.selection.projection;
	return { start: start?.offset, end: end?.offset, isCollapsed };
};

/** A tap or a click on `alpha bravo charlie` after the browser selected `bravo`. */
const run = async (pointerType: 'touch' | 'mouse') => {
	const { edytor } = await renderDomEdytor(
		<root>
			<paragraph>alpha bravo charlie</paragraph>
		</root>
	);
	const element = edytor.root!.children[0]!.firstText!.node!;
	pointer('pointerdown', element, pointerType);
	nativeRange(element, 6, 11);
	await flushDomUpdates();
	pointer('pointerup', element, pointerType);
	pointer('click', element, pointerType);
	await flushDomUpdates();
	return range(edytor);
};

describe('sel.press.touch — a touch press leaves its selection to the platform', () => {
	it("a double tap's word stays selected after its second tap's click", async () => {
		expect(await run('touch')).toEqual({ start: 6, end: 11, isCollapsed: false });
	});

	it('a mouse click still places the caret at the pointer', async () => {
		expect((await run('mouse')).isCollapsed).toBe(true);
	});
});
