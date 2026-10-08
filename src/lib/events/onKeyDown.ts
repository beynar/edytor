import type { Edytor } from '$lib/edytor.svelte.js';
import { isInsideTrailingNewlineMarker } from '$lib/selection/selection.utils.js';
import {
	isNativeInteractiveEvent,
	isNativeTextControl,
	isNativeTextControlEvent,
	ownsEvent
} from './nativeInteractiveControl.js';
import { replaceSelectedAtom } from '$lib/session/bindings.js';
import { admitKeyAttempt } from './onBeforeInput.js';
import { targetless } from '$lib/session/attempt.js';
import { getDomSelection } from '$lib/selection/domSelection.js';

const isEventFromEditor = (edytor: Edytor, event: KeyboardEvent) => {
	if (!edytor.node) {
		return true;
	}

	const activeElement = edytor.node.ownerDocument.activeElement;
	const activeElementIsOutsideTextControl =
		activeElement instanceof HTMLElement &&
		!edytor.node.contains(activeElement) &&
		isNativeTextControl(activeElement);
	if (activeElementIsOutsideTextControl) {
		return false;
	}

	const hasEditorOwnedSelection =
		edytor.selection.selectedBlocks.size > 0 || edytor.selection.selectedInlineBlock.size > 0;
	if (
		hasEditorOwnedSelection &&
		(activeElement === edytor.node ||
			activeElement === edytor.node.ownerDocument.body ||
			(activeElement instanceof Node && edytor.node.contains(activeElement)))
	) {
		return true;
	}

	if (event.composedPath().includes(edytor.node)) {
		return true;
	}

	if (event.target instanceof Node && edytor.node.contains(event.target)) {
		return true;
	}

	const hasModelTextSelection = Boolean(edytor.selection.state.startText?.node);
	if (
		(event.metaKey || event.ctrlKey) &&
		hasModelTextSelection &&
		(activeElement === edytor.node ||
			activeElement === edytor.node.ownerDocument.body ||
			(activeElement instanceof Node && edytor.node.contains(activeElement)))
	) {
		return true;
	}

	const selection = getDomSelection(edytor.node);
	return Boolean(
		selection?.anchorNode &&
		(edytor.node.contains(selection.anchorNode) ||
			(selection.focusNode && edytor.node.contains(selection.focusNode)))
	);
};

const hasCommandModifier = (event: KeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey;

/** Backspace or Delete on a select or a button: the browser would delete around it in the host. */
const shouldPreventNativeInteractiveDeletionKey = (event: KeyboardEvent) =>
	isNativeInteractiveEvent(event) &&
	!isNativeTextControlEvent(event) &&
	(event.key.toLowerCase() === 'backspace' || event.key.toLowerCase() === 'delete');

const modifierKeys = new Set(['Alt', 'Control', 'Meta', 'Shift']);

const shouldRefreshSelectionBeforeKeyDown = (edytor: Edytor, event: KeyboardEvent) =>
	!modifierKeys.has(event.key) &&
	hasCommandModifier(event) &&
	edytor.selection.state.isCollapsed &&
	edytor.selection.selectedBlocks.size === 0 &&
	edytor.selection.selectedInlineBlock.size === 0 &&
	!isNativeInteractiveEvent(event);

const isPrintableReplacementKey = (event: KeyboardEvent) => {
	if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Dead') {
		return false;
	}

	return event.key.length === 1;
};

/** The editing intent of an unmodified key (a character, Backspace, Delete, Enter), if it has one. */
const keyIntent = (event: KeyboardEvent) => {
	if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;
	if (event.key === 'Backspace') return 'deleteContentBackward';
	if (event.key === 'Delete') return 'deleteContentForward';
	if (event.key === 'Enter') return event.shiftKey ? 'insertLineBreak' : 'insertParagraph';
	return isPrintableReplacementKey(event) ? 'insertText' : null;
};

/** Copy, select all and the browser's find (the keymap does not run while readonly). */
const isReadonlyAllowedShortcut = (event: KeyboardEvent) => {
	const key = event.key.toLowerCase();
	const hasCopyModifier = event.metaKey || event.ctrlKey;
	return hasCopyModifier && (key === 'c' || key === 'a' || key === 'f');
};

const isReadonlyNavigationKey = (event: KeyboardEvent) =>
	[
		'arrowleft',
		'arrowright',
		'arrowup',
		'arrowdown',
		'home',
		'end',
		'pageup',
		'pagedown',
		'escape'
	].includes(event.key.toLowerCase());

const shouldPreventReadonlyMutationKey = (event: KeyboardEvent) => {
	if (isNativeTextControlEvent(event)) {
		return false;
	}

	if (isReadonlyAllowedShortcut(event) || isReadonlyNavigationKey(event)) {
		return false;
	}

	const key = event.key.toLowerCase();
	return (
		key.length === 1 || key === 'backspace' || key === 'delete' || key === 'enter' || key === 'tab'
	);
};

const isBackspaceFromTrailingNewlineMarker = (edytor: Edytor) => {
	const { isCollapsed, startText, yStart } = edytor.selection.state;
	if (
		!isCollapsed ||
		!startText?.node ||
		!startText.endsWithNewline ||
		yStart !== startText.length
	) {
		return false;
	}

	const selection = getDomSelection(startText.node);
	const anchorNode = selection?.anchorNode;
	return Boolean(anchorNode && isInsideTrailingNewlineMarker(anchorNode));
};

const getStructuralFallbackInputType = (
	edytor: Edytor,
	event: KeyboardEvent
): InputEvent['inputType'] | null => {
	const key = event.key.toLowerCase();
	const { isCollapsed, isAtStartOfBlock, isAtStartOfText, isAtEndOfBlock, isAtEndOfText } =
		edytor.selection.projection;

	if (hasCommandModifier(event)) {
		// A word or line chord at the block's edge deletes the neighbour like a
		// character (`deleteCollapsedUnit`); WebKit announces no `beforeinput`
		// for it at the document's first text (SW10-crdt-1).
		if (!isCollapsed || event.shiftKey) return null;
		if (key === 'backspace' && isAtStartOfBlock) return 'deleteContentBackward';
		if (key === 'delete' && isAtEndOfBlock) return 'deleteContentForward';
		return null;
	}

	if (key === 'enter') {
		return event.shiftKey ? 'insertLineBreak' : 'insertParagraph';
	}

	if (key === 'backspace') {
		if (isBackspaceFromTrailingNewlineMarker(edytor)) {
			return 'deleteContentBackward';
		}

		return !isCollapsed || isAtStartOfBlock || isAtStartOfText ? 'deleteContentBackward' : null;
	}

	if (key === 'delete') {
		return !isCollapsed || isAtEndOfBlock || isAtEndOfText ? 'deleteContentForward' : null;
	}

	return null;
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

	if (this.selection.state.isVoidEditableElement) {
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
