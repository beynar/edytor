/**
 * Which blocks a marquee rectangle selects (`sel.marquee.blocks`, Notion),
 * read from the blocks' boxes: the one rule the marquee's live selection
 * reads. A pointer move never reads the whole page: a binary search over a
 * parent's children (vertical order) finds the ones at the rectangle's
 * height, then their descendants the same way.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { hidden } from '$lib/selection/visibility.js';

/** A rectangle in viewport (client) coordinates. */
export type MarqueeRect = { left: number; top: number; right: number; bottom: number };

/** Whether two boxes overlap (an edge they share is no overlap: rows touch). */
const meets = (rect: MarqueeRect, box: MarqueeRect) =>
	rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;

/**
 * The blocks `rect` selects, in document order, each once:
 *
 * - a block whose own row (its box down to where its first shown child
 *   begins) meets the rectangle is selected with its whole shown subtree
 *   (Notion: a block carries its children);
 * - a block whose box meets it only below its own row is not: its children
 *   are read the same way;
 * - a void or an island (an image, a code block, a table) is one unit:
 *   selected when its box meets the rectangle, never its rows or lines;
 * - a layout and its columns are never selected themselves: the columns the
 *   rectangle meets are read, so it selects the blocks of the columns it
 *   crosses (a layout covered whole stands for them, `liftLayouts`); a list
 *   container (it shows only its items) is read through its items;
 * - a block hidden by view state (a closed toggle's body) never.
 */
export const marqueeBlocks = (edytor: Edytor, rect: MarqueeRect): Block[] => {
	const { facade, idToBlock } = edytor;
	const out: Block[] = [];
	const seen = new Set<string>();
	const box = (block: Block) => block.node?.getBoundingClientRect();
	const add = (block: Block) => {
		if (seen.has(block.id)) return;
		seen.add(block.id);
		out.push(block);
	};
	const unit = (block: Block) => facade.isVoid(block.id) || facade.isIsland(block.id);
	const layout = (block: Block) => facade.isLayout(block.id) || facade.isLayoutItem(block.id);
	/** A block's children ids while they show (a closed toggle hides its whole body). */
	const shownChildren = (block: Block | null): readonly string[] => {
		const ids = facade.childrenIds(block?.id ?? null);
		const first = ids[0];
		return first === undefined || (block && hidden(idToBlock.block(first))) ? [] : ids;
	};
	/** The children of `parent` at the rectangle's height: a binary search over their boxes. */
	const rows = (ids: readonly string[]): Block[] => {
		const at = (i: number) => box(idToBlock.block(ids[i]!));
		let lo = 0;
		let hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const b = at(mid);
			if (!b || b.bottom <= rect.top) lo = mid + 1;
			else hi = mid;
		}
		const first = lo;
		hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const b = at(mid);
			if (!b || b.top < rect.bottom) lo = mid + 1;
			else hi = mid;
		}
		return ids.slice(first, lo).flatMap((id) => {
			const block = idToBlock.block(id);
			return hidden(block) ? [] : [block];
		});
	};
	/** `block` and its shown subtree, a layout and its columns as their blocks. */
	const whole = (block: Block) => {
		if (!layout(block)) add(block);
		if (unit(block)) return;
		for (const id of shownChildren(block)) {
			const child = idToBlock.block(id);
			if (!hidden(child)) whole(child);
		}
	};
	const visit = (block: Block) => {
		const own = box(block);
		if (!own || !meets(rect, own)) return;
		if (unit(block)) return add(block);
		if (facade.isLayout(block.id)) {
			for (const id of facade.childrenIds(block.id)) visit(idToBlock.block(id));
			return;
		}
		const children = shownChildren(block);
		if (facade.isLayoutItem(block.id) || block.isContainer) {
			for (const child of rows(children)) visit(child);
			return;
		}
		const first = children[0] === undefined ? undefined : box(idToBlock.block(children[0]));
		const bottom = first && first.height > 0 && first.top > own.top ? first.top : own.bottom;
		if (meets(rect, { left: own.left, right: own.right, top: own.top, bottom }))
			return whole(block);
		for (const child of rows(children)) visit(child);
	};
	for (const block of rows(shownChildren(null))) visit(block);
	return out;
};
