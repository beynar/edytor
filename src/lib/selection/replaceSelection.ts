import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { RangeEndpoints } from '$lib/edytor.utils.js';
import { id, prevent } from '$lib/utils.js';
import { hidden, selectedMembers, shown } from './visibility.js';

export type SelectionInsertionTarget = {
	text: Text;
	offset: number;
};

export type SelectionReplacementState = RangeEndpoints & { isCollapsed: boolean };

export const getSelectionReplacementState = (edytor: Edytor): SelectionReplacementState => {
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	return { startText, endText, yStart, yEnd, isCollapsed };
};

/**
 * The selected blocks as clicked, in document order: a grip-selected list is
 * one block. What a command over them acts on (a list with its items) is
 * `selectedMembers`.
 */
export const getSelectedBlocksInDocumentOrder = (edytor: Edytor) =>
	[...edytor.selection.selectedBlocks].sort(edytor.compareBlocks);

/**
 * The blocks the selection touches, in document order: a block selection's
 * members (`selectedMembers`: a selected list with its items);
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
	if (selectedBlocks.size) return selectedMembers(edytor);
	if (state.isCollapsed) return state.startBlock ? [state.startBlock] : [];
	const edges = [state.startBlock, state.endBlock];
	const enters = (block: Block) =>
		block.isContainer && edges.some((edge) => edge && isInside(edge, block));
	return state.blocks.filter((block) => !hidden(block) && !enters(block));
};

/**
 * The blocks <kbd>Mod</kbd>+<kbd>Enter</kbd> modifies (Notion): the
 * selection's blocks the view shows — a to-do in a closed toggle's body is
 * not touched. The built-in binding opens or closes their toggles
 * (`flipToggles`); the rich-text plugin's also checks their to-dos.
 */
export const shownSelectionBlocks = (edytor: Edytor): Block[] =>
	getSelectionBlocks(edytor).filter((block) => !hidden(block));

/** Open or close each toggle (`<details>`) among `blocks`: view state, not the document. */
export const flipToggles = (blocks: readonly Block[]) => {
	for (const { node } of blocks)
		if (node?.tagName === 'DETAILS')
			(node as HTMLDetailsElement).open = !(node as HTMLDetailsElement).open;
};

/** Whether `block` is a descendant of `ancestor`. */
const isInside = (block: Block, ancestor: Block) => {
	for (let parent = block.parent; parent; parent = parent.parent)
		if (parent === ancestor) return true;
	return false;
};

/**
 * `blocks` with every layout they cover whole standing for it (D3, as
 * Notion): a set holding every shown block of every column of a layout (each
 * displayed item's children) holds the layout instead of them and their
 * descendants. A layout so lifted may
 * in turn fill a column of an outer layout. Decided from the roles
 * (`isLayout`/`isLayoutItem`). The move resolver (`outermost`), Copy and the
 * layout's selection highlight read it; content actions read the members
 * (`selectedMembers`).
 */
export const liftLayouts = (blocks: Iterable<Block>): Block[] => {
	const all = new Set(blocks);
	for (let changed = true; changed; ) {
		changed = false;
		const layouts = new Set<Block>();
		for (const block of all) {
			for (let at = block.parent; at && !at.isRoot; at = at.parent) {
				const facade = at.edytor.facade;
				if (facade.isLayoutItem(at.id) && at.parent) layouts.add(at.parent);
			}
		}
		for (const layout of layouts) {
			if (all.has(layout)) continue;
			const items = layout.children;
			const whole =
				items.length > 0 &&
				items.every((item) => item.children.length > 0 && item.children.every((b) => all.has(b)));
			if (!whole) continue;
			for (const block of [...all]) if (block.isChildOf(layout)) all.delete(block);
			all.add(layout);
			changed = true;
		}
	}
	return [...all];
};

/** Whether a block selection holds `blocks`, a layout it covers whole counting as held (D3). */
export const holdsBlocks = (selected: Iterable<Block>, blocks: readonly Block[]) => {
	const as = [...selected];
	const held = new Set([...as, ...liftLayouts(as)]);
	return blocks.every((block) => held.has(block));
};

/**
 * The blocks not inside another of them: a block's descendants among them
 * move with it. A layout they cover whole stands for its blocks
 * (`liftLayouts`, D3): every move (a grip's drag and Alt+arrows,
 * Mod+Shift+arrows, the block menu's Move) and Duplicate act on it.
 */
export const outermost = (blocks: Iterable<Block>): Block[] => {
	const all = new Set(liftLayouts(blocks));
	const inside = (block: Block) => {
		for (let parent = block.parent; parent; parent = parent.parent)
			if (all.has(parent)) return true;
		return false;
	};
	return [...all].filter((block) => !inside(block));
};

/**
 * What a move of `blocks` takes (a handle's drag, Alt+arrow or click,
 * Mod+Shift+↑/↓ over a range): each one, or its nearest movable ancestor
 * when it cannot move by itself (a code block's line: an island's interior
 * moves with the island), once each. A block's descendants among them
 * travel with it (`outermost`).
 */
export const movable = (blocks: Iterable<Block>): Block[] => {
	const lifted = new Set<Block>();
	for (const block of blocks) {
		let at: Block | undefined = block;
		while (at && !at.isRoot && !at.movable) at = at.parent;
		if (at && !at.isRoot) lifted.add(at);
	}
	return [...lifted];
};

/**
 * Select the blocks a move answered (`moved`), and the blocks of `before`
 * (the block selection it moved) inside them: a moved block's selected
 * child stays selected, so the next step moves the same selection.
 */
export const selectMoved = (edytor: Edytor, moved: Block[], before: Iterable<Block>) => {
	const held = [...before];
	const kept = held.filter((block) => moved.some((root) => isInside(block, root)));
	// A layout moved for the blocks covering it whole stays selected as those blocks (D3).
	const lifted = new Set(liftLayouts(kept));
	const roots = moved.filter((block) => !lifted.has(block) || held.includes(block));
	edytor.selection.selectBlocks(...roots, ...kept);
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

/**
 * The first or last text `block` shows: its own line's (a block selection is
 * exactly its members, never their unselected children), else, for a block
 * with no line of its own (a list, a code block), its subtree's first or
 * last shown line, nested items included (`whole`: the subtree's, in
 * document order); none for a void that shows nothing (a divider) or a
 * closed toggle's hidden body. A line created in the same change counts (it
 * is displayed once it mounts), as for `caretBeside`. Ranges over blocks
 * (`setAtBlockRange`, leaving a block selection), the block-selection keys
 * and Escape read it.
 */
export const shownText = (
	block: Block,
	edge: 'first' | 'last',
	whole = false
): Text | undefined => {
	if (hidden(block)) return undefined;
	const own = edge === 'first' ? block.firstText : block.lastText;
	if (own && (edge === 'first' || !whole)) return own;
	for (const child of edge === 'first' ? block.children : block.children.toReversed()) {
		const text = shownText(child, edge, true);
		if (text) return text;
	}
	return own;
};

/**
 * The line a block selection leaves for (Escape, Enter and Shift+Enter:
 * Notion's Enter edits a selected block's text): the last text of the
 * first selected block's own line, a container's last shown line; a
 * selected block with no shown line (a divider, a hidden body) passes to
 * the next one.
 */
export const selectedBlocksLine = (edytor: Edytor): Text | undefined =>
	getSelectedBlocksInDocumentOrder(edytor)
		.map((block) => shownText(block, 'last'))
		.find(Boolean);

/**
 * The caret on the nearest line before (at its end) or after (at its start)
 * `block` once `removed` go: blocks that render no content of their own
 * (voids, containers) and a closed toggle's hidden body are passed over; a
 * line created in the same change counts (it is displayed once it mounts).
 * The keyboard's and the block menu's block deletes, Escape and the one
 * selection writer (`select`, FX-01) share it.
 */
export const caretBeside = (
	block: Block,
	step: 'blockBefore' | 'blockAfter',
	removed?: ReadonlySet<Block>
): SelectionInsertionTarget | null => {
	for (let next = shown(block, step, { removed }); next; next = shown(next, step, { removed })) {
		const text = step === 'blockBefore' ? next.lastText : next.firstText;
		if (text) return { text, offset: step === 'blockBefore' ? text.length : 0 };
	}
	return null;
};

/**
 * Where the caret goes when a block selection is left without removing
 * anything (Escape; a composition whose replacement a plugin refused): the
 * end of `selectedBlocksLine`; over voids alone (a divider has no line),
 * the start of the nearest shown line after them, else the end of the one
 * before — never the voids' own phantom text.
 */
export const selectedBlocksExit = (edytor: Edytor): SelectionInsertionTarget | null => {
	const line = selectedBlocksLine(edytor);
	if (line) return { text: line, offset: line.length };
	const blocks = getSelectedBlocksInDocumentOrder(edytor);
	if (!blocks.length) return null;
	return caretBeside(blocks.at(-1)!, 'blockAfter') ?? caretBeside(blocks[0]!, 'blockBefore');
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
 * Whether a plugin's `onDeleteSelectedBlocks` keeps `blocks` (document
 * order): then the command removing them is refused. Every gesture that
 * removes a block selection asks first: the keyboard's block delete (any
 * Backspace or Delete chord, and a delete intent's `beforeinput`), cut,
 * the block menu's Delete (`deleteSelectedBlocks`), typing or a composition
 * over it (`replaceSelectedBlocksWithEmptyBlock`) and a paste (`pasteFlow`).
 * Enter and Shift+Enter remove none (`selectedBlocksLine`), so they never ask.
 */
export const keepsSelectedBlocks = (edytor: Edytor, blocks: Block[]) => {
	const kept = edytor.dispatcher.intercept((plugin) =>
		plugin.onDeleteSelectedBlocks?.({ prevent, selectedBlocks: blocks })
	);
	if (kept) edytor.dispatcher.last = { operation: 'deleteSelectedBlocks', status: 'refused' };
	return kept;
};

/**
 * Delete (or cut) the selected blocks' members (or `blocks`, the block
 * menu's): the
 * keyboard's block delete, cut and the block menu's Delete share it
 * (`keepsSelectedBlocks` first). The command authors its result selection
 * (FP-7, R9) by `caretAfterBlockDelete`, declared before the delete, so the
 * seam never runs for it; with no line left, the virtual paragraph's start
 * or the block beside them. Answers the caret's text.
 */
export const deleteSelectedBlocks = (
	edytor: Edytor,
	blocks: Block[] = selectedMembers(edytor)
): Text | null => {
	if (!blocks[0]?.parent || keepsSelectedBlocks(edytor, blocks)) return null;
	const at = caretAfterBlockDelete(blocks);
	const besides = at
		? []
		: [
				...beside(blocks[0], 'blockBefore', blocks),
				...beside(blocks.at(-1)!, 'blockAfter', blocks)
			];
	const deleted = edytor.dispatcher.caret(at?.text, at?.offset ?? 0, () =>
		edytor.deleteBlocks({ blocks })
	);
	if (!deleted) return null;
	if (at) return at.text;
	// No line is left: the caret rests in an emptied document's virtual
	// paragraph (`doc.empty.virtual`), else the nearest block beside them that
	// survives (a divider) is selected, so the next key never lands on the
	// deleted blocks.
	const virtual = edytor.facade.virtual();
	const text = virtual ? edytor.idToBlock.get(virtual)?.firstText : undefined;
	const survivor = besides.find((block) => block.isInTree);
	if (text) edytor.dispatcher.caret(text, 0);
	else if (survivor) edytor.selection.selectBlocks(survivor);
	return text ?? null;
};

/**
 * The shown blocks beside `blocks` in `step`'s direction, nearest first, up
 * to the first that is no container: a container the delete leaves with no
 * child (a list whose only items go) goes with them
 * (`del.range.empty-container`), so a survivor is looked for past it.
 */
const beside = (from: Block, step: 'blockBefore' | 'blockAfter', blocks: readonly Block[]) => {
	const removed = new Set(blocks);
	const found: Block[] = [];
	for (let next = shown(from, step, { removed }); next; next = shown(next, step, { removed })) {
		found.push(next);
		if (!next.isContainer) break;
	}
	return found;
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
 * Typing or a composition over a block selection (`flow.slot`),
 * unless `keepsSelectedBlocks`: the selected blocks go and one
 * empty block takes the first one's slot, in ONE plan — deleting them first
 * would let the emptied parent normalize in a survivor beside the new block.
 */
const replaceSelectedBlocksWithEmptyBlock = (edytor: Edytor): SelectionInsertionTarget | null => {
	const selected = selectedMembers(edytor);
	const parent = selected[0]?.parent;
	if (!parent || keepsSelectedBlocks(edytor, selected)) return null;
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
