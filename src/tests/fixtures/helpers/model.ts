import type { Edytor } from '$lib/edytor.svelte.js';
import type { RenderedNode } from '../../jsx/types.js';
import { selectionState } from '../../selection.js';
import { id } from '$lib/utils.js';

export const emptyFixture = { value: { children: [] } } as unknown as RenderedNode;

export const addMentionAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, yStart } = selectionState(edytor);
	if (!startBlock || !startText) {
		throw new Error('Missing selection state for inline-block insertion');
	}

	return edytor.insertInline(startBlock.id, startText.segStart + yStart, { type: 'mention' });
};

export const splitAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, yStart } = selectionState(edytor);
	if (!startBlock || !startText) {
		throw new Error('Missing selection state for splitBlock');
	}

	// Enter's tail: a continuing kind again, with its first preset's data; else the parent's default.
	const tail = startBlock.definition.continues
		? { type: startBlock.type, data: { ...startBlock.definition.presets?.[0]?.data } }
		: { type: edytor.defaultChild(startBlock.parent!) };
	return edytor.splitBlock(startBlock.id, startText.segStart + yStart, id('b'), tail);
};

export const deleteBlockRangeAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, endText, yStart, yEnd } = selectionState(edytor);
	if (!startBlock || !startText || !endText) {
		throw new Error('Missing selection state for deleteRange');
	}

	const at = startText.segStart + yStart;
	edytor.deleteText(startBlock.id, at, endText.segStart + yEnd - at);
};
