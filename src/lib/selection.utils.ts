import type { Edytor } from './edytor.svelte.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Text } from './text/text.svelte.js';

export function getTextOfNode(this: EdytorSelection, node: Node | null) {
	if (!node) return null;
	let text: Text | null = null;
	let currentNode = node;
	while (currentNode.parentElement && !text) {
		text = this.edytor.nodeToText.get(currentNode) || null;
		currentNode = currentNode.parentElement;
	}
	return text;
}
export function getTextsInSelection(
	this: EdytorSelection,
	startNode: Node | null,
	endNode: Node | null,
	ranges: Range[]
): {
	startText: Text | null;
	endText: Text | null;
	texts: Text[];
} {
	const startText = this.getTextOfNode(startNode);
	const endText = this.getTextOfNode(endNode);

	if (!startText) {
		return {
			startText: null,
			endText: null,
			texts: []
		};
	}
	const edytor = this.edytor;

	const isAfterFirstText = (node: Node) => {
		return node.compareDocumentPosition(startText.node!) === Node.DOCUMENT_POSITION_FOLLOWING;
	};
	const isBeforeLastText = (node: Node) => {
		return (
			node.compareDocumentPosition(endText?.node! || startText.node!) ===
			Node.DOCUMENT_POSITION_PRECEDING
		);
	};

	const texts: Text[] = [];
	// Create a TreeWalker to traverse nodes within the range
	const walker = document.createTreeWalker(
		ranges[0].commonAncestorContainer,
		NodeFilter.SHOW_ELEMENT, // Only consider element nodes
		(node) => {
			return node === startText.node ||
				node === endText?.node ||
				(node instanceof HTMLSpanElement &&
					node.hasAttribute('data-edytor-text') &&
					isAfterFirstText(node) &&
					isBeforeLastText(node))
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		}
	);
	ranges.forEach((range) => {
		const isNodeInRange = (node: Node): boolean => {
			const nodeRange = document.createRange();
			try {
				nodeRange.selectNode(node);
			} catch (e) {
				// If the node cannot be selected, it's not a valid target
				return false;
			}
			// Check if the start or end of the node range intersects with the original range
			return (
				range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0 &&
				range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0
			);
		};
		// Start traversing the nodes within the range
		while (walker.nextNode()) {
			// If the current node is within the range, add it to the spans array
			if (isNodeInRange(walker.currentNode)) {
				texts.push(edytor.nodeToText.get(walker.currentNode as Element) as Text);
			}
		}
	});

	if (!texts.length) {
		texts.splice(0, 0, startText);
		if (endText && endText.node !== startText.node) {
			texts.splice(texts.length, 0, endText);
		}
	}
	return {
		startText,
		endText,
		texts
	};
}

export const getYIndex = (text: Text | null, node: Node | null, _start: number) => {
	if (!text || !node) return _start;
	const parent = text.node!;

	const treeWalker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, (child) => {
		return child.textContent &&
			child.compareDocumentPosition(node) === Node.DOCUMENT_POSITION_FOLLOWING
			? NodeFilter.FILTER_ACCEPT
			: NodeFilter.FILTER_SKIP;
	});
	let start = _start;

	while (treeWalker.nextNode()) {
		const child = treeWalker.currentNode;
		if (child.textContent) {
			start += child.textContent.length;
		}
	}
	return start;
};

export const getRangesFromSelection = (selection: Selection): Range[] => {
	return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
};
