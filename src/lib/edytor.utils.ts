import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import { deltaToJson, toDeltas } from './text/deltas.js';
import { InlineBlock } from './block/inlineBlock.svelte.js';
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
					// Delete from offset to end
					part.yText.delete(0, yEnd);
					const deltas = deltaToJson(toDeltas(part.yText)[0]);
					return deltas;
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
				console.log({ part });
				const text = new Text({
					parent: startBlock!,
					content: part
				});
				return text.yText;
			}
		});

		startBlock?.yContent.push(value);
	}
	blocksToDelete.forEach((block, index) => {
		block.removeBlock();
	});

	if (endBlock?.hasChildren) {
		const newBlocks = endBlock.children.map((child) => {
			const newBlock = new Block({
				parent: startBlock!.parent,
				edytor: this,
				block: child.value
			});
			return newBlock.yBlock;
		});

		startBlock?.parent?.yChildren.insert(startBlock!.index + 1, newBlocks);
	}
	endBlock?.removeBlock();

	return [startText, yStart] as const;
}
