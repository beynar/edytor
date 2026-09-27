import type { Edytor, EdytorOptions } from './edytor.svelte.js';
import { Text } from './text/text.svelte.js';
import type { InitializedPlugin } from './plugins.js';
import { prevent } from './utils.js';
import { Block } from './block/block.svelte.js';
import { tick } from 'svelte';
import { clearDomSelection } from './selection/domSelection.js';
import {
	moveCaretAcrossHorizontalBoundary,
	moveToCurrentBlockBoundary,
	navigationHotKeys
} from './hotkeys/navigation.js';
import { createBeforeInputSnapshot } from './events/beforeInputSnapshot.js';
import { runBeforeInputDeleteCommand } from './events/beforeInputDeleteCommands.js';
import { runHistoryCommand } from './events/undoRestore.js';
import {
	getSelectedBlocksInDocumentOrder,
	removeSelectedBlocksForReplacement,
	replaceSelectionWithCollapsedTargetSync
} from './selection/replaceSelection.js';

export type HotKey = (payload: {
	event: KeyboardEvent;
	edytor: Edytor;
	prevent: (cb?: () => void) => void;
}) => void;
export type HotKeyModifier = 'mod' | 'alt' | 'ctrl' | 'shift';

const letter = new Set([
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z'
] as const);
type Letter = typeof letter extends Set<infer T> ? T : never;
type Key =
	| Letter
	| 'tab'
	| 'enter'
	| 'backspace'
	| 'delete'
	| 'space'
	| 'escape'
	| 'home'
	| 'end'
	| 'pageup'
	| 'pagedown'
	| 'arrowup'
	| 'arrowdown'
	| 'arrowleft'
	| 'arrowright';

export type SingleModifierCombination = `${HotKeyModifier}+${Key}`;
export type DoubleModifierCombination =
	| `mod+alt+${Key}`
	| `mod+ctrl+${Key}`
	| `mod+shift+${Key}`
	| `alt+ctrl+${Key}`
	| `alt+shift+${Key}`
	| `ctrl+shift+${Key}`;

export type HotKeyCombination = Key | SingleModifierCombination | DoubleModifierCombination;

const escapedKeys = new Set(['shift']);
const reverseTabKeys = new Set(['iso_left_tab', 'backtab']);
const STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS = 500;
const HISTORY_HOTKEY_DOM_REPAIR_WINDOW_MS = 150;

const isAltGraphInput = (event: KeyboardEvent) => {
	if (event.key === 'AltGraph' || event.key === 'Dead') {
		return true;
	}

	return event.getModifierState?.('AltGraph') === true;
};

const findInlineBlockLocation = (
	block: Block,
	id: string
): { parent: Block; index: number } | null => {
	const index = block.content.findIndex((part) => part.id === id);
	if (index !== -1) {
		return { parent: block, index };
	}

	for (const child of block.children) {
		const location = findInlineBlockLocation(child, id);
		if (location) {
			return location;
		}
	}

	return null;
};

const deleteSelectedInlineBlock = (event: KeyboardEvent, edytor: Edytor) => {
	const inlineBlock =
		edytor.selection.selectedInlineBlock.values().next().value ??
		edytor.selection.inlineBlockDeletionTarget;
	if (!inlineBlock) {
		return false;
	}

	event.preventDefault();
	event.stopPropagation();
	edytor.dispatcher.cut('deleteInlineBlock');

	const location = edytor.root ? findInlineBlockLocation(edytor.root, inlineBlock.id) : null;
	if (!location) {
		edytor.selection.clearInlineBlockSelection();
		return true;
	}

	const { parent, index } = location;
	const previousPart = parent.content[index - 1];
	const nextPart = parent.content[index + 1];
	const fallbackText =
		previousPart instanceof Text
			? previousPart
			: nextPart instanceof Text
				? nextPart
				: parent.firstText;
	const fallbackOffset = previousPart instanceof Text ? previousPart.length : 0;

	edytor.selection.clearInlineBlockSelection();
	parent.removeInlineBlock({ index });
	void tick().then(() => edytor.selection.setAtTextOffset(fallbackText, fallbackOffset));

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

const suppressStructuralHotkeyDomDrift = (edytor: Edytor) => {
	edytor.suppressNextInputFallback(STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
	edytor.repairSuppressedInputFallback(STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS, {
		flushObservedMutations: true
	});
};

const suppressHistoryHotkeyDomDrift = (edytor: Edytor) => {
	edytor.suppressNextInputFallback(HISTORY_HOTKEY_DOM_REPAIR_WINDOW_MS);
	edytor.repairSuppressedInputFallback(HISTORY_HOTKEY_DOM_REPAIR_WINDOW_MS, {
		flushObservedMutations: true
	});
};

const refreshStructuralChildren = (block: Block) => {
	block.children = [...block.children];
	for (const child of block.children) {
		refreshStructuralChildren(child);
	}
};

const restoreStructuralHotkeyCaret = (edytor: Edytor, text: Text, offset: number) => {
	edytor.selection.setCollapsedStateAtTextOffset(text, offset);
	edytor.suppressedInputRepairSelectionTarget = { text, offset };
	const restore = () => {
		// Deferred re-runs must not clobber a selection the user made
		// after the hotkey — DOM drift this repairs leaves MODEL state
		// untouched, so a real caret move / block / inline-atom selection
		// shows up here and aborts the restore.
		const state = edytor.selection.state;
		if (
			state.startText !== text ||
			state.yStart !== offset ||
			!state.isCollapsed ||
			edytor.selection.selectedBlocks.size > 0 ||
			edytor.selection.selectedInlineBlock.size > 0 ||
			edytor.selection.inlineBlockDeletionTarget
		) {
			return;
		}
		if (edytor.root) {
			refreshStructuralChildren(edytor.root);
			edytor.refreshEditorDom();
		}
		edytor.selection.ignoreNextSelectionChange = true;
		void edytor.selection.setAtTextOffset(text, offset);
	};

	void tick().then(restore);
	setTimeout(restore, 30);
	setTimeout(restore, STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
};

const restoreStructuralHotkeyBlockSelection = (edytor: Edytor, block: Block) => {
	const restore = (deferred: boolean) => {
		// Deferred re-runs only re-apply while the block selection is
		// still the live one — a text/inline selection made inside the
		// window wins over this stale repair. The FIRST run installs the
		// selection, so it is never gated.
		if (
			deferred &&
			(edytor.selection.selectedBlocks.size !== 1 || !edytor.selection.selectedBlocks.has(block))
		) {
			return;
		}
		if (edytor.root) {
			refreshStructuralChildren(edytor.root);
			edytor.refreshEditorDom();
		}
		clearDomSelection(edytor.node);
		edytor.selection.selectBlocks(block);
		edytor.selection.ignoreNextSelectedBlockSelectionChange = true;
		edytor.selection.ignoreNextSelectionChange = true;
	};

	restore(false);
	void tick().then(() => restore(true));
	setTimeout(() => restore(true), 30);
	setTimeout(() => restore(true), STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
};

/**
 * Non-Latin keyboard-layout fallback: when `event.key` reports a
 * non-ASCII character (Cyrillic, Greek, Arabic, …) the produced string
 * can never match a registered combination, so we retry with the key
 * the physical `event.code` position would produce on a US layout —
 * the ProseMirror/Lexical convention (Mod+Б on a Russian layout is
 * expected to be Mod+B). Only `Key*`/`Digit*` codes map onto bindable
 * keys.
 */
const layoutFallbackKeys = new Map<string, string>();
for (let index = 0; index < 26; index++) {
	layoutFallbackKeys.set(`Key${String.fromCharCode(65 + index)}`, String.fromCharCode(97 + index));
}
for (let index = 0; index < 10; index++) {
	layoutFallbackKeys.set(`Digit${index}`, `${index}`);
}

/**
 * Returns the US-layout key for `event.code` when the event is a
 * command chord whose produced `event.key` is non-ASCII — or null when
 * the fallback must not apply:
 *
 * - ASCII `event.key` already carries the user's intent (Dvorak users
 *   expect the produced letter, not the physical position).
 * - Modifier-less keypresses are text input, not commands.
 * - Ctrl+Alt is AltGr on Windows (and bare Option remaps characters on
 *   macOS) — both legitimately produce non-ASCII text and must never
 *   resolve to a command binding.
 */
const getLayoutFallbackKey = (event: KeyboardEvent) => {
	if (event.key.length !== 1 || event.key.charCodeAt(0) < 128) {
		return null;
	}

	if (!(event.ctrlKey || event.metaKey) || (event.ctrlKey && event.altKey)) {
		return null;
	}

	return layoutFallbackKeys.get(event.code) ?? null;
};

const hasEditorOwnedDeleteSelection = (edytor: Edytor) =>
	edytor.selection.selectedBlocks.size > 0 || edytor.selection.selectedInlineBlock.size > 0;

type EmacsDeleteInputType =
	| 'deleteContentBackward'
	| 'deleteContentForward'
	| 'deleteHardLineForward';

/**
 * Reuses the exact `beforeinput` delete-command semantics for
 * keydown-level bindings: the command router only reads the snapshot,
 * so a minimal InputEvent-shaped stub is sufficient.
 */
const runDeleteCommandByInputType = (edytor: Edytor, inputType: EmacsDeleteInputType) => {
	const snapshot = createBeforeInputSnapshot(
		edytor,
		{ inputType, data: null, dataTransfer: null } as InputEvent,
		null
	);
	void runBeforeInputDeleteCommand(edytor, snapshot);
};

const handleUndoHotkey: HotKey = ({ edytor }) => {
	prevent(() => {
		suppressHistoryHotkeyDomDrift(edytor);
		void runHistoryCommand(edytor, 'undo', { queueSelectionSnapshot: true });
	});
};

const handleRedoHotkey: HotKey = ({ edytor, prevent }) => {
	prevent(() => {
		suppressHistoryHotkeyDomDrift(edytor);
		void runHistoryCommand(edytor, 'redo', { queueSelectionSnapshot: true });
	});
};

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
					edytor.selection.focusBlocks();
				}
			});
		}
	};
const handleArrowUpHotkey = moveBlockSelection('blockBefore');
const handleArrowDownHotkey = moveBlockSelection('blockAfter');

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

/**
 * macOS Emacs/Cocoa text bindings. Bare `ctrl+` combinations only ever
 * resolve on Apple platforms (see `HotKeys.combination`), so this table
 * is intrinsically platform-gated — on Windows/Linux these physical
 * chords resolve to `mod+` bindings instead.
 *
 * Skipped on purpose:
 * - `ctrl+t` (transpose-chars): the editor has no transpose operation
 *   and no browser fires `insertTranspose` reliably enough to mirror.
 * - `ctrl+y` (yank): requires a kill ring the editor does not maintain.
 */
const macEmacsHotKeys = {
	'ctrl+h': ({ event, edytor, prevent }) => {
		if (hasEditorOwnedDeleteSelection(edytor)) {
			defaultHotKeys.backspace({ event, edytor, prevent });
			return;
		}
		if (!edytor.selection.state.startText) {
			return;
		}
		prevent(() => {
			edytor.dispatcher.cut('deleteContentBackward');
			runDeleteCommandByInputType(edytor, 'deleteContentBackward');
		});
	},
	'ctrl+d': ({ event, edytor, prevent }) => {
		if (hasEditorOwnedDeleteSelection(edytor)) {
			defaultHotKeys.backspace({ event, edytor, prevent });
			return;
		}
		if (!edytor.selection.state.startText) {
			return;
		}
		prevent(() => {
			edytor.dispatcher.cut('deleteContentForward');
			runDeleteCommandByInputType(edytor, 'deleteContentForward');
		});
	},
	'ctrl+k': ({ event, edytor, prevent }) => {
		if (hasEditorOwnedDeleteSelection(edytor)) {
			defaultHotKeys.backspace({ event, edytor, prevent });
			return;
		}
		const { startText, isCollapsed, isAtEndOfBlock } = edytor.selection.state;
		if (!startText) {
			return;
		}
		prevent(() => {
			edytor.dispatcher.cut('deleteHardLineForward');
			// Cocoa kill-line deletes to the paragraph end — and at the end
			// kills the paragraph break itself, joining the next block.
			runDeleteCommandByInputType(
				edytor,
				isCollapsed && isAtEndOfBlock ? 'deleteContentForward' : 'deleteHardLineForward'
			);
		});
	},
	'ctrl+o': ({ edytor, prevent }) => {
		if (hasEditorOwnedDeleteSelection(edytor)) {
			return;
		}
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		if (!startText) {
			return;
		}
		prevent(() => {
			edytor.dispatcher.cut('insertBlock');
			const target = isCollapsed
				? { text: startText, offset: yStart }
				: replaceSelectionWithCollapsedTargetSync(edytor);
			if (!target) {
				return;
			}
			// Emacs open-line: insert a line break at the caret but keep the
			// caret *before* it. When block normalization splits the block on
			// the break (code lines), "before the break" is the source block's
			// trailing edge — the same shape `insertLineBreak` computes.
			const sourceBlock = target.text.parent;
			const sourceParent = sourceBlock.parent;
			const sourceIndex = sourceBlock.index;
			const sourceSiblingCount = sourceParent?.children.length ?? 0;
			target.text.insertText({ value: '\n', start: target.offset, end: target.offset });
			sourceBlock.normalizeContent();
			const normalizedNextBlock = sourceParent?.children[sourceIndex + 1];
			const splitOnBreak =
				sourceParent &&
				sourceParent.children.length > sourceSiblingCount &&
				normalizedNextBlock?.type === sourceBlock.type;
			const caretText = splitOnBreak ? (sourceBlock.lastText ?? target.text) : target.text;
			const caretOffset = caretText === target.text ? target.offset : caretText.length;
			void edytor.selection.setAtTextOffset(caretText, caretOffset);
		});
	},
	'ctrl+a': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'start', false));
		}
	},
	'ctrl+e': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'end', false));
		}
	},
	'ctrl+b': ({ edytor, prevent }) => {
		// Logical document-order motion (Emacs), not visual — so no RTL flip.
		if (moveCaretAcrossHorizontalBoundary(edytor, 'backward', false)) {
			prevent();
		}
	},
	'ctrl+f': ({ edytor, prevent }) => {
		if (moveCaretAcrossHorizontalBoundary(edytor, 'forward', false)) {
			prevent();
		}
	},
	'ctrl+p': handleArrowUpHotkey,
	'ctrl+n': handleArrowDownHotkey
} satisfies Partial<Record<HotKeyCombination, HotKey>>;

const defaultHotKeys = {
	'mod+z': handleUndoHotkey,
	'mod+shift+z': handleRedoHotkey,
	'mod+y': (payload) => {
		// Windows/Linux Ctrl+Y redo convention. On Apple platforms Cmd+Y is
		// not the redo convention (and bare Ctrl+Y is Cocoa "yank", which we
		// intentionally leave unbound) — keep both native.
		if (payload.edytor.hotKeys.isMac) {
			return;
		}
		handleRedoHotkey(payload);
	},
	'mod+enter': ({ edytor, prevent }) => {
		prevent(() => {
			edytor.dispatcher.cut('insertBlock');
			const newBlock = edytor.selection.state.startText?.parent.splitBlock({
				index: edytor.selection.state.startText?.length,
				text: edytor.selection.state.startText
			});
			if (newBlock && newBlock.content[0] instanceof Text) {
				edytor.selection.setAtTextOffset(newBlock.content[0], 0);
			}
		});
	},
	'mod+a': ({ edytor, prevent }) => {
		prevent(() => {
			const { startText, startBlock, islandRoot, isVoid, isIsland, voidRoot } =
				edytor.selection.state;
			if (startText) {
				if (edytor.selection.selectedBlocks.size) {
					edytor.selection.selectBlocks(...edytor.root!.children);
				} else if (
					edytor.selection.state.isAtStartOfBlock &&
					edytor.selection.state.isAtEndOfBlock
				) {
					edytor.selection.selectBlocks(
						edytor.selection.state.isIsland ? islandRoot! : startText.parent
					);
					edytor.selection.ignoreNextSelectedBlockSelectionChange = true;
					edytor.selection.ignoreNextSelectionChange = true;
					clearDomSelection(edytor.node);
				} else {
					edytor.selection.setAtBlockRange(startBlock);
				}
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
	arrowup: handleArrowUpHotkey,
	arrowdown: handleArrowDownHotkey,
	tab: ({ edytor, prevent }) => {
		prevent(() => {
			suppressStructuralHotkeyDomDrift(edytor);
			edytor.dispatcher.cut('nestBlock');
			const selectedBlocks = edytor.selection.selectedBlocks;
			if (selectedBlocks.size <= 1) {
				const selectedBlock = selectedBlocks.values().next().value as Block;
				const { yStart, startText, startBlock } = edytor.selection.state;
				const blockToNest = selectedBlock || startBlock;
				const newBlock = blockToNest?.nestBlock();
				const index = startText?.index;
				if (selectedBlock) {
					newBlock && restoreStructuralHotkeyBlockSelection(edytor, newBlock);
				} else {
					if (newBlock && index !== undefined) {
						const textToFocus = newBlock.content[index] as Text;
						restoreStructuralHotkeyCaret(edytor, textToFocus, yStart);
					}
				}
			}
		});
	},
	'shift+tab': ({ edytor, prevent }) => {
		prevent(() => {
			suppressStructuralHotkeyDomDrift(edytor);
			edytor.dispatcher.cut('unNestBlock');
			const selectedBlocks = edytor.selection.selectedBlocks;
			if (selectedBlocks.size > 1) {
				return;
			}

			const selectedBlock = selectedBlocks.values().next().value as Block | undefined;
			const { yStart, startText, startBlock } = edytor.selection.state;
			const index = startText?.index;
			const blockToUnnest = selectedBlock || startBlock;
			const newBlock = blockToUnnest?.unNestBlock();
			if (selectedBlock) {
				newBlock && restoreStructuralHotkeyBlockSelection(edytor, newBlock);
				return;
			}

			if (newBlock && index !== undefined) {
				const textToFocus = newBlock.content[index] as Text;
				restoreStructuralHotkeyCaret(edytor, textToFocus, yStart);
			}
		});
	},
	escape: ({ edytor, prevent }) => {
		if (edytor.selection.selectedBlocks.size > 0) {
			prevent(() => {
				const firstSelectedBlock = edytor.selection.selectedBlocks.values().next().value as Block;
				edytor.selection.selectBlocks();
				if (firstSelectedBlock.firstEditableText) {
					edytor.selection.setAtTextOffset(
						firstSelectedBlock.firstEditableText,
						firstSelectedBlock.firstEditableText.length
					);
				}
			});
		}
	},
	backspace: ({ event, edytor, prevent }) => {
		if (deleteSelectedInlineBlock(event, edytor)) {
			return;
		}

		if (edytor.selection.selectedBlocks.size) {
			event.preventDefault();
			event.stopPropagation();
			edytor.dispatcher.cut('deleteBlocks');
			const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
			const selectedBlock = selectedBlocks.at(0) as Block | undefined;
			if (!selectedBlock) {
				return;
			}

			edytor.edytor.plugins.forEach((plugin) => {
				plugin.onDeleteSelectedBlocks?.({ prevent, selectedBlocks });
			});

			const removed = removeSelectedBlocksForReplacement(edytor, {
				queueUndoSelectionSnapshot: true
			});
			const blockToFocus = removed?.blockToFocus;

			if (blockToFocus) {
				const focusFallbackBlock = () => {
					const text = blockToFocus.firstEditableText;
					if (!text) {
						return;
					}

					edytor.edytor.expectInternalFocus();
					edytor.edytor.node?.focus();
					void edytor.selection.setAtTextOffset(text, text.length);
				};

				void tick().then(focusFallbackBlock);
				setTimeout(focusFallbackBlock, 30);
			}
		}
	},
	delete: ({ event, edytor, prevent }) => {
		defaultHotKeys.backspace({ event, edytor, prevent });
	},
	...macEmacsHotKeys
} satisfies Partial<Record<HotKeyCombination, HotKey>>;

// Features:
// Case insensitive hotkeys
// Modifier keys in any order
// Hotkeys can prevent execution of subsequent hotkeys and therefore allow for overriding default hotkeys
// Mod to match modifier cmd on mac or ctrl on windows
export class HotKeys {
	private hotkeys = new Map<string, HotKey[]>();
	get isMac() {
		return typeof window != 'undefined' && /Mac|iPod|iPhone|iPad/.test(window.navigator.platform);
	}
	constructor(
		private edytor: Edytor,
		private userHotKeys: EdytorOptions['hotKeys'] = {},
		private plugins: InitializedPlugin[] = []
	) {}

	init = () => {
		// User hotkeys > plugins hotkeys > default hotkeys
		const entries = [
			this.userHotKeys || {},
			...this.plugins.map((plugin) => plugin.hotkeys || {}),
			defaultHotKeys
		];

		entries.forEach((hotKeys) => {
			Object.entries(hotKeys).forEach(([key, func]) => {
				const normalizedKey = this.normalizeKey(key);
				if (this.hotkeys.has(normalizedKey)) {
					this.hotkeys.get(normalizedKey)!.push(func);
				} else {
					this.hotkeys.set(this.normalizeKey(key), [func]);
				}
			});
		});
	};

	private normalizeKey = (key: string): string => {
		const parts = key.toLowerCase().split('+');
		const orderedParts: string[] = [];

		// Add modifiers in the correct order
		if (parts.includes('mod')) orderedParts.push('mod');
		if (parts.includes('alt')) orderedParts.push('alt');
		if (parts.includes('ctrl')) orderedParts.push('ctrl');
		if (parts.includes('shift')) orderedParts.push('shift');

		// Add remaining keys that aren't modifiers
		parts.forEach((part) => {
			if (!['mod', 'alt', 'ctrl', 'shift'].includes(part)) {
				orderedParts.push(part);
			}
		});
		return orderedParts.join('+');
	};

	private combination = (e: KeyboardEvent, keyOverride?: string) => {
		const rawKey = keyOverride ?? e.key.toLowerCase();
		const isReverseTab = reverseTabKeys.has(rawKey);
		const key = isReverseTab ? 'tab' : rawKey;
		let combination = '';

		// `mod` is Cmd on Apple platforms and Ctrl elsewhere. On Apple
		// platforms bare Ctrl stays distinct (`ctrl+`) so the macOS
		// Emacs-style chords and explicit Ctrl bindings remain reachable;
		// `mod+ctrl` still covers Cmd+Ctrl chords there.
		if (e.metaKey || (e.ctrlKey && !this.isMac)) {
			combination += 'mod+';
		}
		// Is alt
		if (e.altKey) {
			combination += 'alt+';
		}
		// Is bare ctrl (Apple only — elsewhere Ctrl already folded into `mod`)
		if (e.ctrlKey && this.isMac) {
			combination += 'ctrl+';
		}
		// Is shift
		if (e.shiftKey || isReverseTab) {
			combination += 'shift+';
		}

		if (!escapedKeys.has(key)) {
			combination += key;
		}

		// Remove trailing plus if it exists
		combination = combination.replace(/\+$/, '');

		return combination;
	};

	isHotkey = (e: KeyboardEvent) => {
		if (isAltGraphInput(e)) {
			return false;
		}

		const combinations = [this.combination(e)];
		// Non-Latin layout fallback: a non-ASCII `event.key` can never match
		// a registered combination — retry via the physical `event.code`
		// position (Mod+Б → Mod+B). The produced key takes precedence: a
		// direct binding for the actual character wins over the fallback,
		// and a direct binding that ran without preventing still lets the
		// fallback fire.
		const fallbackKey = getLayoutFallbackKey(e);
		if (fallbackKey) {
			combinations.push(this.combination(e, fallbackKey));
		}

		for (const combination of combinations) {
			const hotKeys = this.hotkeys.get(combination);
			if (!hotKeys?.length) continue;
			let handled = false;
			this.edytor.dispatcher.scope(
				() => hotKeys.forEach((hotKey) => hotKey({ event: e, edytor: this.edytor, prevent })),
				() => {
					handled = true;
					e.preventDefault();
					e.stopPropagation();
				}
			);
			if (handled) return true;
		}
		return false;
	};
}
