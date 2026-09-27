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
	blockToFocus: Block | null;
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

export const replaceSelectionWithCollapsedTargetSync = (
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

export const replaceSelectionWithCollapsedTarget = async (
	edytor: Edytor,
	state: SelectionReplacementState = getSelectionReplacementState(edytor)
): Promise<SelectionInsertionTarget | null> => {
	const target = replaceSelectionWithCollapsedTargetSync(edytor, state);
	if (target) {
		await edytor.selection.setAtTextOffset(target.text, target.offset);
	}
	return target;
};

export const removeSelectedBlocksForReplacement = (
	edytor: Edytor
): RemovedSelectedBlocks | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	const firstBlock = selectedBlocks.at(0);
	const lastBlock = selectedBlocks.at(-1);
	const parent = firstBlock?.parent;
	const index = firstBlock?.index ?? 0;
	const selectedBlockSet = new Set(selectedBlocks);

	if (!firstBlock || !lastBlock || !parent) {
		return null;
	}

	let blockToFocus =
		getClosestUnselectedBlock(firstBlock, selectedBlockSet, 'previous') ||
		getClosestUnselectedBlock(lastBlock, selectedBlockSet, 'next');
	if (!edytor.deleteBlocks({ blocks: selectedBlocks })) return null;
	edytor.selection.selectBlocks();
	blockToFocus ??=
		parent.children[index] ?? parent.children[index - 1] ?? edytor.root?.children[0] ?? null;

	return {
		parent,
		index,
		blockToFocus,
		selectedBlocks
	};
};

export const replaceSelectedBlocksWithEmptyBlockTargetSync = (
	edytor: Edytor,
	blockType?: string
): SelectionInsertionTarget | null => {
	const removed = removeSelectedBlocksForReplacement(edytor);
	if (!removed) {
		return null;
	}

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

export const replaceSelectedBlocksWithEmptyBlockTarget = async (
	edytor: Edytor,
	blockType?: string
): Promise<SelectionInsertionTarget | null> => {
	const target = replaceSelectedBlocksWithEmptyBlockTargetSync(edytor, blockType);
	if (target) {
		await edytor.selection.setAtTextOffset(target.text, target.offset);
	}
	return target;
};
