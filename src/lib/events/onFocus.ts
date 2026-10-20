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
	focusIn,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from '../selection/domSelection.js';
import { getYIndex } from '../selection/selection.utils.js';
import { noSelection } from '../session/selection.js';
import { observeInternalDragSources } from './onDrop.js';

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
 * The editor takes the keys back: after a pointer gesture on its chrome (a
 * block drop, a column resize, a grip click no menu answers), a menu, panel,
 * toolbar or field of the chrome giving them back, or `edytor.focus()`. The
 * one way to focus the host from code: its host gets the
 * focus, without scrolling, as the editor's own focus (`focusin` restores
 * no cached caret and counts no gesture), so Mod+Z, Mod+Shift+Z and the
 * block-selection keys act at once, whatever the selection (a block
 * selection, or none: an undo giving back "no selection" keeps them). The
 * caret the browser parks for that focus (at the host's start) is drift,
 * never adopted, and the value is displayed over it: a key typed right
 * after lands at the selection, not at the host's start. The projector
 * stays the only DOM-selection writer. Nothing when the host already has
 * the focus (a kind's own control inside it does not), or the view is gone.
 */
export const takeKeys = (edytor: Edytor) => {
	const node = edytor.node;
	if (!node?.isConnected || edytor.destroyed) return;
	if (getActiveElement(node) === node) return;
	edytor.expectInternalFocus(node);
	edytor.projector.parked();
	edytor.selection.display();
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
	// Where the host lives (the document, or a shadow root): its drags' sources.
	observeInternalDragSources(node.getRootNode());
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

	/**
	 * A press outside the view and its chrome (the overlay's menus, handles,
	 * toolbar) ends its block selection (`sel.blocks.outside`, Notion): the
	 * selection is none. Shift or Mod keeps it (a marquee from the page's
	 * margin adds to it), and so does an app element marked
	 * `data-edytor-keep-selection` (its own toolbar acting on the blocks).
	 */
	const pressOutside = (event: MouseEvent) => {
		const { target } = event;
		if (edytor.selection.value.kind !== 'blocks' || !(target instanceof Node)) return;
		if (edytor.node?.contains(target) || edytor.overlay.layer?.contains(target)) return;
		if (event.shiftKey || event.metaKey || event.ctrlKey) return;
		const element = target instanceof Element ? target : target.parentElement;
		if (element?.closest('[data-edytor-keep-selection]')) return;
		edytor.selection.commit(noSelection);
	};

	/**
	 * A press the model answers: on the host's own area, the margin gesture's
	 * (the marquee, `sel.marquee`, which gives a click back); below the last
	 * block, the trailing paragraph; on a block's chrome, its caret.
	 */
	const placingPress = (event: MouseEvent) => {
		const { pointer } = edytor.selection;
		// A control of a block's chrome owns its whole press (`sel.press.void`).
		if (pointer.ownPress(event)) return void (pointer.claimed = false);
		if (pointer.marginPress(event)) return;
		if (!pointer.belowPress(event)) pointer.chromePress(event);
	};

	/** A press inside the host (its bubbling phase: an element inside that took it keeps it). */
	const pressInside = (event: MouseEvent) => {
		// A pointer gesture abandons a live composition.
		edytor.composition.abandon();
		lastPointerDownInsideEditorAt = event.timeStamp;
		const { pointer } = edytor.selection;
		// The margin gesture's press places no caret and starts no text drag; a
		// control's press is the control's (`sel.press.void`).
		if (pointer.claimed || pointer.ownPress(event)) return;
		edytor.projector.pressed();
		pointer.capture(event);
		edytor.selection.clearInlineBlockSelection();
		pointer.collapseBlocksAt(event);
	};

	const clearNativeSelectionAfterExternalFocus = () => {
		if (!focusIn(node) && selectionIsInside(node)) clearDomSelection(node);
	};

	/**
	 * A keyboard or programmatic focus returns to the model's selection: the
	 * caret the browser puts at the start for the focus (its focus reset) is
	 * not the user's, so the value is shown again; any other DOM selection of
	 * the host's is the focus's own and adopted.
	 */
	const restoreAfterKeyboardFocus = (event: FocusEvent) => {
		if (edytor.readonly || event.target !== node) return;
		if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
		if (event.timeStamp - lastPointerDownInsideEditorAt < 250) return;
		if (!edytor.selection.projection.start) return;
		queueMicrotask(() => {
			if (getActiveElement(node) !== node) return;
			const dom = getDomSelectionSnapshot(node);
			const { anchorNode, focusNode } = dom ?? {};
			const text = anchorNode && edytor.selection.getTextOfNode(anchorNode);
			const own =
				text &&
				focusNode &&
				node.contains(anchorNode) &&
				node.contains(focusNode) &&
				edytor.selection.getTextOfNode(focusNode) &&
				!(
					dom!.isCollapsed &&
					text === edytor.root?.firstEditableText &&
					getYIndex(text, anchorNode, dom!.anchorOffset) === 0
				);
			if (own) edytor.selection.applySelectionSnapshot(dom);
			else edytor.selection.select(edytor.selection.value);
		});
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
				pressOutside(event);
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
				pressOutside(event);
			},
			{ capture: true }
		),
		// A press below the last block goes to the trailing paragraph; one on a
		// block's non-editable chrome places the caret in its text.
		on(node, 'pointerdown', placingPress, {
			capture: true
		}),
		on(
			node,
			'mousedown',
			(event: MouseEvent) => {
				if (lone(event)) placingPress(event);
				else edytor.selection.pointer.marginMouse(event);
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
			edytor.selection.pointer.restoreAtomRange(event);
		}),
		// A drag released OUTSIDE the editor never reaches the node-level
		// pointerup — without this `pointerDragStart` stays armed forever
		// and remote-edit restores would stay suppressed.
		on(node.ownerDocument, 'pointerup', () => {
			edytor.markUserGesture();
			edytor.selection.pointer.release();
		}),
		on(node.ownerDocument, 'pointercancel', () => {
			edytor.selection.pointer.release();
		}),
		// A release the page never saw (over a frame of another origin, or in
		// Firefox outside the window): the next move with no button down ends
		// the drag, or the projector would stay held until the next press.
		on(node.ownerDocument, 'pointermove', (event: PointerEvent) => {
			if (event.buttons === 0 && edytor.selection.dragging) edytor.selection.pointer.release();
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
			restoreAfterKeyboardFocus(event);
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
