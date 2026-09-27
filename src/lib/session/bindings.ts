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
import {
	moveCaretAcrossHorizontalBoundary,
	moveToCurrentBlockBoundary,
	navigationHotKeys
} from '$lib/hotkeys/navigation.js';
import { insertLineBreak, runIntent } from '$lib/events/beforeInputCommands.js';
import { attemptOf, intentSnapshot } from './attempt.js';
import {
	getSelectedBlocksInDocumentOrder,
	deleteSelectedBlocks
} from '$lib/selection/replaceSelection.js';
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
	edytor.dispatcher.cut(value ? 'replaceInlineBlock' : 'deleteInlineBlock');
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

	const nextBlock = startText.parent.closestNextBlock;
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

/**
 * After a structural hotkey the cells re-parent only what moved (R2, F-P9);
 * the selection is selected at once and the projector displays it after that
 * flush (R10).
 */
const restoreStructuralHotkeyCaret = (edytor: Edytor, text: Text, offset: number) => {
	edytor.attempts.caret(text, offset);
	void edytor.selection.setAtTextOffset(text, offset);
};

const restoreStructuralHotkeyBlockSelection = (edytor: Edytor, block: Block) => {
	edytor.selection.selectBlocks(block);
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

/** Block-selection keys walk the document order with the island seal (R5). */
const SEALED = { sealed: true } as const;

/** Move a single block selection to its sealed neighbour in document order. */
const moveBlockSelection =
	(step: 'blockBefore' | 'blockAfter'): HotKey =>
	({ edytor, prevent }) => {
		const selectedBlocks = edytor.selection.selectedBlocks;
		if (selectedBlocks.size === 1) {
			prevent(() => {
				const target = edytor[step](selectedBlocks.values().next().value as Block, SEALED);
				if (target) {
					edytor.selection.selectBlocks(target);
				}
			});
		}
	};
const arrowUp = moveBlockSelection('blockBefore');
const arrowDown = moveBlockSelection('blockAfter');

/**
 * Shift+ArrowUp/Down over a block selection. Its first member is the
 * anchor and its last the focus (insertion order): a key moving the focus
 * back toward the anchor shrinks the selection, otherwise it extends past
 * the selection's edge in document order (K7).
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
	if (direction === 'up') {
		const first = sorted[0]!;
		const previous = edytor.blockBefore(first, SEALED);
		if (!previous) return;
		// Reaching the parent selects it instead of its first child.
		if (first.parent === previous) edytor.selection.removeBlockFromSelection(first);
		edytor.selection.addBlockToSelection(previous);
		return;
	}
	const last = sorted.at(-1)!;
	let next = edytor.blockAfter(last, SEALED);
	while (next?.isChildOf(last)) next = edytor.blockAfter(next, SEALED);
	if (next) edytor.selection.addBlockToSelection(next);
};

/** Tab / Shift+Tab: nest or unnest the selected block, or the caret's block. */
const nest =
	(operation: 'nestBlock' | 'unNestBlock'): HotKey =>
	({ edytor, prevent }) =>
		prevent(() => {
			suppressHotkeyDomDrift(edytor, STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
			edytor.dispatcher.cut(operation);
			const selectedBlocks = edytor.selection.selectedBlocks;
			if (selectedBlocks.size > 1) return;
			const selectedBlock = selectedBlocks.values().next().value as Block | undefined;
			const { yStart, startText, startBlock } = edytor.selection.state;
			const index = startText?.index;
			const block = (selectedBlock || startBlock)?.[operation]();
			if (block && selectedBlock) restoreStructuralHotkeyBlockSelection(edytor, block);
			else if (block && index !== undefined)
				restoreStructuralHotkeyCaret(edytor, block.content[index] as Text, yStart);
		});

/**
 * Backspace/Delete over an editor-owned selection: the selected atom (O40), or
 * the selected blocks (the caret lands at the end of the block before them).
 */
const deleteSelection: HotKey = ({ edytor, prevent }) => {
	if (edytor.selection.selectedInlineBlock.size || edytor.selection.inlineBlockDeletionTarget)
		return prevent(() => replaceSelectedAtom(edytor));
	if (!edytor.selection.selectedBlocks.size) return;
	prevent(() => {
		edytor.dispatcher.cut('deleteBlocks');
		const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
		if (!selectedBlocks.length) return;
		edytor.plugins.forEach((plugin) =>
			plugin.onDeleteSelectedBlocks?.({ prevent, selectedBlocks })
		);
		// The command authored its caret (FP-7); the projector displays it.
		deleteSelectedBlocks(edytor);
	});
};

/** An Emacs kill (ctrl+h/d/k): a delete intent, or the owned selection's delete. */
const kill =
	(inputType: (state: Edytor['selection']['state']) => string): HotKey =>
	(payload) => {
		const { edytor, prevent } = payload;
		if (ownsDeleteSelection(edytor)) return deleteSelection(payload);
		const { state } = edytor.selection;
		if (state.startText) prevent(() => runIntent(edytor, inputType(state)));
	};

/** A caret motion that claims the key when there is a text caret. */
const motion =
	(move: (edytor: Edytor) => unknown): HotKey =>
	({ edytor, prevent }) => {
		if (edytor.selection.state.startText) prevent(() => move(edytor));
	};

/** A logical (document-order, never RTL-flipped) one-step move; claims only when it moved. */
const step =
	(direction: 'backward' | 'forward'): HotKey =>
	({ edytor, prevent }) => {
		if (moveCaretAcrossHorizontalBoundary(edytor, direction, false)) prevent();
	};

/**
 * macOS Emacs/Cocoa text bindings. Bare `ctrl+` chords only resolve on
 * Apple platforms (the keymap folds Ctrl into `mod` elsewhere), so the table
 * is platform-gated by the chord encoding. Not bound: `ctrl+t` (no transpose
 * operation) and `ctrl+y` (no kill ring).
 */
const emacs: Record<string, HotKey> = {
	'ctrl+h': kill(() => 'deleteContentBackward'),
	'ctrl+d': kill(() => 'deleteContentForward'),
	// Kill-line deletes to the paragraph end; at the end it joins the next block.
	'ctrl+k': kill((state) =>
		state.isCollapsed && state.isAtEndOfBlock ? 'deleteContentForward' : 'deleteHardLineForward'
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
	'ctrl+a': motion((edytor) => moveToCurrentBlockBoundary(edytor, 'start', false)),
	'ctrl+e': motion((edytor) => moveToCurrentBlockBoundary(edytor, 'end', false)),
	'ctrl+b': step('backward'),
	'ctrl+f': step('forward'),
	'ctrl+p': arrowUp,
	'ctrl+n': arrowDown
};

export const builtInBindings: Record<string, HotKey> = {
	'mod+z': history('undo'),
	'mod+shift+z': history('redo'),
	// Ctrl+Y redo is the Windows/Linux convention; on Apple Cmd+Y is not redo.
	'mod+y': (payload) => (payload.edytor.hotKeys.isMac ? undefined : history('redo')(payload)),
	'mod+enter': ({ edytor, prevent }) => {
		prevent(() => {
			edytor.dispatcher.cut('insertBlock');
			const { startText } = edytor.selection.state;
			const newBlock = startText?.parent.splitBlock({ index: startText.length, text: startText });
			if (newBlock && newBlock.content[0] instanceof Text) {
				edytor.selection.setAtTextOffset(newBlock.content[0], 0);
			}
		});
	},
	// The select-all ladder: the block's text, then the block, then every block.
	'mod+a': ({ edytor, prevent }) => {
		prevent(() => {
			const { startText, startBlock, islandRoot, isIsland, isAtStartOfBlock, isAtEndOfBlock } =
				edytor.selection.state;
			if (!startText) return;
			if (edytor.selection.selectedBlocks.size) {
				edytor.selection.selectBlocks(...edytor.root!.children);
			} else if (isAtStartOfBlock && isAtEndOfBlock) {
				edytor.selection.selectBlocks(isIsland ? islandRoot! : startText.parent);
			} else {
				edytor.selection.setAtBlockRange(startBlock);
			}
		});
	},
	...navigationHotKeys,
	'shift+arrowup': ({ edytor, prevent }) => {
		if (edytor.selection.selectedBlocks.size >= 1) {
			prevent(() => extendBlockSelection(edytor, 'up'));
			return;
		}
		// No block selection: native vertical extension is engine-defined
		// (Firefox can collapse at the anchor or drop the focus on stray
		// boundary text nodes) — own the semantic deterministically.
		if (edytor.selection.extendSelectionVertically('up')) {
			prevent();
		}
	},
	'shift+arrowdown': ({ edytor, prevent }) => {
		const selectedBlocks = edytor.selection.selectedBlocks;
		if (selectedBlocks.size === 0 && selectNextVoidBlockFromCaret(edytor)) {
			prevent();
			return;
		}

		if (selectedBlocks.size >= 1) {
			prevent(() => extendBlockSelection(edytor, 'down'));
			return;
		}
		// See shift+arrowup — deterministic cross-engine extension.
		if (edytor.selection.extendSelectionVertically('down')) {
			prevent();
		}
	},
	arrowup: arrowUp,
	arrowdown: arrowDown,
	tab: nest('nestBlock'),
	'shift+tab': nest('unNestBlock'),
	escape: ({ edytor, prevent }) => {
		const first = edytor.selection.selectedBlocks.values().next().value as Block | undefined;
		if (!first) return;
		prevent(() => {
			edytor.selection.selectBlocks();
			const text = first.firstEditableText;
			if (text) edytor.selection.setAtTextOffset(text, text.length);
		});
	},
	backspace: deleteSelection,
	delete: deleteSelection,
	...emacs
};
