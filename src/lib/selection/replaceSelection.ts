import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { RangeEndpoints } from '$lib/edytor.utils.js';

export type SelectionInsertionTarget = {
	text: Text;
	offset: number;
};

export type SelectionReplacementState = RangeEndpoints & { isCollapsed: boolean };

export type RemovedSelectedBlocks = {
	parent: Block;
	index: number;
	selectedBlocks: Block[];
};

export const getSelectionReplacementState = (edytor: Edytor): SelectionReplacementState => {
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	return { startText, endText, yStart, yEnd, isCollapsed };
};

export const getSelectedBlocksInDocumentOrder = (edytor: Edytor) =>
	Array.from(edytor.selection.selectedBlocks).sort(edytor.compareBlocks);

/** The nearest block before/after `block` in document order that is not in `excluded`. */
export const getClosestUnselectedBlock = (
	block: Block | undefined,
	excluded: Set<Block>,
	direction: 'previous' | 'next'
): Block | null => {
	const step = (b: Block) =>
		direction === 'previous' ? b.edytor.blockBefore(b) : b.edytor.blockAfter(b);
	let current = block ? step(block) : null;
	while (current && excluded.has(current)) current = step(current);
	return current;
};

export const replaceSelectionWithCollapsedTarget = (
	edytor: Edytor,
	state: SelectionReplacementState = getSelectionReplacementState(edytor)
): SelectionInsertionTarget | null => {
	const { startText, yStart } = state;
	if (!startText || state.isCollapsed) {
		return startText && { text: startText, offset: yStart };
	}
	const [text, offset] =
		edytor.deleteContentWithinSelection({ replace: true, selection: state }) ?? [];
	return text ? { text, offset: offset! } : null;
};

export const removeSelectedBlocksForReplacement = (
	edytor: Edytor
): RemovedSelectedBlocks | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	const parent = selectedBlocks[0]?.parent;
	const index = selectedBlocks[0]?.index ?? 0;
	if (!parent) return null;
	if (!edytor.deleteBlocks({ blocks: selectedBlocks })) return null;
	return { parent, index, selectedBlocks };
};

/**
 * Delete (or cut) the selected blocks. The command authors its result
 * selection (FP-7, R9): a caret at the end of the first editable text of the
 * nearest unselected block before them, else after them — declared before the
 * delete, so the seam never runs for it. With neither, the seam applies.
 * Answers the caret's text.
 */
export const deleteSelectedBlocks = (edytor: Edytor): Text | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	const set = new Set(selectedBlocks);
	const text = (
		getClosestUnselectedBlock(selectedBlocks[0], set, 'previous') ||
		getClosestUnselectedBlock(selectedBlocks.at(-1), set, 'next')
	)?.firstEditableText;
	const removed = edytor.dispatcher.caret(text, text?.length ?? 0, () =>
		removeSelectedBlocksForReplacement(edytor)
	);
	return removed ? (text ?? null) : null;
};

export const replaceSelectedBlocksWithEmptyBlockTargetSync = (
	edytor: Edytor,
	blockType?: string
): SelectionInsertionTarget | null => {
	const removed = removeSelectedBlocksForReplacement(edytor);
	if (!removed) {
		return null;
	}
	edytor.selection.selectBlocks();

	const [insertedBlock] = removed.parent.addChildBlocks({
		blocks: [{ type: blockType ?? edytor.defaultChild(removed.parent) }],
		index: removed.index
	});
	const text = insertedBlock?.firstText;
	if (!text) {
		return null;
	}

	return { text, offset: 0 };
};
