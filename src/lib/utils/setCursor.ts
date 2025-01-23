import type { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';

export function findTextNode(node: Node, index: number): { textNode: Node | null; offset: number } {
	let textNode = null;
	let offset = index;

	// Use a TreeWalker to traverse text nodes
	const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);

	while (walker.nextNode()) {
		const currentNode = walker.currentNode as Text;
		if (offset <= currentNode.length) {
			textNode = currentNode;
			break;
		}
		offset -= currentNode.length;
	}

	return { textNode, offset };
}

export function getTextNodeAtPosition(
	root: Node,
	index: number
): { node: Text; offset: number } | null {
	const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, null);
	let currentNode;
	let currentIndex = 0;

	while ((currentNode = treeWalker.nextNode())) {
		const textLength = currentNode.textContent?.length || 0;
		if (currentIndex + textLength >= index) {
			return {
				node: currentNode as Text,
				offset: index - currentIndex
			};
		}
		currentIndex += textLength;
	}
	return null;
}

export const setCursorAtPosition = (dataEdytorId: string, index: number) => {
	const element = document.querySelector(`[data-edytor-id="${dataEdytorId}"]`);
	if (element) {
		const position = getTextNodeAtPosition(element, index);
		if (position) {
			const { node, offset } = position;
			const selection = window.getSelection();
			const range = document.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			selection?.removeAllRanges();
			selection?.addRange(range);
			(element as HTMLElement).focus();
		}
	}
};

export const setCursorAtRange = (dataEdytorId: string, start: number, end: number) => {
	tick().then(() => {
		const element = document.querySelector(`[data-edytor-id="${dataEdytorId}"]`);

		// Function to find the text node and offset within the element
		if (element) {
			const { textNode: startTextNode, offset: startOffset } = findTextNode(element, start);
			const { textNode: endTextNode, offset: endOffset } = findTextNode(element, end);

			if (startTextNode && endTextNode) {
				const selection = window.getSelection();
				selection?.removeAllRanges();
				const range = document.createRange();
				range.setStart(startTextNode, startOffset);
				range.setEnd(endTextNode, endOffset);
				selection?.addRange(range);
				return element.getBoundingClientRect();
			}
		}
	});
};

export function moveCursor(this: Edytor, delta: number) {
	tick().then(() => {
		let node = this.selection.startNode;

		// Find the text node and offset within the element if the startNode is not a text node
		// Just in case
		while (node && node.nodeType !== 3 && node?.firstChild) {
			node = node.firstChild;
		}

		if (this.selection.isAtStart) {
			// node = node?.parentElement.previousSibling;
			// console.log({ node }, node?.textContent, this.selection.start, this.selection.end);
			// this.selection.ranges[0].setStart(node!, this.selection.start);
			// this.selection.ranges[0].setEnd(node!, this.selection.start);
		} else {
			this.selection.ranges[0].setStart(node!, this.selection.start + delta);
			this.selection.ranges[0].setEnd(node!, this.selection.start + delta);
		}
	});
}
