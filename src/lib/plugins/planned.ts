/**
 * What the comments and find plugins share: showing an offset of a block's
 * text.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import { reveal } from '$lib/selection/replaceSelection.js';

/**
 * Show `offset` of block `id`'s text: the closed toggles it sits in open
 * (Notion), and it scrolls into view. The selection stays where it was.
 */
export const showText = (edytor: Edytor, id: string, offset: number) => {
	const block = edytor.idToBlock.get(id);
	if (!block) return;
	reveal(block);
	block.textAtOffset(offset)?.text.node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
};
