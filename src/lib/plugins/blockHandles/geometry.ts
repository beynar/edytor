/**
 * The block handles' drop geometry, shared by the controller (where a drop
 * lands) and the drop indicator (where its bar and backdrop draw): a
 * placement's shape, a block's own row, its first text line and one
 * nesting step.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { BlockMovePosition } from '$lib/session/moves.js';

export type DropPlacement = {
	target: Block;
	node: HTMLElement;
	position: BlockMovePosition;
	/** The pointer's half was refused (the hitbox's `blocked`): this is the placement it gave way to. */
	blocked?: boolean;
};

export const isBeside = (position: BlockMovePosition): position is 'left' | 'right' =>
	position === 'left' || position === 'right';

export const getOwnRowBottom = (node: HTMLElement) => {
	const rect = node.getBoundingClientRect();
	// Block nodes wrap their children in the DOM; the parent's placement
	// bands belong to its own row, ending where the first child begins.
	const firstChild = node.querySelector<HTMLElement>('[data-edytor-block="true"]');
	const childRect = firstChild?.getBoundingClientRect();
	return childRect &&
		childRect.height > 0 &&
		childRect.top >= rect.top &&
		childRect.top < rect.bottom
		? childRect.top
		: rect.bottom;
};

/** A block's own row: its box down to where its first child begins. */
export const ownRow = (node: HTMLElement) => {
	const rect = node.getBoundingClientRect();
	return new DOMRect(
		rect.left,
		rect.top,
		rect.width,
		Math.max(0, getOwnRowBottom(node) - rect.top)
	);
};

/** The first line of a block's own text (not a child's), or the block's box. */
export const ownTextRow = (node: HTMLElement) => {
	const text = Array.from(node.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).find(
		(element) => element.closest('[data-edytor-block="true"]') === node
	);
	const row = text?.getClientRects()[0];
	return row && row.height > 0 ? row : node.getBoundingClientRect();
};

/**
 * One nesting step, a nested child's indent when the target has no visible
 * child to measure: the `--edytor-nest-indent` the children container is
 * indented by (in px), else its default.
 */
export const NEST_INDENT = 24;
export const nestIndent = (node: HTMLElement) => {
	const value = node.ownerDocument.defaultView
		?.getComputedStyle(node)
		.getPropertyValue('--edytor-nest-indent')
		.trim();
	return value?.endsWith('px') ? parseFloat(value) : NEST_INDENT;
};

/**
 * Whether `y` is over the hint of `node`'s empty body (`body.hint`, a kind's
 * `data-edytor-empty-body` element: an open toggle's, a callout's): a drop
 * there goes inside the block.
 */
export const overEmptyBody = (node: HTMLElement, y: number) => {
	const hint = Array.from(node.querySelectorAll('[data-edytor-empty-body]')).find(
		(element) => element.closest('[data-edytor-block="true"]') === node
	);
	const rect = hint?.getBoundingClientRect();
	return !!rect && rect.height > 0 && y >= rect.top && y <= rect.bottom;
};

/**
 * How far a block drag reaches past the editor's content column (`dnd.reach`):
 * past the handle column on the left and past the content's right edge, in
 * px, the `--edytor-drop-reach` the root inherits, else this default.
 */
export const DROP_REACH = 240;
/**
 * The beside bands' share of each margin, nearest the content: within it a
 * document with a layout kind offers the band (a new column); past it, up
 * to the reach, the row's reorder.
 */
export const BESIDE_MARGIN = 120;

/** Which margin of a block drag a pointer is in, and what answers there (`marginAt`). */
export type DropMargin = {
	side: 'left' | 'right';
	/**
	 * `handles`: the handle column, the row's reorder; `beside`: a beside
	 * band's place (the reorder without a band to offer); `reorder`: the row's
	 * reorder.
	 */
	zone: 'handles' | 'beside' | 'reorder';
};

/**
 * Where `x` falls outside the editor's content column (`start`…`end`, its
 * edges inside): left of it, the handle column (`handles` px wide) at any
 * reach; past that column on the left, and past `end` on the right, the
 * first `BESIDE_MARGIN` px (at most `reach`) a beside band's place, the rest
 * of `reach` the reorder; `null` inside the content or past the reach
 * (`dnd.reach`).
 */
export const marginAt = (
	x: number,
	{ start, end, handles, reach }: { start: number; end: number; handles: number; reach: number }
): DropMargin | null => {
	if (x >= start && x <= end) return null;
	if (x < start && x >= start - handles) return { side: 'left', zone: 'handles' };
	const side = x < start ? 'left' : 'right';
	const out = side === 'left' ? start - handles - x : x - end;
	if (out > reach) return null;
	return { side, zone: out <= Math.min(BESIDE_MARGIN, reach) ? 'beside' : 'reorder' };
};

/** The drop reach a style gives: its `--edytor-drop-reach` in px (0 or more), else `DROP_REACH`. */
export const dropReach = (style: CSSStyleDeclaration | undefined) => {
	const value = style?.getPropertyValue('--edytor-drop-reach').trim();
	const px = value?.endsWith('px') ? parseFloat(value) : NaN;
	return Number.isFinite(px) && px >= 0 ? px : DROP_REACH;
};
