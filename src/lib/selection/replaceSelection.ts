import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { RangeEndpoints } from '$lib/edytor.utils.js';
import { id } from '$lib/utils.js';
import { hidden, shown } from './visibility.js';

export type SelectionInsertionTarget = {
	text: Text;
	offset: number;
};

export type SelectionReplacementState = RangeEndpoints & { isCollapsed: boolean };

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
 * toggle's children are) but a container it starts or ends in — a list
 * shows no text of its own, so a range entering it touches the items, never
 * the list (ZW-02, AW-02); a list the range runs through is touched whole,
 * so Tab moves it with the blocks around it, in order (DR-behavior-1); else
 * the caret's block. Menus, the toolbar, kind commands and Tab read it.
 */
export const getSelectionBlocks = (edytor: Edytor): Block[] => {
	const { selectedBlocks, state } = edytor.selection;
	if (selectedBlocks.size) return getSelectedBlocksInDocumentOrder(edytor);
	if (state.isCollapsed) return state.startBlock ? [state.startBlock] : [];
	const edges = [state.startBlock, state.endBlock];
	const enters = (block: Block) =>
		block.isContainer && edges.some((edge) => edge && isInside(edge, block));
	return state.blocks.filter((block) => !hidden(block) && !enters(block));
};

/** Whether `block` is a descendant of `ancestor`. */
const isInside = (block: Block, ancestor: Block) => {
	for (let parent = block.parent; parent; parent = parent.parent)
		if (parent === ancestor) return true;
	return false;
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
 * (R11). Every relative move (`edytor.moveBlocks`) and every block move
 * command (`revealed`) share it. Answers the moved blocks.
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
 * A block's move command (`nestBlock`, `unNestBlock`, `moveBlock`,
 * `moveBlocks`) that reveals what it moved (`revealing`), as the keys and
 * `edytor.moveBlocks` do (ZW-09). A remote peer's move, an undo or a redo
 * opens nothing: `open` is this view's state, and history restores it as
 * it was.
 */
export const revealed = <A extends unknown[], R extends Block | Block[] | null | undefined>(
	command: (...args: A) => R
) =>
	function (this: Block, ...args: A): R {
		let out!: R;
		const moving = (args[0] as { blocks?: Block[] } | undefined)?.blocks ?? [this];
		revealing(moving, () => [(out = command.apply(this, args)) ?? []].flat());
		return out;
	};

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

/** The texts of `block`'s own line (a container's phantom content slot never mounts). */
export const lineOf = (block: Block): Text[] =>
	block.content.filter((part): part is Text => part instanceof Text && part.node != null);

/**
 * The last text of the last line shown in `block`'s subtree: its own line's
 * with no child shown, else its last shown child's (a closed toggle's
 * hidden body is passed over).
 */
export const lastShownText = (block: Block): Text | undefined => {
	for (let i = block.children.length - 1; i >= 0; i--) {
		const child = block.children[i]!;
		const text = hidden(child) ? undefined : lastShownText(child);
		if (text) return text;
	}
	return lineOf(block).at(-1);
};

/**
 * The caret on the nearest line before (at its end) or after (at its start)
 * `block` once `removed` go: blocks with no line of their own (voids,
 * containers) and a closed toggle's hidden body are passed over. The
 * keyboard's and the block menu's block deletes and Escape share it.
 */
export const caretBeside = (
	block: Block,
	step: 'blockBefore' | 'blockAfter',
	removed?: ReadonlySet<Block>
): SelectionInsertionTarget | null => {
	for (let next = shown(block, step, { removed }); next; next = shown(next, step, { removed })) {
		const text = step === 'blockBefore' ? lineOf(next).at(-1) : lineOf(next)[0];
		if (text) return { text, offset: step === 'blockBefore' ? text.length : 0 };
	}
	return null;
};

/**
 * The caret once `blocks` (document order) are deleted, their unselected
 * children promoted (`del.blocks.promote`): the start of a child that takes
 * their place (FW-05), else the end of the nearest line before them, else the
 * start of the nearest line after. The keyboard's block delete and cut and
 * the block menu's Delete share it (YW-04).
 */
export const caretAfterBlockDelete = (
	blocks: readonly Block[]
): SelectionInsertionTarget | null => {
	const removed = new Set(blocks);
	const next = caretBeside(blocks[0], 'blockAfter', removed);
	let promoted = false;
	for (let up = next?.text.parent.parent; up && !promoted; up = up.parent)
		promoted = removed.has(up);
	return (
		(promoted ? next : null) ??
		caretBeside(blocks[0], 'blockBefore', removed) ??
		caretBeside(blocks.at(-1)!, 'blockAfter', removed)
	);
};

/**
 * Delete (or cut) the selected blocks. The command authors its result
 * selection (FP-7, R9) by `caretAfterBlockDelete`, declared before the
 * delete, so the seam never runs for it. With none, the seam applies.
 * Answers the caret's text.
 */
export const deleteSelectedBlocks = (edytor: Edytor): Text | null => {
	const blocks = getSelectedBlocksInDocumentOrder(edytor);
	if (!blocks[0]?.parent) return null;
	const at = caretAfterBlockDelete(blocks);
	const deleted = edytor.dispatcher.caret(at?.text, at?.offset ?? 0, () =>
		edytor.deleteBlocks({ blocks })
	);
	return deleted ? (at?.text ?? null) : null;
};

/** Delete the selected range (or `selection`) as Backspace does (`del.range.*`), then its caret. */
export const deleteSelectedRange = (
	edytor: Edytor,
	payload: { selection?: RangeEndpoints } = {}
) => {
	const [text, offset] = edytor.deleteContentWithinSelection(payload) ?? [];
	if (text) edytor.selection.setAtTextOffset(text, offset!);
};

/**
 * Typing over a block selection (`flow.slot`): the selected blocks go and one
 * empty block takes the first one's slot, in ONE plan — deleting them first
 * would let the emptied parent normalize in a survivor beside the new block.
 */
const replaceSelectedBlocksWithEmptyBlock = (edytor: Edytor): SelectionInsertionTarget | null => {
	const selected = getSelectedBlocksInDocumentOrder(edytor);
	const parent = selected[0]?.parent;
	if (!parent) return null;
	const [text, offset] = edytor.insertFlow({
		flow: { lines: [{ id: id('b'), type: edytor.defaultChild(parent) }] },
		target: { replace: selected.map((block) => block.id) }
	});
	if (!text) return null;
	edytor.selection.selectBlocks();
	return { text, offset };
};

/** Where typed text lands: over selected blocks, one empty block in their place; else the range replaced. */
export const replaceSelectionForInsertion = (edytor: Edytor, state?: SelectionReplacementState) =>
	edytor.selection.selectedBlocks.size
		? replaceSelectedBlocksWithEmptyBlock(edytor)
		: replaceSelectionWithCollapsedTarget(edytor, state);
