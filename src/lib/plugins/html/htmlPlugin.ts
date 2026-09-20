import type { Block } from '$lib/block/block.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import {
	getContentTextLength,
	setSelectionAtBlockOffset,
	splitBlockContentAtText,
	type JSONContentPart
} from '$lib/block/contentRange.js';
import type { SelectionInsertionTarget } from '$lib/selection/replaceSelection.js';
import {
	replaceSelectedBlocksWithEmptyBlockTarget,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { ElementDefinitions } from './deserialize.js';
import { parseHtml } from './deserialize.js';

type HTMLPluginOptions = Partial<ElementDefinitions>;

const mergeTrailingContent = (block: Block, trailing: JSONContentPart[]) => {
	if (!trailing.length) {
		return;
	}

	block.setBlock({
		value: {
			content: [...(block.value.content ?? []), ...trailing]
		}
	});
};

const buildPastedTargetBlock = (
	targetBlock: Block,
	firstBlock: JSONBlock,
	content: JSONContentPart[]
): Partial<JSONBlock> => {
	if (targetBlock.isEmpty && firstBlock.type !== '$fragment') {
		return {
			type: firstBlock.type,
			data: firstBlock.data,
			content
		};
	}

	return { content };
};

const insertParsedHtml = async (target: SelectionInsertionTarget, blocks: JSONBlock[]) => {
	const currentBlock = target.text.parent;
	const { before, after } = splitBlockContentAtText(target.text, target.offset);
	const [first, ...rest] = blocks;

	if (!first) {
		return;
	}

	const firstContent = first.type === '$fragment' ? (first.content ?? []) : (first.content ?? []);
	if (rest.length === 0) {
		currentBlock.setBlock({
			value: buildPastedTargetBlock(currentBlock, first, [...before, ...firstContent, ...after])
		});
		await setSelectionAtBlockOffset(
			currentBlock,
			getContentTextLength([...before, ...firstContent])
		);
		return;
	}

	currentBlock.setBlock({
		value: buildPastedTargetBlock(currentBlock, first, [...before, ...firstContent])
	});

	let previousBlock = currentBlock;
	for (const nextBlock of rest) {
		const inserted = previousBlock.insertBlockAfter({
			block: nextBlock
		});
		if (inserted) {
			previousBlock = inserted;
		}
	}

	mergeTrailingContent(previousBlock, after);
	await setSelectionAtBlockOffset(
		previousBlock,
		getContentTextLength(previousBlock.value.content ?? []) - getContentTextLength(after)
	);
};

export const htmlPlugin =
	(options: HTMLPluginOptions): Plugin =>
	(edytor) => {
		return {
			onPaste: ({ prevent, e }) => {
				const html = e.clipboardData?.getData('text/html');
				if (!html) {
					return;
				}

				prevent(async () => {
					const parsedBlocks = parseHtml.call(edytor, html, options);
					edytor.undoManager.stopCapturing();

					const target =
						edytor.selection.selectedBlocks.size > 0
							? await replaceSelectedBlocksWithEmptyBlockTarget(edytor)
							: await replaceSelectionWithCollapsedTarget(edytor);
					if (!target) return;

					await insertParsedHtml(target, parsedBlocks);
				});
			}
		};
	};
