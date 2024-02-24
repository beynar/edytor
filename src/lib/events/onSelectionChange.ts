import type { Edytor } from '$lib/hooks/useEdytor.svelte.js';
import { RelativePosition, Text, createRelativePositionFromTypeIndex } from 'yjs';

export type EdytorSelection = {
	selection: Selection;
	start: number;
	end: number;
	length: number;
	startNode: Node | null;
	startLeaf: HTMLSpanElement;
	endLeaf: HTMLSpanElement;
	endNode: Node | null;
	ranges: Range[];
	rects: DOMRect[];
	yStartIndex: number;
	yEndIndex: number;
	text: string;
	isCollapsed: boolean;
	insideMark: boolean;
	isAtStart: boolean;
	yStartElement: Text | null;
	yTextsInRanges: Text[];
	yEndElement: Text | null;
	yStart: RelativePosition | null;
	yEnd: RelativePosition | null;
};

const getRangesFromSelection = (selection: Selection): Range[] => {
	const rangeCount = selection.rangeCount;
	return Array.from({ length: rangeCount }, (_, i) => selection.getRangeAt(i));
};

const getYTextsInRange = (ranges: Range[], edytor: Edytor) => {
	const spans: Text[] = [];
	// Create a TreeWalker to traverse nodes within the range
	const walker = document.createTreeWalker(
		ranges[0].commonAncestorContainer,
		NodeFilter.SHOW_ELEMENT, // Only consider element nodes
		null
	);

	// The current node of the TreeWalker will be the first node in its traversal order
	let currentNode: Node | null = walker.currentNode;
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
		while (currentNode) {
			// If the current node is within the range, add it to the spans array

			if (
				currentNode instanceof HTMLSpanElement &&
				currentNode.hasAttribute('data-edytor-id') &&
				isNodeInRange(currentNode)
			) {
				spans.push(edytor.nodesToYElements.get(currentNode as Element) as Text);
			}

			currentNode = walker.nextNode();
		}
	});

	if (!spans.length) {
		return [
			edytor.nodesToYElements.get(recursivelyFindEdytorNode(ranges[0].startContainer) as Element)
		];
	}
	return spans;
};

const recursivelyFindEdytorNode = (node: Node | null) => {
	if (!node) return null;

	let id: null | string = null;
	let currentNode = node as Node | null;
	while (
		currentNode &&
		currentNode.parentNode instanceof HTMLElement &&
		!currentNode.parentNode.hasAttribute('data-edytor') &&
		!id
	) {
		currentNode = currentNode.parentElement;
		if (currentNode instanceof HTMLElement) {
			id = currentNode.getAttribute('data-edytor-id');
		}
	}
	if (!currentNode && node instanceof HTMLElement) {
		currentNode = node.querySelector('[data-edytor-id]');
	}
	return currentNode;
};

export function onSelectionChange(this: Edytor) {
	const selection = window.getSelection();

	if (
		!selection ||
		!selection?.anchorNode ||
		!this.container?.contains(selection.anchorNode as Node)
	) {
		return;
	}
	const { anchorNode, focusNode, anchorOffset, focusOffset, isCollapsed } = selection;

	const ranges = getRangesFromSelection(selection);
	const rects = ranges.map((range) => range.getBoundingClientRect());

	const anchorElement = recursivelyFindEdytorNode(anchorNode);
	const focusElement = recursivelyFindEdytorNode(focusNode);

	const insideMark = anchorNode?.parentElement !== anchorElement;

	if (!anchorElement) {
		return;
	}
	const isReversed = !isCollapsed && anchorOffset > focusOffset;
	const startLeaf = isReversed ? focusElement : anchorElement;
	const endLeaf = isReversed ? anchorElement : focusElement;
	const yAnchorElement = this.nodesToYElements.get(anchorElement);
	const yFocusElement = focusElement ? this.nodesToYElements.get(focusElement) : null;
	const start = isCollapsed ? anchorOffset : Math.min(anchorOffset, focusOffset);
	const end = isCollapsed ? anchorOffset : Math.max(anchorOffset, focusOffset);

	const yStartElement = isReversed ? yFocusElement : (yAnchorElement as Text);
	const yEndElement = isReversed ? yAnchorElement : (yFocusElement as Text);

	let parentElement = anchorNode.parentElement;
	function isDirectDescendant(parent: HTMLElement | Node, child: HTMLElement | null) {
		return child?.parentNode === parent;
	}
	while (anchorElement !== parentElement && !isDirectDescendant(anchorElement, parentElement)) {
		parentElement = parentElement?.parentElement || null;
	}
	let yStartIndex = start;
	let previousSibling =
		parentElement !== anchorElement ? parentElement?.previousSibling : anchorNode.previousSibling;

	while (previousSibling) {
		yStartIndex += previousSibling?.textContent?.length || 0;
		previousSibling = previousSibling.previousSibling;
	}

	const isAtStart = yStartIndex === 0;
	const isAtEnd = yStartIndex === yStartElement?.length;
	const yTextsInRanges = getYTextsInRange(ranges, this);

	this.selection = {
		selection,
		ranges,
		isAtStart,
		isAtEnd,
		text: selection.toString(),
		rects,
		start,
		end,
		yStartIndex,
		yEndIndex: yStartIndex + selection.toString().length,
		isCollapsed,
		insideMark,
		yTextsInRanges,
		startNode: anchorNode,
		startLeaf,
		endLeaf,
		endNode: focusNode,
		yStartElement: yStartElement as Text,
		length: selection.toString().length,
		yEndElement: yEndElement as Text,
		yStart: createRelativePositionFromTypeIndex(yStartElement as Text, yStartIndex),
		yEnd: createRelativePositionFromTypeIndex(yEndElement as Text, focusOffset)
	};
}
