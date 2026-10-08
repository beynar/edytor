/**
 * Focus and pointer ownership of one attached view (installed by
 * `Edytor.attach`): who owns focus and the selection — the editor, or the
 * user outside it (`lastUserGestureOutsideEditor`) — the gesture serial for
 * pointer and focus gestures, and the cached caret a keyboard or
 * programmatic focus returns to. Answers the listeners' teardown.
 */
import { on } from 'svelte/events';
import type { Edytor } from '../edytor.svelte.js';
import {
	clearDomSelection,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from '../selection/domSelection.js';
import { getYIndex } from '../selection/selection.utils.js';

const getEventTimeStamp = (event: Event | undefined) =>
	event?.timeStamp || (typeof performance === 'undefined' ? Date.now() : performance.now());

/** The DOM selection has an endpoint inside `node`. */
export const selectionIsInside = (node: HTMLElement) => {
	const selection = getDomSelection(node);
	return Boolean(
		selection?.anchorNode &&
		(node.contains(selection.anchorNode) ||
			(selection.focusNode && node.contains(selection.focusNode)))
	);
};

/**
 * The editor takes the keys after a pointer gesture on its chrome (a block
 * drop, a column resize, a grip click no menu answers): its host gets the
 * focus, without scrolling, as the editor's own focus (`focusin` restores
 * no cached caret and counts no gesture), so Mod+Z, Mod+Shift+Z and the
 * block-selection keys act at once, whatever the selection (a block
 * selection, or none: an undo giving back "no selection" keeps them). The
 * projector stays the only DOM-selection writer. Nothing when the focus is
 * already inside the host, or the view is gone.
 */
export const takeKeys = (edytor: Edytor) => {
	const node = edytor.node;
	if (!node?.isConnected || edytor.destroyed) return;
	const active = getActiveElement(node);
	if (active instanceof Node && node.contains(active)) return;
	edytor.expectInternalFocus();
	node.focus({ preventScroll: true });
	edytor.projector.parked();
};

/*
 * The press: one per primary button press, its `pointerdown`, or a
 * `mousedown` no `pointerdown` came before. WebKit fires no `pointercancel`
 * at a native `dragstart` (a block handle's drag) and, believing the button
 * still down, no `pointerdown` for the next press, only its `mousedown`
 * (WebKit bugs 202287, 222632, 279749): that primary `mousedown` is the
 * press (lone). `attachFocus` classifies each `mousedown` of its view's
 * document at the capture phase, first of the view's listeners; the lone one
 * of each view is kept here, read by `isLonePress` and `onPress`.
 */
const lonePresses = new WeakMap<Edytor, MouseEvent>();

/**
 * Whether `event` is the press of a primary `mousedown` no `pointerdown`
 * came before (WebKit's first press after a drag). Asked during the
 * event's dispatch, after the document's capture phase saw it: by a
 * listener the view's attach installs later (a plugin's `onEdytorAttached`)
 * or by an element's own (bubbling, target phase), such as the chrome in the
 * overlay, which starts from it as from a `pointerdown`.
 */
export const isLonePress = (edytor: Edytor, event: MouseEvent) => lonePresses.get(edytor) === event;

/**
 * Every press on `target` (`isLonePress`): its `pointerdown`, or the lone
 * `mousedown` standing for a missing one, never both for one press. For a
 * listener installed after the view's attach (a plugin's press outside its
 * menu). Answers the teardown.
 */
export const onPress = (
	edytor: Edytor,
	target: EventTarget,
	listener: (event: MouseEvent) => void,
	options?: boolean | AddEventListenerOptions
) => {
	const lone = (event: Event) => {
		if (isLonePress(edytor, event as MouseEvent)) listener(event as MouseEvent);
	};
	target.addEventListener('pointerdown', listener as EventListener, options);
	target.addEventListener('mousedown', lone, options);
	return () => {
		target.removeEventListener('pointerdown', listener as EventListener, options);
		target.removeEventListener('mousedown', lone, options);
	};
};

export const attachFocus = (edytor: Edytor, node: HTMLElement): (() => void)[] => {
	let lastPointerDownInsideEditorAt = Number.NEGATIVE_INFINITY;

	/*
	 * A primary `pointerdown` arms `compat` until the `mousedown` it is
	 * followed by (before or after its release, a touch's comes after), so a
	 * pair counts once. Only the browser's own `mousedown` stands for a
	 * missing press; a script's is none (`lonePresses`).
	 */
	let compat = false;
	const lone = (event: MouseEvent) => isLonePress(edytor, event);

	/** Where the press landed: the gesture serial, and whether the user went outside. */
	const gesture = (event: MouseEvent) => {
		edytor.markUserGesture();
		edytor.lastUserGestureOutsideEditor = Boolean(
			event.target instanceof Node && !edytor.node?.contains(event.target)
		);
	};

	/** A press inside the host (its bubbling phase: an element inside that took it keeps it). */
	const pressInside = (event: MouseEvent) => {
		// A pointer gesture abandons a live composition.
		edytor.composition.abandon();
		lastPointerDownInsideEditorAt = getEventTimeStamp(event);
		edytor.projector.pressed();
		edytor.selection.clearModelSelectionPreservation();
		edytor.selection.capturePointerDragStart(event);
		edytor.selection.clearInlineBlockSelection();
		edytor.selection.collapseSelectedBlocksAtPointer(event);
	};

	const clearNativeSelectionAfterExternalFocus = () => {
		const activeElement = getActiveElement(node);
		if (activeElement instanceof Node && node.contains(activeElement)) {
			return;
		}
		if (selectionIsInside(node)) {
			clearDomSelection(node);
		}
	};

	const restoreCachedSelectionAfterKeyboardFocus = (event: FocusEvent) => {
		if (edytor.readonly || event.target !== node) {
			return;
		}

		if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) {
			return;
		}

		if (getEventTimeStamp(event) - lastPointerDownInsideEditorAt < 250) {
			return;
		}

		const text = edytor.selection.state.startText;
		if (!text) {
			return;
		}

		const offset = edytor.selection.state.yStart;
		const applyMeaningfulDomSelection = () => {
			const selection = getDomSelectionSnapshot(node);
			if (!selection?.anchorNode || !selection.focusNode) {
				return false;
			}

			if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) {
				return false;
			}

			const anchorText = edytor.selection.getTextOfNode(selection.anchorNode);
			const focusText = edytor.selection.getTextOfNode(selection.focusNode);
			if (!anchorText || !focusText) {
				return false;
			}

			const isBrowserFocusReset =
				selection.isCollapsed &&
				anchorText === edytor.root?.firstEditableText &&
				getYIndex(anchorText, selection.anchorNode, selection.anchorOffset) === 0;
			if (isBrowserFocusReset) {
				return false;
			}

			edytor.selection.applySelectionSnapshot(selection);
			return true;
		};
		const restore = () => {
			if (getActiveElement(node) !== node) {
				return;
			}

			if (applyMeaningfulDomSelection()) {
				return;
			}

			const s = edytor.selection.state;
			// A remote delivery or command may have legitimately moved the
			// selection since the focus-time capture — the CURRENT state
			// owns the caret then; writing the cached point would yank it
			// back to a pre-update position. The cache only wins while the
			// state still equals it, or when the browser collapsed the
			// caret to its focus-reset spot (first editable text at 0).
			if (!s.isCollapsed || !s.startText) {
				return;
			}
			const focusReset = s.startText === edytor.root?.firstEditableText && s.yStart === 0;
			const [targetText, targetOffset] = focusReset ? [text, offset] : [s.startText, s.yStart];
			if (!targetText?.node?.isConnected) {
				return;
			}

			edytor.selection.setAtTextOffset(targetText, Math.min(targetOffset, targetText.length));
		};

		queueMicrotask(restore);
	};

	return [
		// Any press anywhere disarms pending restores — Firefox can move
		// the DOM selection on outside clicks without blurring the editor,
		// so node-local marking is not enough. The target also records
		// where the gesture landed: an outside press means the current
		// focus/selection is user-owned until an inside gesture or focusin
		// returns it.
		on(
			node.ownerDocument,
			'pointerdown',
			(event: PointerEvent) => {
				if (event.isPrimary) compat = true;
				lonePresses.delete(edytor);
				gesture(event);
			},
			{ capture: true }
		),
		on(
			node.ownerDocument,
			'mousedown',
			(event: MouseEvent) => {
				const press = !compat && event.isTrusted && event.button === 0;
				compat = false;
				if (!press) return void lonePresses.delete(edytor);
				lonePresses.set(edytor, event);
				gesture(event);
			},
			{ capture: true }
		),
		// A press on a block's non-editable chrome places the caret in its text.
		on(node, 'pointerdown', edytor.selection.handleNonNativeEditableBlockChromePointerDown, {
			capture: true
		}),
		on(
			node,
			'mousedown',
			(event: MouseEvent) => {
				if (lone(event)) edytor.selection.handleNonNativeEditableBlockChromePointerDown(event);
			},
			{ capture: true }
		),
		// The document's capture listener already marked the gesture.
		on(node, 'pointerdown', pressInside),
		on(node, 'mousedown', (event: MouseEvent) => {
			if (lone(event)) pressInside(event);
		}),
		on(node, 'pointerup', (event: PointerEvent) => {
			edytor.markUserGesture();
			edytor.selection.restoreInlineAtomDragRange(event);
		}),
		// A drag released OUTSIDE the editor never reaches the node-level
		// pointerup — without this `pointerDragStart` stays armed forever
		// and remote-edit restores would stay suppressed.
		on(node.ownerDocument, 'pointerup', () => {
			edytor.markUserGesture();
			edytor.selection.clearPointerDragStart();
		}),
		on(node.ownerDocument, 'pointercancel', () => {
			edytor.selection.clearPointerDragStart();
		}),
		on(node, 'focusin', (event: FocusEvent) => {
			// Focus arriving back inside the editor re-establishes editor
			// ownership of the selection.
			edytor.lastUserGestureOutsideEditor = false;
			// The editor's own programmatic `focus()` calls (selection
			// writes refocus the text host) also fire focusin — with a
			// relatedTarget already inside the editor they're internal
			// housekeeping, not user gestures. Click-driven focus returns
			// are already marked by the document-level pointerdown capture.
			// The projector focused the host for its own display: nothing to restore.
			if (edytor.consumeInternalFocus()) return;
			if (!(event.relatedTarget instanceof Node && edytor.node?.contains(event.relatedTarget))) {
				edytor.markUserGesture();
				// A focus from outside (Tab, an app's `focus()`) places the user's caret.
				edytor.projector.pressed();
			}
			restoreCachedSelectionAfterKeyboardFocus(event);
		}),
		on(node, 'focusout', (event: FocusEvent) => {
			// Focus moving to a concrete element outside the editor is the
			// same user evidence as an outside pointerdown — mark the
			// gesture. A blur with NO relatedTarget is different: either
			// the focused node was detached by a render (e.g. the undo's
			// own DOM update replacing the caret's text — programmatic
			// churn that must not disarm a pending restore) or an OS/window
			// blur (restoring a caret in a blurred editor is harmless —
			// the selection holds until focus returns). Outside clicks
			// were already marked by the pointerdown capture listener.
			if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
			if (event.relatedTarget instanceof Node) {
				edytor.markUserGesture();
				edytor.lastUserGestureOutsideEditor = true;
			}
			// Focus leaving abandons a live composition: the browser committed what it shows.
			edytor.composition.abandon();
			setTimeout(clearNativeSelectionAfterExternalFocus);
		}),
		() => void lonePresses.delete(edytor)
	];
};
