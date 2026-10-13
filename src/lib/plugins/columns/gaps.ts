import type { Block } from '$lib/block/block.svelte.js';

/**
 * The gap between two columns, measured once for the two chrome layers that
 * share it (one measurement, no duplicated geometry): the resize band
 * (`resize.svelte.ts`) and a column block's handle (`BlockHandles.svelte`).
 */

/** The resize band's width (px): Notion's grab zone, its guide drawn in the middle. */
export const BAND = 10;

/** A gap in client px: the right edge of the column before it, the left edge of the one after. */
export type Gap = { left: number; right: number };

/**
 * The gap left of `column` (a layout's item): from the shown column before
 * it to `column`, when that one sits on its left (`null` for the first shown
 * column, an unmounted one, or a stacked layout, whose columns sit one
 * above the other).
 */
export const gapBefore = (column: Block): Gap | null => {
	const own = column.node?.getBoundingClientRect();
	const siblings = column.parent?.children ?? [];
	const index = siblings.indexOf(column);
	if (!own || own.width === 0 || index < 1) return null;
	for (const before of siblings.slice(0, index).reverse()) {
		const rect = before.node?.getBoundingClientRect();
		if (!rect || rect.width === 0) continue;
		const beside = rect.right <= own.left + 1 && rect.top < own.bottom && own.top < rect.bottom;
		return beside ? { left: rect.right, right: Math.max(rect.right, own.left) } : null;
	}
	return null;
};

/**
 * The resize band of `gap`: `BAND` px (the gap's width when narrower)
 * centered in it, its guide on the gap's middle line (Notion's). The handle
 * of a column's block takes the gap's right part (`handleSpan`): its box
 * from the band to the block, its `+` and grip flush with the block
 * (Notion's "+ ⋮⋮", over the band where the gap is narrower than they are).
 * At the default 46px gap (`--edytor-columns-gap`): the band 18–28, the
 * handle's box 28–46.
 */
export const bandOf = ({ left, right }: Gap) => {
	const width = Math.min(BAND, right - left);
	return { left: left + (right - left - width) / 2, width };
};

/** The width a column block's handle spans in `gap`: from the band's right edge to the block at `blockLeft`. */
export const handleSpan = (gap: Gap, blockLeft: number) => {
	const band = bandOf(gap);
	return Math.max(0, blockLeft - (band.left + band.width));
};
