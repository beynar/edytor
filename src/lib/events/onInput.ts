import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { diffText } from '$lib/utils/diffText.js';
import type { SerializableContent } from '$lib/utils/json.js';
import type { Text } from '$lib/text/text.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { isInsideTrailingNewlineMarker } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { replaceSelectionWithCollapsedTarget } from '$lib/selection/replaceSelection.js';
import {
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';
import { runHistoryCommand } from './undoRestore.js';
import { getTextContentOffsetAtPoint } from './domTextOffset.js';
import { getTextPath } from './events.utils.js';

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
	(event.inputType === 'insertText' ||
		event.inputType === 'insertParagraph' ||
		event.inputType === 'insertLineBreak');

const isTextInsertionInput = (event: Event): event is InputEvent =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	event.inputType === 'insertText' &&
	typeof event.data === 'string' &&
	event.data.length > 0;

const isNativeHistoryInput = (event: Event): event is InputEvent =>
	typeof InputEvent !== 'undefined' &&
	event instanceof InputEvent &&
	(event.inputType === 'historyUndo' || event.inputType === 'historyRedo');

const runInputHistoryCommand = (edytor: Edytor, event: InputEvent) =>
	runHistoryCommand(edytor, event.inputType === 'historyUndo' ? 'undo' : 'redo');

const getNormalizedDomText = (text: Text) => {
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

const queueBrowserOwnedInputSelectionSnapshot = (
	edytor: Edytor,
	target: NonNullable<Edytor['browserOwnedInputTarget']>
) => {
	const textPath = getTextPath(target.text);
	edytor.selection.queueNextUndoSelectionSnapshot({
		isCollapsed: true,
		isReversed: false,
		startTextId: target.text.id,
		endTextId: target.text.id,
		startTextPath: textPath,
		endTextPath: textPath,
		yStart: target.historyOffset ?? target.offset,
		yEnd: target.historyOffset ?? target.offset,
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

const isDeleteInputType = (inputType: string) => inputType.startsWith('delete');

const isBrowserOwnedTextInputType = (inputType: string) =>
	inputType === 'insertText' || inputType === 'insertReplacementText';

const isCompatibleBrowserOwnedInputType = (
	target: NonNullable<Edytor['browserOwnedInputTarget']>,
	inputType: string
) =>
	!inputType ||
	inputType === target.inputType ||
	(isBrowserOwnedTextInputType(inputType) && isBrowserOwnedTextInputType(target.inputType));

const shouldPreserveModelSelectionDuringRepair = (event: Event) => {
	const inputType = getInputType(event);
	return inputType === 'insertParagraph' || inputType === 'insertLineBreak';
};

const waitForSuppressedObservedMutationRepair = () =>
	new Promise((resolve) => setTimeout(resolve, 20));

const getModelSelectionRepairTarget = (edytor: Edytor) => {
	const text = edytor.selection.state.startText;
	if (!text) {
		return null;
	}

	return {
		text,
		offset: edytor.selection.state.yStart
	};
};

const getSuppressedInputRepairTarget = (
	edytor: Edytor,
	event: Event,
	preserveModelSelection = false
) => {
	if (preserveModelSelection || shouldPreserveModelSelectionDuringRepair(event)) {
		return getModelSelectionRepairTarget(edytor) ?? getEventTextRepairTarget(edytor, event);
	}

	return getCollapsedDomTextSelection(edytor) ?? getEventTextRepairTarget(edytor, event);
};

const removeUnmanagedLineBreaks = (text: Text) => {
	text.node?.querySelectorAll('br').forEach((lineBreak) => {
		lineBreak.remove();
	});
};

const withoutNullMarks = (marks?: Record<string, SerializableContent | null>) => {
	if (!marks) {
		return undefined;
	}

	const activeMarks = Object.entries(marks).filter(
		(entry): entry is [string, SerializableContent] => entry[1] !== null
	);
	return activeMarks.length ? Object.fromEntries(activeMarks) : undefined;
};

const getMarksForInsertion = (text: Text, index: number) => {
	if (text.markOnNextInsert) {
		return withoutNullMarks(text.markOnNextInsert);
	}

	const before = index > 0 ? text.getMarksAtRange(index - 1, index)[0]?.marks : undefined;
	if (before && Object.keys(before).length > 0) {
		return before;
	}

	const after = index < text.length ? text.getMarksAtRange(index, index + 1)[0]?.marks : undefined;
	if (after && Object.keys(after).length > 0) {
		return after;
	}

	return undefined;
};

const haveSameMarks = (
	left: Record<string, SerializableContent>,
	right: Record<string, SerializableContent>
) => {
	const leftEntries = Object.entries(left);
	if (leftEntries.length !== Object.keys(right).length) {
		return false;
	}

	return leftEntries.every(([key, value]) => right[key] === value);
};

const getUniformMarksForDeletedRange = (text: Text, index: number, length: number) => {
	let uniformMarks: Record<string, SerializableContent> | undefined;

	for (const part of text.getMarksAtRange(index, index + length)) {
		const marks = withoutNullMarks(part.marks);
		if (!marks) {
			return undefined;
		}

		if (!uniformMarks) {
			uniformMarks = marks;
			continue;
		}

		if (!haveSameMarks(uniformMarks, marks)) {
			return undefined;
		}
	}

	return uniformMarks;
};

const getPendingMarksForDeletionOnlyDiff = (text: Text, operations: PlannedDiffOperation[]) => {
	let pendingMarks: Record<string, SerializableContent> | undefined;

	for (const operation of operations) {
		if (operation.type !== 'delete') {
			return undefined;
		}

		const marks = getUniformMarksForDeletedRange(text, operation.index, operation.length);
		if (!marks) {
			return undefined;
		}

		if (!pendingMarks) {
			pendingMarks = marks;
			continue;
		}

		if (!haveSameMarks(pendingMarks, marks)) {
			return undefined;
		}
	}

	return pendingMarks;
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
				marks: getMarksForInsertion(text, index)
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

const createSyntheticStructuralInput = (inputType: InputEvent['inputType']) => {
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable: false
	}) as InputEvent;
	Object.defineProperties(event, {
		inputType: {
			value: inputType,
			configurable: true
		},
		data: {
			value: null,
			configurable: true
		},
		dataTransfer: {
			value: null,
			configurable: true
		},
		getTargetRanges: {
			value: () => [],
			configurable: true
		}
	});
	return event;
};

export const handleNativeLineBreakTextValue = async (edytor: Edytor, text: Text, value: string) => {
	if (!isLiveText(text)) {
		return false;
	}

	const insertionIndex = getNativeLineBreakInsertionIndexFromValue(text, value);
	if (insertionIndex === null) {
		return false;
	}

	const inputType =
		edytor.structuralKeyFallbackInputType === 'insertLineBreak' || value.includes('\n')
			? 'insertLineBreak'
			: 'insertParagraph';

	edytor.cancelStructuralKeyFallback();
	text.refreshFromModel();
	removeUnmanagedLineBreaks(text);
	await tick();
	await edytor.selection.setAtTextOffset(text, insertionIndex);
	await edytor.onBeforeInput(createSyntheticStructuralInput(inputType));
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

const reconcileBrowserOwnedInputTarget = async (
	edytor: Edytor,
	target: NonNullable<Edytor['browserOwnedInputTarget']>,
	event: Event
) => {
	const inputType = getInputType(event);
	if (!isCompatibleBrowserOwnedInputType(target, inputType)) {
		return false;
	}

	if (!isLiveText(target.text)) {
		return false;
	}

	if (isDeleteInputType(inputType) || isDeleteInputType(target.inputType)) {
		edytor.dispatcher.cut('deleteContent');
	}

	const domText = getNormalizedDomText(target.text);
	const nativeSelection = getCollapsedDomTextSelection(edytor);
	const selectionOffset =
		nativeSelection?.text === target.text
			? nativeSelection.offset
			: getCaretOffsetAfterTextDiff(target.valueBeforeInput, domText, target.offset);
	const operations = planDomTextDiff(target.text, target.text.stringContent, domText);

	queueBrowserOwnedInputSelectionSnapshot(edytor, {
		...target,
		offset: selectionOffset
	});
	const didReconcile = await reconcileTextValue(edytor, target.text, domText, selectionOffset);
	if (!didReconcile) {
		edytor.selection.nextUndoSelectionSnapshot = null;
		if (target.text.stringContent !== domText) {
			return false;
		}
	}

	await edytor.selection.setAtTextOffset(
		target.text,
		Math.min(selectionOffset, target.text.length)
	);
	notifyBrowserOwnedTextInsertions(edytor, target.text, operations);
	return true;
};

export async function onInput(this: Edytor, event: Event) {
	if (this.shouldSuppressNextInputFallback) {
		const shouldRepair = this.shouldRepairSuppressedInputFallback;
		const hasPendingStructuralKeyFallback = Boolean(this.structuralKeyFallbackInputType);
		const shouldRefreshFromModel = !shouldRepair;
		const shouldFlushObservedMutations = this.shouldFlushSuppressedObservedMutationFallback;
		const shouldPreserveModelSelection = shouldRepair || shouldFlushObservedMutations;
		if (hasPendingStructuralKeyFallback && !shouldRepair) {
			this.consumeNextInputFallbackSuppression();
			this.suppressObservedMutationFallback(50);
			return;
		}
		if (shouldPreserveModelSelection) {
			await tick();
		}
		if (shouldFlushObservedMutations) {
			await waitForSuppressedObservedMutationRepair();
		}
		const explicitRepairTarget = this.consumeNextInputFallbackSuppression();
		const target =
			explicitRepairTarget && shouldPreserveModelSelection
				? explicitRepairTarget
				: shouldRepair || shouldRefreshFromModel
					? getSuppressedInputRepairTarget(this, event, shouldPreserveModelSelection)
					: null;
		if (target) {
			const eventTarget = getEventTextRepairTarget(this, event);
			if (eventTarget && eventTarget.text !== target.text && isLiveText(eventTarget.text)) {
				eventTarget.text.refreshFromModel();
				removeUnmanagedLineBreaks(eventTarget.text);
			}
			target.text.refreshFromModel();
			removeUnmanagedLineBreaks(target.text);
			await tick();
			const offset = Math.min(target.offset, target.text.length);
			await this.selection.setAtTextOffset(target.text, offset);
			if (shouldPreserveModelSelection) {
				this.selection.ignoreNextSelectionChange = true;
				setTimeout(() => {
					if (!isLiveText(target.text)) {
						return;
					}
					this.selection.ignoreNextSelectionChange = true;
					void this.selection.setAtTextOffset(target.text, offset);
				}, 30);
			}
		}
		return;
	}

	if (
		isNativeInteractiveEvent(event) ||
		(event && isNestedForeignEditableTarget(this.node, event.target))
	) {
		this.browserOwnedInputTarget = null;
		return;
	}

	if (isNativeHistoryInput(event)) {
		this.browserOwnedInputTarget = null;
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

	const browserOwnedInputTarget = this.browserOwnedInputTarget;
	this.browserOwnedInputTarget = null;

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
		browserOwnedInputTarget &&
		(await reconcileBrowserOwnedInputTarget(this, browserOwnedInputTarget, event))
	) {
		return;
	}

	await reconcileFocusedDomText(this, event);
}
