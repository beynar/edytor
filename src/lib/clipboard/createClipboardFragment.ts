import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONContentPart } from './types.js';
import type { EdytorClipboardFragment } from './types.js';
import { sliceTextValue } from '$lib/block/contentRange.js';
import { cloneJson, type JSONBlock } from '$lib/utils/json.js';
import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';
import { rangeCovers } from '$lib/selection/visibility.js';

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
			// An atom's `value.data` is a shallow copy of the index's: clone it.
			content.push(cloneJson(part.value));
			continue;
		}

		const start = part === startText ? startOffset : 0;
		const end = part === endText ? endOffset : part.length;
		content.push(...sliceTextValue(part.value, start, end));
	}

	return content;
};

/**
 * Block values nested as in the document, members only: a child that is not
 * a member is left out, a member under a non-member starts a top-level entry.
 * `blocks` in document order; `valueOf` answers fresh JSON (children dropped here).
 */
const nestMembers = (blocks: Block[], valueOf: (block: Block) => JSONBlock): JSONBlock[] => {
	const values = new Map<Block, JSONBlock>();
	const out: JSONBlock[] = [];
	for (const block of blocks) {
		const value = valueOf(block);
		delete value.children;
		values.set(block, value);
		const parent = block.parent && values.get(block.parent);
		if (parent) parent.children = [...(parent.children ?? []), value];
		else out.push(value);
	}
	return out;
};

const extractBlockRange = (edytor: Edytor) => {
	const { blocks, startBlock, endBlock, startText, endText, yStart, yEnd } = edytor.selection.state;
	if (!startBlock || !endBlock || !startText || !endText || blocks.length === 0) {
		return null;
	}
	// A hidden block (a closed toggle's body) is copied exactly when the range's
	// delete removes it, so a cut, or a copy then Backspace, never loses or
	// duplicates it (`del.range.hidden-body`).
	const copied = blocks.filter(rangeCovers(edytor));
	// `block.value` is the document's serializer output: fresh JSON, no clone.
	return nestMembers(copied, (block) => {
		const value = block.value;
		if (block === startBlock) {
			value.content = extractContentRange(
				block,
				startText,
				yStart,
				block.lastText!,
				block.lastText!.length
			);
		}
		if (block === endBlock) {
			value.content = extractContentRange(block, block.firstText!, 0, endText, yEnd);
		}
		if (startBlock === endBlock) {
			value.content = extractContentRange(block, startText, yStart, endText, yEnd);
		}
		return value;
	});
};

export const createEdytorClipboardFragment = (edytor: Edytor): EdytorClipboardFragment | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	if (selectedBlocks.length > 0) {
		return {
			version: 1,
			source: 'edytor',
			kind: 'blocks',
			// Exactly the members (`sel.blocks.exact`): what a cut copies is what it deletes.
			blocks: nestMembers(selectedBlocks, (block) => block.value),
			whole: true
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
