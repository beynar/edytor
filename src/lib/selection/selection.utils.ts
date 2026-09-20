import { EdytorSelection } from './selection.svelte.js';
import { Text } from '../text/text.svelte.js';
import { Block } from '$lib/block/block.svelte.js';
import { Edytor } from '$lib/edytor.svelte.js';
import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { DomSelectionSnapshot } from './domSelection.js';

const TRAILING_NEWLINE_SELECTOR = '[data-edytor-trailing-newline]';
const SYNTHETIC_TEXT_OVERLAY_SELECTOR =
	'[data-edytor-text-placeholder], [data-edytor-text-suggestion]';

const getElementFromNode = (node: Node | null) => {
	if (!node || typeof Element === 'undefined') {
		return null;
	}

	if (node instanceof Element) {
		return node;
	}

	return node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
};

export const isInsideTrailingNewlineMarker = (node: Node) => {
	const element = getElementFromNode(node);
	return element instanceof Element && Boolean(element.closest(TRAILING_NEWLINE_SELECTOR));
};

const findClosestTextElement = (node: Node) => {
	const element = getElementFromNode(node);
	const textElement = element?.closest('[data-edytor-text]');
	return textElement instanceof HTMLElement ? textElement : null;
};

const findSyntheticTextOverlayElement = (node: Node) => {
	const element = getElementFromNode(node);
	const overlay = element?.closest(SYNTHETIC_TEXT_OVERLAY_SELECTOR);
	return overlay instanceof HTMLElement ? overlay : null;
};

const isIgnoredBoundaryNode = (node: Node) => {
	if (node.nodeType === Node.COMMENT_NODE) {
		return true;
	}

	if (node.nodeType !== Node.TEXT_NODE) {
		return false;
	}

	return (node.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === '';
};

const getBoundaryChild = (element: Element, offset: number, direction: 'previous' | 'next') => {
	const step = direction === 'previous' ? -1 : 1;
	let index = direction === 'previous' ? offset - 1 : offset;

	while (index >= 0 && index < element.childNodes.length) {
		const child = element.childNodes[index];
		if (!isIgnoredBoundaryNode(child)) {
			return child;
		}
		index += step;
	}

	return null;
};

const getFirstTextElement = (node: Node | null): HTMLElement | null => {
	if (!node) {
		return null;
	}

	const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
	if (!(element instanceof HTMLElement)) {
		return null;
	}

	if (element.hasAttribute('data-edytor-text')) {
		return element;
	}

	const nested = element.querySelector('[data-edytor-text]');
	return nested instanceof HTMLElement ? nested : null;
};

const getLastTextElement = (node: Node | null): HTMLElement | null => {
	if (!node) {
		return null;
	}

	const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
	if (!(element instanceof HTMLElement)) {
		return null;
	}

	if (element.hasAttribute('data-edytor-text')) {
		return element;
	}

	const nested = element.querySelectorAll('[data-edytor-text]');
	const last = nested.item(nested.length - 1);
	return last instanceof HTMLElement ? last : null;
};

const containsInlineBlock = (node: Node | null) => {
	if (!(node instanceof Element)) {
		return false;
	}

	return (
		node.matches('[data-edytor-inline-block]') ||
		Boolean(node.querySelector('[data-edytor-inline-block]'))
	);
};

const containsBlock = (node: Node | null) => {
	if (!(node instanceof Element)) {
		return false;
	}

	return node.matches('[data-edytor-block]') || Boolean(node.querySelector('[data-edytor-block]'));
};

const getElementBoundary = (node: Node, offset: number) => {
	if (!(node instanceof Element)) {
		return null;
	}

	const previous = getBoundaryChild(node, offset, 'previous');
	const next = getBoundaryChild(node, offset, 'next');

	return {
		previousText: getLastTextElement(previous),
		nextText: getFirstTextElement(next),
		previousInline: containsInlineBlock(previous),
		nextInline: containsInlineBlock(next),
		previousBlock: containsBlock(previous),
		nextBlock: containsBlock(next)
	};
};

const getTextElementAtBoundary = (node: Node, offset: number) => {
	const boundary = getElementBoundary(node, offset);
	if (!boundary) {
		return null;
	}

	if (boundary.previousInline && boundary.nextText) {
		return boundary.nextText;
	}

	if (boundary.nextInline && boundary.previousText) {
		return boundary.previousText;
	}

	if (boundary.nextBlock && boundary.nextText) {
		return boundary.nextText;
	}

	if (boundary.previousBlock && boundary.previousText) {
		return boundary.previousText;
	}

	return boundary.previousText ?? boundary.nextText;
};

const getTextOffsetAtElementBoundary = (text: Text, node: Node, offset: number) => {
	const boundary = getElementBoundary(node, offset);
	const textNode = text.node;
	if (!boundary || !textNode) {
		return null;
	}

	if (boundary.previousInline && boundary.nextText === textNode) {
		return 0;
	}

	if (boundary.nextInline && boundary.previousText === textNode) {
		return text.length;
	}

	if (boundary.previousText === textNode) {
		return text.length;
	}

	if (boundary.nextText === textNode) {
		return 0;
	}

	if (boundary.nextBlock && boundary.nextText === textNode) {
		return 0;
	}

	if (boundary.previousBlock && boundary.previousText === textNode) {
		return text.length;
	}

	return null;
};

export function getTextOfNode(this: EdytorSelection, node: Node | null, offset?: number) {
	if (!node) return null;
	let text: Text | null = null;
	let currentNode = node;
	if (node.nodeType !== Node.TEXT_NODE) {
		text = this.edytor.nodeToText.get(node as Element) || null;
		if (text) {
			return text;
		}
		const syntheticOverlay = findSyntheticTextOverlayElement(node);
		if (syntheticOverlay) {
			const blockElement = syntheticOverlay.closest('[data-edytor-block]');
			const blockId =
				blockElement instanceof HTMLElement ? blockElement.dataset.edytorId : undefined;
			const block = blockId ? this.edytor.idToBlock.get(blockId) : null;
			return block?.lastText ?? null;
		}
		const closestTextElement = findClosestTextElement(node);
		if (closestTextElement) {
			text = this.edytor.nodeToText.get(closestTextElement) || null;
			if (text) {
				return text;
			}
		}
		if (typeof offset === 'number') {
			const boundaryTextElement = getTextElementAtBoundary(node, offset);
			if (boundaryTextElement) {
				text = this.edytor.nodeToText.get(boundaryTextElement) || null;
				if (text) {
					return text;
				}
			}
		}
	} else {
		while (currentNode.parentElement && !text) {
			text = this.edytor.nodeToText.get(currentNode) || null;
			currentNode = currentNode.parentElement;
		}
	}
	return text;
}

export function getInlineBlockOfNode(this: EdytorSelection, node: Node | null) {
	if (!node) return null;

	const element = getElementFromNode(node);
	const inlineElement = element?.closest('[data-edytor-inline-block]');
	if (inlineElement instanceof Element && this.edytor.container?.contains(inlineElement)) {
		return this.edytor.nodeToInlineBlock.get(inlineElement) || null;
	}

	if (element instanceof Element) {
		const nestedInlineElement = element.querySelector('[data-edytor-inline-block]');
		if (nestedInlineElement instanceof Element) {
			return this.edytor.nodeToInlineBlock.get(nestedInlineElement) || null;
		}
	}

	return null;
}

export function getInlineBlockInSelectedRange(this: EdytorSelection, range: Range | undefined) {
	if (!range || range.collapsed) {
		return null;
	}

	const root =
		range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer
			: range.commonAncestorContainer.parentElement;
	if (!root) {
		return null;
	}

	const inlineElements = [
		...(root.matches('[data-edytor-inline-block]') ? [root] : []),
		...Array.from(root.querySelectorAll('[data-edytor-inline-block]'))
	].filter((element) => range.intersectsNode(element));
	const inlineBlocks = new Set(
		inlineElements
			.map((element) => this.edytor.nodeToInlineBlock.get(element))
			.filter((inlineBlock): inlineBlock is InlineBlock => Boolean(inlineBlock))
	);

	if (inlineBlocks.size !== 1) {
		return null;
	}

	const intersectsText = Array.from(root.querySelectorAll('[data-edytor-text]')).some((element) =>
		range.intersectsNode(element)
	);
	if (intersectsText) {
		return null;
	}

	return inlineBlocks.values().next().value ?? null;
}

export function getTextsInSelection(
	this: EdytorSelection,
	startNode: Node | null,
	endNode: Node | null,

	ranges: Range[],
	startOffset = 0,
	endOffset = startOffset
): {
	startText: Text | null;
	endText: Text | null;
	inlineBlock: InlineBlock | null;
	texts: Text[];
} {
	const startText = this.getTextOfNode(startNode, startOffset);
	const endText = this.getTextOfNode(endNode, endOffset);
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
			const ownerDocument =
				node.ownerDocument ?? (typeof document === 'undefined' ? null : document);
			if (!ownerDocument) {
				return false;
			}

			const nodeRange = ownerDocument.createRange();
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

	if (text.endsWithNewline && isInsideTrailingNewlineMarker(node)) {
		return text.length;
	}

	const boundaryOffset = getTextOffsetAtElementBoundary(text, node, _start);
	if (boundaryOffset !== null) {
		return boundaryOffset;
	}

	const getChildTextLengthBeforeOffset = (element: Node, offset: number) => {
		let length = 0;
		const end = Math.min(offset, element.childNodes.length);
		for (let index = 0; index < end; index++) {
			length += element.childNodes[index].textContent?.length ?? 0;
		}
		return length;
	};

	const getTextOffsetInsideParent = () => {
		let offset = 0;
		let resolved = false;

		const visit = (current: Node): boolean => {
			if (current === node) {
				if (current.nodeType === Node.TEXT_NODE) {
					offset += Math.min(_start, current.textContent?.length ?? 0);
				} else {
					offset += getChildTextLengthBeforeOffset(current, _start);
				}
				resolved = true;
				return true;
			}

			if (current.nodeType === Node.TEXT_NODE) {
				offset += current.textContent?.length ?? 0;
				return false;
			}

			for (const child of current.childNodes) {
				if (visit(child)) {
					return true;
				}
			}
			return false;
		};

		visit(parent);
		return resolved ? offset : null;
	};

	const start =
		parent === node || parent.contains(node) ? (getTextOffsetInsideParent() ?? _start) : _start;
	if ((start === 0 || start === 1) && isEmpty) {
		return 0;
	}
	return start;
};

export const getRangesFromSelection = (
	selection: Pick<Selection, 'getRangeAt' | 'rangeCount'> | DomSelectionSnapshot
): Range[] => {
	return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
};

export const climb = (block: Block | Edytor | undefined, cb: (block: Block) => void | true) => {
	if (!block) return;
	let parent: Block | Edytor | undefined = block;
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
