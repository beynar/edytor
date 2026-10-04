/**
 * The built-in key bindings (R7, §4.3 `session/bindings`), as rows of the
 * keymap: history, the select-all ladder, block-selection keys, Tab and
 * Shift+Tab, selection deletes, and the macOS Emacs table. They come last in
 * the keymap's precedence: the consumer's and every extension's bindings of
 * a chord run first.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { extendVertically, navigationBindings, stayWithoutTarget, vertical } from './navigation.js';
import { insertLineBreak, runIntent } from '$lib/events/beforeInputCommands.js';
import { attemptOf, caretAt, intentSnapshot } from './attempt.js';
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

const STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS = 500;
const HISTORY_HOTKEY_DOM_REPAIR_WINDOW_MS = 150;

/**
 * Remove the selected inline atom as one command (O40): the caret lands where
 * the atom was; a printable key types `value` there. Answers whether an atom
 * was selected.
 */
export const replaceSelectedAtom = (edytor: Edytor, value = '') => {
	const selected =
		edytor.selection.selectedInlineBlock.values().next().value ??
		edytor.selection.inlineBlockDeletionTarget;
	if (!selected) return false;
	edytor.selection.clearInlineBlockSelection();
	const { parent } = selected;
	const index = parent.content.indexOf(selected);
	if (index === -1) return true;
	const [before, after] = [parent.content[index - 1], parent.content[index + 1]];
	const caret = before instanceof Text ? before : after instanceof Text ? after : parent.firstText;
	const offset = before instanceof Text ? before.length : 0;
	parent.removeInlineBlock({ index });
	if (value) caret?.insertText({ value, start: offset, end: offset });
	edytor.dispatcher.caret(caret, offset + value.length);
	return true;
};

const selectNextVoidBlockFromCaret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	if (!startText || !isCollapsed || yStart !== startText.length) {
		return false;
	}

	const nextBlock = shown(startText.parent, 'blockAfter');
	if (!nextBlock?.definition.void) {
		return false;
	}

	edytor.selection.selectBlocks(nextBlock);
	return true;
};

/** The key's attempt: the model owns the DOM drift around its command for `window` ms. */
const suppressHotkeyDomDrift = (edytor: Edytor, window: number) => {
	const attempt = attemptOf(edytor, { inputType: 'hotkey', cancelable: true });
	edytor.attempts.drift(edytor.attempts.admit(attempt, 'model'), 'discard', window);
};

const ownsDeleteSelection = (edytor: Edytor) =>
	edytor.selection.selectedBlocks.size > 0 || edytor.selection.selectedInlineBlock.size > 0;

const history =
	(direction: 'undo' | 'redo'): HotKey =>
	({ edytor, prevent }) =>
		prevent(() => {
			suppressHotkeyDomDrift(edytor, HISTORY_HOTKEY_DOM_REPAIR_WINDOW_MS);
			if (direction === 'undo') edytor.historyUndo();
			else edytor.historyRedo();
		});

/**
 * Block-selection keys walk the document order with the island seal (R5),
 * past a collapsed toggle's hidden body.
 */
const SEALED = { sealed: true } as const;

/**
 * The next block a block-selection key steps onto: the next shown block in
 * document order (`shown`, sealed), past a layout and its columns, which show
 * no line and no highlight of their own (Notion): a selection holding every
 * block of a layout stands for it (`liftLayouts`).
 */
const stepOnto = (block: Block, step: 'blockBefore' | 'blockAfter') => {
	const { facade } = block.edytor;
	let next = shown(block, step, SEALED);
	while (next && (facade.isLayout(next.id) || facade.isLayoutItem(next.id)))
		next = shown(next, step, SEALED);
	return next;
};

/** Move a single block selection to its sealed neighbour in document order. */
const moveBlockSelection =
	(step: 'blockBefore' | 'blockAfter'): HotKey =>
	({ edytor, prevent }) => {
		const selectedBlocks = edytor.selection.selectedBlocks;
		if (selectedBlocks.size === 1) {
			prevent(() => {
				const target = stepOnto(selectedBlocks.values().next().value as Block, step);
				if (target) {
					edytor.selection.selectBlocks(target);
				}
			});
		}
	};
const arrowUp = vertical(-1, moveBlockSelection('blockBefore'));
const arrowDown = vertical(1, moveBlockSelection('blockAfter'));

/**
 * Shift+ArrowUp/Down over a block selection. Its first member is the
 * anchor and its last the focus (insertion order): a key moving the focus
 * back toward the anchor shrinks the selection, otherwise it extends past
 * the selection's edge in document order (K7), one block at a time — a
 * parent and its children are separate members (`sel.blocks.exact`).
 */
const extendBlockSelection = (edytor: Edytor, direction: 'up' | 'down'): void => {
	const members = Array.from(edytor.selection.selectedBlocks);
	const focus = members.at(-1)!;
	const sign = Math.sign(edytor.compareBlocks(focus, members[0]!));
	if (sign === (direction === 'up' ? 1 : -1)) {
		edytor.selection.removeBlockFromSelection(focus);
		return;
	}
	const sorted = members.toSorted(edytor.compareBlocks);
	const next =
		direction === 'up'
			? stepOnto(sorted[0]!, 'blockBefore')
			: stepOnto(sorted.at(-1)!, 'blockAfter');
	if (next) edytor.selection.addBlockToSelection(next);
};

/**
 * Move `blocks` one level, one group of siblings at a time (Notion: over
 * several nesting levels, each group that can move does, a vetoed one too:
 * `dispatcher.each`), as one undo step. A block inside another of them
 * moves with it; `edytor.moveBlocks` moves siblings with an unselected block
 * between them apart, so no key reorders the text (DR-behavior-1). Answers
 * the moved blocks.
 */
const moveRoots = (edytor: Edytor, blocks: Block[], direction: 'in' | 'out') => {
	const groups = new Map<Block | undefined, Block[]>();
	for (const block of outermost(blocks).toSorted(edytor.compareBlocks))
		groups.set(block.parent, [...(groups.get(block.parent) ?? []), block]);
	return edytor.dispatcher
		.each('moveBlocks', [...groups.values()], (group) =>
			edytor.moveBlocks({ blocks: group, direction })
		)
		.flatMap((moved) => moved ?? []);
};

/**
 * Tab / Shift+Tab: nest or unnest the selected block, or the caret's block.
 * Selected blocks, or the blocks a text range spans, move one level per
 * group of siblings, a selected block's selected descendants with it, as
 * one command; the selection stays.
 */
const nest =
	(operation: 'nestBlock' | 'unNestBlock'): HotKey =>
	({ edytor, prevent }) =>
		prevent(() => {
			suppressHotkeyDomDrift(edytor, STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
			const selectedBlocks = edytor.selection.selectedBlocks;
			const direction = operation === 'nestBlock' ? 'in' : 'out';
			const blocks = getSelectionBlocks(edytor);
			if (blocks.length > 1) {
				const members = [...selectedBlocks];
				const { startText, endText, yStart, yEnd, isReversed } = edytor.selection.state;
				if (!moveRoots(edytor, blocks, direction).length) return;
				if (members.length) edytor.selection.selectBlocks(...members);
				else if (startText && endText)
					edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed });
				return;
			}
			const selectedBlock = selectedBlocks.values().next().value as Block | undefined;
			const { yStart, startText, startBlock } = edytor.selection.state;
			const index = startText?.index;
			// The block's command reveals a closed toggle it lands in or that adopts (ZW-09).
			const block = (selectedBlock || startBlock)?.[operation]();
			if (block && selectedBlock) edytor.selection.selectBlocks(block);
			else if (block && index !== undefined) caretAt(edytor, block.content[index] as Text, yStart);
		});

/**
 * Backspace/Delete over an editor-owned selection: the selected atom (O40), or
 * the selected blocks (the caret lands at the end of the block before them).
 */
const deleteSelection: HotKey = ({ edytor, prevent }) => {
	if (edytor.selection.selectedInlineBlock.size || edytor.selection.inlineBlockDeletionTarget)
		return prevent(() => replaceSelectedAtom(edytor));
	if (!edytor.selection.selectedBlocks.size) return;
	// The command runs the hooks and authors its caret (FP-7); the projector displays it.
	prevent(() => deleteSelectedBlocks(edytor));
};

/** An Emacs kill (ctrl+h/d/k): a delete intent, or the owned selection's delete. */
const kill =
	(inputType: (projection: Edytor['selection']['projection']) => string): HotKey =>
	(payload) => {
		const { edytor, prevent } = payload;
		if (ownsDeleteSelection(edytor)) return deleteSelection(payload);
		const { state, projection } = edytor.selection;
		if (state.startText) prevent(() => runIntent(edytor, inputType(projection)));
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
		['backspace', 'delete'].map((key): [string, HotKey] => [
			`${modifier}+${key}`,
			(payload) => (ownsDeleteSelection(payload.edytor) ? deleteSelection(payload) : undefined)
		])
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
		if (ownsDeleteSelection(edytor) || !edytor.selection.state.startText) return;
		prevent(() =>
			edytor.dispatcher.run('insertBlock', () =>
				insertLineBreak(edytor, intentSnapshot(edytor, 'insertLineBreak'), 'before')
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
	'mod+y': (payload) => (payload.edytor.hotKeys.isMac ? undefined : history('redo')(payload)),
	// Mod+Enter modifies each shown block it is in (Notion): a toggle opens or
	// closes, a to-do checks (the rich-text plugin's binding, which flips the
	// toggles among them too). It never edits text or structure, and it claims
	// the key everywhere: a browser's own Ctrl+Enter is a paragraph break.
	'mod+enter': ({ edytor, prevent }) => prevent(() => flipToggles(shownSelectionBlocks(edytor))),
	// The select-all ladder: the block's text, then the block, then every block
	// (at once with no selection at all, as Notion).
	'mod+a': ({ edytor, prevent }) => {
		prevent(() => {
			const { startText, startBlock } = edytor.selection.state;
			const { islandRoot, isAtStartOfBlock, isAtEndOfBlock } = edytor.selection.projection;
			// Every block, nested ones included: a block selection is exactly its members.
			const every = () =>
				edytor.selection.selectBlocks(
					...edytor.facade.order().flatMap((id) => edytor.idToBlock.get(id) ?? [])
				);
			if (!startText) {
				if (edytor.selection.value.kind === 'none') every();
				return;
			}
			if (edytor.selection.selectedBlocks.size) {
				every();
			} else if (isAtStartOfBlock && isAtEndOfBlock) {
				edytor.selection.selectBlocks(edytor.idToBlock.get(islandRoot ?? '') ?? startText.parent);
			} else {
				edytor.selection.setAtBlockRange(startBlock);
			}
		});
	},
	...navigationBindings,
	// Without a block selection the editor owns vertical extension (K1).
	'shift+arrowup': ({ edytor, prevent }) => {
		if (edytor.selection.selectedBlocks.size)
			return prevent(() => extendBlockSelection(edytor, 'up'));
		stayWithoutTarget(edytor, prevent);
		if (extendVertically(edytor, -1)) prevent();
	},
	'shift+arrowdown': ({ edytor, prevent }) => {
		if (edytor.selection.selectedBlocks.size)
			return prevent(() => extendBlockSelection(edytor, 'down'));
		stayWithoutTarget(edytor, prevent);
		if (selectNextVoidBlockFromCaret(edytor) || extendVertically(edytor, 1)) prevent();
	},
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
			if (at) edytor.selection.setAtTextOffset(at.text, at.offset);
		});
	},
	backspace: deleteSelection,
	delete: deleteSelection,
	...wordAndLineDeletes,
	...emacs
};
