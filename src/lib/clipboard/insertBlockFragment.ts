import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import {
	removeSelectedBlocksForReplacement,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { stripIdsFromBlock } from './jsonClipboard.js';
import type { EdytorClipboardFragment } from './types.js';

const focusLastInsertedBlock = async (block: Block | undefined) => {
	const text = block?.lastText;
	if (text) await block.edytor.selection.setAtTextOffset(text, text.length);
};

const insertBlocksAtSelectionTarget = async (
	edytor: Edytor,
	blocks: JSONBlock[],
	target: Text | null
) => {
	const block = target?.parent ?? edytor.selection.state.startBlock;
	if (!block || !block.parent || blocks.length === 0) {
		return;
	}

	const sanitizedBlocks = blocks.map(stripIdsFromBlock);
	if (block.isEmpty) {
		const [firstBlock, ...restBlocks] = sanitizedBlocks;
		block.setBlock({ value: firstBlock });
		const insertedRest = restBlocks.length
			? block.parent.addChildBlocks({ blocks: restBlocks, index: block.index + 1 })
			: [];
		await focusLastInsertedBlock(insertedRest.at(-1) ?? block);
		return;
	}

	const insertedBlocks = block.parent.addChildBlocks({
		blocks: sanitizedBlocks,
		index: block.index + 1
	});
	await focusLastInsertedBlock(insertedBlocks.at(-1));
};

export const insertBlockFragment = async (
	edytor: Edytor,
	fragment: Extract<EdytorClipboardFragment, { kind: 'blocks' }>
) => {
	if (fragment.blocks.length === 0) {
		return;
	}

	if (edytor.selection.selectedBlocks.size > 0) {
		const removed = removeSelectedBlocksForReplacement(edytor);
		if (!removed) {
			return;
		}
		const insertedBlocks = removed.parent.addChildBlocks({
			blocks: fragment.blocks.map(stripIdsFromBlock),
			index: removed.index
		});
		await focusLastInsertedBlock(insertedBlocks.at(-1));
		return;
	}

	const target = await replaceSelectionWithCollapsedTarget(edytor);
	await insertBlocksAtSelectionTarget(edytor, fragment.blocks, target?.text ?? null);
};
