import type { Edytor } from '../edytor.svelte.js';
import { vetoable } from '$lib/utils.js';
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
import { runBeforeInputCommand } from './beforeInputCommands.js';
import { readDomText } from './onInput.js';

/** The Android no-op-Backspace and model-owned drift deadlines (named, counted browser rules). */
const NATIVE_INPUT_REPAIR_WINDOW_MS = 150;

const dirOf = (inputType: string) => INTENTS[inputType]?.dir;

/** An insertion at the caret the user placed (not a drop point, not a break). */
const inserts = (inputType: string) => {
	const kind = kindOf(inputType);
	return (
		inputType.startsWith('insert') && inputType !== 'insertFromDrop' && !!kind && kind !== 'break'
	);
};

/**
 * Whether the range the browser declared, not the model selection, is where
 * the attempt acts: never for history, nor for an insertion the model keeps
 * its selection for, nor over a model range (but for a replacement or a
 * drop); an insertion at the admitted caret keeps its edge side (Chromium
 * re-reports ` tail`@0 as `Link`@4); a delete whose extent the model
 * computes takes only a caret edge inside one text (Firefox declares
 * block-level containers for word and line deletes).
 */
const declares = (edytor: Edytor, a: Attempt, range: StaticRange) => {
	const { reported, inputType: intent, isCollapsed } = a;
	const insertion = inserts(intent);
	if (kindOf(reported) === 'history') return false;
	// The kept selection may be re-selected: the attempt reads it again.
	if (insertion && edytor.selection.consumeModelSelectionPreservationForTextInsertion())
		return void reproject(edytor, a);
	if (
		!isCollapsed &&
		(insertion ? intent !== 'insertReplacementText' : kindOf(intent) === 'break' || dirOf(intent))
	)
		return false;
	const start = edytor.selection.getTextOfNode(range.startContainer);
	const end = edytor.selection.getTextOfNode(range.endContainer);
	const from = getYIndex(start, range.startContainer, range.startOffset);
	const to = getYIndex(end, range.endContainer, range.endOffset);
	if (
		insertion &&
		isCollapsed &&
		start === a.startText &&
		end === start &&
		from === a.yStart &&
		to === from
	)
		return false;
	const dir = dirOf(reported);
	return (
		!dir ||
		(!!start &&
			start === end &&
			from >= 0 &&
			from <= to &&
			to <= start.length &&
			(from !== to || (dir === 'back' ? from > 0 : from < start.length)))
	);
};

/** The declared range becomes the model selection: the DOM selection is not a transport. */
const adoptDeclared = (edytor: Edytor, a: Attempt, declared: StaticRange) => {
	const range = createDomRange(declared.startContainer);
	const { startContainer, startOffset, endContainer, endOffset } = declared;
	const dir = dirOf(a.reported);
	if (dir && a.isCollapsed) {
		// A collapsed caret's delete: the declared range only locates its edge.
		if (dir === 'back') range.setStart(endContainer, endOffset);
		else range.setStart(startContainer, startOffset);
		range.collapse(true);
	} else {
		range.setStart(startContainer, startOffset);
		range.setEnd(endContainer, endOffset);
	}
	edytor.selection.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range), {
		restoreNormalizedDomRange: false
	});
	reproject(edytor, a);
};

/**
 * Undo-scope walk (Lexical #6714): when a control OUTSIDE the editor exhausts
 * its own undo stack, Chromium/WebKit re-dispatch `historyUndo`/`historyRedo`
 * at the contenteditable root. Those are not the editor's: no
 * `preventDefault`, the owning scope handles them. A focused element outside
 * owns the command; with nothing focused (the body, the document, the shadow
 * host that retargets inner focus) the DOM selection decides.
 */
const isForeignHistory = (edytor: Edytor) => {
	const node = edytor.node;
	if (!node) return true;
	const active = getActiveElement(node);
	if (active && (active === node || node.contains(active))) return false;
	const root = node.getRootNode();
	const { body, documentElement } = node.ownerDocument;
	if (
		active &&
		active !== (root instanceof ShadowRoot ? root.host : null) &&
		active !== body &&
		active !== documentElement
	)
		return true;
	const anchor = getDomSelection(node)?.anchorNode;
	return !anchor || !node.contains(anchor);
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

/**
 * The owner rule, one answer per attempt: the browser performs a text-local
 * change — an insertion it reports without letting the model take it (but a
 * tab or a mention trigger), a replacement or rearrangement (transpose, yank:
 * no data the model could insert), a character delete inside the text (not a
 * trailing soft break's, whose `<br>` it mishandles) — and the attempt
 * expects that change on its host (`deleteCompositionText`: none to check).
 * The model performs everything else; the answer is then how long it owns
 * the DOM drift around it and how it repairs it: a browser write it could
 * not prevent is discarded (text, payloads, breaks) or restored around (a
 * delete).
 */
const nativeOf = (edytor: Edytor, a: Attempt): Expect | null | [Drift, number] => {
	const { inputType: type, startText: text, cancelable, isCollapsed } = a;
	const kind = kindOf(type);
	const plain = !a.hasDataTransferTextPayload;
	const local =
		!edytor.selection.selectedBlocks.size &&
		!!text &&
		text === a.endText &&
		!a.isTextSpanning &&
		!a.isBlockSpanning;
	const change = (after: string | null = null): Expect => ({ kind: 'change', host: text!, after });
	if (local) {
		if (
			isCollapsed &&
			!cancelable &&
			type === 'insertText' &&
			a.data !== '\t' &&
			!(a.data === '@' && edytor.inlineBlocks.has('mention'))
		) {
			const before = text!.stringContent;
			return change(before.slice(0, a.yStart) + a.data + before.slice(a.yStart));
		}
		if (isCollapsed && plain && type === 'insertReplacementText') return change();
		if (
			plain &&
			!a.data &&
			/^insert(Transpose|FromYank)$/.test(type) &&
			!edytor.selection.selectedInlineBlock.size
		)
			return change();
		if (
			!cancelable &&
			!a.isStructuralKeyFallback &&
			/^deleteContent(Back|For)ward$/.test(type) &&
			!isTrailingSoftBreakBackward(a) &&
			!(isCollapsed && (dirOf(type) === 'back' ? a.isAtStartOfText : a.isAtEndOfText))
		)
			return change();
	}
	if (type === 'deleteCompositionText') return null;
	if (cancelable) return ['refresh', 0];
	if (kind === 'delete') return ['restore', NATIVE_INPUT_REPAIR_WINDOW_MS];
	return kind === 'break' || kind === 'payload' || /^insert(Text|ReplacementText)$/.test(type)
		? ['discard', NATIVE_INPUT_REPAIR_WINDOW_MS]
		: ['refresh', 0];
};

/**
 * Android can announce a non-cancelable Backspace it never performs. At the
 * deadline, the attempt that no adoption applied deletes one grapheme before
 * its anchored caret — unless the caret moved or a native change is pending.
 */
const androidNoOpBackspaceDeadline = (edytor: Edytor, attempt: Attempt) => {
	const text = attempt.startText!;
	if (
		!isAndroidChromeBrowser() ||
		attempt.inputType !== 'deleteContentBackward' ||
		!attempt.isCollapsed
	)
		return;
	setTimeout(() => {
		// Did this attempt's adoption apply (or refuse) a deletion?
		if (
			attempt.phase === 'applied' ||
			attempt.phase === 'failed' ||
			!text.isInDocument ||
			!sameValue(edytor.selection.value, attempt.target) ||
			readDomText(text) !== text.stringContent
		)
			return;
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
const isTrailingSoftBreakBackward = ({ inputType, yStart, yEnd, startText }: Attempt) =>
	inputType === 'deleteContentBackward' &&
	yStart === yEnd &&
	!!startText?.stringContent.endsWith('\n') &&
	yStart === startText.length;

/**
 * Perform a model-owned attempt as one user command (undo policy, prevention
 * scope): the key's bindings first (offered once per occurrence: the key it
 * stands for when no keydown offered it — Android, virtual keyboards; a
 * non-cancelable intent too, its attempt owns the browser's drift either
 * way), then its drift expectation, the extension hook and the intent's
 * command.
 */
const perform = (
	edytor: Edytor,
	attempt: Attempt,
	offered: string | null,
	[mode, window]: [Drift, number]
) =>
	edytor.dispatcher.run(attempt.inputType, async () => {
		const { event, inputType, data } = attempt;
		const kind = kindOf(inputType);
		attempt.phase = 'applied';
		event?.preventDefault();
		const key = inputType === 'insertText' && data === '\t' ? 'tab' : INTENTS[inputType]?.key;
		// A binding claimed the intent: its command owns the result, the
		// observer repairs what the browser did around it.
		if (key && key !== offered && edytor.keymap.run(key)) return;
		// The live composition host is the session's: no drift expectation on it.
		if (kind !== 'composition') edytor.attempts.drift(attempt, mode, window);
		if (kind === 'history') return edytor[inputType as 'historyUndo' | 'historyRedo']();
		try {
			if (event)
				for (const plugin of edytor.plugins)
					vetoable((prevent) => plugin.onBeforeInput?.({ prevent, e: event }));
			await runBeforeInputCommand(edytor, attempt);
		} catch (error) {
			attempt.phase = 'failed';
			throw error;
		}
		if (mode !== 'refresh') edytor.attempts.arm(attempt, window);
		// The command selected its caret; a paste re-renders the text it landed in.
		const text = edytor.selection.state.startText;
		if (inputType === 'insertFromPaste' && text?.node?.isConnected) text.refreshFromModel();
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
	key: Attempt | null,
	offered: string | null,
	reuse?: Attempt
) => {
	const { event, declared } = occurrence;
	const intent = intentOf(occurrence.inputType, occurrence.data ?? null, key?.inputType);
	if (kindOf(intent) !== 'composition') edytor.composition.occurred(intent);
	const drop = () => reuse && edytor.attempts.close(reuse);
	// Admission: an intent with no target is refused before the declared range
	// (where the browser parked its own caret) could become one. Nothing is
	// written; a browser write that cannot be prevented is drift the model
	// owns until the deadline (a composition's is its session's: the tail
	// restores its pinned host).
	if (targetless(edytor, intent)) {
		drop();
		edytor.dispatcher.record({ operation: occurrence.inputType, status: 'refused' });
		// The caret the browser placed for this key is its own, never adopted.
		edytor.projector.parked();
		if (occurrence.cancelable || !event) return event?.preventDefault();
		if (kindOf(occurrence.inputType) === 'composition') return;
		const attempt = edytor.attempts.admit(attemptOf(edytor, occurrence, key?.inputType), 'model');
		attempt.phase = 'failed';
		return edytor.attempts.drift(attempt, 'discard', NATIVE_INPUT_REPAIR_WINDOW_MS);
	}
	const attempt = reuse ? reproject(edytor, reuse) : attemptOf(edytor, occurrence, key?.inputType);
	if (!reuse && declared && declares(edytor, attempt, declared))
		adoptDeclared(edytor, attempt, declared);
	// A native control's input over a block or atom selection (the others are
	// the browser's, before any admission) writes nothing either.
	if (
		edytor.readonly ||
		attempt.isVoidEditableElement ||
		(event && isNativeInteractiveControl(event.target))
	)
		return drop();
	const native = nativeOf(edytor, attempt);
	if (!Array.isArray(native)) {
		edytor.dispatcher.cut(attempt.inputType);
		edytor.attempts.admit(attempt, 'browser', native);
		return androidNoOpBackspaceDeadline(edytor, attempt);
	}
	if (!edytor.dispatcher.permits()) {
		event?.preventDefault();
		return drop();
	}
	if (!reuse) edytor.attempts.admit(attempt, 'model');
	return perform(edytor, attempt, offered, native);
};

/** The keydown's attempt this occurrence confirms, and the chord it offered the bindings. */
const keyed = (edytor: Edytor) => {
	const offered = edytor.keymap.offered;
	edytor.keymap.offered = null;
	return [edytor.attempts.confirm(), offered] as const;
};

/** An occurrence with no `beforeinput` of its own (paste, drop, a line break found in the DOM). */
export const runOccurrence = (edytor: Edytor, occurrence: Occurrence) =>
	occur(edytor, occurrence, ...keyed(edytor));

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
	edytor.selection.select(attempt.target);
	// Its target is gone (a remote delete): a named no-op.
	if (!edytor.selection.projection.start) return edytor.attempts.close(attempt);
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
	const [key, offered] = keyed(this);
	const { inputType } = event;
	const kind = kindOf(inputType);
	if (inputType === 'deleteByDrag' && event.isTrusted) {
		event.preventDefault();
		return this.selection.pointer.release();
	}
	if (isBrowserOwnedNativeInput(this, event))
		return this.attempts.clear((attempt) => attempt.owner === 'browser');
	const declared = event.getTargetRanges?.()[0] ?? null;
	const node = this.node;
	if (
		declared &&
		!(node?.contains(declared.startContainer) && node.contains(declared.endContainer))
	)
		return event.preventDefault();
	if (kind === 'history' && isForeignHistory(this)) return;
	// A history command landing mid-composition would consume capture groups
	// (and the preview's own model writes) while the IME still owns the DOM
	// node: swallowed, undo applies cleanly after the commit. A paste or drop
	// mid-composition is left to the browser (PM input.ts:656-660): the
	// preview owns the write path, the observer reconciles it after the end.
	if (this.isComposing && (kind === 'history' || kind === 'payload'))
		return kind === 'history' ? event.preventDefault() : undefined;
	return occur(
		this,
		{
			inputType,
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
