import {
	getContentTextLength,
	setSelectionAtBlockOffset,
	splitBlockContentAtText
} from '$lib/block/contentRange.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	removeSelectedBlocksForReplacement,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { stripIdsFromContent } from './jsonClipboard.js';
import type { EdytorClipboardFragment } from './types.js';

export const insertContentFragment = async (
	edytor: Edytor,
	fragment: Extract<EdytorClipboardFragment, { kind: 'content' }>
) => {
	const content = stripIdsFromContent(fragment.content);
	if (edytor.selection.selectedBlocks.size > 0) {
		const removed = removeSelectedBlocksForReplacement(edytor);
		if (!removed) {
			return;
		}
		const [insertedBlock] = removed.parent.addChildBlocks({
			blocks: [{ type: fragment.blockType, content }],
			index: removed.index
		});
		if (insertedBlock) {
			await setSelectionAtBlockOffset(insertedBlock, getContentTextLength(content));
		}
		return;
	}

	const target = await replaceSelectionWithCollapsedTarget(edytor);
	if (!target) {
		return;
	}

	const block = target.text.parent;
	const { before, after } = splitBlockContentAtText(target.text, target.offset);
	block.setBlock({
		value: {
			content: [...before, ...content, ...after]
		}
	});
	await setSelectionAtBlockOffset(block, getContentTextLength([...before, ...content]));
};
