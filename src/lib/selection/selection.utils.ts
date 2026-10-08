import type { EdytorSelection } from './selection.svelte.js';
import type { Text } from '../text/text.svelte.js';
import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { DomSelectionSnapshot } from './domSelection.js';
import type { EdgeSide } from '$lib/session/editing/text.js';
import { getTextContentOffsetAtPoint } from '$lib/events/domTextOffset.js';

const TRAILING_NEWLINE_SELECTOR = '[data-edytor-trailing-newline]';
export const SYNTHETIC_TEXT_OVERLAY_SELECTOR = '[data-edytor-text-suggestion]';
/** A block suggestion's preview group: view-only, never a selection endpoint (`session/suggestions`). */
export const SUGGESTION = '[data-edytor-suggestion]';

export const getElementFromNode = (node: Node | null) => {
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

/**
 * A selection endpoint counts as text-bound when it lives inside a
 * `data-edytor-text` element — either a text node inside it or an
 * element boundary within it. Endpoints outside (block/container
 * boundaries covering whole nodes, stray whitespace text nodes) make the
 * native selection "node-bound" — the shape engines disagree on when
 * extending horizontally.
 */
export const isTextBoundSelectionPoint = (node: Node | null) => {
	const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
	return element instanceof Element && Boolean(element.closest('[data-edytor-text]'));
};

const isIgnoredBoundaryNode = (node: Node) => {
	if (node.nodeType === Node.COMMENT_NODE) {
		return true;
	}

	if (node instanceof Element) {
		return (
			node.matches(SUGGESTION) ||
			!(
				node.matches('[data-edytor-text], [data-edytor-inline-block], [data-edytor-block]') ||
				node.querySelector('[data-edytor-text], [data-edytor-inline-block], [data-edytor-block]')
			)
		);
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

/** The first or last text element at `node`: itself, or one nested in it. */
const getEdgeTextElement = (edge: 'first' | 'last', node: Node | null): HTMLElement | null => {
	const element = getElementFromNode(node);
	if (!(element instanceof HTMLElement)) return null;
	if (element.hasAttribute('data-edytor-text')) return element;
	const nested = element.querySelectorAll('[data-edytor-text]');
	const found = nested.item(edge === 'first' ? 0 : nested.length - 1);
	return found instanceof HTMLElement ? found : null;
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
		previousText: getEdgeTextElement('last', previous),
		nextText: getEdgeTextElement('first', next),
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

/**
 * Resolve an endpoint that sits on a stray DOM node — a text node or
 * element that belongs to no `data-edytor-text` element. Firefox drops
 * the focus of a Shift+Arrow extension on the whitespace/empty text
 * nodes that sit between blocks or beside the render anchor, producing
 * open-ended root boundaries (`before: text N, after: null`). The point
 * is treated as an element boundary at `(parentNode, indexInParent)` and
 * climbs while no editor content is found — the same ignored-node rules
 * as element boundaries apply (comments, whitespace/zero-width text
 * nodes, and elements without editor content are skipped).
 */
const getStrayBoundaryTextElement = (node: Node, container?: HTMLElement | null) => {
	// The first non-ignored ELEMENT sibling of `current` in `direction`.
	// A non-empty stray text node stops the scan: the gap is ambiguous and
	// the caller should look at the enclosing level instead.
	const siblingElement = (parent: Element, index: number, step: -1 | 1) => {
		for (let i = index + step; i >= 0 && i < parent.childNodes.length; i += step) {
			const child = parent.childNodes[i];
			if (child instanceof Element) {
				if (isIgnoredBoundaryNode(child)) continue;
				return child;
			}
			if (!isIgnoredBoundaryNode(child)) break;
		}
		return null;
	};

	let current: Node = node;
	let parent = current.parentNode;
	while (parent instanceof Element) {
		const index = Array.prototype.indexOf.call(parent.childNodes, current);
		if (index !== -1) {
			const element =
				getEdgeTextElement('last', siblingElement(parent, index, -1)) ??
				getEdgeTextElement('first', siblingElement(parent, index, 1));
			if (element) {
				return element;
			}
		}
		if (parent === container) {
			break;
		}
		current = parent;
		parent = current.parentNode;
	}
	return null;
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

	return null;
};

export function getTextOfNode(this: EdytorSelection, node: Node | null, offset?: number) {
	if (!node) return null;
	const textOf = (element: Node | null) => (element && this.edytor.nodeToText.get(element)) || null;
	// A point in a suggestion's preview is the stray boundary the preview sits at.
	const preview = getElementFromNode(node)?.closest(SUGGESTION);
	if (preview) return textOf(getStrayBoundaryTextElement(preview, this.edytor.node));
	let text: Text | null = null;
	if (node.nodeType !== Node.TEXT_NODE) {
		text = textOf(node);
		if (text) return text;
		const syntheticOverlay = findSyntheticTextOverlayElement(node);
		if (syntheticOverlay) {
			const blockElement = syntheticOverlay.closest('[data-edytor-block]');
			const blockId =
				blockElement instanceof HTMLElement ? blockElement.dataset.edytorId : undefined;
			const block = blockId ? this.edytor.idToBlock.get(blockId) : null;
			return block?.lastText ?? null;
		}
		text =
			textOf(findClosestTextElement(node)) ??
			(typeof offset === 'number' ? textOf(getTextElementAtBoundary(node, offset)) : null);
	} else {
		for (let current: Node = node; current.parentElement && !text; current = current.parentElement)
			text = textOf(current);
	}
	// The endpoint lives on a stray node (whitespace/empty text between
	// blocks, the render anchor, a non-editable gap) — resolve it to the
	// nearest text element at that boundary so open-ended selections
	// still map to a model text position.
	return text ?? textOf(getStrayBoundaryTextElement(node, this.edytor.node));
}

export function getInlineBlockOfNode(this: EdytorSelection, node: Node | null) {
	if (!node) return null;

	const element = getElementFromNode(node);
	const inlineElement = element?.closest('[data-edytor-inline-block]');
	if (inlineElement instanceof Element && this.edytor.node?.contains(inlineElement)) {
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
	startOffset = 0,
	endOffset = startOffset
): { startText: Text | null; endText: Text | null; inlineBlock: InlineBlock | null } {
	const startText = this.getTextOfNode(startNode, startOffset);
	return {
		startText,
		endText: startText ? this.getTextOfNode(endNode, endOffset) : null,
		inlineBlock: this.getInlineBlockOfNode(startNode)
	};
}

/**
 * The edge side of a collapsed DOM point at `offset` of `text` (R4): inside
 * when every mark element rendering the character before it contains the
 * point, outside when one does not; `undefined` when that character has none.
 */
export const getMarkEdgeSide = (text: Text, node: Node | null, offset: number) => {
	const walker = text.node?.ownerDocument.createTreeWalker(text.node, NodeFilter.SHOW_TEXT);
	let leaf: Node | null | undefined = null;
	for (let start = 0; node && offset > 0 && (leaf = walker?.nextNode()); ) {
		start += leaf.textContent?.length ?? 0;
		if (offset <= start) break;
	}
	let side: EdgeSide | undefined;
	for (let element = leaf?.parentElement; element && element !== text.node; ) {
		if (element.hasAttribute('data-edytor-mark'))
			side = element.contains(node) ? (side ?? 'inside') : 'outside';
		element = element.parentElement;
	}
	return side;
};

export const getYIndex = (text: Text | null, node: Node | null, _start: number) => {
	if (!text || !node) return _start;
	const parent = text.node!;
	const { isEmpty } = text;

	if (text.endsWithNewline && isInsideTrailingNewlineMarker(node)) {
		return text.length;
	}

	// A point inside the text element reads the text before it (F-S5); the
	// element-boundary rule is for points outside it.
	const boundaryOffset = parent.contains(node)
		? null
		: getTextOffsetAtElementBoundary(text, node, _start);
	if (boundaryOffset !== null) {
		return boundaryOffset;
	}

	const start = getTextContentOffsetAtPoint(parent, node, _start);
	if ((start === 0 || start === 1) && isEmpty) {
		return 0;
	}
	return start;
};

/** The mounted text and display offset a DOM point stands in, or `null` (`edytor.ports.surface.pointAt`). */
export function textPointAt(this: EdytorSelection, node: Node, offset: number) {
	const text = getTextOfNode.call(this, node);
	return text?.node ? { text, offset: getYIndex(text, node, offset) } : null;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * DOM Range offsets use UTF-16 code units and programmatic ranges can land
 * between the two units of a surrogate pair. Browser target ranges disagree
 * about that invalid boundary, so normalize it before it reaches editor state.
 */
export const normalizeUtf16Boundary = (
	value: string,
	offset: number,
	direction: 'backward' | 'forward'
) => {
	const clamped = Math.min(Math.max(offset, 0), value.length);
	if (
		clamped === 0 ||
		clamped === value.length ||
		!isHighSurrogate(value.charCodeAt(clamped - 1)) ||
		!isLowSurrogate(value.charCodeAt(clamped))
	) {
		return clamped;
	}

	return direction === 'backward' ? clamped - 1 : clamped + 1;
};

export const getRangesFromSelection = (
	selection: Pick<Selection, 'getRangeAt' | 'rangeCount'> | DomSelectionSnapshot
): Range[] => {
	return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
};

export const climbDom = (node: Node | undefined | null, cb: (node: Node) => void | true) => {
	if (!node) return;
	let parent: Node | HTMLElement | null = node;
	while (parent) {
		if (cb(parent)) break;
		parent = parent.parentElement;
	}
};
