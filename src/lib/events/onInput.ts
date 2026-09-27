import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { diffText } from '$lib/utils/diffText.js';
import type { Text } from '$lib/text/text.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { isInsideTrailingNewlineMarker } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { replaceSelectionWithCollapsedTarget } from '$lib/selection/replaceSelection.js';
import {
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';
import { getTextContentOffsetAtPoint } from './domTextOffset.js';
import { runOccurrence } from './onBeforeInput.js';
import {
	attemptOf,
	kindOf,
	type Attempt,
	type Expect,
	type TextPoint
} from '$lib/session/attempt.js';

const ZERO_WIDTH_SPACE = '\u200B';

const isCompositionCommitInputEvent = (event: Event) =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	!event.isComposing &&
	(event.inputType === 'insertText' ||
		event.inputType === 'insertCompositionText' ||
		event.inputType === 'insertFromComposition');

const isNativeLineBreakTextInput = (event: Event) =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	(event.inputType === 'insertText' || kindOf(event.inputType) === 'break');

const isTextInsertionInput = (event: Event): event is InputEvent =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	event.inputType === 'insertText' &&
	typeof event.data === 'string' &&
	event.data.length > 0;

const isNativeHistoryInput = (event: Event): event is InputEvent =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	kindOf(event.inputType) === 'history';

const runInputHistoryCommand = (edytor: Edytor, event: InputEvent) =>
	event.inputType === 'historyUndo' ? edytor.historyUndo() : edytor.historyRedo();

export const getNormalizedDomText = (text: Text) => {
	let value = text.node?.textContent ?? '';

	if (value === ZERO_WIDTH_SPACE) {
		return '';
	}

	if ((text.isEmpty || text.endsWithNewline) && value.endsWith(ZERO_WIDTH_SPACE)) {
		value = value.slice(0, -ZERO_WIDTH_SPACE.length);
	}

	return value;
};

const isLiveText = (text: Text) => text.isInDocument;

const getDomOffsetWithinText = (text: Text, node: Node, offset: number) => {
	if (!text.node) {
		return 0;
	}

	if (text.endsWithNewline && isInsideTrailingNewlineMarker(node)) {
		return text.length;
	}

	// No model-length clamp here — the DOM caret is read BEFORE the
	// reconcile writes the model, so a native insertion legitimately sits
	// past the current `text.length` (the trailing-newline marker case is
	// handled above; `setAtTextOffset` clamps the final write).
	return getTextContentOffsetAtPoint(text.node, node, offset);
};

export const getCollapsedDomTextSelection = (edytor: Edytor) => {
	const selection = getDomSelectionSnapshot(edytor.node);
	if (!selection?.anchorNode || !selection.isCollapsed) {
		return null;
	}

	if (!edytor.container?.contains(selection.anchorNode)) {
		return null;
	}

	const text = edytor.selection.getTextOfNode(selection.anchorNode);
	if (!text?.node) {
		return null;
	}

	return {
		text,
		offset: getDomOffsetWithinText(text, selection.anchorNode, selection.anchorOffset)
	};
};

const getEventTextRepairTarget = (edytor: Edytor, event: Event) => {
	const target = event.target instanceof Node ? event.target : null;
	const text = edytor.selection.getTextOfNode(target);
	if (!text?.node) {
		return null;
	}

	return {
		text,
		offset: edytor.selection.state.startText === text ? edytor.selection.state.yStart : text.length
	};
};

const getInputType = (event: Event) => {
	const inputType = (event as InputEvent).inputType;
	return typeof inputType === 'string' ? inputType : '';
};

const waitForSuppressedObservedMutationRepair = () =>
	new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Where drift repair puts the caret: the command's caret, else the model
 * caret (a restore, or a line break), else the DOM caret; the event's text last.
 */
const driftRepairTarget = (
	edytor: Edytor,
	event: Event,
	repair: boolean,
	caret: TextPoint | null
) => {
	const { startText, yStart } = edytor.selection.state;
	const model = startText ? { text: startText, offset: yStart } : null;
	const preferModel = repair || kindOf(getInputType(event)) === 'break';
	return (
		(repair && caret) ||
		(preferModel ? model : getCollapsedDomTextSelection(edytor)) ||
		getEventTextRepairTarget(edytor, event)
	);
};

export const removeUnmanagedLineBreaks = (text: Text) => {
	text.node?.querySelectorAll('br').forEach((lineBreak) => {
		lineBreak.remove();
	});
};

const getNativeLineBreakInsertionIndexFromValue = (text: Text, value: string) => {
	const change = diffText(text.stringContent, value);
	return change && !change.remove && /^[\r\n]+$/.test(change.insert) ? change.at : null;
};

export const handleNativeLineBreakTextValue = async (edytor: Edytor, text: Text, value: string) => {
	if (!isLiveText(text)) {
		return false;
	}

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
	removeUnmanagedLineBreaks(text);
	await tick();
	await edytor.selection.setAtTextOffset(text, insertionIndex);
	await runOccurrence(edytor, { inputType, cancelable: false });
	return true;
};

export const handleNativeLineBreakTextMutation = async (edytor: Edytor, text: Text) =>
	handleNativeLineBreakTextValue(edytor, text, getNormalizedDomText(text));

const handleNativeLineBreakTextInput = async (edytor: Edytor, event: Event) => {
	if (!isNativeLineBreakTextInput(event)) {
		return false;
	}

	const target = getCollapsedDomTextSelection(edytor) ?? getEventTextRepairTarget(edytor, event);
	return target ? handleNativeLineBreakTextMutation(edytor, target.text) : false;
};

const getExpandedSelectionInputText = (edytor: Edytor, event: Event) =>
	!edytor.readonly &&
	!edytor.isComposing &&
	isTextInsertionInput(event) &&
	!edytor.selection.state.isCollapsed &&
	edytor.selection.selectedBlocks.size === 0
		? event.data
		: null;

const replaceExpandedSelectionFromInputOnlyText = async (edytor: Edytor, value: string) => {
	const target = await replaceSelectionWithCollapsedTarget(edytor);
	if (!target) {
		return false;
	}

	target.text.insertText({
		value,
		start: target.offset,
		end: target.offset
	});
	target.text.refreshFromModel();
	await tick();
	scheduleRemoveStalePlaceholders(target.text);
	await edytor.selection.setAtTextOffset(target.text, target.offset + value.length);
	return true;
};

/** Drift around a model-owned attempt: re-render its texts from the model and put the caret back. */
const repairDrift = async (
	edytor: Edytor,
	attempt: Attempt,
	expect: Extract<Expect, { kind: 'drift' }>,
	event: Event
) => {
	const repair = expect.mode !== 'refresh';
	if (attempt.isStructuralKeyFallback && attempt.phase === 'open' && !repair) {
		// The key's attempt has not run yet: its deadline performs it.
		expect.input = false;
		edytor.attempts.arm(attempt, 50);
		return;
	}
	if (repair) {
		await tick();
	}
	if (expect.mode === 'discard') {
		await waitForSuppressedObservedMutationRepair();
	}
	expect.input = false;
	if (expect.mode !== 'discard') edytor.attempts.arm(attempt, 0);
	const target = driftRepairTarget(edytor, event, repair, expect.caret);
	if (!target) return;
	const eventTarget = getEventTextRepairTarget(edytor, event);
	if (eventTarget && eventTarget.text !== target.text && isLiveText(eventTarget.text)) {
		eventTarget.text.refreshFromModel();
		removeUnmanagedLineBreaks(eventTarget.text);
	}
	target.text.refreshFromModel();
	removeUnmanagedLineBreaks(target.text);
	await tick();
	// The attempt decided the caret; `select()` it — the projector displays it (V4).
	await edytor.selection.setAtTextOffset(target.text, Math.min(target.offset, target.text.length));
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
 * An `input` event. Model-owned drift is repaired here; browser-made text is
 * never adopted here: the mutation queue is the only adopter (R8, L31), so
 * the `input` flushes it — a browser-owned attempt's change is adopted there,
 * once, through the dispatcher — then closes the attempt it belongs to.
 */
export async function onInput(this: Edytor, event: Event) {
	// The attempt this `input` belongs to: the newest whose expectation it satisfies.
	let attempt = this.attempts.inputOf(getInputType(event));
	const expect = attempt?.expect;
	if (attempt && expect?.kind === 'drift') {
		return repairDrift(this, attempt, expect, event);
	}

	try {
		if (
			isNativeInteractiveEvent(event) ||
			(event && isNestedForeignEditableTarget(this.node, event.target))
		) {
			return;
		}

		if (isNativeHistoryInput(event)) {
			// Same guard as the beforeinput channel — a history command
			// mid-composition consumes capture groups while the IME still
			// owns the DOM node (engines that deliver history via `input`
			// only would otherwise bypass the beforeinput swallow).
			if (!this.isComposing) runInputHistoryCommand(this, event);
			return;
		}

		attempt ??= claimOf(this, event);
		if (this.isComposing && isCompositionCommitInputEvent(event)) {
			this.compositionState = null;
			this.isComposing = false;
			this.hasHandledCompositionInput = false;
		}

		if (await handleNativeLineBreakTextInput(this, event)) {
			return;
		}

		const expandedSelectionInputText = getExpandedSelectionInputText(this, event);
		if (expandedSelectionInputText) {
			if (await replaceExpandedSelectionFromInputOnlyText(this, expandedSelectionInputText)) {
				return;
			}
		}

		await this.observer?.flushNow();
	} finally {
		if (attempt) this.attempts.close(attempt);
	}
}
