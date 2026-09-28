const hasSelectionApi = (root: Node): root is Node & { getSelection: () => Selection | null } =>
	typeof (root as Node & { getSelection?: unknown }).getSelection === 'function';

const isShadowRoot = (root: Node | undefined): root is ShadowRoot =>
	typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot;

const getOwnerDocument = (node?: Node | null): Document | null =>
	node?.ownerDocument ?? (typeof document === 'undefined' ? null : document);

export type DomSelectionSnapshot = Pick<
	Selection,
	| 'anchorNode'
	| 'anchorOffset'
	| 'direction'
	| 'focusNode'
	| 'focusOffset'
	| 'isCollapsed'
	| 'rangeCount'
	| 'toString'
> & {
	getRangeAt: (index: number) => Range;
	nativeSelection: Selection | null;
	type?: string;
};

const getDocumentSelection = (node?: Node | null) => {
	const ownerDocument = getOwnerDocument(node);
	return ownerDocument?.defaultView?.getSelection?.() ?? ownerDocument?.getSelection?.() ?? null;
};

export const getDomSelection = (node?: Node | null): Selection | null => {
	const root = node?.getRootNode();
	if (isShadowRoot(root) && hasSelectionApi(root)) {
		const selection = root.getSelection();
		if (selection) {
			return selection;
		}
	}

	return getDocumentSelection(node);
};

export const getActiveElement = (node?: Node | null): Element | null => {
	const root = node?.getRootNode();
	if (isShadowRoot(root)) {
		return root.activeElement ?? getOwnerDocument(node)?.activeElement ?? null;
	}

	return getOwnerDocument(node)?.activeElement ?? null;
};

export const clearDomSelection = (node?: Node | null) => {
	getDomSelection(node)?.removeAllRanges();
};

export const createDomRange = (node: Node): Range => {
	const ownerDocument = getOwnerDocument(node);
	if (!ownerDocument) {
		throw new Error('Cannot create a DOM range without an owner document');
	}
	return ownerDocument.createRange();
};

const isSelectionCollapsed = (selection: Selection) =>
	selection.anchorNode === selection.focusNode && selection.anchorOffset === selection.focusOffset;

const createDomSelectionSnapshot = (selection: Selection): DomSelectionSnapshot => ({
	anchorNode: selection.anchorNode,
	anchorOffset: selection.anchorOffset,
	direction: selection.direction,
	focusNode: selection.focusNode,
	focusOffset: selection.focusOffset,
	isCollapsed: isSelectionCollapsed(selection),
	rangeCount: selection.rangeCount,
	getRangeAt: (index) => selection.getRangeAt(index),
	nativeSelection: selection,
	toString: () => selection.toString(),
	type: (selection as Selection & { type?: string }).type
});

export const createDomSelectionSnapshotFromRange = (
	range: Range,
	nativeSelection: Selection | null = null
): DomSelectionSnapshot => ({
	anchorNode: range.startContainer,
	anchorOffset: range.startOffset,
	direction: 'forward',
	focusNode: range.endContainer,
	focusOffset: range.endOffset,
	isCollapsed: range.collapsed,
	rangeCount: 1,
	getRangeAt: (index) => {
		if (index !== 0) {
			throw new Error(`Selection range ${index} is unavailable`);
		}
		return range;
	},
	nativeSelection,
	toString: () => range.toString(),
	type: range.collapsed ? 'Caret' : 'Range'
});

const createRangeFromStaticRange = (staticRange: StaticRange) => {
	const range = createDomRange(staticRange.startContainer);
	range.setStart(staticRange.startContainer, staticRange.startOffset);
	range.setEnd(staticRange.endContainer, staticRange.endOffset);
	return range;
};

const isNodeInside = (root: Node, target: Node) => root === target || root.contains(target);

const getContainedRanges = (selection: Selection, container?: Node | null) => {
	const ranges: Range[] = [];
	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		if (
			!container ||
			(isNodeInside(container, range.startContainer) && isNodeInside(container, range.endContainer))
		) {
			ranges.push(range);
		}
	}
	return ranges;
};

const createDomSelectionSnapshotFromMultiRange = (
	selection: Selection,
	container?: Node | null
): DomSelectionSnapshot | null => {
	if (selection.rangeCount <= 1) {
		return null;
	}

	const ranges = getContainedRanges(selection, container);
	if (ranges.length === 0) {
		return null;
	}

	if (ranges.length === 1) {
		return createDomSelectionSnapshotFromRange(ranges[0], selection);
	}

	let firstRange = ranges[0];
	let lastRange = ranges[0];
	for (const range of ranges.slice(1)) {
		if (range.compareBoundaryPoints(Range.START_TO_START, firstRange) < 0) {
			firstRange = range;
		}
		if (range.compareBoundaryPoints(Range.END_TO_END, lastRange) > 0) {
			lastRange = range;
		}
	}

	const combinedRange = createDomRange(firstRange.startContainer);
	combinedRange.setStart(firstRange.startContainer, firstRange.startOffset);
	combinedRange.setEnd(lastRange.endContainer, lastRange.endOffset);
	// Not just a read: a multi-range selection is canonicalized to its
	// bounding range in the DOM too, so what the user sees matches the
	// snapshot the model derives (the editor has no multi-range model).
	selection.removeAllRanges();
	selection.addRange(combinedRange);
	return createDomSelectionSnapshotFromRange(combinedRange, selection);
};

const getComposedRangeSnapshot = (
	root: ShadowRoot,
	selection: Selection | null
): DomSelectionSnapshot | null => {
	if (typeof selection?.getComposedRanges !== 'function') {
		return null;
	}

	const [staticRange] = selection.getComposedRanges({ shadowRoots: [root] });
	if (
		!staticRange ||
		!root.contains(staticRange.startContainer) ||
		!root.contains(staticRange.endContainer)
	) {
		return null;
	}

	const range = createRangeFromStaticRange(staticRange);
	return createDomSelectionSnapshotFromRange(range, selection);
};

/**
 * Scroll the caret into view after a programmatic selection write.
 *
 * Browsers scroll on NATIVE input — but on the event-first path every
 * keystroke is `preventDefault`ed and the caret is re-written through
 * `selection.addRange`/`setBaseAndExtent`, which never scrolls. Without
 * this, typing past the bottom of the scrollport walks the caret
 * offscreen (PM `scrollRectIntoView` / Lexical `scrollIntoViewIfNeeded`
 * do this on every selection-affecting transaction).
 *
 * Gates:
 * - only when the editor root holds focus — a selection write from a
 *   non-issuing view (remote sync, programmatic API on an unfocused
 *   editor) must never move the page under the user;
 * - only when the caret rect is actually clipped — `scrollIntoView` with
 *   `block:'nearest'` otherwise still nudges scroll containers.
 */
export const scrollCaretIntoView = (root: Element | null | undefined) => {
	if (!root) {
		return;
	}
	const selection = getDomSelection(root);
	const focusNode = selection?.focusNode;
	if (!selection || !focusNode || selection.rangeCount === 0 || !root.contains(focusNode)) {
		return;
	}
	const activeElement = getActiveElement(root);
	if (activeElement !== root && !(activeElement && root.contains(activeElement))) {
		return;
	}

	// Collapse a scratch range at the FOCUS endpoint so a backward range
	// scrolls to the moving edge, and collapsed carets get the exact
	// caret box rather than the element box. The offset is clamped — a
	// foreign DOM mutation can leave the selection pointing past a
	// shrunken node, and `setStart` throws on out-of-bounds offsets.
	const caretRange = createDomRange(focusNode);
	const maxOffset =
		focusNode instanceof Element ? focusNode.childNodes.length : (focusNode.nodeValue?.length ?? 0);
	caretRange.setStart(focusNode, Math.min(selection.focusOffset, maxOffset));
	caretRange.collapse(true);
	const element = focusNode instanceof Element ? focusNode : focusNode.parentElement;
	if (!element) {
		return;
	}
	// Optional-chained: non-layout environments (jsdom) don't implement
	// range rects — the element box is the fallback in real browsers too
	// when the caret rect comes back empty.
	const caretRect = caretRange.getBoundingClientRect?.() ?? null;
	const box =
		caretRect && (caretRect.top !== 0 || caretRect.bottom !== 0)
			? caretRect
			: element.getBoundingClientRect();

	const view = element.ownerDocument.defaultView;
	const viewportHeight = view?.innerHeight ?? element.ownerDocument.documentElement.clientHeight;
	const viewportWidth = view?.innerWidth ?? element.ownerDocument.documentElement.clientWidth;
	const insideViewport =
		box.top >= 0 && box.bottom <= viewportHeight && box.left >= 0 && box.right <= viewportWidth;

	// The viewport check alone is not enough — an `overflow:auto/scroll/
	// hidden` ancestor clips the caret while it stays inside the window
	// viewport (the common "editor inside a scrollable pane" case). Walk
	// the ancestor chain; any scrollable clip counts as out-of-view.
	let clippedByScroller = false;
	if (insideViewport && view?.getComputedStyle) {
		for (
			let ancestor = element.parentElement;
			ancestor && ancestor !== element.ownerDocument.documentElement;
			ancestor = ancestor.parentElement
		) {
			const style = view.getComputedStyle(ancestor);
			const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
			if (!/(auto|scroll|hidden)/.test(overflow)) {
				continue;
			}
			const rect = ancestor.getBoundingClientRect();
			if (
				box.top < rect.top ||
				box.bottom > rect.bottom ||
				box.left < rect.left ||
				box.right > rect.right
			) {
				clippedByScroller = true;
				break;
			}
		}
	}

	if (insideViewport && !clippedByScroller) {
		return;
	}
	element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
};

export const getDomSelectionSnapshot = (node?: Node | null): DomSelectionSnapshot | null => {
	const root = node?.getRootNode();
	const documentSelection = getDocumentSelection(node);

	if (isShadowRoot(root)) {
		if (hasSelectionApi(root)) {
			const shadowSelection = root.getSelection();
			if (shadowSelection?.anchorNode) {
				return (
					createDomSelectionSnapshotFromMultiRange(shadowSelection, node) ??
					createDomSelectionSnapshot(shadowSelection)
				);
			}
		}

		const composedSnapshot = getComposedRangeSnapshot(root, documentSelection);
		if (composedSnapshot) {
			return composedSnapshot;
		}
	}

	return documentSelection
		? (createDomSelectionSnapshotFromMultiRange(documentSelection, node) ??
				createDomSelectionSnapshot(documentSelection))
		: null;
};
