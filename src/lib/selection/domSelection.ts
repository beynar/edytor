/**
 * The DOM selection of the document or shadow root holding a node, and a
 * snapshot of it: its endpoints as plain values and its ranges, a
 * multi-range selection (Firefox) read as its bounding range.
 */
type Root = ShadowRoot & { getSelection?: () => Selection | null };

const ownerOf = (node?: Node | null): Document | null =>
	node?.ownerDocument ?? (typeof document === 'undefined' ? null : document);

/** The shadow root holding `node`, if any. */
const shadowOf = (node?: Node | null): Root | null => {
	const root = node?.getRootNode();
	return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : null;
};

const documentSelection = (node?: Node | null) => {
	const owner = ownerOf(node);
	return owner?.defaultView?.getSelection?.() ?? owner?.getSelection?.() ?? null;
};

export type DomSelectionSnapshot = Pick<
	Selection,
	'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset' | 'isCollapsed' | 'rangeCount'
> & { getRangeAt: (index: number) => Range };

export const getDomSelection = (node?: Node | null): Selection | null =>
	shadowOf(node)?.getSelection?.() ?? documentSelection(node);

export const getActiveElement = (node?: Node | null): Element | null =>
	shadowOf(node)?.activeElement ?? ownerOf(node)?.activeElement ?? null;

export const clearDomSelection = (node?: Node | null) => {
	getDomSelection(node)?.removeAllRanges();
};

export const createDomRange = (node: Node): Range => {
	const owner = ownerOf(node);
	if (!owner) throw new Error('Cannot create a DOM range without an owner document');
	return owner.createRange();
};

/** A snapshot of one range, forward. */
export const createDomSelectionSnapshotFromRange = (range: Range): DomSelectionSnapshot => ({
	anchorNode: range.startContainer,
	anchorOffset: range.startOffset,
	focusNode: range.endContainer,
	focusOffset: range.endOffset,
	isCollapsed: range.collapsed,
	rangeCount: 1,
	getRangeAt: () => range
});

/**
 * A snapshot of `selection`. Several ranges inside `container` are read as
 * their bounding range, and the DOM is canonicalized to it too, so what the
 * user sees matches what the model derives (the editor has no multi-range
 * model); one is read alone.
 */
const snapshotOf = (selection: Selection, container?: Node | null): DomSelectionSnapshot => {
	const ranges: Range[] = [];
	for (let index = 0; selection.rangeCount > 1 && index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		if (
			!container ||
			(container.contains(range.startContainer) && container.contains(range.endContainer))
		)
			ranges.push(range);
	}
	if (ranges.length === 1) return createDomSelectionSnapshotFromRange(ranges[0]);
	if (ranges.length > 1) {
		const [first, last] = ranges.reduce(
			([first, last], range) => [
				range.compareBoundaryPoints(Range.START_TO_START, first) < 0 ? range : first,
				range.compareBoundaryPoints(Range.END_TO_END, last) > 0 ? range : last
			],
			[ranges[0], ranges[0]]
		);
		const bounds = createDomRange(first.startContainer);
		bounds.setStart(first.startContainer, first.startOffset);
		bounds.setEnd(last.endContainer, last.endOffset);
		selection.removeAllRanges();
		selection.addRange(bounds);
		return createDomSelectionSnapshotFromRange(bounds);
	}
	const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
	return {
		anchorNode,
		anchorOffset,
		focusNode,
		focusOffset,
		isCollapsed: anchorNode === focusNode && anchorOffset === focusOffset,
		rangeCount: selection.rangeCount,
		getRangeAt: (index) => selection.getRangeAt(index)
	};
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
	const selection = root && getDomSelection(root);
	const focusNode = selection?.focusNode;
	if (!selection || !focusNode || selection.rangeCount === 0 || !root.contains(focusNode)) return;
	const active = getActiveElement(root);
	if (!active || !root.contains(active)) return;
	const element = focusNode instanceof Element ? focusNode : focusNode.parentElement;
	if (!element) return;
	// A scratch range collapsed at the FOCUS endpoint: a backward range
	// scrolls to the moving edge, a caret gets its exact box. The offset is
	// clamped — a foreign DOM mutation can leave the selection past a
	// shrunken node, and `setStart` throws out of bounds.
	const caret = createDomRange(focusNode);
	const max =
		focusNode instanceof Element ? focusNode.childNodes.length : (focusNode.nodeValue?.length ?? 0);
	caret.setStart(focusNode, Math.min(selection.focusOffset, max));
	caret.collapse(true);
	// Optional-chained: jsdom has no range rects; an empty caret rect reads
	// the element's box, in real browsers too.
	const rect = caret.getBoundingClientRect?.();
	const box =
		rect && (rect.top !== 0 || rect.bottom !== 0) ? rect : element.getBoundingClientRect();
	const clips = (r: { top: number; bottom: number; left: number; right: number }) =>
		box.top < r.top || box.bottom > r.bottom || box.left < r.left || box.right > r.right;
	const document = element.ownerDocument;
	const view = document.defaultView;
	const { clientWidth, clientHeight } = document.documentElement;
	// The viewport clips it, or a scrolling ancestor does while it stays in
	// the window (the "editor inside a scrollable pane" case).
	let clipped = clips({
		top: 0,
		left: 0,
		bottom: view?.innerHeight ?? clientHeight,
		right: view?.innerWidth ?? clientWidth
	});
	for (
		let ancestor = element.parentElement;
		!clipped && view?.getComputedStyle && ancestor && ancestor !== document.documentElement;
		ancestor = ancestor.parentElement
	) {
		const { overflow, overflowX, overflowY } = view.getComputedStyle(ancestor);
		clipped =
			/(auto|scroll|hidden)/.test(`${overflow} ${overflowX} ${overflowY}`) &&
			clips(ancestor.getBoundingClientRect());
	}
	if (clipped) element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
};

export const getDomSelectionSnapshot = (node?: Node | null): DomSelectionSnapshot | null => {
	const root = shadowOf(node);
	const selection = documentSelection(node);
	if (root) {
		const own = root.getSelection?.();
		if (own?.anchorNode) return snapshotOf(own, node);
		// A selection inside a shadow root the document only reports composed.
		const [composed] = selection?.getComposedRanges?.({ shadowRoots: [root] }) ?? [];
		if (
			composed &&
			root.contains(composed.startContainer) &&
			root.contains(composed.endContainer)
		) {
			const range = createDomRange(composed.startContainer);
			range.setStart(composed.startContainer, composed.startOffset);
			range.setEnd(composed.endContainer, composed.endOffset);
			return createDomSelectionSnapshotFromRange(range);
		}
	}
	return selection && snapshotOf(selection, node);
};
