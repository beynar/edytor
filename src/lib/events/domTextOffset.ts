const getChildTextLengthBeforeOffset = (element: Node, offset: number) => {
	let length = 0;
	const end = Math.min(offset, element.childNodes.length);
	for (let index = 0; index < end; index++) {
		// Svelte's hydration comments carry data, never text.
		const child = element.childNodes[index];
		if (child.nodeType !== Node.COMMENT_NODE) length += child.textContent?.length ?? 0;
	}
	return length;
};

/**
 * Character offset of the DOM point `(node, offset)` inside `textNode`,
 * counting text content in document order — the same point→offset rule
 * `getYIndex` (selection.utils.ts) applies. Two point shapes exist: a
 * text-node anchor carries a character offset; an element anchor
 * (Firefox's node-bound caret shape) carries a CHILD INDEX, so the text
 * content of the children before that index is counted instead. Points
 * outside `textNode` clamp to the nearest edge by document position —
 * an ancestor anchor resolves through the child-index boundary.
 */
export const getTextContentOffsetAtPoint = (textNode: Node, node: Node, offset: number) => {
	if (textNode !== node && !textNode.contains(node)) {
		const position = textNode.compareDocumentPosition(node);
		if (position & Node.DOCUMENT_POSITION_DISCONNECTED) {
			return offset;
		}
		if (position & Node.DOCUMENT_POSITION_CONTAINS) {
			// `node` is an ancestor of `textNode` — `offset` indexes its
			// children, so the whole text sits on one side of the boundary.
			let child: Node = textNode;
			while (child.parentNode && child.parentNode !== node) {
				child = child.parentNode;
			}
			const index =
				child.parentNode === node ? Array.prototype.indexOf.call(node.childNodes, child) : -1;
			return index !== -1 && index < offset ? (textNode.textContent?.length ?? 0) : 0;
		}
		return position & Node.DOCUMENT_POSITION_FOLLOWING ? (textNode.textContent?.length ?? 0) : 0;
	}

	const pointOffset =
		node.nodeType === Node.TEXT_NODE
			? Math.min(offset, node.textContent?.length ?? 0)
			: getChildTextLengthBeforeOffset(node, offset);

	let total = pointOffset;
	const treeWalker = (textNode.ownerDocument ?? document).createTreeWalker(
		textNode,
		NodeFilter.SHOW_TEXT,
		(child) =>
			child.compareDocumentPosition(node) === Node.DOCUMENT_POSITION_FOLLOWING
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP
	);
	while (treeWalker.nextNode()) {
		total += treeWalker.currentNode.textContent?.length ?? 0;
	}
	return total;
};
