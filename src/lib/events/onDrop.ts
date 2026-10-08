import type { Edytor } from '$lib/edytor.svelte.js';
import { isNativeInteractiveControl, ownsEvent } from './nativeInteractiveControl.js';
import { runOccurrence } from './onBeforeInput.js';
import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import { endTextDrag, startTextDrag, textDragOf } from '$lib/clipboard/moveText.js';
import { getDomSelection } from '$lib/selection/domSelection.js';

/**
 * Payloads the editor can consume on drop. Preventing `dragover` is what
 * enables a drop, so it is prevented only for these types — internal and
 * unsupported drags keep the browser's not-allowed affordance and can never
 * produce a native DOM mutation.
 *
 * `Files` is intentionally accepted: file drops route through the plugin
 * `onPaste` hook (the Files → image seam: the image plugin with `upload`
 * claims image files; unclaimed files insert nothing).
 */
const ACCEPTED_FOREIGN_DROP_TYPES = ['Files', 'text/html', 'text/plain', 'text/uri-list'];

// Internal block-move drags (src/lib/plugins/blockHandles/) tag their
// payload with this private mime type.
const EDYTOR_BLOCK_DRAG_MIME = 'application/x-edytor-block-id';

// `dataTransfer.types` cannot distinguish a foreign text drop from an
// editor-owned text drag (Chrome exposes text/plain + text/html for both).
// Track the drag source instead: a `dragstart` inside the editor's root node
// marks the drag as editor-owned. An editor-owned drag is a drop only when
// it is the view's own text drag (`textDragOf`: a selected range dragged,
// moved by `dropText`); the browser's paired `deleteByDrag` /
// `insertFromDrop` beforeinput events never run (the drop is prevented,
// and `deleteByDrag` is suppressed).
let internalDragSource: Node | null = null;
const observedDragRoots = new WeakSet<Node>();

export const observeInternalDragSources = (rootNode: Node | null | undefined) => {
	if (!rootNode || observedDragRoots.has(rootNode)) {
		return;
	}
	observedDragRoots.add(rootNode);
	// Capture phase so a listener attached to a shadow root still observes
	// the real (unretargeted) drag source.
	rootNode.addEventListener(
		'dragstart',
		(event) => {
			internalDragSource = event.target instanceof Node ? event.target : null;
		},
		true
	);
	rootNode.addEventListener(
		'dragend',
		() => {
			internalDragSource = null;
		},
		true
	);
};

if (typeof document !== 'undefined') {
	observeInternalDragSources(document);
}

const isInternalDrag = (root: Element, dataTransfer: DataTransfer | null) => {
	if (dataTransfer && Array.from(dataTransfer.types).includes(EDYTOR_BLOCK_DRAG_MIME)) {
		return true;
	}
	return internalDragSource !== null && root.contains(internalDragSource);
};

/**
 * A foreign drop on a kind's own control (a field bound to `block.data`, a
 * nested editable island) is the control's (`ownsEvent`): the editor writes
 * nothing and the browser does what the control does with it. Not a file,
 * which the browser would open in place of the page: that one is swallowed.
 */
const isControlDrop = (root: Element, event: DragEvent) =>
	!Array.from(event.dataTransfer?.types ?? []).includes('Files') && ownsEvent(root, event);

/**
 * The view's own text drag: a selected text range dragged from
 * inside the host, the block handles' drags excluded (their payload's MIME).
 */
const isTextDrag = (edytor: Edytor | undefined, root: Element, dataTransfer: DataTransfer | null) =>
	edytor !== undefined &&
	textDragOf(edytor) !== undefined &&
	!Array.from(dataTransfer?.types ?? []).includes(EDYTOR_BLOCK_DRAG_MIME) &&
	internalDragSource !== null &&
	root.contains(internalDragSource);

/** Where the view's text drag may land: an editable view, in its text, not a kind's control. */
const takesTextDrop = (edytor: Edytor, root: Element, event: DragEvent) =>
	!edytor.readonly &&
	edytor.dispatcher.permits() &&
	!edytor.isComposing &&
	!ownsEvent(root, event) &&
	!isNativeInteractiveControl(event.target);

/** `target` (a drag's source) lies in the host's selected DOM range. */
const startsInSelection = (root: Element, target: EventTarget | null) => {
	const selection = getDomSelection(root);
	if (!selection?.rangeCount || !(target instanceof Node)) return false;
	try {
		return selection.getRangeAt(0).intersectsNode(target);
	} catch {
		return false;
	}
};

/**
 * A `dragstart` in the host over a selected text range (a press inside it,
 * then a drag): the view's text drag. Its data is the range as a clipboard
 * fragment (a copy's: the private MIME, HTML and plain text), so a drop in
 * another editor or app takes it as a paste; in this view, `dropText` moves
 * it. A drag from a kind's own control is the control's, and one that starts
 * outside the selected range (another draggable in the host) is its own.
 */
export const onTextDragStart = (edytor: Edytor, event: DragEvent) => {
	endTextDrag(edytor);
	const root = edytor.node;
	const value = edytor.selection.value;
	if (!root || ownsEvent(root, event) || value.kind !== 'text') return;
	if (edytor.selection.state.isCollapsed || edytor.isComposing) return;
	// Only a drag of the selection itself: another draggable in the host drags its own thing.
	if (!startsInSelection(root, event.target)) return;
	const fragment = createEdytorClipboardFragment(edytor);
	if (!fragment) return;
	writeEdytorClipboardData(event.dataTransfer, fragment, edytor);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = edytor.readonly ? 'copy' : 'copyMove';
	startTextDrag(edytor, { range: value, fragment });
	// The press is a drag now, no longer a selection (Chromium cancels its pointer here; the
	// other engines send no release until the drop).
	edytor.selection.pointer.release();
};

/** The drag ended, dropped or not: no text drag. */
export const onTextDragEnd = (edytor: Edytor) => endTextDrag(edytor);

const isAcceptedForeignDrop = (root: Element, dataTransfer: DataTransfer | null) => {
	if (!dataTransfer || isInternalDrag(root, dataTransfer)) {
		return false;
	}
	return Array.from(dataTransfer.types).some((type) => ACCEPTED_FOREIGN_DROP_TYPES.includes(type));
};

type CaretPointDocument = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

// `caretPositionFromPoint` is the spec API (Firefox, Chromium ≥128);
// `caretRangeFromPoint` is the legacy WebKit/Chromium API. Support both.
const caretRangeFromPoint = (doc: CaretPointDocument, x: number, y: number) => {
	const position = doc.caretPositionFromPoint?.(x, y);
	if (position?.offsetNode) {
		return { container: position.offsetNode, offset: position.offset };
	}
	const range = doc.caretRangeFromPoint?.(x, y);
	if (range) {
		return { container: range.startContainer, offset: range.startOffset };
	}
	return null;
};

const createCollapsedStaticRange = (container: Node, offset: number): StaticRange => {
	if (typeof StaticRange === 'function') {
		try {
			return new StaticRange({
				startContainer: container,
				startOffset: offset,
				endContainer: container,
				endOffset: offset
			});
		} catch {
			// Fall through to the structural StaticRange below.
		}
	}
	return {
		startContainer: container,
		startOffset: offset,
		endContainer: container,
		endOffset: offset,
		collapsed: true
	} as StaticRange;
};

// Preventing the drop suppresses the browser's own `insertFromDrop`
// beforeinput, so the accepted payload is the occurrence itself — the same
// routing as `insertFromPaste`, with the resolved drop point as its declared
// target range.
const insertFromDrop = (edytor: Edytor, root: Element, event: DragEvent) => {
	const caret = caretRangeFromPoint(
		root.ownerDocument as CaretPointDocument,
		event.clientX,
		event.clientY
	);
	return runOccurrence(edytor, {
		inputType: 'insertFromDrop',
		dataTransfer: event.dataTransfer,
		declared:
			caret && root.contains(caret.container)
				? createCollapsedStaticRange(caret.container, caret.offset)
				: null,
		cancelable: true
	});
};

/**
 * Root `dragover`/`drop` handler (registered for both event types in
 * `edytor.svelte.ts`).
 *
 * - `dragover`: prevented only when the payload is an accepted foreign drop —
 *   that is what enables the drop. Internal drags (block-handle mime or an
 *   editor-sourced dragstart) and unsupported payloads are left unprevented.
 * - `drop`: consumed — a native drop would mutate the DOM outside the
 *   model. Accepted foreign payloads are funneled into the beforeinput
 *   pipeline as `insertFromDrop`; everything else is swallowed. The one
 *   exception is a foreign drop other than a file on a kind's own control,
 *   which is the control's (`isControlDrop`).
 */
export const preventUnsupportedDrop = (event: DragEvent, edytor?: Edytor) => {
	const root = event.currentTarget;
	if (!(root instanceof Element)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	observeInternalDragSources(root.getRootNode());

	// The view's own text drag: a move (a copy with Alt) where it may land.
	if (isTextDrag(edytor, root, event.dataTransfer)) {
		const takes = takesTextDrop(edytor!, root, event);
		if (event.type === 'dragover') {
			if (!takes) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const drag = textDragOf(edytor!)!;
		if (!takes) return;
		drag.copy = event.altKey;
		// Its occurrence's handler takes it (`dropText`): the drop is the paste of a move.
		drag.dropping = true;
		return insertFromDrop(edytor!, root, event);
	}

	if (event.type === 'dragover') {
		if (isAcceptedForeignDrop(root, event.dataTransfer)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'copy';
			}
		}
		return;
	}

	const accepted = isAcceptedForeignDrop(root, event.dataTransfer);
	if (accepted && isControlDrop(root, event)) return;
	event.preventDefault();
	event.stopPropagation();

	if (!accepted) {
		return;
	}
	if (ownsEvent(root, event) || isNativeInteractiveControl(event.target)) {
		// A file dropped on a kind's control, or a drop on a link, is
		// swallowed — consumed without a model write.
		return;
	}
	// Mid-composition drops are swallowed: the preview owns the write path.
	if (edytor && !edytor.isComposing) return insertFromDrop(edytor, root, event);
};
