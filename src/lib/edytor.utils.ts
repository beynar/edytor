import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import type { Edytor } from './edytor.svelte.js';

import { InlineBlock } from './block/inlineBlock.svelte.js';

const getClosestRemainingBlock = (
	block: Block | undefined,
	blocksToDelete: Set<Block>,
	direction: 'previous' | 'next'
) => {
	let current = direction === 'previous' ? block?.closestPreviousBlock : block?.closestNextBlock;
	while (current && blocksToDelete.has(current)) {
		current = direction === 'previous' ? current.closestPreviousBlock : current.closestNextBlock;
	}
	return current && !current.isRoot ? current : null;
};

export function deleteContentWithinSelection(this: Edytor, {}) {
	const {
		startBlock,
		startText,
		endBlock,
		yStart,
		yEnd,
		isAtStartOfBlock,
		isAtEndOfBlock,
		endText
	} = this.selection.state;

	if (startBlock && endBlock && startBlock === endBlock && startText && endText) {
		startBlock.deleteContentAtRange({
			start: [startText.index, yStart],
			end: [endText.index, yEnd]
		});
		return [startText, yStart] as const;
	}

	const blocksToDelete = this.selection.state.blocks.filter((block, index) => {
		const isFirst = index === 0;
		const isLast = index === this.selection.state.blocks.length - 1;
		if (isFirst) {
			return isAtStartOfBlock;
		} else if (isLast) {
			return isAtEndOfBlock;
		} else {
			return true;
		}
	});
	const deletedBlockSet = new Set(blocksToDelete);
	const firstDeletedBlock = blocksToDelete[0];
	const lastDeletedBlock = blocksToDelete.at(-1);
	const fallbackPreviousBlock = getClosestRemainingBlock(
		firstDeletedBlock,
		deletedBlockSet,
		'previous'
	);
	const fallbackNextBlock = getClosestRemainingBlock(lastDeletedBlock, deletedBlockSet, 'next');
	const fallbackText =
		startBlock && !deletedBlockSet.has(startBlock) && startText
			? startText
			: (fallbackPreviousBlock?.lastText ?? fallbackNextBlock?.firstText ?? null);
	const fallbackOffset =
		startBlock && !deletedBlockSet.has(startBlock) && startText
			? yStart
			: fallbackPreviousBlock
				? (fallbackText?.length ?? 0)
				: 0;

	const firstRange =
		startText && startBlock
			? {
					start: [startText.index, yStart] as [number, number],
					end: [startBlock.lastText.index, startBlock.lastText.length] as [number, number]
				}
			: null;

	if (startBlock !== blocksToDelete[0] && firstRange) {
		// Delete the text from the yStart
		startBlock?.deleteContentAtRange(firstRange);
	}
	// We need to find the content that will be merged into the first block
	if (endBlock && endText && endBlock !== blocksToDelete[blocksToDelete.length - 1]) {
		const contentToMerge = endBlock.content
			.slice(endText.index, endBlock?.content.length)
			.map((part, index) => {
				const isFirstPart = index === 0;

				if (part instanceof Text && isFirstPart) {
					// Delete from offset to end — the merge tail is the JSON slice
					// after `yEnd` of the ORIGINAL items.
					const tail = part._sliceFrom(yEnd);
					part.yText.delete(0, yEnd);
					return tail;
				}

				return part.value;
			});
		const value = contentToMerge.map((part) => {
			if ('type' in part) {
				const block = new InlineBlock({
					parent: startBlock!,
					block: part
				});
				return block.yBlock;
			} else {
				const text = new Text({
					parent: startBlock!,
					content: part
				});
				return text.yText;
			}
		});

		startBlock?.yContent.push(value);
		startBlock?.normalizeContent();
	}
	blocksToDelete.forEach((block, index) => {
		block.removeBlock();
	});

	if (endBlock?.hasChildren) {
		// Relocate the end block's surviving children under the start block's
		// parent (move, not copy — `insertBlock` rejects specs with existing
		// ids, and moving preserves block identity for undo/collab).
		const moving = endBlock.children.map((child) => child.yBlock);
		startBlock?.parent?.yChildren.insert(startBlock!.index + 1, moving);
	}
	endBlock?.removeBlock();
	startBlock?.parent?.normalizeChildren();

	return [fallbackText, fallbackOffset] as const;
}
