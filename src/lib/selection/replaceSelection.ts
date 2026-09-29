import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { RangeEndpoints } from '$lib/edytor.utils.js';
import { id } from '$lib/utils.js';

export type SelectionInsertionTarget = {
	text: Text;
	offset: number;
};

export type SelectionReplacementState = RangeEndpoints & { isCollapsed: boolean };

export type RemovedSelectedBlocks = {
	parent: Block;
	index: number;
	selectedBlocks: Block[];
};

export const getSelectionReplacementState = (edytor: Edytor): SelectionReplacementState => {
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	return { startText, endText, yStart, yEnd, isCollapsed };
};

export const getSelectedBlocksInDocumentOrder = (edytor: Edytor) =>
	Array.from(edytor.selection.selectedBlocks).sort(edytor.compareBlocks);

/**
 * The blocks the selection touches, in document order: the selected blocks;
 * for a text range, every shown block from its start block to its end block
 * (Notion: a collapsed toggle's hidden body is not touched, an open
 * toggle's children are); else the caret's block. Menus, the toolbar, kind
 * commands and Tab read it.
 */
export const getSelectionBlocks = (edytor: Edytor): Block[] => {
	const { selectedBlocks, state, hidden } = edytor.selection;
	if (selectedBlocks.size) return getSelectedBlocksInDocumentOrder(edytor);
	if (state.isCollapsed) return state.startBlock ? [state.startBlock] : [];
	return state.blocks.filter((block) => !hidden(block));
};

/** The blocks not inside another of them: a block's descendants among them move with it. */
export const outermost = (blocks: Iterable<Block>): Block[] => {
	const all = new Set(blocks);
	const inside = (block: Block) => {
		for (let parent = block.parent; parent; parent = parent.parent)
			if (all.has(parent)) return true;
		return false;
	};
	return [...all].filter((block) => !inside(block));
};

/**
 * Run a block move that never hides a block the user saw (Notion): a closed
 * toggle a moved block lands in opens, and so does a closed toggle that
 * adopts blocks (Shift+Tab takes the blocks after it). `open` is view state
 * (R11). Tab, the handles' Alt+arrows and drops share it. Answers the moved blocks.
 */
export const revealing = (blocks: Block[], move: () => Block[]) => {
	const had = new Map(blocks.map((block) => [block, block.children.length]));
	const moved = move();
	const open = (block: Block) => {
		if (block.node?.tagName === 'DETAILS') (block.node as HTMLDetailsElement).open = true;
	};
	for (const block of moved) {
		for (let parent = block.parent; parent; parent = parent.parent) open(parent);
		if (block.children.length > (had.get(block) ?? Infinity)) open(block);
	}
	return moved;
};

/**
 * The nearest block before/after `block` in document order that is not in
 * `excluded` and is displayed once they are deleted (a collapsed toggle's
 * body is skipped, unless the toggle is among them: its children take its
 * place).
 */
export const getClosestUnselectedBlock = (
	block: Block | undefined,
	excluded: Set<Block>,
	direction: 'previous' | 'next'
): Block | null =>
	block
		? block.edytor.selection.shown(block, direction === 'previous' ? 'blockBefore' : 'blockAfter', {
				removed: excluded
			})
		: null;

export const replaceSelectionWithCollapsedTarget = (
	edytor: Edytor,
	state: SelectionReplacementState = getSelectionReplacementState(edytor)
): SelectionInsertionTarget | null => {
	const { startText, yStart } = state;
	if (!startText || state.isCollapsed) {
		return startText && { text: startText, offset: yStart };
	}
	const [text, offset] =
		edytor.deleteContentWithinSelection({ replace: true, selection: state }) ?? [];
	return text ? { text, offset: offset! } : null;
};

export const removeSelectedBlocksForReplacement = (
	edytor: Edytor
): RemovedSelectedBlocks | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	const parent = selectedBlocks[0]?.parent;
	const index = selectedBlocks[0]?.index ?? 0;
	if (!parent) return null;
	if (!edytor.deleteBlocks({ blocks: selectedBlocks })) return null;
	return { parent, index, selectedBlocks };
};

/**
 * Delete (or cut) the selected blocks. The command authors its result
 * selection (FP-7, R9): a caret at the end of the first editable text of the
 * nearest unselected block before them, else after them — declared before the
 * delete, so the seam never runs for it. With neither, the seam applies.
 * Answers the caret's text.
 */
export const deleteSelectedBlocks = (edytor: Edytor): Text | null => {
	const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
	const set = new Set(selectedBlocks);
	const text = (
		getClosestUnselectedBlock(selectedBlocks[0], set, 'previous') ||
		getClosestUnselectedBlock(selectedBlocks.at(-1), set, 'next')
	)?.firstEditableText;
	const removed = edytor.dispatcher.caret(text, text?.length ?? 0, () =>
		removeSelectedBlocksForReplacement(edytor)
	);
	return removed ? (text ?? null) : null;
};

/**
 * Typing over a block selection (`flow.slot`): the selected blocks go and one
 * empty block takes the first one's slot, in ONE plan — deleting them first
 * would let the emptied parent normalize in a survivor beside the new block.
 */
export const replaceSelectedBlocksWithEmptyBlockTargetSync = (
	edytor: Edytor,
	blockType?: string
): SelectionInsertionTarget | null => {
	const selected = getSelectedBlocksInDocumentOrder(edytor);
	const parent = selected[0]?.parent;
	if (!parent) return null;
	const [text, offset] = edytor.insertFlow({
		flow: { lines: [{ id: id('b'), type: blockType ?? edytor.defaultChild(parent) }] },
		target: { replace: selected.map((block) => block.id) }
	});
	if (!text) return null;
	edytor.selection.selectBlocks();
	return { text, offset };
};
