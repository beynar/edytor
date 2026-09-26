import type { Block } from '$lib/block/block.svelte.js';
import { sortBlocksByPath } from '$lib/block/blockPath.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';

export type SelectionInsertionTarget = {
	text: Text;
	offset: number;
};

export type SelectionReplacementState = {
	startText: Text | null;
	endText: Text | null;
	yStart: number;
	yEnd: number;
	isCollapsed: boolean;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
};

export type RemovedSelectedBlocks = {
	parent: Block;
	index: number;
	blockToFocus: Block | null;
	selectedBlocks: Block[];
};

export const getSelectionReplacementState = (edytor: Edytor): SelectionReplacementState => {
	const { startText, endText, yStart, yEnd, isCollapsed, isTextSpanning, isBlockSpanning } =
		edytor.selection.state;

	return {
		startText,
		endText,
		yStart,
		yEnd,
		isCollapsed,
		isTextSpanning,
		isBlockSpanning
	};
};

export const getSelectedBlocksInDocumentOrder = (edytor: Edytor) =>
	sortBlocksByPath(Array.from(edytor.selection.selectedBlocks));

const getClosestUnselectedBlock = (
	block: Block,
	selectedBlocks: Set<Block>,
	direction: 'previous' | 'next'
) => {
	let current = direction === 'previous' ? block.closestPreviousBlock : block.closestNextBlock;
	while (current && selectedBlocks.has(current)) {
		current = direction === 'previous' ? current.closestPreviousBlock : current.closestNextBlock;
	}
	return current;
};

export const replaceSelectionWithCollapsedTargetSync = (
	edytor: Edytor,
	state: SelectionReplacementState = getSelectionReplacementState(edytor)
): SelectionInsertionTarget | null => {
	const { startText, endText, yStart, yEnd } = state;
	if (!startText) {
		return null;
	}

	if (state.isBlockSpanning) {
		const [nextStartText, offset] = edytor.deleteContentWithinSelection({
			preserveStartBlock: true,
			selection: state
		});
		if (!nextStartText) {
			return null;
		}
		return { text: nextStartText, offset };
	}

	if (state.isTextSpanning) {
		if (!endText) {
			return null;
		}
		startText.parent.deleteContentAtRange({
			start: [startText.index, yStart],
			end: [endText.index, yEnd]
		});
		return { text: startText, offset: yStart };
	}

	if (!state.isCollapsed) {
		startText.deleteText({
			direction: 'FORWARD',
			length: yEnd - yStart
		});
		return { text: startText, offset: yStart };
	}

	return { text: startText, offset: yStart };
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
	edytor: Edytor,
	{ queueUndoSelectionSnapshot = false }: { queueUndoSelectionSnapshot?: boolean } = {}
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

	if (queueUndoSelectionSnapshot) {
		edytor.selection.queueNextUndoSelectionSnapshot({
			selectedBlockIds: selectedBlocks.map((block) => block.id),
			selectedBlockPaths: selectedBlocks.map((block) => [...block.path])
		});
	}

	let blockToFocus =
		getClosestUnselectedBlock(firstBlock, selectedBlockSet, 'previous') ||
		getClosestUnselectedBlock(lastBlock, selectedBlockSet, 'next');
	edytor.transact(() => {
		for (const block of selectedBlocks.toReversed()) {
			block.removeBlock();
		}
	});
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
	blockType = edytor.getDefaultBlock()
): SelectionInsertionTarget | null => {
	const removed = removeSelectedBlocksForReplacement(edytor);
	if (!removed) {
		return null;
	}

	const [insertedBlock] = removed.parent.addChildBlocks({
		blocks: [{ type: blockType }],
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
	blockType = edytor.getDefaultBlock()
): Promise<SelectionInsertionTarget | null> => {
	const target = replaceSelectedBlocksWithEmptyBlockTargetSync(edytor, blockType);
	if (target) {
		await edytor.selection.setAtTextOffset(target.text, target.offset);
	}
	return target;
};
