import type { Edytor } from '../edytor.svelte.js';
import { diffText } from '$lib/utils/diffText.js';
import type { Text } from '$lib/text/text.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { domOffsetIn } from '$lib/selection/selection.utils.js';
import { isControlEvent } from './nativeInteractiveControl.js';
import { runOccurrence } from './onBeforeInput.js';
import { attemptOf, kindOf } from '$lib/session/attempt.js';

const ZERO_WIDTH_SPACE = '\u200B';

/**
 * What the browser shows for `text`: its element's text nodes in order (WebKit's
 * converted-space wrappers read as plain spaces), the empty filler and the
 * trailing-newline marker stripped.
 */
export const readDomText = (text: Text) => {
	let value = '';
	const node = text.node;
	if (node) {
		const walker = (node.ownerDocument ?? document).createTreeWalker(node, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const leaf = walker.currentNode as globalThis.Text;
			value += leaf.parentElement?.closest('span.Apple-converted-space')
				? leaf.data.replaceAll('\u00A0', ' ')
				: leaf.data;
		}
	}

	// An empty text's filler shares its node with what the browser typed, on either side.
	if (text.isEmpty) return value.replaceAll(ZERO_WIDTH_SPACE, '');

	if (text.endsWithNewline && value.endsWith(ZERO_WIDTH_SPACE)) {
		value = value.slice(0, -ZERO_WIDTH_SPACE.length);
	}

	return value;
};

export const getCollapsedDomTextSelection = (edytor: Edytor) => {
	const selection = getDomSelectionSnapshot(edytor.node);
	if (!selection?.anchorNode || !selection.isCollapsed) {
		return null;
	}

	if (!edytor.node?.contains(selection.anchorNode)) {
		return null;
	}

	const text = edytor.selection.getTextOfNode(selection.anchorNode);
	if (!text?.node) {
		return null;
	}

	// No model rule here: the DOM caret is read BEFORE the reconcile writes
	// the model, so a native insertion legitimately sits past `text.length`
	// (`setAtTextOffset` clamps the final write).
	return { text, offset: domOffsetIn(text, selection.anchorNode, selection.anchorOffset) };
};

const getInputType = (event: Event) => {
	const inputType = (event as InputEvent).inputType;
	return typeof inputType === 'string' ? inputType : '';
};

const getNativeLineBreakInsertionIndexFromValue = (text: Text, value: string) => {
	const change = diffText(text.stringContent, value);
	return change && !change.remove && /^[\r\n]+$/.test(change.insert) ? change.at : null;
};

export const handleNativeLineBreakTextValue = async (edytor: Edytor, text: Text, value: string) => {
	if (!text.isInDocument) return false;
	const insertionIndex = getNativeLineBreakInsertionIndexFromValue(text, value);
	if (insertionIndex === null) {
		return false;
	}

	// The native line break is the key's occurrence: its intent, run by the model.
	const inputType =
		edytor.attempts.confirm()?.inputType === 'insertLineBreak' || value.includes('\n')
			? 'insertLineBreak'
			: 'insertParagraph';
	text.refreshFromModel();
	edytor.selection.selectText(text, insertionIndex);
	await runOccurrence(edytor, { inputType, cancelable: false });
	return true;
};

/**
 * An `input` no attempt expected (its engine sent no `beforeinput`): the
 * browser changed the text under its caret — a browser-owned attempt of its own.
 */
const claimOf = (edytor: Edytor, event: Event) => {
	const caret = !edytor.isComposing && getCollapsedDomTextSelection(edytor);
	if (!caret || (event as InputEvent).isComposing) return null;
	const attempt = attemptOf(edytor, { inputType: getInputType(event), cancelable: false });
	return edytor.attempts.admit(attempt, 'browser', {
		kind: 'change',
		host: caret.text,
		after: null
	});
};

/**
 * An `input` event. Browser-made text is never adopted here: the mutation
 * queue is the only adopter (a native line break there runs as its
 * occurrence), so the `input` flushes it — a browser-owned attempt's change
 * is adopted there, once, through the dispatcher — then closes the attempt it
 * belongs to. Drift around a model-owned attempt is the observer's to invert;
 * a restoring attempt (a delete the browser could not be kept from) also
 * re-renders the text the input landed in and shows its caret again, which
 * the browser moved.
 */
export async function onInput(this: Edytor, event: Event) {
	// The live session's own input; a late one of its tail is drift it expects.
	if (this.composition.input(event as InputEvent) === 'live') return;
	const inputType = getInputType(event);
	// The attempt this `input` belongs to: the newest whose expectation it satisfies.
	let attempt = this.attempts.inputOf(inputType);
	const expect = attempt?.expect;
	if (expect?.kind === 'drift') {
		expect.input = false;
		if (expect.mode !== 'restore') return;
		this.attempts.arm(attempt!, 0);
		const { selection } = this;
		const at = expect.caret;
		for (const text of [selection.getTextOfNode(event.target as Node | null), at?.text])
			if (text?.isInDocument) text.refreshFromModel();
		return selection.select(at ? selection.textValue(at.text, at.offset) : selection.value);
	}
	try {
		if (isControlEvent(this.node, event)) return;
		// History an engine delivers by `input` only; mid-composition it would
		// consume capture groups while the IME still owns the DOM node.
		if (kindOf(inputType) === 'history') {
			if (!this.isComposing) this[inputType as 'historyUndo' | 'historyRedo']();
			return;
		}
		attempt ??= claimOf(this, event);
		await this.surface.flush();
	} finally {
		if (attempt) this.attempts.close(attempt);
	}
}
