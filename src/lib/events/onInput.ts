import type { Edytor } from '../edytor.svelte.js';
import { isControlEvent } from './nativeInteractiveControl.js';
import { attemptOf, kindOf } from '$lib/session/attempt.js';
import { getCollapsedDomTextSelection } from '$lib/surface/observer.svelte.js';

const getInputType = (event: Event) => {
	const inputType = (event as InputEvent).inputType;
	return typeof inputType === 'string' ? inputType : '';
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
