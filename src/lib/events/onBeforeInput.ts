import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { prevent, PreventionError } from '$lib/utils.js';
import { Text } from '$lib/text/text.svelte.js';
import {
	createDomRange,
	createDomSelectionSnapshotFromRange,
	domSelectionCoversRange,
	getActiveElement,
	getDomSelection
} from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { runHistoryCommand } from './undoRestore.js';
import { isAndroidChromeBrowser } from './events.utils.js';
import {
	isNativeInteractiveControl,
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';
import { observeInternalDragSources } from './onDrop.js';
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

const isBackwardAdvancedDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteWordBackward' ||
	inputType === 'deleteSoftLineBackward' ||
	inputType === 'deleteHardLineBackward';

const isForwardAdvancedDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteWordForward' ||
	inputType === 'deleteSoftLineForward' ||
	inputType === 'deleteHardLineForward';

const isBackwardDeleteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteContentBackward' || isBackwardAdvancedDeleteInput(inputType);

// Deletes whose extent the model computes itself (`deleteCollapsed*` in
// beforeInputDeleteCommands): for a collapsed caret the browser's
// targetRange is only used to locate the caret edge, never adopted
// verbatim — Firefox delivers block-level end containers for word/line
// deletes, which derive to a degenerate caret and no-op the delete.
const isDeleteTargetRangeInput = (inputType: InputEvent['inputType']) =>
	inputType === 'deleteContentBackward' ||
	inputType === 'deleteContentForward' ||
	isBackwardAdvancedDeleteInput(inputType) ||
	isForwardAdvancedDeleteInput(inputType);

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
	inputType === 'insertFromPaste' ||
	inputType === 'insertFromPasteAsQuotation';

const NATIVE_INPUT_REPAIR_WINDOW_MS = 150;

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

	return isBackwardDeleteInput(inputType) ? yStart > 0 : yStart < startText.length;
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
		effectiveInputType !== 'insertReplacementText' &&
		!edytor.selection.state.isCollapsed
	) {
		return false;
	}
	if (isStructuralNativeMutationInput(effectiveInputType) && !edytor.selection.state.isCollapsed) {
		return false;
	}
	if (isDeleteTargetRangeInput(effectiveInputType) && !edytor.selection.state.isCollapsed) {
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
	const collapsesDeleteTargetRange =
		isDeleteTargetRangeInput(event.inputType) && edytor.selection.state.isCollapsed;
	if (collapsesDeleteTargetRange) {
		const container = isBackwardDeleteInput(event.inputType)
			? targetRange.endContainer
			: targetRange.startContainer;
		const offset = isBackwardDeleteInput(event.inputType)
			? targetRange.endOffset
			: targetRange.startOffset;
		liveRange.setStart(container, offset);
		liveRange.collapse(true);
	} else {
		liveRange.setStart(targetRange.startContainer, targetRange.startOffset);
		liveRange.setEnd(targetRange.endContainer, targetRange.endOffset);
	}
	if (
		!collapsesDeleteTargetRange &&
		// U8a — the browser usually fires beforeinput with the target range
		// the DOM selection already covers (e.g. deleting the current
		// selection). The previous unconditional removeAllRanges+addRange
		// forced a synchronous layout per keystroke for an identical write.
		// Only skip when the selection matches exactly — a reversed live
		// selection still gets normalized to forward, as before.
		!domSelectionCoversRange(
			selection,
			liveRange.startContainer,
			liveRange.startOffset,
			liveRange.endContainer,
			liveRange.endOffset,
			false
		)
	) {
		selection?.removeAllRanges();
		selection?.addRange(liveRange);
	}
	edytor.selection.applySelectionSnapshot(
		createDomSelectionSnapshotFromRange(liveRange, selection),
		{
			restoreNormalizedDomRange: false
		}
	);
};

const hasOutsideBeforeInputTargetRange = (edytor: Edytor, event: InputEvent) => {
	const targetRange = getBeforeInputTargetRange(event);
	return Boolean(targetRange && !isRangeInsideEditor(edytor, targetRange));
};

/**
 * Undo-scope walk (Lexical #6714): when a control OUTSIDE the editor exhausts
 * its own undo stack, Chromium/WebKit re-dispatch `historyUndo`/`historyRedo`
 * at the contenteditable root with no selection. Those events are not
 * editor-owned — bail without `preventDefault` so the owning scope can handle
 * the command and the document's undo history is never consumed on a foreign
 * intent.
 */
const isForeignHistoryBeforeInput = (edytor: Edytor, event: InputEvent) => {
	if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') {
		return false;
	}

	const node = edytor.node;
	if (!node) {
		return true;
	}

	const activeElement = getActiveElement(node);
	if (activeElement === node || (activeElement && node.contains(activeElement))) {
		return false;
	}

	// A focused element outside the editor owns the command. When nothing is
	// focused (null/body/html, or the shadow host that retargets inner focus),
	// the DOM selection decides whether the editor still holds editing scope.
	const rootNode = node.getRootNode();
	const shadowHost =
		typeof ShadowRoot !== 'undefined' && rootNode instanceof ShadowRoot ? rootNode.host : null;
	const ownerDocument = node.ownerDocument;
	if (
		activeElement &&
		activeElement !== shadowHost &&
		activeElement !== ownerDocument.body &&
		activeElement !== ownerDocument.documentElement
	) {
		return true;
	}

	const selection = getDomSelection(node);
	return !selection?.anchorNode || !node.contains(selection.anchorNode);
};

// Mid-composition paste/drop is left to the browser (PM input.ts:656-660):
// the composition preview owns the write path and the deferred observer
// reconciles whatever the native insertion produced after compositionend.
const isCompositionInterruptingPasteInput = (inputType: InputEvent['inputType']) =>
	inputType === 'insertFromPaste' ||
	inputType === 'insertFromPasteAsQuotation' ||
	inputType === 'insertFromDrop';

const isBrowserOwnedNativeInput = (edytor: Edytor, event: InputEvent) =>
	isNativeInteractiveEvent(event) &&
	edytor.selection.selectedBlocks.size === 0 &&
	edytor.selection.selectedInlineBlock.size === 0;

const shouldIgnoreBeforeInput = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	edytor.readonly ||
	snapshot.isVoidEditableElement ||
	isBrowserOwnedNativeInput(edytor, snapshot.event) ||
	isNativeInteractiveControl(snapshot.event.target) ||
	isNestedForeignEditableTarget(edytor.node, snapshot.event.target);

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
	(!snapshot.event.cancelable &&
		(snapshot.inputType === 'insertFromPaste' ||
			snapshot.inputType === 'insertFromPasteAsQuotation' ||
			snapshot.inputType === 'insertFromDrop'));

/**
 * `insertTranspose` (macOS Ctrl+T) and `insertFromYank` (Emacs yank)
 * carry no `data` and usually no `dataTransfer` — the model cannot know
 * what to insert, so the only correct handling is letting the browser
 * perform the mutation natively and reconciling it. Restricted to a
 * single text: a spanning range would let the browser clobber structure
 * the model cannot recover.
 */
const isTextLocalRearrangeInput = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	(snapshot.inputType === 'insertTranspose' || snapshot.inputType === 'insertFromYank') &&
	!snapshot.data &&
	!snapshot.hasDataTransferTextPayload &&
	edytor.selection.selectedBlocks.size === 0 &&
	edytor.selection.selectedInlineBlock.size === 0 &&
	Boolean(snapshot.startText) &&
	snapshot.startText === snapshot.endText &&
	!snapshot.isTextSpanning &&
	!snapshot.isBlockSpanning;

const shouldLetBrowserHandleBeforeInput = (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	(!snapshot.hasDataTransferTextPayload && isTextLocalReplacement(edytor, snapshot)) ||
	snapshot.inputType === 'deleteCompositionText' ||
	isSafeTextLocalInsertion(edytor, snapshot) ||
	isTextLocalDeletion(edytor, snapshot) ||
	isTextLocalRearrangeInput(edytor, snapshot);

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

	if (isTextLocalRearrangeInput(edytor, snapshot)) {
		// Transpose/yank — the caret stays at the same model offset after
		// the native rearrange; recording the target preserves the undo
		// selection snapshot and plugin insert notifications.
		edytor.browserOwnedInputTarget = {
			text,
			offset: snapshot.yStart,
			historyOffset: snapshot.yStart,
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
		if (!text.isInDocument) {
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
		snapshot.inputType === 'insertFromPasteAsQuotation' ||
		snapshot.inputType === 'insertFromDrop' ||
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
		startText.deleteAt(yStart - 1, 1);
	});
	startText.refreshFromModel();
	void tick().then(() => edytor.selection.setAtTextOffset(startText, yStart - 1));
	return true;
};

// `insert*` command types that never deliver composition text — a native
// `insertLink`/list/`insertHorizontalRule` landing between
// `compositionstart` and the first real composition input must NOT mark
// the composition handled, or `onCompositionEnd` drops the IME's
// `finalValue` commit.
const NON_COMPOSITION_INSERT_TYPES = new Set([
	'insertLink',
	'insertOrderedList',
	'insertUnorderedList',
	'insertHorizontalRule',
	'insertTranspose',
	'insertFromYank',
	'insertFromPaste',
	'insertFromDrop'
]);

const markCompositionInputHandledIfNeeded = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (
		edytor.isComposing &&
		snapshot.inputType.startsWith('insert') &&
		!NON_COMPOSITION_INSERT_TYPES.has(snapshot.inputType)
	) {
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
	void runHistoryCommand(edytor, snapshot.inputType === 'historyUndo' ? 'undo' : 'redo', {
		queueSelectionSnapshot: true
	});
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

	if (isForeignHistoryBeforeInput(this, event)) {
		return;
	}

	if (this.isComposing && event.inputType.startsWith('history')) {
		// A history command landing mid-composition would consume capture
		// groups (and the preview's own model writes) while the IME still
		// owns the DOM node; the commit would then resolve against a moved
		// document. Swallow it — undo applies cleanly after the commit.
		event.preventDefault();
		return;
	}

	if (this.isComposing && isCompositionInterruptingPasteInput(event.inputType)) {
		return;
	}

	// Island beforeinputs must return BEFORE the selection sync — the
	// sync writes the DOM selection from the (stale) model state and
	// would collapse the island's live range before its own delete runs.
	if (isNestedForeignEditableTarget(this.node, event.target)) {
		return;
	}

	observeInternalDragSources(this.node?.getRootNode());
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
