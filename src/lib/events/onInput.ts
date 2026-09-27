import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { diffText } from '$lib/utils/diffText.js';
import type { SerializableContent } from '$lib/utils/json.js';
import type { Text } from '$lib/text/text.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { isInsideTrailingNewlineMarker } from '$lib/selection/selection.utils.js';
import { activeMarks, marksForInsertion } from '$lib/session/editing/text.js';
import { jsonValuesEqual } from '$lib/collaboration/awarenessSelection.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { replaceSelectionWithCollapsedTarget } from '$lib/selection/replaceSelection.js';
import {
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';
import { runHistoryCommand } from './undoRestore.js';
import { getTextContentOffsetAtPoint } from './domTextOffset.js';
import { getTextPath } from './events.utils.js';
import { runOccurrence } from './onBeforeInput.js';
import { kindOf, type Attempt, type Expect, type TextPoint } from '$lib/session/attempt.js';

const ZERO_WIDTH_SPACE = '\u200B';

type PlannedDiffOperation =
	| { type: 'delete'; index: number; length: number }
	| {
			type: 'insert';
			index: number;
			value: string;
			marks?: Record<string, SerializableContent>;
	  };

const isComposingInputEvent = (event: Event) =>
	typeof InputEvent !== 'undefined' && event instanceof InputEvent && event.isComposing;

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
	runHistoryCommand(edytor, event.inputType === 'historyUndo' ? 'undo' : 'redo');

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

export const isLiveText = (text: Text) => text.isInDocument;

const queueBrowserOwnedInputSelectionSnapshot = (edytor: Edytor, text: Text, offset: number) => {
	const textPath = getTextPath(text);
	edytor.selection.queueNextUndoSelectionSnapshot({
		isCollapsed: true,
		isReversed: false,
		startTextId: text.id,
		endTextId: text.id,
		startTextPath: textPath,
		endTextPath: textPath,
		yStart: offset,
		yEnd: offset,
		selectedBlockIds: [],
		selectedBlockPaths: []
	});
};

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

const removeUnmanagedLineBreaks = (text: Text) => {
	text.node?.querySelectorAll('br').forEach((lineBreak) => {
		lineBreak.remove();
	});
};

/** The marks of a native deletion's removed runs when they are all the same (kept pending). */
const getPendingMarksForDeletionOnlyDiff = (text: Text, operations: PlannedDiffOperation[]) => {
	const parts = operations.flatMap((operation) =>
		operation.type === 'delete'
			? text.getMarksAtRange(operation.index, operation.index + operation.length)
			: [{ text: '' }]
	);
	const marks = activeMarks(parts[0]?.marks);
	return Object.keys(marks).length > 0 &&
		parts.every((part) => jsonValuesEqual(activeMarks(part.marks), marks))
		? marks
		: undefined;
};

const planDomTextDiff = (text: Text, modelText: string, domText: string) => {
	const operations: PlannedDiffOperation[] = [];
	let index = 0;

	for (const operation of diffText(modelText, domText)) {
		if (operation.retain) {
			index += operation.retain;
		}

		if (operation.delete) {
			operations.push({
				type: 'delete',
				index,
				length: operation.delete
			});
		}

		if (operation.insert) {
			operations.push({
				type: 'insert',
				index,
				value: operation.insert,
				marks: marksForInsertion(text, index, { pending: text.markOnNextInsert })
			});
			index += operation.insert.length;
		}
	}

	return operations;
};

const getCaretOffsetAfterTextDiff = (
	valueBeforeInput: string,
	valueAfterInput: string,
	fallbackOffset: number
) => {
	let index = 0;
	let changedOffset: number | null = null;

	for (const operation of diffText(valueBeforeInput, valueAfterInput)) {
		if (operation.retain) {
			index += operation.retain;
		}

		if (operation.delete) {
			changedOffset = index;
		}

		if (operation.insert) {
			changedOffset = index + operation.insert.length;
			index += operation.insert.length;
		}
	}

	return changedOffset ?? fallbackOffset;
};

const getNativeLineBreakInsertionIndexFromValue = (text: Text, value: string) => {
	const operations = planDomTextDiff(text, text.stringContent, value);
	if (operations.length !== 1) {
		return null;
	}

	const operation = operations[0];
	if (operation.type !== 'insert' || !/^[\r\n]+$/.test(operation.value)) {
		return null;
	}

	return operation.index;
};

const getNativeLineBreakInsertionIndex = (text: Text) =>
	getNativeLineBreakInsertionIndexFromValue(text, getNormalizedDomText(text));

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

const applyDomTextDiff = (text: Text, domText: string) => {
	const operations = planDomTextDiff(text, text.stringContent, domText);
	if (operations.length === 0) {
		return false;
	}

	const pendingMarksAfterDeletion = getPendingMarksForDeletionOnlyDiff(text, operations);
	const shouldClearPendingMarks =
		Boolean(text.markOnNextInsert) && operations.some((operation) => operation.type === 'insert');

	text.edytor.transact(() => {
		for (const operation of operations) {
			if (operation.type === 'delete') {
				const length = Math.min(operation.length, text.length - operation.index);
				if (length > 0) {
					text.deleteAt(operation.index, length);
				}
				continue;
			}

			if (operation.value.length > 0) {
				text.insertAt(operation.index, operation.value, operation.marks);
			}
		}
	});

	if (shouldClearPendingMarks) {
		text.markOnNextInsert = undefined;
	}

	if (pendingMarksAfterDeletion) {
		text.markOnNextInsert = pendingMarksAfterDeletion;
	}

	return true;
};

const insertNativeMentionTrigger = async (edytor: Edytor, text: Text, value: string) => {
	if (!edytor.inlineBlocks.has('mention')) {
		return false;
	}

	const operations = planDomTextDiff(text, text.stringContent, value);
	if (operations.length !== 1 || operations[0].type !== 'insert' || operations[0].value !== '@') {
		return false;
	}

	text.refreshFromModel();
	removeUnmanagedLineBreaks(text);
	await tick();

	const trailingText = text.parent.addInlineBlock({
		index: operations[0].index,
		block: {
			type: 'mention',
			data: {}
		},
		text
	});
	await tick();
	scheduleRemoveStalePlaceholders(text);
	const liveTrailingText = edytor.getTextById(trailingText.id) ?? trailingText;
	await edytor.selection.setAtTextOffset(liveTrailingText, 0);
	return true;
};

export const reconcileTextValue = async (
	edytor: Edytor,
	text: Text,
	value: string,
	selectionOffset?: number
) => {
	if (!isLiveText(text)) {
		return false;
	}

	if (await insertNativeMentionTrigger(edytor, text, value)) {
		return true;
	}

	const caretOffset =
		typeof selectionOffset === 'number' ? Math.min(selectionOffset, value.length) : undefined;
	if (!applyDomTextDiff(text, value)) {
		scheduleRemoveStalePlaceholders(text);
		return false;
	}
	edytor.attempts.adopted(text);

	text.syncFromModel();
	await tick();
	scheduleRemoveStalePlaceholders(text);

	if (typeof caretOffset === 'number') {
		await edytor.selection.setAtTextOffset(text, caretOffset);
	}

	return true;
};

export const reconcileDomText = async (edytor: Edytor, text: Text, selectionOffset?: number) =>
	reconcileTextValue(edytor, text, getNormalizedDomText(text), selectionOffset);

export const reconcileFocusedDomText = async (edytor: Edytor, event?: Event) => {
	if (
		edytor.readonly ||
		edytor.isComposing ||
		(event &&
			(isComposingInputEvent(event) ||
				isNativeInteractiveEvent(event) ||
				isNestedForeignEditableTarget(edytor.node, event.target)))
	) {
		return false;
	}

	const target = getCollapsedDomTextSelection(edytor);
	if (!target) {
		return false;
	}

	return reconcileDomText(edytor, target.text, target.offset);
};

const getExpandedSelectionInputText = (edytor: Edytor, event: Event) => {
	if (
		edytor.readonly ||
		edytor.isComposing ||
		!isTextInsertionInput(event) ||
		edytor.selection.state.isCollapsed ||
		edytor.selection.selectedBlocks.size > 0
	) {
		return null;
	}

	const value = event.data;
	if (value) {
		return value;
	}

	const { startText, endText } = edytor.selection.state;
	if (!startText || startText !== endText) {
		return null;
	}

	const insertedText = diffText(startText.stringContent, getNormalizedDomText(startText))
		.map((operation) => operation.insert ?? '')
		.join('');
	return insertedText || null;
};

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

const notifyBrowserOwnedTextInsertions = (
	edytor: Edytor,
	text: Text,
	operations: PlannedDiffOperation[]
) => {
	for (const operation of operations) {
		if (operation.type !== 'insert' || operation.value.length === 0) {
			continue;
		}

		edytor.plugins.forEach((plugin) => {
			plugin.onAfterOperation?.({
				operation: 'insertText',
				text,
				block: text.parent,
				payload: {
					value: operation.value,
					start: operation.index,
					end: operation.index
				}
			});
		});
	}
};

/** Adopt the change a browser-owned attempt expected on its host. */
const reconcileBrowserOwnedInputTarget = async (
	edytor: Edytor,
	attempt: Attempt,
	expect: Extract<Expect, { kind: 'change' }>,
	event: Event
) => {
	const { host } = expect;
	if (!isLiveText(host)) {
		return false;
	}

	if (kindOf(getInputType(event)) === 'delete' || kindOf(attempt.inputType) === 'delete') {
		edytor.dispatcher.cut('deleteContent');
	}

	// A model-owned attempt's drift on the same host is not this attempt's
	// change: adopt what this attempt expected, and re-render the rest.
	const dom = getNormalizedDomText(host);
	const drifted = expect.after !== null && dom !== expect.after && edytor.attempts.drifting(host);
	const domText = drifted ? expect.after! : dom;
	const nativeSelection = getCollapsedDomTextSelection(edytor);
	const selectionOffset =
		!drifted && nativeSelection?.text === host
			? nativeSelection.offset
			: getCaretOffsetAfterTextDiff(expect.before, domText, expect.caret);
	const operations = planDomTextDiff(host, host.stringContent, domText);

	queueBrowserOwnedInputSelectionSnapshot(edytor, host, expect.historyCaret ?? selectionOffset);
	const didReconcile = await reconcileTextValue(edytor, host, domText, selectionOffset);
	if (!didReconcile) {
		edytor.selection.nextUndoSelectionSnapshot = null;
		if (host.stringContent !== domText) {
			return false;
		}
	}
	if (drifted) host.refreshFromModel();
	attempt.phase = 'applied';

	await edytor.selection.setAtTextOffset(host, Math.min(selectionOffset, host.length));
	notifyBrowserOwnedTextInsertions(edytor, host, operations);
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
	const offset = Math.min(target.offset, target.text.length);
	await edytor.selection.setAtTextOffset(target.text, offset);
	if (repair) {
		edytor.selection.ignoreNextSelectionChange = true;
		setTimeout(() => {
			if (!isLiveText(target.text)) {
				return;
			}
			edytor.selection.ignoreNextSelectionChange = true;
			void edytor.selection.setAtTextOffset(target.text, offset);
		}, 30);
	}
};

export async function onInput(this: Edytor, event: Event) {
	// The attempt this `input` belongs to: the newest whose expectation it satisfies.
	const attempt = this.attempts.inputOf(getInputType(event));
	const expect = attempt?.expect;
	if (attempt && expect?.kind === 'drift') {
		return repairDrift(this, attempt, expect, event);
	}
	if (attempt) this.attempts.close(attempt);

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
		if (this.isComposing) {
			return;
		}
		await runInputHistoryCommand(this, event);
		return;
	}

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

	if (
		attempt &&
		expect?.kind === 'change' &&
		(await reconcileBrowserOwnedInputTarget(this, attempt, expect, event))
	) {
		return;
	}

	await reconcileFocusedDomText(this, event);
}
