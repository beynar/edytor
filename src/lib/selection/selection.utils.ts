import type { EdytorSelection } from './selection.svelte.js';
import type { Text } from '../text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { DomSelectionSnapshot } from './domSelection.js';
import type { EdgeSide } from '$lib/session/editing/text.js';
import { getTextContentOffsetAtPoint } from '$lib/events/domTextOffset.js';

const TRAILING_NEWLINE_SELECTOR = '[data-edytor-trailing-newline]';
export const SYNTHETIC_TEXT_OVERLAY_SELECTOR = '[data-edytor-text-suggestion]';
/** A block suggestion's preview group: view-only, never a selection endpoint (`session/suggestions`). */
export const SUGGESTION = '[data-edytor-suggestion]';

const TEXT = '[data-edytor-text]';
const INLINE = '[data-edytor-inline-block]';
const BLOCK = '[data-edytor-block]';

export const getElementFromNode = (node: Node | null) =>
	!node || typeof Element === 'undefined'
		? null
		: node instanceof Element
			? node
			: node.nodeType === Node.TEXT_NODE
				? node.parentElement
				: null;

/**
 * The nearest `contenteditable` boundary of `node` inside `host` (the host
 * itself excluded), and whether it is editable: `false` is non-editable
 * chrome (a void block's wrapper, an atom, a control's icon); a nested
 * `true`, `plaintext-only` or `''` (a void block's caption, which turns
 * editing on again for its text) is an editable region whose presses and
 * drags are the browser's (`sel.press.nested-editable`). The attribute or,
 * without one, the property (an attach hook sets it; jsdom reflects
 * neither way). `null`: no boundary below the host.
 */
export const editableBoundary = (node: Node | null, host: Element | null | undefined) => {
	if (!host) return null;
	for (let at = getElementFromNode(node); at && at !== host; at = at.parentElement) {
		if (!host.contains(at)) return null;
		const attribute = at.getAttribute('contenteditable');
		const state = attribute?.toLowerCase() ?? (at as HTMLElement).contentEditable;
		if (state === 'false') return { element: at, editable: false };
		if (state === 'true' || state === 'plaintext-only' || state === '')
			return { element: at, editable: true };
	}
	return null;
};

/** The element around `node` (itself included) matching `selector`. */
const closestTo = (node: Node | null, selector: string) =>
	getElementFromNode(node)?.closest<HTMLElement>(selector) ?? null;

/** `node` is an element matching `selector` or holding one. */
const holds = (node: Node | null, selector: string) =>
	node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));

export const isInsideTrailingNewlineMarker = (node: Node) =>
	!!closestTo(node, TRAILING_NEWLINE_SELECTOR);

/**
 * A selection endpoint counts as text-bound when it lives inside a
 * `data-edytor-text` element — either a text node inside it or an
 * element boundary within it. Endpoints outside (block/container
 * boundaries covering whole nodes, stray whitespace text nodes) make the
 * native selection "node-bound" — the shape engines disagree on when
 * extending horizontally.
 */
export const isTextBoundSelectionPoint = (node: Node | null) => !!closestTo(node, TEXT);

/** A node a boundary looks past: a comment, blank text, a suggestion, an element with no editor content. */
const isIgnoredBoundaryNode = (node: Node) =>
	node.nodeType === Node.COMMENT_NODE ||
	(node instanceof Element
		? node.matches(SUGGESTION) || !holds(node, `${TEXT}, ${INLINE}, ${BLOCK}`)
		: node.nodeType === Node.TEXT_NODE &&
			!(node.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim());

/** The first child of `element` from `offset` in `step`'s direction a boundary does not look past. */
const boundaryChild = (element: Element, offset: number, step: -1 | 1) => {
	for (let i = step < 0 ? offset - 1 : offset; i >= 0 && i < element.childNodes.length; i += step)
		if (!isIgnoredBoundaryNode(element.childNodes[i])) return element.childNodes[i];
	return null;
};

/** The first or last text element at `node`: itself, or one nested in it. */
const edgeText = (edge: 'first' | 'last', node: Node | null): HTMLElement | null => {
	const element = getElementFromNode(node);
	if (!(element instanceof HTMLElement)) return null;
	if (element.hasAttribute('data-edytor-text')) return element;
	const nested = element.querySelectorAll<HTMLElement>(TEXT);
	return nested[edge === 'first' ? 0 : nested.length - 1] ?? null;
};

/** The children on either side of an element boundary, and the text elements they end and start with. */
const boundaryOf = (node: Node, offset: number) => {
	if (!(node instanceof Element)) return null;
	const [previous, next] = [boundaryChild(node, offset, -1), boundaryChild(node, offset, 1)];
	return { previous, next, before: edgeText('last', previous), after: edgeText('first', next) };
};

/** The text element an element boundary stands in: past an atom or a block, the text beside it. */
const textAtBoundary = (node: Node, offset: number) => {
	const at = boundaryOf(node, offset);
	if (!at) return null;
	const { previous, next, before, after } = at;
	if (holds(previous, INLINE) && after) return after;
	if (holds(next, INLINE) && before) return before;
	if (holds(next, BLOCK) && after) return after;
	if (holds(previous, BLOCK) && before) return before;
	return before ?? after;
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
const strayText = (node: Node, container?: HTMLElement | null) => {
	// The first non-ignored ELEMENT sibling of `current` in `step`'s direction.
	// A non-empty stray text node stops the scan: the gap is ambiguous and
	// the caller should look at the enclosing level instead.
	const sibling = (parent: Element, index: number, step: -1 | 1) => {
		for (let i = index + step; i >= 0 && i < parent.childNodes.length; i += step) {
			const child = parent.childNodes[i];
			if (!isIgnoredBoundaryNode(child)) return child instanceof Element ? child : null;
		}
		return null;
	};
	for (let current = node, parent = node.parentNode; parent instanceof Element; ) {
		const index = Array.prototype.indexOf.call(parent.childNodes, current);
		const element =
			index !== -1 &&
			(edgeText('last', sibling(parent, index, -1)) ??
				edgeText('first', sibling(parent, index, 1)));
		if (element) return element;
		if (parent === container) break;
		current = parent;
		parent = current.parentNode;
	}
	return null;
};

/**
 * The text a DOM point is in: its text element; in a text suggestion's
 * overlay, its block's last text; at an element boundary (with `offset`),
 * the text beside it; on a stray node or in a block suggestion's preview,
 * the nearest text at that boundary.
 */
export function getTextOfNode(this: EdytorSelection, node: Node | null, offset?: number) {
	if (!node) return null;
	const { edytor } = this;
	const textOf = (element: Node | null) => edytor.surface.handleOf(element, 'text');
	// A point in a suggestion's preview is the stray boundary the preview sits at.
	const preview = closestTo(node, SUGGESTION);
	if (preview) return textOf(strayText(preview, edytor.node));
	const element = node.nodeType !== Node.TEXT_NODE;
	const overlay = element && !textOf(node) && closestTo(node, SYNTHETIC_TEXT_OVERLAY_SELECTOR);
	if (overlay) return this.getBlockOfNode(overlay)?.lastText ?? null;
	return (
		textOf(closestTo(node, TEXT)) ??
		(element && typeof offset === 'number' ? textOf(textAtBoundary(node, offset)) : null) ??
		textOf(strayText(node, edytor.node))
	);
}

/** The inline atom at `node`: around it, or the first one inside it. */
export const getInlineBlockOfNode = (edytor: Edytor, node: Node | null) => {
	const element = getElementFromNode(node);
	const around = element?.closest(INLINE);
	const inline = around && edytor.node?.contains(around) ? around : element?.querySelector(INLINE);
	return edytor.surface.handleOf(inline, 'atom');
};

/** The one inline atom a non-collapsed range covers, touching no text. */
export const getInlineBlockInSelectedRange = (edytor: Edytor, range: Range | undefined) => {
	const root = range && !range.collapsed ? getElementFromNode(range.commonAncestorContainer) : null;
	if (!root) return null;
	const inside = (selector: string) =>
		[...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)].filter(
			(element) => range!.intersectsNode(element)
		);
	const atoms = new Set(
		inside(INLINE).flatMap((element) => edytor.surface.handleOf(element, 'atom') ?? [])
	);
	return atoms.size === 1 && !inside(TEXT).length ? [...atoms][0] : null;
};

/**
 * The edge side of a collapsed DOM point at `offset` of `text`: inside
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

/**
 * The offset the DOM point `(node, offset)` stands for in the rendered text
 * `text` as the DOM holds it: its trailing newline's marker reads the end;
 * no model rule (the DOM may be ahead of the model: a native insertion read
 * before its adoption).
 */
export const domOffsetIn = (text: Text, node: Node, offset: number) =>
	text.endsWithNewline && isInsideTrailingNewlineMarker(node)
		? text.length
		: getTextContentOffsetAtPoint(text.node!, node, offset);

/**
 * The one DOM point → text offset mapper ({@link domOffsetIn} with the
 * model's rules; `domPointOf` is its inverse): a point outside the text
 * element beside it (an element boundary, past an inline atom) reads its
 * edge, and an empty text's filler reads 0.
 */
export const getYIndex = (text: Text | null, node: Node | null, offset: number) => {
	if (!text || !node) return offset;
	const element = text.node!;
	// A point inside the text element reads the text before it; the
	// element-boundary rule is for points outside it.
	if (!element.contains(node)) {
		const boundary = boundaryOf(node, offset);
		if (boundary?.before === element) return text.length;
		if (boundary?.after === element) return 0;
	}
	const at = domOffsetIn(text, node, offset);
	return (at === 0 || at === 1) && text.isEmpty ? 0 : at;
};

/** {@link getYIndex} within the text's length (a caret the model can hold). */
export const offsetIn = (text: Text, node: Node | null, offset: number) =>
	Math.min(Math.max(getYIndex(text, node, offset), 0), text.length);

/** The mounted text and display offset a DOM point stands in, or `null` (`edytor.ports.surface.pointAt`). */
export function textPointAt(this: EdytorSelection, node: Node, offset: number) {
	const text = getTextOfNode.call(this, node);
	return text?.node ? { text, offset: getYIndex(text, node, offset) } : null;
}

/** A DOM selection's endpoints in document order, and whether it runs backward. */
export const ordered = (
	selection: Pick<
		DomSelectionSnapshot,
		'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset'
	>,
	reversed: boolean
) => {
	const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
	return reversed
		? { startNode: focusNode, start: focusOffset, endNode: anchorNode, end: anchorOffset }
		: { startNode: anchorNode, start: anchorOffset, endNode: focusNode, end: focusOffset };
};

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
