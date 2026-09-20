import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { prevent, PreventionError } from '$lib/utils.js';
import { Text } from '$lib/text/text.svelte.js';
import {
	createDomRange,
	createDomSelectionSnapshotFromStaticRange,
	getDomSelection
} from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { refreshDomAfterHistoryChange } from '$lib/history/refreshDomAfterHistoryChange.js';
import {
	beginHistoryCommandRestore,
	getHistorySelectionSnapshot,
	restoreCollapsedHistorySelectionState,
	restoreCollapsedHistorySelection
} from '$lib/history/historySelectionSnapshot.js';
import {
	isNativeInteractiveControl,
	isNativeInteractiveEvent
} from './nativeInteractiveControl.js';
import {
	isCompositionInput,
	runBeforeInputCommand,
	runBeforeInputHotkeyBridge,
	shouldRefreshDomAfterModelCommand
} from './beforeInputCommands.js';
import {
	createBeforeInputSnapshot,
	getEffectiveBeforeInputType,
	isTabTextInput,
	type BeforeInputSnapshot
} from './beforeInputSnapshot.js';

const getBeforeInputTargetRange = (event: InputEvent): StaticRange | null => {
	if (typeof event.getTargetRanges !== 'function') {
		return null;
	}

	return event.getTargetRanges()[0] ?? null;
};

const isRangeInsideEditor = (edytor: Edytor, range: StaticRange) =>
	Boolean(
		edytor.node &&
		edytor.node.contains(range.startContainer) &&
		edytor.node.contains(range.endContainer)
	);

type BeforeInputTextTargetRange = {
	startText: Text;
	endText: Text;
	yStart: number;
	yEnd: number;
};

const isDeleteTargetRangeInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteContentBackward' || inputType === 'deleteContentForward';

const isBackwardAdvancedDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteWordBackward' ||
	inputType === 'deleteSoftLineBackward' ||
	inputType === 'deleteHardLineBackward';

const isForwardAdvancedDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteWordForward' ||
	inputType === 'deleteSoftLineForward' ||
	inputType === 'deleteHardLineForward';

const isFragmentDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteByCut' ||
	inputType === 'deleteByDrag' ||
	inputType === 'deleteByComposition';

const isGenericDeleteInput = (inputType: InputEvent['inputType']) => inputType === 'deleteContent';

const isEntireSoftLineDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteEntireSoftLine';

const isModelOwnedDeleteInput = (inputType: InputEvent['inputType']) =>
	isDeleteTargetRangeInput(inputType) ||
	isBackwardAdvancedDeleteInput(inputType) ||
	isForwardAdvancedDeleteInput(inputType) ||
	isFragmentDeleteInput(inputType) ||
	isGenericDeleteInput(inputType) ||
	isEntireSoftLineDeleteInput(inputType);

const isStructuralNativeMutationInput = (inputType: InputEvent['inputType']) =>
	inputType === 'insertParagraph' || inputType === 'insertLineBreak';

const isTextInsertionInput = (inputType: InputEvent['inputType']) =>
	inputType === 'insertText' ||
	inputType === 'insertReplacementText' ||
	inputType === 'insertFromYank' ||
	inputType === 'insertTranspose' ||
	inputType === 'insertCompositionText' ||
	inputType === 'insertFromComposition' ||
	inputType === 'insertFromPaste';

const NATIVE_INPUT_REPAIR_WINDOW_MS = 150;

const isAndroidChromeBrowser = () => {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const userAgent = navigator.userAgent;
	return (
		/Android/i.test(userAgent) &&
		/\bChrome\//i.test(userAgent) &&
		!/(Edg|OPR|SamsungBrowser)/i.test(userAgent)
	);
};

const getBeforeInputTextTargetRange = (
	edytor: Edytor,
	range: StaticRange
): BeforeInputTextTargetRange | null => {
	const startText = edytor.selection.getTextOfNode(range.startContainer);
	const endText = edytor.selection.getTextOfNode(range.endContainer);
	if (!startText || !endText) {
		return null;
	}

	return {
		startText,
		endText,
		yStart: getYIndex(startText, range.startContainer, range.startOffset),
		yEnd: getYIndex(endText, range.endContainer, range.endOffset)
	};
};

const isValidTextLocalRange = ({ startText, endText, yStart, yEnd }: BeforeInputTextTargetRange) =>
	startText === endText && yStart >= 0 && yEnd >= yStart && yEnd <= startText.length;

const isSafeDeleteTargetRange = (
	inputType: InputEvent['inputType'],
	targetTextRange: BeforeInputTextTargetRange
) => {
	if (!isDeleteTargetRangeInput(inputType) || !isValidTextLocalRange(targetTextRange)) {
		return false;
	}

	const { startText, yStart, yEnd } = targetTextRange;
	if (yStart !== yEnd) {
		return true;
	}

	return inputType === 'deleteContentBackward' ? yStart > 0 : yStart < startText.length;
};

const shouldSyncBeforeInputTargetRange = (
	edytor: Edytor,
	event: InputEvent,
	targetRange: StaticRange,
	structuralKeyFallbackInputType: InputEvent['inputType'] | null
) => {
	if (event.inputType.startsWith('history')) {
		return false;
	}

	const effectiveInputType = getEffectiveBeforeInputType(event, structuralKeyFallbackInputType);
	if (
		isTextInsertionInput(effectiveInputType) &&
		edytor.selection.consumeModelSelectionPreservationForTextInsertion()
	) {
		return false;
	}

	if (
		isTextInsertionInput(effectiveInputType) &&
		!edytor.selection.state.isCollapsed &&
		targetRange.collapsed
	) {
		return false;
	}

	if (!isDeleteTargetRangeInput(event.inputType)) {
		return true;
	}

	const targetTextRange = getBeforeInputTextTargetRange(edytor, targetRange);
	return targetTextRange ? isSafeDeleteTargetRange(event.inputType, targetTextRange) : false;
};

const syncSelectionFromBeforeInputTargetRange = (
	edytor: Edytor,
	event: InputEvent,
	structuralKeyFallbackInputType: InputEvent['inputType'] | null
) => {
	const targetRange = getBeforeInputTargetRange(event);
	if (
		!targetRange ||
		!isRangeInsideEditor(edytor, targetRange) ||
		!shouldSyncBeforeInputTargetRange(edytor, event, targetRange, structuralKeyFallbackInputType)
	) {
		return;
	}

	const selection = getDomSelection(edytor.node);

	const liveRange = createDomRange(targetRange.startContainer);
	liveRange.setStart(targetRange.startContainer, targetRange.startOffset);
	liveRange.setEnd(targetRange.endContainer, targetRange.endOffset);
	selection?.removeAllRanges();
	selection?.addRange(liveRange);
	edytor.selection.applySelectionSnapshot(
		createDomSelectionSnapshotFromStaticRange(targetRange, selection)
	);
};

const hasOutsideBeforeInputTargetRange = (edytor: Edytor, event: InputEvent) => {
	const targetRange = getBeforeInputTargetRange(event);
	return Boolean(targetRange && !isRangeInsideEditor(edytor, targetRange));
};

const isBrowserOwnedNativeInput = (edytor: Edytor, event: InputEvent) =>
	isNativeInteractiveEvent(event) &&
	edytor.selection.selectedBlocks.size === 0 &&
	edytor.selection.selectedInlineBlock.size === 0;

const shouldIgnoreBeforeInput = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	edytor.readonly ||
	snapshot.isVoidEditableElement ||
	isBrowserOwnedNativeInput(edytor, snapshot.event) ||
	isNativeInteractiveControl(snapshot.event.target);

const isTextLocalDeletion = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (
		edytor.selection.selectedBlocks.size > 0 ||
		snapshot.isStructuralKeyFallback ||
		snapshot.event.cancelable ||
		(snapshot.inputType !== 'deleteContentBackward' &&
			snapshot.inputType !== 'deleteContentForward') ||
		!snapshot.startText ||
		snapshot.startText !== snapshot.endText ||
		snapshot.isBlockSpanning ||
		snapshot.isTextSpanning
	) {
		return false;
	}

	if (!snapshot.isCollapsed) {
		return true;
	}

	return snapshot.inputType === 'deleteContentBackward'
		? !snapshot.isAtStartOfText
		: !snapshot.isAtEndOfText;
};

const isTextLocalReplacement = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	snapshot.inputType === 'insertReplacementText' &&
	edytor.selection.selectedBlocks.size === 0 &&
	snapshot.isCollapsed &&
	Boolean(snapshot.startText) &&
	snapshot.startText === snapshot.endText &&
	!snapshot.isTextSpanning &&
	!snapshot.isBlockSpanning;

const isNonCancelableInsertText = (snapshot: BeforeInputSnapshot) =>
	!snapshot.event.cancelable && snapshot.inputType === 'insertText';

const isNonCancelableReplacementText = (snapshot: BeforeInputSnapshot) =>
	!snapshot.event.cancelable && snapshot.inputType === 'insertReplacementText';

const isSafeTextLocalInsertion = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	isNonCancelableInsertText(snapshot) &&
	!isTabTextInput(snapshot) &&
	!(snapshot.data === '@' && edytor.inlineBlocks.has('mention')) &&
	edytor.selection.selectedBlocks.size === 0 &&
	snapshot.isCollapsed &&
	Boolean(snapshot.startText) &&
	snapshot.startText === snapshot.endText &&
	!snapshot.isTextSpanning &&
	!snapshot.isBlockSpanning;

const isUnsafeNativeInsertText = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	isNonCancelableInsertText(snapshot) && !isSafeTextLocalInsertion(edytor, snapshot);

const isUnsafeNativeReplacementText = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	isNonCancelableReplacementText(snapshot) && !isTextLocalReplacement(edytor, snapshot);

const isUnsafeNativeTextInsertion = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	isUnsafeNativeInsertText(edytor, snapshot) ||
	isUnsafeNativeReplacementText(edytor, snapshot) ||
	(!snapshot.event.cancelable && snapshot.inputType === 'insertFromPaste');

const shouldLetBrowserHandleBeforeInput = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	(!snapshot.hasDataTransferTextPayload && isTextLocalReplacement(edytor, snapshot)) ||
	snapshot.inputType === 'deleteCompositionText' ||
	isSafeTextLocalInsertion(edytor, snapshot) ||
	isTextLocalDeletion(edytor, snapshot);

const rememberBrowserOwnedInputTarget = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const text = snapshot.startText;
	if (!text || edytor.selection.selectedBlocks.size > 0) {
		edytor.browserOwnedInputTarget = null;
		return;
	}

	if (isSafeTextLocalInsertion(edytor, snapshot)) {
		edytor.browserOwnedInputTarget = {
			text,
			offset: snapshot.yStart + (snapshot.data?.length ?? 0),
			inputType: snapshot.inputType,
			valueBeforeInput: text.stringContent
		};
		return;
	}

	if (isTextLocalReplacement(edytor, snapshot)) {
		edytor.browserOwnedInputTarget = {
			text,
			offset: snapshot.yStart,
			inputType: snapshot.inputType,
			valueBeforeInput: text.stringContent
		};
		return;
	}

	if (isTextLocalDeletion(edytor, snapshot)) {
		const offset =
			!snapshot.isCollapsed || snapshot.inputType === 'deleteContentForward'
				? snapshot.yStart
				: Math.max(0, snapshot.yStart - 1);
		edytor.browserOwnedInputTarget = {
			text,
			offset,
			historyOffset: snapshot.yStart,
			inputType: snapshot.inputType,
			valueBeforeInput: text.stringContent
		};
		return;
	}

	edytor.browserOwnedInputTarget = null;
};

const shouldRepairNativeMutationAfterModelCommand = (
	edytor: Edytor,
	snapshot: BeforeInputSnapshot
) =>
	!snapshot.event.cancelable &&
	(isUnsafeNativeTextInsertion(edytor, snapshot) ||
		(isModelOwnedDeleteInput(snapshot.inputType) && !isTextLocalDeletion(edytor, snapshot)) ||
		isStructuralNativeMutationInput(snapshot.inputType));

const shouldFlushObservedNativeMutationsAfterSuppressedInput = (
	edytor: Edytor,
	snapshot: BeforeInputSnapshot
) =>
	!snapshot.event.cancelable &&
	(isUnsafeNativeTextInsertion(edytor, snapshot) ||
		isStructuralNativeMutationInput(snapshot.inputType));

const scheduleAndroidChromeNativeBackspaceFallback = (
	edytor: Edytor,
	snapshot: BeforeInputSnapshot
) => {
	if (
		!isAndroidChromeBrowser() ||
		snapshot.inputType !== 'deleteContentBackward' ||
		!snapshot.startText ||
		!snapshot.isCollapsed ||
		snapshot.isAtStartOfText ||
		snapshot.isTextSpanning ||
		snapshot.isBlockSpanning
	) {
		return;
	}

	const text = snapshot.startText;
	const initialValue = text.stringContent;
	const initialDomValue = text.node?.textContent ?? null;
	const initialOffset = snapshot.yStart;

	setTimeout(() => {
		const isLiveText =
			text.parent.content.indexOf(text) !== -1 &&
			text.parent.yContent.get(text.index) === text.yText &&
			text.yText.doc === edytor.doc;
		if (!isLiveText) {
			return;
		}

		if (
			text.stringContent !== initialValue ||
			(text.node?.textContent ?? null) !== initialDomValue
		) {
			return;
		}

		const { startText, yStart, isCollapsed } = edytor.selection.state;
		if (startText !== text || !isCollapsed || yStart !== initialOffset) {
			return;
		}

		edytor.suppressNextInputFallback();
		const deletion = text.deleteText({ direction: 'BACKWARD', length: 1 });
		void edytor.selection.setAtTextOffset(text, deletion?.start ?? initialOffset - 1);
	}, NATIVE_INPUT_REPAIR_WINDOW_MS);
};

const resetCompositionIfNeeded = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (
		snapshot.inputType !== 'insertCompositionText' &&
		snapshot.inputType !== 'insertFromComposition' &&
		!edytor.isComposing
	) {
		edytor.compositionState = null;
	}
};

const stopHistoryCaptureIfNeeded = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (
		snapshot.inputType === 'insertParagraph' ||
		snapshot.inputType === 'insertFromPaste' ||
		(snapshot.inputType.startsWith('delete') && snapshot.inputType !== 'deleteCompositionText')
	) {
		edytor.undoManager.stopCapturing();
	}
};

const deleteTrailingSoftBreakBackward = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	const isModelCollapsed = snapshot.isCollapsed || snapshot.yStart === snapshot.yEnd;
	if (
		snapshot.inputType !== 'deleteContentBackward' ||
		!isModelCollapsed ||
		!startText?.stringContent.endsWith('\n') ||
		yStart !== startText.length
	) {
		return false;
	}

	snapshot.event.preventDefault();
	stopHistoryCaptureIfNeeded(edytor, snapshot);
	edytor.transact(() => {
		startText.yText.delete(yStart - 1, 1);
	});
	startText.refreshFromModel();
	void tick().then(() => edytor.selection.setAtTextOffset(startText, yStart - 1));
	return true;
};

const markCompositionInputHandledIfNeeded = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (edytor.isComposing && snapshot.inputType.startsWith('insert')) {
		edytor.hasHandledCompositionInput = true;
	}
};

const refreshSelectionTextFromModel = async (edytor: Edytor, forceDomRefresh = false) => {
	const text = edytor.selection.state.startText;
	if (!text?.node?.isConnected) {
		return;
	}
	const offset = edytor.selection.state.yStart;
	forceDomRefresh ? text.refreshFromModel() : text.syncFromModel();
	await tick();
	scheduleRemoveStalePlaceholders(text);
	await edytor.selection.setAtTextOffset(text, Math.min(offset, text.length));
};

const rememberInterruptedCompositionSelectionIfNeeded = (
	edytor: Edytor,
	snapshot: BeforeInputSnapshot
) => {
	if (!edytor.isComposing || !edytor.compositionState || isCompositionInput(snapshot.inputType)) {
		return;
	}
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	if (!startText || !isCollapsed) {
		return;
	}
	edytor.compositionState.restoreSelectionAfterCommit = {
		textId: startText.id,
		offset: yStart
	};
};

const runBeforeInputPlugins = (edytor: Edytor, event: InputEvent) => {
	edytor.plugins.forEach((plugin) => {
		plugin.onBeforeInput?.({ prevent, e: event });
	});
};

const runBeforeInputHistoryCommand = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (snapshot.inputType !== 'historyUndo' && snapshot.inputType !== 'historyRedo') {
		return false;
	}

	snapshot.event.preventDefault();
	edytor.suppressNextInputFallback();
	edytor.selection.queueNextUndoSelectionSnapshot();

	if (snapshot.inputType === 'historyUndo') {
		const stackItem = edytor.undoManager.undoStack.at(-1);
		const selectionSnapshot = getHistorySelectionSnapshot(stackItem);
		const shouldRestoreSelection = beginHistoryCommandRestore(edytor);
		edytor.undoManager.undo();
		restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestoreSelection);
		void refreshDomAfterHistoryChange(edytor, {
			restoreSelection: false,
			shouldRestoreSelection
		}).then(() =>
			restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestoreSelection)
		);
		return true;
	}

	const stackItem = edytor.undoManager.redoStack.at(-1);
	const selectionSnapshot = getHistorySelectionSnapshot(stackItem, { preferRestore: true });
	const shouldRestoreSelection = beginHistoryCommandRestore(edytor);
	edytor.undoManager.redo();
	restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestoreSelection);
	void refreshDomAfterHistoryChange(edytor, {
		restoreSelection: false,
		shouldRestoreSelection
	}).then(() =>
		restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestoreSelection)
	);
	return true;
};

export async function onBeforeInput(this: Edytor, event: InputEvent) {
	const structuralKeyFallbackInputType = this.structuralKeyFallbackInputType;
	this.cancelStructuralKeyFallback();
	if (event.inputType === 'deleteByDrag' && event.isTrusted) {
		event.preventDefault();
		this.selection.clearPointerDragStart();
		return;
	}

	if (isBrowserOwnedNativeInput(this, event)) {
		this.browserOwnedInputTarget = null;
		return;
	}

	if (hasOutsideBeforeInputTargetRange(this, event)) {
		event.preventDefault();
		return;
	}

	syncSelectionFromBeforeInputTargetRange(this, event, structuralKeyFallbackInputType);
	const snapshot = createBeforeInputSnapshot(this, event, structuralKeyFallbackInputType);
	if (shouldIgnoreBeforeInput(this, snapshot)) {
		return;
	}
	if (deleteTrailingSoftBreakBackward(this, snapshot)) {
		return;
	}
	if (shouldLetBrowserHandleBeforeInput(this, snapshot)) {
		stopHistoryCaptureIfNeeded(this, snapshot);
		rememberBrowserOwnedInputTarget(this, snapshot);
		scheduleAndroidChromeNativeBackspaceFallback(this, snapshot);
		return;
	}

	try {
		resetCompositionIfNeeded(this, snapshot);
		stopHistoryCaptureIfNeeded(this, snapshot);
		markCompositionInputHandledIfNeeded(this, snapshot);

		if (runBeforeInputHistoryCommand(this, snapshot)) {
			return;
		}

		if (runBeforeInputHotkeyBridge(this, snapshot)) {
			event.preventDefault();
			return;
		}

		const shouldRepairNativeMutation = shouldRepairNativeMutationAfterModelCommand(this, snapshot);
		const shouldRestoreModelSelectionAfterCommand =
			shouldFlushObservedNativeMutationsAfterSuppressedInput(this, snapshot);
		const inputFallbackRepairDuration = shouldRepairNativeMutation
			? NATIVE_INPUT_REPAIR_WINDOW_MS
			: 0;

		event.preventDefault();
		this.suppressNextInputFallback(inputFallbackRepairDuration);
		runBeforeInputPlugins(this, event);
		if (shouldRepairNativeMutation) {
			this.repairSuppressedInputFallback(inputFallbackRepairDuration, {
				flushObservedMutations: shouldRestoreModelSelectionAfterCommand
			});
		}
		const command = runBeforeInputCommand(this, snapshot);
		await command;
		if (shouldRepairNativeMutation) {
			this.suppressObservedMutationFallback(inputFallbackRepairDuration);
		}
		if (
			shouldRestoreModelSelectionAfterCommand &&
			snapshot.inputType !== 'insertLineBreak' &&
			this.selection.state.startText
		) {
			await this.selection.setAtTextOffset(
				this.selection.state.startText,
				this.selection.state.yStart
			);
		}
		if (shouldRefreshDomAfterModelCommand(snapshot)) {
			await refreshSelectionTextFromModel(this, snapshot.inputType === 'insertFromPaste');
		}
		rememberInterruptedCompositionSelectionIfNeeded(this, snapshot);
	} catch (error) {
		if (error instanceof PreventionError) {
			return error.cb?.();
		}
		throw error;
	}
}
