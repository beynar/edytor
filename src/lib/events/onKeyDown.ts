import type { Edytor } from '$lib/edytor.svelte.js';
import { isInsideTrailingNewlineMarker } from '$lib/selection/selection.utils.js';
import {
	isNativeInteractiveEvent,
	isNativeTextControl,
	isNativeTextControlEvent,
	isNestedForeignEditableTarget,
	isNestedForeignEditableEvent
} from './nativeInteractiveControl.js';
import { replaceSelectedAtom } from '$lib/session/bindings.js';
import { admitKeyAttempt } from './onBeforeInput.js';
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

const shouldPreventNativeInteractiveDeletionKey = (event: KeyboardEvent) =>
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

const isReadonlyAllowedShortcut = (event: KeyboardEvent) => {
	const key = event.key.toLowerCase();
	const hasCopyModifier = event.metaKey || event.ctrlKey;
	return hasCopyModifier && (key === 'c' || key === 'a');
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
	if (hasCommandModifier(event)) {
		return null;
	}

	const key = event.key.toLowerCase();
	const { isCollapsed, isAtStartOfBlock, isAtStartOfText, isAtEndOfBlock, isAtEndOfText } =
		edytor.selection.projection;

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
	this.hotKeys.offered = null;
	if (e.defaultPrevented) {
		return;
	}

	if (!isEventFromEditor(this, e)) {
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

	if (isNativeInteractiveEvent(e) && this.selection.selectedBlocks.size === 0) {
		if (shouldPreventNativeInteractiveDeletionKey(e)) {
			e.preventDefault();
		}
		return;
	}

	// Keys inside a nested `contenteditable` island belong to that island —
	// hotkeys and structural fallbacks operate on the MODEL selection,
	// which still points wherever the editor last left it.
	// Composed-path check — the document-level listener sees `e.target`
	// retargeted to the shadow host, which would let island keys through.
	if (
		isNestedForeignEditableTarget(this.node, e.target) ||
		isNestedForeignEditableEvent(this.node, e)
	) {
		return;
	}

	if (this.composition.keydown(e)) {
		return;
	}

	// A real key past the swallow/island guards is a user gesture —
	// disarm pending deferred restores (phantom composition keys never
	// reach this line).
	this.markUserGesture();

	if (shouldRefreshSelectionBeforeKeyDown(this, e)) {
		this.selection.onSelectionChange();
	}

	// One prevention scope per keydown: a veto anywhere in it aborts the key.
	this.dispatcher.scope(() => {
		if (this.hotKeys.handle(e) || e.defaultPrevented) {
			return;
		}

		// A printable key over a selected inline atom types over it (O40).
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
