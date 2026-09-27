import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { prevent } from '$lib/utils.js';
import { Text } from '$lib/text/text.svelte.js';
import {
	createDomRange,
	createDomSelectionSnapshotFromRange,
	domSelectionCoversRange,
	getActiveElement,
	getDomSelection
} from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import {
	INTENTS,
	attemptOf,
	intentOf,
	kindOf,
	type Attempt,
	type Occurrence
} from '$lib/session/attempt.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { runHistoryCommand } from './undoRestore.js';
import { isAndroidChromeBrowser } from './events.utils.js';
import {
	isNativeInteractiveControl,
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';
import { observeInternalDragSources } from './onDrop.js';
import { runBeforeInputCommand, runBeforeInputHotkeyBridge } from './beforeInputCommands.js';

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

// Deletes whose extent the model computes itself (`deleteCollapsed*` in
// beforeInputDeleteCommands): for a collapsed caret the browser's
// targetRange is only used to locate the caret edge, never adopted
// verbatim — Firefox delivers block-level end containers for word/line
// deletes, which derive to a degenerate caret and no-op the delete.
const deleteDir = (inputType: string) => INTENTS[inputType]?.dir;

/** Insertions whose target is the caret the user placed (not a drop point). */
const isTextInsertionInput = (inputType: string) =>
	inputType.startsWith('insert') &&
	inputType !== 'insertFromDrop' &&
	['text', 'composition', 'payload'].includes(kindOf(inputType) ?? '');

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

const isSafeDeleteTargetRange = (
	inputType: string,
	{ startText, endText, yStart, yEnd }: BeforeInputTextTargetRange
) => {
	if (!deleteDir(inputType) || startText !== endText || yStart < 0 || yEnd < yStart) return false;
	if (yEnd > startText.length) return false;
	if (yStart !== yEnd) return true;
	return deleteDir(inputType) === 'back' ? yStart > 0 : yStart < startText.length;
};

const shouldSyncBeforeInputTargetRange = (
	edytor: Edytor,
	reported: string,
	intent: string,
	targetRange: StaticRange
) => {
	if (kindOf(reported) === 'history') {
		return false;
	}

	const { isCollapsed } = edytor.selection.state;
	if (
		isTextInsertionInput(intent) &&
		edytor.selection.consumeModelSelectionPreservationForTextInsertion()
	) {
		return false;
	}

	if (isTextInsertionInput(intent) && intent !== 'insertReplacementText' && !isCollapsed) {
		return false;
	}
	if ((kindOf(intent) === 'break' || deleteDir(intent)) && !isCollapsed) {
		return false;
	}

	const targetTextRange = getBeforeInputTextTargetRange(edytor, targetRange);
	const { startText, yStart } = edytor.selection.state;
	if (
		isTextInsertionInput(intent) &&
		isCollapsed &&
		targetTextRange?.startText === startText &&
		targetTextRange.endText === startText &&
		targetTextRange.yStart === yStart &&
		targetTextRange.yEnd === yStart
	) {
		// The engine re-reports the admitted caret, canonicalized (Chromium moves
		// ` tail`@0 into `Link`@4): the caret keeps its admitted edge side (R4).
		return false;
	}
	if (!deleteDir(reported)) {
		return true;
	}

	return targetTextRange ? isSafeDeleteTargetRange(reported, targetTextRange) : false;
};

/** Resolve the declared target range into the selection the attempt is admitted at. */
const syncSelectionFromDeclaredRange = (edytor: Edytor, occurrence: Occurrence, intent: string) => {
	const targetRange = occurrence.declared;
	const reported = occurrence.inputType;
	if (
		!targetRange ||
		!isRangeInsideEditor(edytor, targetRange) ||
		!shouldSyncBeforeInputTargetRange(edytor, reported, intent, targetRange)
	) {
		return;
	}

	const selection = getDomSelection(edytor.node);

	const liveRange = createDomRange(targetRange.startContainer);
	const collapsesDeleteTargetRange =
		Boolean(deleteDir(reported)) && edytor.selection.state.isCollapsed;
	if (collapsesDeleteTargetRange) {
		const backward = deleteDir(reported) === 'back';
		const container = backward ? targetRange.endContainer : targetRange.startContainer;
		const offset = backward ? targetRange.endOffset : targetRange.startOffset;
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

/**
 * Undo-scope walk (Lexical #6714): when a control OUTSIDE the editor exhausts
 * its own undo stack, Chromium/WebKit re-dispatch `historyUndo`/`historyRedo`
 * at the contenteditable root with no selection. Those events are not
 * editor-owned — bail without `preventDefault` so the owning scope can handle
 * the command and the document's undo history is never consumed on a foreign
 * intent.
 */
const isForeignHistoryBeforeInput = (edytor: Edytor, event: InputEvent) => {
	if (kindOf(event.inputType) !== 'history') {
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

const isBrowserOwnedNativeInput = (edytor: Edytor, event: InputEvent) =>
	isNativeInteractiveEvent(event) &&
	edytor.selection.selectedBlocks.size === 0 &&
	edytor.selection.selectedInlineBlock.size === 0;

const shouldIgnoreBeforeInput = (edytor: Edytor, attempt: Attempt) =>
	edytor.readonly ||
	attempt.isVoidEditableElement ||
	(attempt.event &&
		(isBrowserOwnedNativeInput(edytor, attempt.event) ||
			isNativeInteractiveControl(attempt.event.target) ||
			isNestedForeignEditableTarget(edytor.node, attempt.event.target)));

/** One text, nothing spanning, no block selection: a change the browser can make alone. */
const isTextLocal = (edytor: Edytor, attempt: Attempt) =>
	edytor.selection.selectedBlocks.size === 0 &&
	Boolean(attempt.startText) &&
	attempt.startText === attempt.endText &&
	!attempt.isTextSpanning &&
	!attempt.isBlockSpanning;

const isTextLocalDeletion = (edytor: Edytor, attempt: Attempt) => {
	if (
		attempt.isStructuralKeyFallback ||
		attempt.cancelable ||
		(attempt.inputType !== 'deleteContentBackward' &&
			attempt.inputType !== 'deleteContentForward') ||
		!isTextLocal(edytor, attempt)
	) {
		return false;
	}

	if (!attempt.isCollapsed) {
		return true;
	}

	return attempt.inputType === 'deleteContentBackward'
		? !attempt.isAtStartOfText
		: !attempt.isAtEndOfText;
};

const isTextLocalReplacement = (edytor: Edytor, attempt: Attempt) =>
	attempt.inputType === 'insertReplacementText' &&
	attempt.isCollapsed &&
	isTextLocal(edytor, attempt);

const isSafeTextLocalInsertion = (edytor: Edytor, attempt: Attempt) =>
	!attempt.cancelable &&
	attempt.inputType === 'insertText' &&
	attempt.data !== '\t' &&
	!(attempt.data === '@' && edytor.inlineBlocks.has('mention')) &&
	attempt.isCollapsed &&
	isTextLocal(edytor, attempt);

/** A non-cancelable insertion the model must perform: the browser's own write is drift. */
const isUnsafeNativeTextInsertion = (edytor: Edytor, attempt: Attempt) =>
	!attempt.cancelable &&
	((attempt.inputType === 'insertText' && !isSafeTextLocalInsertion(edytor, attempt)) ||
		(attempt.inputType === 'insertReplacementText' && !isTextLocalReplacement(edytor, attempt)) ||
		kindOf(attempt.inputType) === 'payload');

/**
 * `insertTranspose` (macOS Ctrl+T) and `insertFromYank` (Emacs yank)
 * carry no `data` and usually no `dataTransfer` — the model cannot know
 * what to insert, so the only correct handling is letting the browser
 * perform the mutation natively and reconciling it. Restricted to a
 * single text: a spanning range would let the browser clobber structure
 * the model cannot recover.
 */
const isTextLocalRearrangeInput = (edytor: Edytor, attempt: Attempt) =>
	(attempt.inputType === 'insertTranspose' || attempt.inputType === 'insertFromYank') &&
	!attempt.data &&
	!attempt.hasDataTransferTextPayload &&
	edytor.selection.selectedInlineBlock.size === 0 &&
	isTextLocal(edytor, attempt);

/**
 * The owner rule: the browser performs a text-local insertion, replacement,
 * rearrangement or deletion (and composition-text deletion); the model
 * performs everything else.
 */
const shouldLetBrowserHandleBeforeInput = (edytor: Edytor, attempt: Attempt) =>
	(!attempt.hasDataTransferTextPayload && isTextLocalReplacement(edytor, attempt)) ||
	attempt.inputType === 'deleteCompositionText' ||
	isSafeTextLocalInsertion(edytor, attempt) ||
	isTextLocalDeletion(edytor, attempt) ||
	isTextLocalRearrangeInput(edytor, attempt);

/** The change a browser-owned attempt expects: its text, value before and caret after. */
const rememberBrowserOwnedInputTarget = (edytor: Edytor, attempt: Attempt) => {
	const text = attempt.startText;
	const target = (offset: number, historyOffset?: number) =>
		text && edytor.selection.selectedBlocks.size === 0
			? {
					text,
					offset,
					historyOffset,
					inputType: attempt.inputType,
					valueBeforeInput: text.stringContent
				}
			: null;
	edytor.browserOwnedInputTarget = isSafeTextLocalInsertion(edytor, attempt)
		? target(attempt.yStart + (attempt.data?.length ?? 0))
		: isTextLocalReplacement(edytor, attempt)
			? target(attempt.yStart)
			: // Transpose/yank — the caret stays at the same model offset after
				// the native rearrange; the target keeps the undo selection
				// snapshot and plugin insert notifications.
				isTextLocalRearrangeInput(edytor, attempt)
				? target(attempt.yStart, attempt.yStart)
				: isTextLocalDeletion(edytor, attempt)
					? target(
							!attempt.isCollapsed || attempt.inputType === 'deleteContentForward'
								? attempt.yStart
								: Math.max(0, attempt.yStart - 1),
							attempt.yStart
						)
					: null;
};

/** How the browser's own mutation around a model-owned attempt is handled: repair it, flush structure too. */
const driftOf = (edytor: Edytor, attempt: Attempt) => {
	const kind = kindOf(attempt.inputType);
	const flush =
		!attempt.cancelable && (isUnsafeNativeTextInsertion(edytor, attempt) || kind === 'break');
	const repair =
		flush || (!attempt.cancelable && kind === 'delete' && !isTextLocalDeletion(edytor, attempt));
	return { repair, flush };
};

const scheduleAndroidChromeNativeBackspaceFallback = (edytor: Edytor, attempt: Attempt) => {
	if (
		!isAndroidChromeBrowser() ||
		attempt.inputType !== 'deleteContentBackward' ||
		!attempt.startText ||
		!attempt.isCollapsed ||
		attempt.isAtStartOfText ||
		attempt.isTextSpanning ||
		attempt.isBlockSpanning
	) {
		return;
	}

	const text = attempt.startText;
	const initialValue = text.stringContent;
	const initialDomValue = text.node?.textContent ?? null;
	const initialOffset = attempt.yStart;

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

const resetCompositionIfNeeded = (edytor: Edytor, attempt: Attempt) => {
	if (kindOf(attempt.inputType) !== 'composition' && !edytor.isComposing) {
		edytor.compositionState = null;
	}
};

const deleteTrailingSoftBreakBackward = (edytor: Edytor, attempt: Attempt) => {
	const { startText, yStart } = attempt;
	const isModelCollapsed = attempt.isCollapsed || attempt.yStart === attempt.yEnd;
	if (
		attempt.inputType !== 'deleteContentBackward' ||
		!isModelCollapsed ||
		!startText?.stringContent.endsWith('\n') ||
		yStart !== startText.length
	) {
		return false;
	}

	attempt.event?.preventDefault();
	edytor.dispatcher.cut(attempt.inputType);
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

const markCompositionInputHandledIfNeeded = (edytor: Edytor, attempt: Attempt) => {
	if (
		edytor.isComposing &&
		attempt.inputType.startsWith('insert') &&
		!NON_COMPOSITION_INSERT_TYPES.has(attempt.inputType)
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

const rememberInterruptedCompositionSelectionIfNeeded = (edytor: Edytor, attempt: Attempt) => {
	if (
		!edytor.isComposing ||
		!edytor.compositionState ||
		kindOf(attempt.inputType) === 'composition'
	) {
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

/** The pre-admission extension hook: an extension may claim a browser `beforeinput`. */
const runBeforeInputPlugins = (edytor: Edytor, event: InputEvent) => {
	edytor.plugins.forEach((plugin) => {
		plugin.onBeforeInput?.({ prevent, e: event });
	});
};

/**
 * Perform a model-owned attempt as one user command (undo policy, prevention
 * scope): the key's bindings first (offered once per occurrence), then its
 * drift windows, the extension hook and the intent's command.
 */
const perform = (edytor: Edytor, attempt: Attempt, offered: string | null) =>
	edytor.dispatcher.run(attempt.inputType, async () => {
		const { event } = attempt;
		const kind = kindOf(attempt.inputType);
		resetCompositionIfNeeded(edytor, attempt);
		markCompositionInputHandledIfNeeded(edytor, attempt);
		event?.preventDefault();
		if (kind === 'history') {
			edytor.suppressNextInputFallback();
			void runHistoryCommand(edytor, attempt.inputType === 'historyUndo' ? 'undo' : 'redo', {
				queueSelectionSnapshot: true
			});
			return;
		}
		// A binding claimed the intent: its command owns the result, the
		// observer repairs what the browser did around it.
		if (runBeforeInputHotkeyBridge(edytor, attempt, offered)) return;

		const { repair, flush } = driftOf(edytor, attempt);
		const window = repair ? NATIVE_INPUT_REPAIR_WINDOW_MS : 0;
		edytor.suppressNextInputFallback(window);
		if (event) runBeforeInputPlugins(edytor, event);
		if (repair) edytor.repairSuppressedInputFallback(window, { flushObservedMutations: flush });
		await runBeforeInputCommand(edytor, attempt);
		if (repair) edytor.suppressObservedMutationFallback(window);
		if (flush && attempt.inputType !== 'insertLineBreak' && edytor.selection.state.startText) {
			await edytor.selection.setAtTextOffset(
				edytor.selection.state.startText,
				edytor.selection.state.yStart
			);
		}
		if (kind === 'text' || kind === 'payload') {
			await refreshSelectionTextFromModel(edytor, attempt.inputType === 'insertFromPaste');
		}
		rememberInterruptedCompositionSelectionIfNeeded(edytor, attempt);
	});

/**
 * Admit one occurrence and run it: resolve its declared target, fix intent
 * and target, then let the browser perform it or perform it here.
 * `keyIntent` is the intent a keydown of the same occurrence announced.
 */
const occur = (
	edytor: Edytor,
	occurrence: Occurrence,
	keyIntent: string | null,
	offered: string | null
) => {
	observeInternalDragSources(edytor.node?.getRootNode());
	const intent = intentOf(occurrence.inputType, occurrence.data ?? null, keyIntent ?? undefined);
	syncSelectionFromDeclaredRange(edytor, occurrence, intent);
	const attempt = attemptOf(edytor, occurrence, keyIntent ?? undefined);
	if (
		shouldIgnoreBeforeInput(edytor, attempt) ||
		deleteTrailingSoftBreakBackward(edytor, attempt)
	) {
		return;
	}
	if (shouldLetBrowserHandleBeforeInput(edytor, attempt)) {
		edytor.dispatcher.cut(attempt.inputType);
		rememberBrowserOwnedInputTarget(edytor, attempt);
		scheduleAndroidChromeNativeBackspaceFallback(edytor, attempt);
		return;
	}

	if (!edytor.dispatcher.permits()) {
		occurrence.event?.preventDefault();
		return;
	}
	return perform(edytor, attempt, offered);
};

export async function onBeforeInput(this: Edytor, event: InputEvent) {
	// The keydown of this occurrence may have announced its intent and offered its key.
	const keyIntent = this.structuralKeyFallbackInputType;
	this.cancelStructuralKeyFallback();
	const offered = this.hotKeys.offered;
	this.hotKeys.offered = null;
	if (event.inputType === 'deleteByDrag' && event.isTrusted) {
		event.preventDefault();
		this.selection.clearPointerDragStart();
		return;
	}

	if (isBrowserOwnedNativeInput(this, event)) {
		this.browserOwnedInputTarget = null;
		return;
	}

	const declared =
		typeof event.getTargetRanges === 'function' ? (event.getTargetRanges()[0] ?? null) : null;
	if (declared && !isRangeInsideEditor(this, declared)) {
		event.preventDefault();
		return;
	}

	if (isForeignHistoryBeforeInput(this, event)) {
		return;
	}

	if (this.isComposing && kindOf(event.inputType) === 'history') {
		// A history command landing mid-composition would consume capture
		// groups (and the preview's own model writes) while the IME still
		// owns the DOM node; the commit would then resolve against a moved
		// document. Swallow it — undo applies cleanly after the commit.
		event.preventDefault();
		return;
	}

	// Mid-composition paste/drop is left to the browser (PM input.ts:656-660):
	// the composition preview owns the write path and the deferred observer
	// reconciles whatever the native insertion produced after compositionend.
	if (this.isComposing && kindOf(event.inputType) === 'payload') {
		return;
	}

	// Island beforeinputs must return BEFORE the selection sync — the
	// sync writes the DOM selection from the (stale) model state and
	// would collapse the island's live range before its own delete runs.
	if (isNestedForeignEditableTarget(this.node, event.target)) {
		return;
	}

	return occur(
		this,
		{
			inputType: event.inputType,
			data: event.data,
			dataTransfer: event.dataTransfer,
			declared,
			cancelable: event.cancelable,
			event
		},
		keyIntent,
		offered
	);
}
