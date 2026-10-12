import type { Edytor } from '$lib/edytor.svelte.js';
import {
	isNativeInteractiveEvent,
	isNativeTextControl,
	isNativeTextControlEvent,
	ownsEvent
} from './nativeInteractiveControl.js';
import { replaceSelectedAtom } from '$lib/session/bindings.js';
import { admitKeyAttempt, isTrailingSoftBreakBackward } from './onBeforeInput.js';
import { INTENTS, intentSnapshot, keyIntentOf, targetless } from '$lib/session/attempt.js';
import { selectionIsInside } from './onFocus.js';

const isEventFromEditor = (edytor: Edytor, event: KeyboardEvent) => {
	const { node, selection } = edytor;
	if (!node) return true;
	const active = node.ownerDocument.activeElement;
	if (active instanceof HTMLElement && !node.contains(active) && isNativeTextControl(active))
		return false;
	// Focus on the host or inside it, or nowhere (the body): a selection of the
	// editor's own (blocks, an atom; a text one under a command chord) takes the key.
	const focused =
		active === node.ownerDocument.body || (active instanceof Node && node.contains(active));
	if (
		focused &&
		(selection.selectedBlocks.size > 0 ||
			selection.selectedInlineBlock.size > 0 ||
			((event.metaKey || event.ctrlKey) && selection.textRange().startText?.node))
	)
		return true;
	if (event.composedPath().includes(node)) return true;
	if (event.target instanceof Node && node.contains(event.target)) return true;
	return selectionIsInside(node);
};

const hasCommandModifier = (event: KeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey;

/** Backspace or Delete on a select or a button: the browser would delete around it in the host. */
const shouldPreventNativeInteractiveDeletionKey = (event: KeyboardEvent) =>
	isNativeInteractiveEvent(event) &&
	!isNativeTextControlEvent(event) &&
	(event.key.toLowerCase() === 'backspace' || event.key.toLowerCase() === 'delete');

/** A command chord at a caret (a block or atom selection projects no caret). */
const shouldRefreshSelectionBeforeKeyDown = (edytor: Edytor, event: KeyboardEvent) =>
	!/^(Alt|Control|Meta|Shift)$/.test(event.key) &&
	hasCommandModifier(event) &&
	edytor.selection.projection.isCollapsed &&
	!isNativeInteractiveEvent(event);

/** A character key with no command modifier (a dead key's name is no character). */
const isPrintableReplacementKey = (event: KeyboardEvent) =>
	!hasCommandModifier(event) && event.key.length === 1;

/** The editing intent of an unmodified key (a character, Backspace, Delete, Enter), if it has one. */
const keyIntent = (event: KeyboardEvent) =>
	event.isComposing || hasCommandModifier(event)
		? null
		: (keyIntentOf(event.key, event.shiftKey) ??
			(isPrintableReplacementKey(event) ? 'insertText' : null));

/**
 * A key that would edit a readonly view (a character, Backspace, Delete,
 * Enter, Tab), outside a text control: never copy, select all or the
 * browser's find (the keymap does not run while readonly).
 */
const shouldPreventReadonlyMutationKey = (event: KeyboardEvent) =>
	/^(.|backspace|delete|enter|tab)$/i.test(event.key) &&
	!((event.metaKey || event.ctrlKey) && /^[acf]$/i.test(event.key)) &&
	!isNativeTextControlEvent(event);

/**
 * The intent a keydown admits when its `beforeinput` may never come: Enter
 * and Shift+Enter, and a Backspace or Delete over a range or at the edge of
 * its block or text (or right after a trailing soft break, for Backspace,
 * which the model deletes). With a
 * command modifier, a word or line chord at the block's edge deletes the
 * neighbour like a character (a unit delete, `runBeforeInputDeleteCommand`); WebKit announces no
 * `beforeinput` for it at the document's first text.
 */
const getStructuralFallbackInputType = (edytor: Edytor, event: KeyboardEvent) => {
	const intent = keyIntentOf(event.key, event.shiftKey);
	const dir = intent && INTENTS[intent]!.dir;
	const { isCollapsed, isAtStartOfBlock, isAtStartOfText, isAtEndOfBlock, isAtEndOfText } =
		edytor.selection.projection;
	const back = dir === 'back';
	const atBlockEdge = back ? isAtStartOfBlock : isAtEndOfBlock;
	if (hasCommandModifier(event))
		return dir && isCollapsed && !event.shiftKey && atBlockEdge ? intent : null;
	if (!dir) return intent;
	const atTextEdge = back ? isAtStartOfText : isAtEndOfText;
	const atMarker = back && isTrailingSoftBreakBackward(intentSnapshot(edytor, intent!));
	return !isCollapsed || atBlockEdge || atTextEdge || atMarker ? intent : null;
};

export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	// A keydown the bindings are not offered offers no key to its `beforeinput`.
	this.keymap.offered = null;
	if (e.defaultPrevented) {
		return;
	}

	if (!isEventFromEditor(this, e)) {
		return;
	}

	// A kind's own control (a field bound to `block.data`, a select, a nested
	// editable island) keeps its keys, whatever the selection: Backspace there
	// never deletes the selected blocks, hotkeys never act on the model.
	// Composed path: a document-level listener sees `e.target` retargeted to
	// the shadow host.
	if (ownsEvent(this.node, e)) {
		if (shouldPreventNativeInteractiveDeletionKey(e)) {
			e.preventDefault();
		}
		return;
	}

	if (this.readonly) {
		if (shouldPreventReadonlyMutationKey(e)) {
			e.preventDefault();
		}
		return;
	}

	if (this.selection.voidField) {
		return;
	}

	// Any other native control (a link, the chrome's buttons beside the host)
	// keeps its keys unless a block selection stands: a grip hands its keys to
	// the blocks it selected.
	if (isNativeInteractiveEvent(e) && this.selection.selectedBlocks.size === 0) {
		if (shouldPreventNativeInteractiveDeletionKey(e)) {
			e.preventDefault();
		}
		return;
	}

	if (this.composition.keydown(e)) {
		return;
	}

	// A press's caret its `selectionchange` has not brought to the model yet
	// (`sel.key.before-adoption`): the key reads the DOM first, as that event
	// would have, so a binding, the fallback and the admission act at it.
	if (this.projector.unobserved()) {
		this.selection.onSelectionChange();
	}

	// A real key past the swallow/island guards is a user gesture —
	// disarm pending deferred restores (phantom composition keys never
	// reach this line).
	// The key is an occurrence with no target (`targetless`, read before the
	// key counts as a gesture): refused at its keydown, in every engine (WebKit
	// reads a Backspace no editing claims as "back"; Chromium parks a caret at
	// the host's start for a printable key, which stays parked).
	const keyed = keyIntent(e);
	const refused = keyed !== null && targetless(this, keyed);

	this.markUserGesture();

	if (refused) {
		e.preventDefault();
		this.dispatcher.record({ operation: keyed, status: 'refused' });
		this.projector.parked();
		return;
	}

	if (shouldRefreshSelectionBeforeKeyDown(this, e)) {
		this.selection.onSelectionChange();
	}

	// One prevention scope per keydown: a veto anywhere in it aborts the key.
	this.dispatcher.scope(() => {
		if (this.keymap.handle(e) || e.defaultPrevented) {
			return;
		}

		// A printable key over a selected inline atom types over it.
		if (isPrintableReplacementKey(e) && replaceSelectedAtom(this, e.key)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}

		const fallbackInputType = getStructuralFallbackInputType(this, e);
		if (fallbackInputType) {
			admitKeyAttempt(this, fallbackInputType);
		} else if (isPrintableReplacementKey(e) && this.selection.selectedBlocks.size > 0) {
			// A printable key over a block selection: the native selection is
			// empty, and Firefox and WebKit announce no `beforeinput` without
			// one — the deadline types it over the blocks (`flow.slot`).
			admitKeyAttempt(this, 'insertText', e.key);
		}
	});
}
