import type { Edytor } from '$lib/edytor.svelte.js';
import type { RenderedNode } from '../../jsx/types.js';

export const emptyFixture = { value: { children: [] } } as unknown as RenderedNode;

export const addMentionAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, yStart } = edytor.selection.state;
	if (!startBlock || !startText) {
		throw new Error('Missing selection state for inline-block insertion');
	}

	return startBlock.addInlineBlock({
		index: yStart,
		block: { type: 'mention' },
		text: startText
	});
};

export const splitAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, yStart } = edytor.selection.state;
	if (!startBlock || !startText) {
		throw new Error('Missing selection state for splitBlock');
	}

	return startBlock.splitBlock({
		index: yStart,
		text: startText
	});
};

export const deleteBlockRangeAtSelection = (edytor: Edytor) => {
	const { startBlock, startText, endText, yStart, yEnd } = edytor.selection.state;
	if (!startBlock || !startText || !endText) {
		throw new Error('Missing selection state for deleteContentAtRange');
	}

	startBlock.deleteContentAtRange({
		start: [startText.index, yStart],
		end: [endText.index, yEnd]
	});
};
