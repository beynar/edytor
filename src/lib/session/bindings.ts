/**
 * The built-in key bindings, as rows of the
 * keymap: history, the select-all ladder, block-selection keys, Tab and
 * Shift+Tab, selection deletes, and the macOS Emacs table. They come last in
 * the keymap's precedence: the consumer's and every extension's bindings of
 * a chord run first.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import { blockSelection } from './selection.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import {
	extendVertically,
	navigationBindings,
	stayWithoutTarget,
	vertical,
	type Dir
} from './navigation.js';
import { caretAt, intentSnapshot } from './attempt.js';
import {
	flipToggles,
	getSelectionBlocks,
	deleteSelectedBlocks,
	outermost,
	selectedBlocksExit,
	shownSelectionBlocks
} from '$lib/selection/replaceSelection.js';
import { shown } from '$lib/selection/visibility.js';
import type { HotKey } from './keymap.js';

/**
 * Remove the selected inline atom as one command: the caret lands where
 * the atom was; a printable key types `value` there. Answers whether an atom
 * was selected.
 */
export const replaceSelectedAtom = (edytor: Edytor, value = '') => {
	const selected = edytor.selection.inlineBlockDeletionTarget;
	if (!selected) return false;
	edytor.selection.clearInlineBlockSelection();
	const { parent } = selected;
	const index = parent.content.indexOf(selected);
	if (index === -1) return true;
	// The text before the atom (a block's content starts with a text): the
	// removal joins the text after the atom to it.
	const text = parent.content[index - 1] as Text;
	const offset = text.length;
	edytor.removeInline(parent.id, selected.id);
	if (value) edytor.insertText(parent.id, text.segStart + offset, value);
	edytor.dispatcher.caret(text, offset + value.length);
	return true;
};

/** The selection is the editor's own: an inline atom or blocks (no DOM range shows it). */
const owned = ({ selection }: Edytor) =>
	selection.selectedBlocks.size > 0 || selection.inlineBlockDeletionTarget !== null;

const history =
	(direction: 'undo' | 'redo'): HotKey =>
	({ edytor, prevent }) =>
		prevent(() => (direction === 'undo' ? edytor.historyUndo() : edytor.historyRedo()));

/**
 * Block-selection keys walk the document order with the island seal,
 * past a collapsed toggle's hidden body.
 */
const SEALED = { sealed: true } as const;

/**
 * The next block a block-selection key steps onto: the next shown block in
 * document order (`shown`, sealed), past a layout and its columns, which show
 * no line and no highlight of their own (Notion): a selection holding every
 * block of a layout stands for it (`liftLayouts`).
 */
const stepOnto = (block: Block, dir: Dir) => {
	const { facade } = block.edytor;
	const step = dir > 0 ? 'blockAfter' : 'blockBefore';
	let next = shown(block, step, SEALED);
	while (next && (facade.isLayout(next.id) || facade.isLayoutItem(next.id)))
		next = shown(next, step, SEALED);
	return next;
};

/** Move a single block selection to its sealed neighbour in document order. */
const moveBlockSelection =
	(dir: Dir): HotKey =>
	({ edytor, prevent }) => {
		const [block, ...rest] = edytor.selection.selectedBlocks;
		if (!block || rest.length) return;
		prevent(() => {
			const target = stepOnto(block, dir);
			if (target) edytor.selection.select(blockSelection([target.id]));
		});
	};
const arrowUp = vertical(-1, moveBlockSelection(-1));
const arrowDown = vertical(1, moveBlockSelection(1));

/**
 * Shift+ArrowUp/Down over a block selection. Its first member is the
 * anchor and its last the focus (insertion order): a key moving the focus
 * back toward the anchor shrinks the selection, otherwise it extends past
 * the selection's edge in document order, one block at a time — a
 * parent and its children are separate members (`sel.blocks.exact`).
 * Without a block selection the editor owns vertical extension (Shift+ArrowDown
 * at the end of a text right before a void selects the void).
 */
const extend =
	(dir: Dir): HotKey =>
	({ edytor, prevent }) => {
		const { selection } = edytor;
		const members = [...selection.selectedBlocks];
		if (!members.length) {
			stayWithoutTarget(edytor, prevent);
			if ((dir > 0 && voidAfter(edytor)) || extendVertically(edytor, dir)) prevent();
			return;
		}
		prevent(() => {
			const { value } = selection;
			const ids = value.kind === 'blocks' ? value.ids : [];
			const focus = members.at(-1)!;
			if (Math.sign(edytor.compareBlocks(focus, members[0]!)) === -dir)
				return selection.select(blockSelection(ids.filter((id) => id !== focus.id)));
			const sorted = members.toSorted(edytor.compareBlocks);
			const next = stepOnto((dir > 0 ? sorted.at(-1) : sorted[0])!, dir);
			if (next && !ids.includes(next.id)) selection.select(blockSelection([...ids, next.id]));
		});
	};

/** A caret at the end of a text whose block a void follows selects that void. */
const voidAfter = (edytor: Edytor) => {
	const { start, isCollapsed, isAtEndOfText } = edytor.selection.projection;
	const block = isCollapsed && isAtEndOfText && start && edytor.idToBlock.get(start.block);
	const next = block ? shown(block, 'blockAfter') : null;
	if (!next?.definition.void) return false;
	edytor.selection.select(blockSelection([next.id]));
	return true;
};

/**
 * Move `blocks` one level, one group of siblings at a time (Notion: over
 * several nesting levels, each group that can move does, a vetoed one too:
 * `dispatcher.each`), as one undo step. A block inside another of them
 * moves with it; `edytor.move` moves siblings with an unselected block
 * between them apart, so no key reorders the text. Answers
 * the moved blocks.
 */
const moveRoots = (edytor: Edytor, blocks: Block[], direction: 'in' | 'out') => {
	const groups = new Map<Block | undefined, Block[]>();
	for (const block of outermost(blocks).toSorted(edytor.compareBlocks))
		groups.set(block.parent, [...(groups.get(block.parent) ?? []), block]);
	return edytor.dispatcher
		.each('moveBlocks', [...groups.values()], (group) => edytor.move({ blocks: group, direction }))
		.flatMap((moved) => moved ?? []);
};

/**
 * Tab / Shift+Tab: nest or unnest the selected block, or the caret's block.
 * Selected blocks, or the blocks a text range spans, move one level per
 * group of siblings, a selected block's selected descendants with it, as
 * one command; the selection stays (its anchors moved with the blocks).
 */
const nest =
	(operation: 'nestBlock' | 'unNestBlock'): HotKey =>
	({ edytor, prevent }) =>
		prevent(() => {
			const { selection } = edytor;
			const { value } = selection;
			const direction = operation === 'nestBlock' ? 'in' : 'out';
			const blocks = getSelectionBlocks(edytor);
			if (blocks.length > 1) {
				if (moveRoots(edytor, blocks, direction).length) selection.select(value);
				return;
			}
			const [selected] = selection.selectedBlocks;
			const at = selection.textAt(selection.projection.start);
			const block = selected ?? at?.text.parent;
			if (!block) return;
			// Into the block before it; the view's move reveals a closed toggle it lands in or that adopts.
			const into = block.previousBlock;
			if (operation === 'nestBlock' && !into)
				return edytor.dispatcher.record({ operation, status: 'refused' });
			const result =
				operation === 'unNestBlock'
					? edytor.unNestBlock(block.id)
					: edytor.nestBlock(block.id, into!.id);
			if (result.status !== 'applied') return;
			edytor.announcer.moved({ blocks: [block], direction }, [block]);
			if (selected) selection.select(blockSelection([block.id]));
			else if (at) caretAt(edytor, block.content[at.text.index] as Text, at.offset);
		});

/**
 * Backspace/Delete over an editor-owned selection: the selected atom, or
 * the selected blocks (the caret lands at the end of the block before them).
 * The command runs the hooks and authors its caret; the projector displays it.
 */
const deleteSelection: HotKey = ({ edytor, prevent }) => {
	if (edytor.selection.inlineBlockDeletionTarget) prevent(() => replaceSelectedAtom(edytor));
	else if (edytor.selection.selectedBlocks.size) prevent(() => deleteSelectedBlocks(edytor));
};

/** An Emacs kill (ctrl+h/d/k): a delete intent, or the owned selection's delete. */
const kill =
	(inputType: (projection: Edytor['selection']['projection']) => string): HotKey =>
	(payload) => {
		const { edytor, prevent } = payload;
		if (owned(edytor)) return deleteSelection(payload);
		const { projection } = edytor.selection;
		if (edytor.selection.textAt(projection.start))
			prevent(() => edytor.ports.input.runIntent(inputType(projection)));
	};

/**
 * A word or line delete chord (Alt, Mod or Ctrl with Backspace/Delete) over an
 * editor-owned selection deletes it as Backspace does; over text it stays the
 * browser's word or line delete. Firefox and WebKit announce no `beforeinput`
 * without a DOM range, so the chord is claimed at its keydown. Shift+Delete
 * is not one (the Windows cut).
 */
const wordAndLineDeletes: Record<string, HotKey> = Object.fromEntries(
	['alt', 'mod', 'ctrl'].flatMap((modifier) =>
		['backspace', 'delete'].map((key) => [`${modifier}+${key}`, deleteSelection])
	)
);

/**
 * macOS Emacs/Cocoa text bindings. Bare `ctrl+` chords only resolve on
 * Apple platforms (the keymap folds Ctrl into `mod` elsewhere), so the table
 * is platform-gated by the chord encoding; its motions (ctrl+a/e/b/f) are
 * navigation rows. Not bound: `ctrl+t` (no transpose operation) and `ctrl+y`
 * (no kill ring).
 */
const emacs: Record<string, HotKey> = {
	'ctrl+h': kill(() => 'deleteContentBackward'),
	'ctrl+d': kill(() => 'deleteContentForward'),
	// Kill-line deletes to the paragraph end; at the end it joins the next block.
	'ctrl+k': kill((at) =>
		at.isCollapsed && at.isAtEndOfBlock ? 'deleteContentForward' : 'deleteHardLineForward'
	),
	// Open-line: a soft break with the caret kept before it.
	'ctrl+o': ({ edytor, prevent }) => {
		if (owned(edytor) || !edytor.selection.textAt(edytor.selection.projection.start)) return;
		prevent(() =>
			edytor.dispatcher.run('insertBlock', () =>
				edytor.ports.input.insertLineBreak(intentSnapshot(edytor, 'insertLineBreak'), 'before')
			)
		);
	},
	'ctrl+p': arrowUp,
	'ctrl+n': arrowDown
};

export const builtInBindings: Record<string, HotKey> = {
	'mod+z': history('undo'),
	'mod+shift+z': history('redo'),
	// Ctrl+Y redo is the Windows/Linux convention; on Apple Cmd+Y is not redo.
	'mod+y': (payload) => (payload.edytor.keymap.isMac ? undefined : history('redo')(payload)),
	// Mod+Enter modifies each shown block it is in (Notion): a toggle opens or
	// closes, a to-do checks (the rich-text plugin's binding, which flips the
	// toggles among them too). It never edits text or structure, and it claims
	// the key everywhere: a browser's own Ctrl+Enter is a paragraph break.
	'mod+enter': ({ edytor, prevent }) => prevent(() => flipToggles(shownSelectionBlocks(edytor))),
	// The select-all ladder: the block's text, then the block, then every block
	// (at once with no selection at all, as Notion).
	'mod+a': ({ edytor, prevent }) =>
		prevent(() => {
			const { selection, idToBlock } = edytor;
			const { start, islandRoot, isAtStartOfBlock, isAtEndOfBlock } = selection.projection;
			const block = selection.textAt(start)?.text.parent;
			// Every block, nested ones included: a block selection is exactly its members.
			if (block ? selection.selectedBlocks.size : selection.value.kind === 'none')
				selection.select(blockSelection(edytor.facade.order().filter((id) => idToBlock.has(id))));
			else if (block && isAtStartOfBlock && isAtEndOfBlock)
				selection.select(blockSelection([(idToBlock.get(islandRoot ?? '') ?? block).id]));
			else selection.selectLines(block);
		}),
	...navigationBindings,
	'shift+arrowup': extend(-1),
	'shift+arrowdown': extend(1),
	arrowup: arrowUp,
	arrowdown: arrowDown,
	tab: nest('nestBlock'),
	'shift+tab': nest('unNestBlock'),
	// Escape leaves a block selection for a shown line (`selectedBlocksExit`);
	// voids with no line beside them stay selected.
	escape: ({ edytor, prevent }) => {
		if (!edytor.selection.selectedBlocks.size) return;
		prevent(() => {
			const at = selectedBlocksExit(edytor);
			if (at) edytor.selection.selectText(at.text, at.offset);
		});
	},
	backspace: deleteSelection,
	delete: deleteSelection,
	...wordAndLineDeletes,
	...emacs
};
