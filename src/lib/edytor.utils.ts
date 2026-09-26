import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import type { Edytor } from './edytor.svelte.js';

import { InlineBlock } from './block/inlineBlock.svelte.js';
import { getClosestUnselectedBlock } from './selection/replaceSelection.js';

export function deleteContentWithinSelection(
	this: Edytor,
	{
		preserveStartBlock = false,
		selection: selectionOverride
	}: {
		preserveStartBlock?: boolean;
		selection?: {
			startText: Text | null;
			endText: Text | null;
			yStart: number;
			yEnd: number;
		};
	}
) {
	const selection = selectionOverride ?? this.selection.state;
	const { startText, endText, yStart, yEnd } = selection;
	const startBlock = selectionOverride
		? (startText?.parent ?? null)
		: this.selection.state.startBlock;
	const endBlock = selectionOverride ? (endText?.parent ?? null) : this.selection.state.endBlock;
	const isAtStartOfBlock = selectionOverride
		? Boolean(startText && startBlock && startText === startBlock.firstText && yStart === 0)
		: this.selection.state.isAtStartOfBlock;
	const isAtEndOfBlock = selectionOverride
		? Boolean(endText && endBlock && endText === endBlock.lastText && yEnd === endText.length)
		: this.selection.state.isAtEndOfBlock;
	const selectedBlocks = (() => {
		if (!selectionOverride) {
			return this.selection.state.blocks;
		}
		return startBlock ? this.blocksBetween(startBlock, endBlock) : [];
	})();

	if (startBlock && endBlock && startBlock === endBlock && startText && endText) {
		startBlock.deleteContentAtRange({
			start: [startText.index, yStart],
			end: [endText.index, yEnd]
		});
		return [startText, yStart] as const;
	}

	const blocksToDelete = selectedBlocks.filter((block, index) => {
		const isFirst = index === 0;
		const isLast = index === selectedBlocks.length - 1;
		if (isFirst) {
			return isAtStartOfBlock && !preserveStartBlock;
		} else if (isLast) {
			return isAtEndOfBlock;
		} else {
			return true;
		}
	});
	const deletedBlockSet = new Set(blocksToDelete);
	const deletesStartBlock = Boolean(startBlock && deletedBlockSet.has(startBlock));
	const keepsPartialEndBlock = Boolean(endBlock && endText && !deletedBlockSet.has(endBlock));
	const deletedEndAncestor = endBlock
		? blocksToDelete.find(
				(block) =>
					block !== endBlock &&
					block.path.length < endBlock.path.length &&
					block.path.every((segment, index) => endBlock.path[index] === segment)
			)
		: undefined;
	if (
		deletesStartBlock &&
		keepsPartialEndBlock &&
		deletedEndAncestor &&
		deletedEndAncestor.parent &&
		endBlock &&
		endText
	) {
		const destinationParent = deletedEndAncestor.parent;
		const destinationIndex = deletedEndAncestor.index;
		const survivingBlocks = [endBlock];
		let branch = endBlock;
		while (branch !== deletedEndAncestor) {
			const parent = branch.parent;
			if (!parent) break;
			survivingBlocks.push(...parent.children.slice(branch.index + 1));
			branch = parent;
		}

		endBlock.deleteContentAtRange({
			start: [endBlock.firstText.index, 0],
			end: [endText.index, yEnd]
		});
		destinationParent.insertChildren(destinationIndex, survivingBlocks);
		deletedEndAncestor.removeBlock();
		for (const block of blocksToDelete) {
			if (block === deletedEndAncestor) continue;
			let insideDoomedSubtree = false;
			for (let cur: Block | undefined = block.parent; cur instanceof Block; cur = cur.parent) {
				if (cur === deletedEndAncestor) {
					insideDoomedSubtree = true;
					break;
				}
			}
			if (!insideDoomedSubtree) block.removeBlock();
		}
		destinationParent.normalizeChildren();
		return [endBlock.firstText, 0] as const;
	}
	if (deletesStartBlock && keepsPartialEndBlock && !deletedEndAncestor && endBlock && endText) {
		endBlock.deleteContentAtRange({
			start: [endBlock.firstText.index, 0],
			end: [endText.index, yEnd]
		});
		for (const block of blocksToDelete.toReversed()) {
			block.removeBlock();
		}
		endBlock.parent?.normalizeChildren();
		return [endBlock.firstText, 0] as const;
	}
	const firstDeletedBlock = blocksToDelete[0];
	const lastDeletedBlock = blocksToDelete.at(-1);
	const fallbackPreviousBlock = getClosestUnselectedBlock(
		firstDeletedBlock,
		deletedBlockSet,
		'previous'
	);
	const fallbackNextBlock = getClosestUnselectedBlock(lastDeletedBlock, deletedBlockSet, 'next');
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
					part.deleteAt(0, yEnd);
					return tail;
				}

				return part.value;
			});
		const value = contentToMerge.map((part) => {
			if ('type' in part) {
				return new InlineBlock({
					parent: startBlock!,
					block: part
				});
			} else {
				return new Text({
					parent: startBlock!,
					content: part
				});
			}
		});

		startBlock?.insertParts(startBlock.content.length, value);
		startBlock?.normalizeContent();
	}
	blocksToDelete.forEach((block, index) => {
		block.removeBlock();
	});

	if (endBlock?.hasChildren) {
		// Relocate the end block's surviving children under the start block's
		// parent (move, not copy — `insertBlock` rejects specs with existing
		// ids, and moving preserves block identity for undo/collab).
		startBlock?.parent?.insertChildren(startBlock!.index + 1, [...endBlock.children]);
	}
	endBlock?.removeBlock();
	startBlock?.parent?.normalizeChildren();

	const liveFallbackText =
		fallbackText && this.facade.isVisibleBlock(fallbackText.parent.id)
			? fallbackText
			: (this.root?.children[0]?.firstText ?? null);
	return [liveFallbackText, liveFallbackText === fallbackText ? fallbackOffset : 0] as const;
}
