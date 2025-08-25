import { EdytorSelection } from './selection.svelte.js';
import { Text } from '../text/text.svelte.js';
import { Block } from '$lib/block/block.svelte.js';
import { Edytor } from '$lib/edytor.svelte.js';
import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';

export function getTextOfNode(this: EdytorSelection, node: Node | null) {
	if (!node) return null;
	// If the node is not a text node, we need to find the closest text node
	let text: Text | null = null;
	let currentNode = node;
	if (node.nodeType !== Node.TEXT_NODE) {
		const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, (node) => {
			if (node instanceof HTMLSpanElement && node.hasAttribute('data-edytor-text')) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		});

		currentNode = treeWalker.nextNode() as Node;
		text = this.edytor.nodeToText.get(currentNode) || null;
		while (currentNode && !text) {
			currentNode = treeWalker.nextNode() as Node;
			text = this.edytor.nodeToText.get(currentNode) || null;
		}
	} else {
		while (currentNode.parentElement && !text) {
			text = this.edytor.nodeToText.get(currentNode) || null;
			currentNode = currentNode.parentElement;
		}
		// Maybe a weird behavior in firefox that force us to do that.
		// Didn't explore much as it seems to work.
		if (!text) {
			currentNode = node;
			// try with previousSibling
			while (currentNode.previousSibling && !text) {
				text = this.edytor.nodeToText.get(currentNode) || null;
				currentNode = currentNode.previousSibling;
			}
		}
	}
	return text;
}

export function getInlineBlockOfNode(this: EdytorSelection, node: Node | null) {
	if (!node) return null;
	let inlineBlock: InlineBlock | null = null;
	if (node.nodeType !== Node.TEXT_NODE) {
		const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, (node) => {
			if (node instanceof HTMLElement && node.hasAttribute('data-edytor-inline-block')) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		});

		const inlineBlock = treeWalker.nextNode() as InlineBlock | null;
		return inlineBlock;
	} else {
		let currentNode = node;
		while (currentNode.parentElement && !inlineBlock) {
			inlineBlock = this.edytor.nodeToInlineBlock.get(currentNode) || null;
			currentNode = currentNode.parentElement;
		}
	}
	return inlineBlock;
}

export function getTextsInSelection(
	this: EdytorSelection,
	startNode: Node | null,
	endNode: Node | null,

	ranges: Range[]
): {
	startText: Text | null;
	endText: Text | null;
	inlineBlock: InlineBlock | null;
	texts: Text[];
} {
	const startText = this.getTextOfNode(startNode);
	const endText = this.getTextOfNode(endNode);
	const inlineBlock = this.getInlineBlockOfNode(startNode);
	if (!startText) {
		return {
			startText: null,
			endText: null,
			inlineBlock,
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

	const texts: Set<Text> = new Set();
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
				texts.add(edytor.nodeToText.get(walker.currentNode as Element) as Text);
			}
		}
	});

	if (!texts.size) {
		texts.add(startText);
		if (endText && endText.node !== startText.node) {
			texts.add(endText);
		}
	}
	return {
		startText,
		endText,
		inlineBlock,
		texts: Array.from(texts)
	};
}

export const getYIndex = (text: Text | null, node: Node | null, _start: number) => {
	if (!text || !node) return _start;
	const parent = text.node!;
	const { isEmpty } = text;

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
	if ((start === 0 || start === 1) && isEmpty) {
		return 0;
	}
	return start;
};

export const getRangesFromSelection = (selection: Selection): Range[] => {
	return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
};

export const climb = (block: Block | Edytor | undefined, cb: (block: Block) => void | true) => {
	if (!block) return;
	let parent = block;
	while (parent && parent instanceof Block) {
		if (cb(parent)) break;
		parent = parent.parent;
	}
};
export const climbDom = (node: Node | undefined | null, cb: (node: Node) => void | true) => {
	if (!node) return;
	let parent: Node | HTMLElement | null = node;
	while (parent) {
		if (cb(parent)) break;
		parent = parent.parentElement;
	}
};
