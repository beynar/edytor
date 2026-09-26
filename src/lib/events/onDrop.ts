import {
	isNativeInteractiveControl,
	isNestedForeignEditableTarget
} from './nativeInteractiveControl.js';

/**
 * Payloads the editor can consume on drop. Preventing `dragover` is what
 * enables a drop, so it is prevented only for these types — internal and
 * unsupported drags keep the browser's not-allowed affordance and can never
 * produce a native DOM mutation.
 *
 * `Files` is intentionally accepted: file drops route through the plugin
 * `onPaste` hook (the Files → image seam — no bundled consumer claims them
 * yet, and unclaimed files insert nothing).
 */
const ACCEPTED_FOREIGN_DROP_TYPES = ['Files', 'text/html', 'text/plain', 'text/uri-list'];

// Internal block-move drags (src/lib/plugins/blockHandles/) tag their
// payload with this private mime type.
const EDYTOR_BLOCK_DRAG_MIME = 'application/x-edytor-block-id';

// `dataTransfer.types` cannot distinguish a foreign text drop from an
// editor-owned text drag (Chrome exposes text/plain + text/html for both).
// Track the drag source instead: a `dragstart` inside the editor's root node
// marks the drag as editor-owned, and editor-owned drags never become
// drops — internal drag-move is not supported (the paired `deleteByDrag` /
// `insertFromDrop` beforeinput events are also suppressed there).
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
// beforeinput, so the accepted payload is re-dispatched as a synthetic
// beforeinput that the regular input pipeline consumes — same routing as
// `insertFromPaste`, with the resolved drop point reported as the target
// range.
const dispatchInsertFromDrop = (root: Element, event: DragEvent) => {
	const caret = caretRangeFromPoint(
		root.ownerDocument as CaretPointDocument,
		event.clientX,
		event.clientY
	);
	const targetRanges =
		caret && root.contains(caret.container)
			? [createCollapsedStaticRange(caret.container, caret.offset)]
			: [];

	const beforeInput = new Event('beforeinput', {
		bubbles: true,
		cancelable: true
	}) as InputEvent;
	Object.defineProperties(beforeInput, {
		inputType: { value: 'insertFromDrop', configurable: true },
		dataTransfer: { value: event.dataTransfer, configurable: true },
		getTargetRanges: { value: () => targetRanges, configurable: true }
	});
	root.dispatchEvent(beforeInput);
};

/**
 * Root `dragover`/`drop` handler (registered for both event types in
 * `edytor.svelte.ts`).
 *
 * - `dragover`: prevented only when the payload is an accepted foreign drop —
 *   that is what enables the drop. Internal drags (block-handle mime or an
 *   editor-sourced dragstart) and unsupported payloads are left unprevented.
 * - `drop`: always consumed — a native drop would mutate the DOM outside the
 *   model. Accepted foreign payloads are funneled into the beforeinput
 *   pipeline as `insertFromDrop`; everything else is swallowed.
 */
export const preventUnsupportedDrop = (event: DragEvent) => {
	const root = event.currentTarget;
	if (!(root instanceof Element)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	observeInternalDragSources(root.getRootNode());

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

	event.preventDefault();
	event.stopPropagation();

	if (!isAcceptedForeignDrop(root, event.dataTransfer)) {
		return;
	}
	if (
		isNativeInteractiveControl(event.target) ||
		isNestedForeignEditableTarget(root, event.target)
	) {
		// A drop onto a native control or a nested editable island inside
		// the editor keeps the historical swallow — consumed without a
		// model write.
		return;
	}
	dispatchInsertFromDrop(root, event);
};
