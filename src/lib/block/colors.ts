/**
 * Block colours (Notion's "Color" in the block menu): a block's text colour
 * and background, by palette name, in two data leaves, `data.color` and
 * `data.background`. Each is one property of the block, so two people
 * colouring it at once keep one value each (per-leaf last writer), and
 * Turn into keeps them (a retype sets only the leaves it names).
 *
 * The core renders a valid name as `data-edytor-color` and
 * `data-edytor-background` on the block element (`Block.svelte`, owned by
 * the attribute table), and its stylesheet paints the bundled names from
 * theme tokens (`--edytor-color-<name>`, `--edytor-background-<name>`).
 */
import type { Block } from './block.svelte.js';
import type { Edytor } from '../edytor.svelte.js';

/** Notion's palette: the colour names a block may hold, in menu order ("Default" is none). */
export const BLOCK_COLORS = [
	'gray',
	'brown',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink',
	'red'
] as const;

/**
 * Notion's light values of the palette: the fallbacks of the theme tokens
 * (`--edytor-color-<name>`, `--edytor-background-<name>`), as the core's
 * stylesheet (`Block.svelte`) and the Notion theme write them.
 */
export const BLOCK_PALETTE: Record<
	(typeof BLOCK_COLORS)[number],
	{ color: string; background: string }
> = {
	gray: { color: '#7d7a75', background: '#f0efed' },
	brown: { color: '#9f765a', background: '#f5ede9' },
	orange: { color: '#d27b2d', background: '#fbebde' },
	yellow: { color: '#cb9434', background: '#f9f3dc' },
	green: { color: '#50946e', background: '#e8f1ec' },
	blue: { color: '#387dc9', background: '#e5f2fc' },
	purple: { color: '#9a6bb4', background: '#f3ebf9' },
	pink: { color: '#c14c8a', background: '#fae9f1' },
	red: { color: '#cf5148', background: '#fce9e7' }
};

/** A block's colour fields: its text colour and its background. */
export type BlockColorField = 'color' | 'background';

/**
 * A colour name the core renders: lowercase letters, digits and hyphens,
 * starting with a letter (an app's own name, such as `teal`, renders too,
 * and its stylesheet paints it). Anything else renders nothing.
 */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `value` as a colour name, or `undefined`. */
export const colorName = (value: unknown): string | undefined =>
	typeof value === 'string' && NAME.test(value) ? value : undefined;

/** The block element's colour attributes for `data` (absent when it holds none). */
export const colorAttributes = (data: Readonly<Record<string, unknown>> | undefined) => ({
	'data-edytor-color': colorName(data?.color),
	'data-edytor-background': colorName(data?.background)
});

/**
 * Whether `block` takes a colour: a block showing its own text (a
 * paragraph, a heading, a list item, a toggle, a callout), not a void (a
 * divider, an image), an island (a code block) or one of its lines.
 */
export const colorable = (block: Block): boolean => {
	const { facade } = block.edytor;
	const line = block.parent && !block.parent.isRoot && facade.isLines(block.parent.id);
	return (
		!block.isRoot &&
		block.rendersContent &&
		!facade.isVoid(block.id) &&
		!facade.isIsland(block.id) &&
		!line
	);
};

/**
 * Set `field` of every colourable block of `blocks` to `value` (`null`
 * removes it: the default), as one command and one undo step; each block
 * is its own data write (`patchData`), so an extension vetoing one keeps
 * that block as it was. Answers whether any block changed.
 */
export const setBlockColor = (
	edytor: Edytor,
	blocks: Iterable<Block>,
	field: BlockColorField,
	value: string | null
): boolean => {
	const name = value === null ? undefined : colorName(value);
	if (value !== null && name === undefined) return false;
	const painted = [...blocks].filter(
		(block) => colorable(block) && edytor.facade.blockDataOf(block.id)?.[field] !== name
	);
	if (!painted.length) return false;
	const applied = edytor.dispatcher.each('setBlockColor', painted, (block) => {
		block.patchData({ ops: [{ path: [field], value: name }] });
		return edytor.dispatcher.last?.status === 'applied';
	});
	return applied.some(Boolean);
};
