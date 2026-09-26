import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONContentPart } from './types.js';
import type { EdytorClipboardFragment } from './types.js';
import { sliceTextValue } from '$lib/block/contentRange.js';
import { cloneJson } from '$lib/utils/json.js';
import { stripIdsFromBlock } from './jsonClipboard.js';
import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';

const extractContentRange = (
	block: Block,
	startText: Text,
	startOffset: number,
	endText: Text,
	endOffset: number
) => {
	const content: JSONContentPart[] = [];
	const startIndex = block.content.indexOf(startText);
	const endIndex = block.content.indexOf(endText);

	for (const [index, part] of block.content.entries()) {
		if (index < startIndex || index > endIndex) {
			continue;
		}

		if (part instanceof InlineBlock) {
			content.push(cloneJson(part.value));
			continue;
		}

		const start = part === startText ? startOffset : 0;
		const end = part === endText ? endOffset : part.length;
		content.push(...sliceTextValue(part.value, start, end));
	}

	return content;
};

const extractBlockRange = (edytor: Edytor) => {
	const { blocks, startBlock, endBlock, startText, endText, yStart, yEnd } = edytor.selection.state;
	if (!startBlock || !endBlock || !startText || !endText || blocks.length === 0) {
		return null;
	}

	const selectedBlocks = new Set(blocks);
	const values = new Map<Block, ReturnType<typeof stripIdsFromBlock>>();
	const fragmentBlocks: ReturnType<typeof stripIdsFromBlock>[] = [];

	for (const block of blocks) {
		const value = stripIdsFromBlock(block.value);
		delete value.children;

		if (block === startBlock) {
			value.content = extractContentRange(
				block,
				startText,
				yStart,
				block.lastText,
				block.lastText.length
			);
		}
		if (block === endBlock) {
			value.content = extractContentRange(block, block.firstText, 0, endText, yEnd);
		}
		if (startBlock === endBlock) {
			value.content = extractContentRange(block, startText, yStart, endText, yEnd);
		}

		values.set(block, value);
	}

	for (const block of blocks) {
		const value = values.get(block);
		if (!value) {
			continue;
		}

		if (block.parent && selectedBlocks.has(block.parent)) {
			const parentValue = values.get(block.parent);
			if (parentValue) {
				parentValue.children = [...(parentValue.children ?? []), value];
				continue;
			}
		}

		fragmentBlocks.push(value);
	}

	return fragmentBlocks;
};

export const createEdytorClipboardFragment = (edytor: Edytor): EdytorClipboardFragment | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	if (selectedBlocks.length > 0) {
		return {
			version: 1,
			source: 'edytor',
			kind: 'blocks',
			blocks: selectedBlocks.map((block) => stripIdsFromBlock(block.value))
		};
	}

	const { startBlock, startText, endText, yStart, yEnd, isCollapsed, isBlockSpanning } =
		edytor.selection.state;
	if (!startBlock || !startText || !endText || isCollapsed) {
		return null;
	}

	if (isBlockSpanning) {
		const blocks = extractBlockRange(edytor);
		return blocks
			? {
					version: 1,
					source: 'edytor',
					kind: 'blocks',
					blocks
				}
			: null;
	}

	return {
		version: 1,
		source: 'edytor',
		kind: 'content',
		blockType: startBlock.type,
		content: extractContentRange(startBlock, startText, yStart, endText, yEnd)
	};
};
