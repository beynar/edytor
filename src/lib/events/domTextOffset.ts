/**
 * Character offset of the DOM point `(node, offset)` inside `textNode`: the
 * text of the text nodes before it, in document order (Svelte's anchors
 * are comments and carry none) — the one DOM→model point mapper
 * (`getYIndex` adds the editor's marker, boundary and filler rules on top;
 * `domPointOf` is its inverse). A text-node point carries a character
 * offset, an element point (Firefox's node-bound caret) a child index;
 * either past its node's end clamps to it. A point outside `textNode` clamps
 * to the nearest edge by document position (an ancestor's point resolves
 * through its child index); a disconnected one keeps its offset.
 */
export const getTextContentOffsetAtPoint = (textNode: Node, node: Node, offset: number) => {
	if (textNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_DISCONNECTED) return offset;
	const range = (textNode.ownerDocument ?? document).createRange();
	range.selectNodeContents(textNode);
	const at = Math.min(
		offset,
		node.nodeType === Node.TEXT_NODE ? (node as CharacterData).length : node.childNodes.length
	);
	const side = range.comparePoint(node, at);
	if (side < 0) return 0;
	if (side === 0) range.setEnd(node, at);
	return range.toString().length;
};
