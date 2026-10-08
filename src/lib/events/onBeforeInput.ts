import type { Edytor } from '../edytor.svelte.js';
import { vetoable } from '$lib/utils.js';
import { Text } from '$lib/text/text.svelte.js';
import {
	createDomRange,
	createDomSelectionSnapshotFromRange,
	getActiveElement,
	getDomSelection
} from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { sameValue } from '$lib/session/selection.js';
import {
	INTENTS,
	attemptOf,
	intentOf,
	kindOf,
	reproject,
	targetless,
	type Attempt,
	type Drift,
	type Expect,
	type Occurrence
} from '$lib/session/attempt.js';
import { isAndroidChromeBrowser } from './events.utils.js';
import {
	isNativeInteractiveControl,
	isNativeInteractiveEvent,
	ownsEvent
} from './nativeInteractiveControl.js';
import { observeInternalDragSources } from './onDrop.js';
import { runBeforeInputCommand, runBeforeInputHotkeyBridge } from './beforeInputCommands.js';
import { readDomText } from './onInput.js';

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

/** The Android no-op-Backspace and model-owned drift deadlines (named, counted browser rules). */
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
		// ` tail`@0 into `Link`@4): the caret keeps its admitted edge side.
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

	// The declared range becomes the model selection directly: the DOM
	// selection is not a transport (a delete's caret edge for a collapsed caret).
	const range = createDomRange(targetRange.startContainer);
	const dir = deleteDir(reported);
	if (dir && edytor.selection.state.isCollapsed) {
		const [container, offset] =
			dir === 'back'
				? [targetRange.endContainer, targetRange.endOffset]
				: [targetRange.startContainer, targetRange.startOffset];
		range.setStart(container, offset);
		range.collapse(true);
	} else {
		range.setStart(targetRange.startContainer, targetRange.startOffset);
		range.setEnd(targetRange.endContainer, targetRange.endOffset);
	}
	edytor.selection.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range), {
		restoreNormalizedDomRange: false
	});
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

/**
 * An input the browser performs alone: any in a kind's own control (a field
 * bound to `block.data`, a nested editable island: `ownsEvent`), whatever the
 * selection, or any other native control's while no block or atom is selected.
 * It returns before the selection sync, which would write the DOM selection
 * from the model and collapse the control's own range.
 */
const isBrowserOwnedNativeInput = (edytor: Edytor, event: InputEvent) =>
	ownsEvent(edytor.node, event) ||
	(isNativeInteractiveEvent(event) &&
		edytor.selection.selectedBlocks.size === 0 &&
		edytor.selection.selectedInlineBlock.size === 0);

const shouldIgnoreBeforeInput = (edytor: Edytor, attempt: Attempt) =>
	edytor.readonly ||
	attempt.isVoidEditableElement ||
	(attempt.event &&
		(isBrowserOwnedNativeInput(edytor, attempt.event) ||
			isNativeInteractiveControl(attempt.event.target)));

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
		isTrailingSoftBreakBackward(attempt) ||
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
 * performs everything else. Answers the change a browser-owned attempt
 * expects, or `undefined` when the model owns it.
 */
const browserExpectation = (edytor: Edytor, attempt: Attempt): Expect | null | undefined => {
	const text = attempt.startText;
	const change = (after: string | null = null): Expect | null =>
		text && edytor.selection.selectedBlocks.size === 0
			? { kind: 'change', host: text, after }
			: null;
	if (isSafeTextLocalInsertion(edytor, attempt)) {
		const before = text!.stringContent;
		return change(before.slice(0, attempt.yStart) + attempt.data + before.slice(attempt.yStart));
	}
	if (
		(!attempt.hasDataTransferTextPayload && isTextLocalReplacement(edytor, attempt)) ||
		// Transpose/yank: the browser rearranges; the model adopts it.
		isTextLocalRearrangeInput(edytor, attempt) ||
		isTextLocalDeletion(edytor, attempt)
	)
		return change();
	if (attempt.inputType === 'deleteCompositionText') return null;
	return undefined;
};

/** How the browser's own mutation around a model-owned attempt is handled, for how long. */
const driftOf = (edytor: Edytor, attempt: Attempt): [Drift, number] => {
	const kind = kindOf(attempt.inputType);
	if (attempt.cancelable || kind === 'history') return ['refresh', 0];
	if (isUnsafeNativeTextInsertion(edytor, attempt) || kind === 'break')
		return ['discard', NATIVE_INPUT_REPAIR_WINDOW_MS];
	if (kind === 'delete' && !isTextLocalDeletion(edytor, attempt))
		return ['restore', NATIVE_INPUT_REPAIR_WINDOW_MS];
	return ['refresh', 0];
};

/**
 * Android can announce a non-cancelable Backspace it never performs. At the
 * deadline, the attempt that no adoption applied deletes one grapheme before
 * its anchored caret — unless the caret moved or a native change is pending.
 */
const androidNoOpBackspaceDeadline = (edytor: Edytor, attempt: Attempt) => {
	const text = attempt.startText;
	if (
		!isAndroidChromeBrowser() ||
		attempt.inputType !== 'deleteContentBackward' ||
		!text ||
		!attempt.isCollapsed ||
		attempt.isAtStartOfText ||
		attempt.isTextSpanning ||
		attempt.isBlockSpanning
	) {
		return;
	}

	setTimeout(() => {
		// Did this attempt's adoption apply (or refuse) a deletion?
		if (
			attempt.phase === 'applied' ||
			attempt.phase === 'failed' ||
			!text.isInDocument ||
			!sameValue(edytor.selection.value, attempt.target) ||
			readDomText(text) !== text.stringContent
		) {
			return;
		}
		attempt.phase = 'applied';
		edytor.attempts.drift(attempt, 'refresh', 0);
		const deletion = text.deleteText({ direction: 'BACKWARD', length: 1 });
		edytor.selection.setAtTextOffset(text, deletion?.start ?? attempt.yStart - 1);
	}, NATIVE_INPUT_REPAIR_WINDOW_MS);
};

/**
 * Backspace right after a trailing soft break: the browser mishandles the
 * `<br>` it renders, so the model deletes the break (a command hooks see).
 */
const isTrailingSoftBreakBackward = ({
	inputType,
	isCollapsed,
	yStart,
	yEnd,
	startText
}: Attempt) =>
	inputType === 'deleteContentBackward' &&
	(isCollapsed || yStart === yEnd) &&
	Boolean(startText?.stringContent.endsWith('\n')) &&
	yStart === startText!.length;

/** The pre-admission extension hook: an extension may claim a browser `beforeinput`. */
const runBeforeInputPlugins = (edytor: Edytor, event: InputEvent) => {
	edytor.plugins.forEach((plugin) => {
		vetoable((prevent) => plugin.onBeforeInput?.({ prevent, e: event }));
	});
};

/**
 * Perform a model-owned attempt as one user command (undo policy, prevention
 * scope): the key's bindings first (offered once per occurrence), then its
 * drift expectation, the extension hook and the intent's command.
 */
const perform = (edytor: Edytor, attempt: Attempt, offered: string | null) =>
	edytor.dispatcher.run(attempt.inputType, async () => {
		const { event } = attempt;
		const kind = kindOf(attempt.inputType);
		attempt.phase = 'applied';
		event?.preventDefault();
		if (kind === 'history') {
			edytor.attempts.drift(attempt, 'refresh', 0);
			if (attempt.inputType === 'historyUndo') edytor.historyUndo();
			else edytor.historyRedo();
			return;
		}
		// A binding claimed the intent: its command owns the result, the
		// observer repairs what the browser did around it.
		if (runBeforeInputHotkeyBridge(edytor, attempt, offered)) return;

		const [mode, window] = driftOf(edytor, attempt);
		// The live composition host is the session's: no drift expectation on it.
		if (kind !== 'composition') edytor.attempts.drift(attempt, mode, window);
		try {
			if (event) runBeforeInputPlugins(edytor, event);
			await runBeforeInputCommand(edytor, attempt);
		} catch (error) {
			attempt.phase = 'failed';
			throw error;
		}
		if (mode !== 'refresh') edytor.attempts.arm(attempt, window);
		// The command selected its caret; a paste re-renders the text it landed in.
		const text = edytor.selection.state.startText;
		if (attempt.inputType === 'insertFromPaste' && text?.node?.isConnected) text.refreshFromModel();
		if (kind !== 'composition') edytor.composition.interrupt();
	});

/**
 * Admit one occurrence and run it: resolve its declared target, fix intent,
 * target and owner, then let the browser perform it or perform it here.
 * `key` is the keydown's attempt when that keydown announced the intent;
 * `reuse` is that attempt itself when its `beforeinput` never came.
 */
const occur = (
	edytor: Edytor,
	occurrence: Occurrence,
	key: Attempt | null = null,
	offered: string | null = null,
	reuse?: Attempt
) => {
	observeInternalDragSources(edytor.node?.getRootNode());
	const intent = intentOf(occurrence.inputType, occurrence.data ?? null, key?.inputType);
	if (kindOf(intent) !== 'composition') edytor.composition.occurred(intent);
	// Admission: an intent with no target is refused before the declared range
	// (where the browser parked its own caret) could become one.
	if (targetless(edytor, intent)) return refuseTargetless(edytor, occurrence, key, reuse);
	if (!reuse) syncSelectionFromDeclaredRange(edytor, occurrence, intent);
	const attempt = reuse ? reproject(edytor, reuse) : attemptOf(edytor, occurrence, key?.inputType);
	if (shouldIgnoreBeforeInput(edytor, attempt)) {
		if (reuse) edytor.attempts.close(reuse);
		return;
	}
	const expect = browserExpectation(edytor, attempt);
	if (expect !== undefined) {
		edytor.dispatcher.cut(attempt.inputType);
		edytor.attempts.admit(attempt, 'browser', expect);
		androidNoOpBackspaceDeadline(edytor, attempt);
		return;
	}

	if (!edytor.dispatcher.permits()) {
		occurrence.event?.preventDefault();
		if (reuse) edytor.attempts.close(reuse);
		return;
	}
	if (!reuse) edytor.attempts.admit(attempt, 'model');
	return perform(edytor, attempt, offered);
};

/**
 * Refuse an occurrence with no target (`targetless`): nothing is written. A
 * cancelable one is prevented; a browser write that cannot be is drift the
 * model owns until the deadline (restored from the model, as an unsafe
 * native insertion's).
 */
const refuseTargetless = (
	edytor: Edytor,
	occurrence: Occurrence,
	key: Attempt | null,
	reuse?: Attempt
) => {
	if (reuse) edytor.attempts.close(reuse);
	edytor.dispatcher.record({ operation: occurrence.inputType, status: 'refused' });
	// The caret the browser placed for this key is its own, never adopted.
	edytor.projector.parked();
	if (occurrence.cancelable || !occurrence.event) {
		occurrence.event?.preventDefault();
		return;
	}
	// A composition's writes are its session's: the tail restores its pinned host.
	if (kindOf(occurrence.inputType) === 'composition') return;
	const attempt = edytor.attempts.admit(attemptOf(edytor, occurrence, key?.inputType), 'model');
	attempt.phase = 'failed';
	edytor.attempts.drift(attempt, 'discard', NATIVE_INPUT_REPAIR_WINDOW_MS);
};

/** An occurrence with no `beforeinput` of its own (paste, drop, a line break found in the DOM). */
export const runOccurrence = (edytor: Edytor, occurrence: Occurrence) => {
	const offered = edytor.keymap.offered;
	edytor.keymap.offered = null;
	return occur(edytor, occurrence, edytor.attempts.confirm(), offered);
};

/**
 * A keydown whose intent some engines never announce (structural keys): an
 * attempt at the keydown's anchored target, run at the missing-`beforeinput`
 * deadline unless a `beforeinput` of the same occurrence confirms it first.
 */
export const admitKeyAttempt = (edytor: Edytor, inputType: string, data?: string) => {
	const attempt = edytor.attempts.admit(
		attemptOf(edytor, { inputType, cancelable: false, data }, inputType),
		'model'
	);
	edytor.attempts.drift(attempt, 'refresh', 50);
	// The missing-`beforeinput` deadline (a named, counted browser rule).
	setTimeout(() => void runKeyAttempt(edytor, attempt));
};

const runKeyAttempt = async (edytor: Edytor, attempt: Attempt) => {
	if (edytor.attempts.key !== attempt) return;
	edytor.attempts.arm(attempt, NATIVE_INPUT_REPAIR_WINDOW_MS);
	// The browser may have moved the selection since the keydown: the key
	// acts on its anchored target, which followed any concurrent edit.
	edytor.selection.commit(attempt.target, 'repair');
	const { state, selectedBlocks } = edytor.selection;
	if (selectedBlocks.size > 0) {
		edytor.selection.selectBlocks(...selectedBlocks);
	} else if (state.startText && state.endText) {
		if (state.isCollapsed) edytor.selection.setAtTextOffset(state.startText, state.yStart);
		else edytor.selection.setAtRange(state.startText, state.yStart, state.endText, state.yEnd);
	} else {
		// Its target is gone (a remote delete): a named no-op.
		edytor.attempts.close(attempt);
		return;
	}
	// A real `beforeinput` or a newer key may have taken over meanwhile.
	if (edytor.attempts.key !== attempt) return;
	await edytor.userInput(() =>
		occur(
			edytor,
			{ inputType: attempt.inputType, cancelable: false },
			attempt,
			INTENTS[attempt.inputType]?.key ?? null,
			attempt
		)
	);
};

export async function onBeforeInput(this: Edytor, event: InputEvent) {
	// The keydown of this occurrence may have admitted its attempt and offered its key.
	const key = this.attempts.confirm();
	const offered = this.keymap.offered;
	this.keymap.offered = null;
	if (event.inputType === 'deleteByDrag' && event.isTrusted) {
		event.preventDefault();
		this.selection.clearPointerDragStart();
		return;
	}

	if (isBrowserOwnedNativeInput(this, event)) {
		this.attempts.clear((attempt) => attempt.owner === 'browser');
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
		key,
		offered
	);
}
