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

const getRootSelection = (node: HTMLElement) => {
	const root = node.getRootNode();
	if (
		typeof ShadowRoot !== 'undefined' &&
		root instanceof ShadowRoot &&
		'getSelection' in root &&
		typeof root.getSelection === 'function'
	) {
		return root.getSelection() as Selection | null;
	}

	return window.getSelection();
};

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

	const selection = getRootSelection(edytor.node);
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

const nativeSelectionNavigationKeys = new Set([
	'arrowleft',
	'arrowright',
	'arrowup',
	'arrowdown',
	'home',
	'end',
	'pageup',
	'pagedown'
]);

const shouldSyncAfterNativeNavigation = (event: KeyboardEvent) =>
	nativeSelectionNavigationKeys.has(event.key.toLowerCase()) &&
	!event.defaultPrevented &&
	!isNativeInteractiveEvent(event);

const getHorizontalFallbackOffset = (event: KeyboardEvent, offset: number, textLength: number) => {
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
		return null;
	}

	const key = event.key.toLowerCase();
	if (key === 'arrowleft' && offset > 0) {
		return offset - 1;
	}

	if (key === 'arrowright' && offset < textLength) {
		return offset + 1;
	}

	return null;
};

const scheduleNativeNavigationSelectionSync = (edytor: Edytor, event: KeyboardEvent) => {
	const syncSelection = () => edytor.selection.onSelectionChange();
	const ownerDocument = edytor.node?.ownerDocument ?? document;
	const originalText = edytor.selection.state.startText;
	const originalOffset = edytor.selection.state.yStart;
	const fallbackOffset =
		originalText && edytor.selection.state.isCollapsed
			? getHorizontalFallbackOffset(event, originalOffset, originalText.length)
			: null;

	ownerDocument.addEventListener('keyup', syncSelection, { once: true, capture: true });

	setTimeout(syncSelection, 0);

	if (typeof window !== 'undefined') {
		window.requestAnimationFrame(syncSelection);
	}

	if (fallbackOffset === null || !originalText) {
		return;
	}

	let isFallbackCanceled = false;
	const cancelFallback = () => {
		isFallbackCanceled = true;
	};
	ownerDocument.addEventListener('keydown', cancelFallback, { once: true, capture: true });

	setTimeout(() => {
		ownerDocument.removeEventListener('keydown', cancelFallback, { capture: true });
		if (isFallbackCanceled) {
			return;
		}

		syncSelection();
		const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
		if (
			!isCollapsed ||
			startText !== originalText ||
			endText !== originalText ||
			yStart !== originalOffset ||
			yEnd !== originalOffset
		) {
			return;
		}

		edytor.selection.setAtTextOffset(originalText, fallbackOffset);
	}, 30);
};

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

	const selection = getRootSelection(startText.node);
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
		edytor.selection.state;

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

		if (shouldSyncAfterNativeNavigation(e)) {
			scheduleNativeNavigationSelectionSync(this, e);
		}

		const fallbackInputType = getStructuralFallbackInputType(this, e);
		if (fallbackInputType) {
			admitKeyAttempt(this, fallbackInputType);
		}
	});
}
