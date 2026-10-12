/**
 * Test reads and writes of the selection in text-segment terms: the view's
 * value and projection, lowered to the handles the assertions name
 * (`selection.textRange`, `block.textAtOffset`). Not shipped.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { blockSelection } from '$lib/session/selection.js';

/**
 * The selection's ends as text segments and the blocks they lie in, with
 * the projection's direction and span flags; for a block selection,
 * `blocks` is exactly its live members in document order.
 */
export const selectionState = (edytor: Edytor) => {
	const { selection, facade, idToBlock } = edytor;
	const projection = selection.projection;
	const range = selection.textRange(projection);
	const { value } = selection;
	const ids =
		value.kind === 'blocks'
			? value.ids.filter((id) => facade.isVisibleBlock(id)).sort((a, b) => facade.compare(a, b))
			: projection.blocks;
	return {
		...range,
		startBlock: range.startText?.parent ?? null,
		endBlock: range.endText?.parent ?? null,
		blocks: projection.start ? ids.flatMap((id) => idToBlock.get(id) ?? []) : [],
		isCollapsed: projection.isCollapsed,
		isReversed: projection.isReversed,
		isBlockSpanning: projection.isBlockSpanning,
		edge: selection.edge,
		isVoidEditableElement: selection.voidField
	};
};

/** Select exactly `blocks` (a block selection). */
export const selectBlocks = (edytor: Edytor, ...blocks: (Block | null | undefined)[]) =>
	edytor.selection.select(blockSelection(blocks.flatMap((block) => (block ? [block.id] : []))));
