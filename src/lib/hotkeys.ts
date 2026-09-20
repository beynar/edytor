import type { Edytor, EdytorOptions } from './edytor.svelte.js';
import { Text } from './text/text.svelte.js';
import type { InitializedPlugin } from './plugins.js';
import { prevent, PreventionError } from './utils.js';
import { Block } from './block/block.svelte.js';
import { tick } from 'svelte';
import { clearDomSelection } from './selection/domSelection.js';
import { navigationHotKeys } from './hotkeys/navigation.js';
import { refreshDomAfterHistoryChange } from './history/refreshDomAfterHistoryChange.js';
import {
	beginHistoryCommandRestore,
	getHistorySelectionSnapshot,
	restoreCollapsedHistorySelectionState,
	restoreCollapsedHistorySelection
} from './history/historySelectionSnapshot.js';
import {
	getSelectedBlocksInDocumentOrder,
	removeSelectedBlocksForReplacement
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
	edytor.undoManager.stopCapturing();

	const location = edytor.root ? findInlineBlockLocation(edytor.root, inlineBlock.id) : null;
	if (!location) {
		edytor.selection.selectedInlineBlock.clear();
		edytor.selection.inlineBlockDeletionTarget = null;
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

	edytor.selection.selectedInlineBlock.clear();
	edytor.selection.inlineBlockDeletionTarget = null;
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
	const restore = () => {
		if (edytor.root) {
			refreshStructuralChildren(edytor.root);
			edytor.refreshEditorDom();
		}
		clearDomSelection(edytor.node);
		edytor.selection.selectBlocks(block);
		edytor.selection.ignoreNextSelectedBlockSelectionChange = true;
		edytor.selection.ignoreNextSelectionChange = true;
	};

	restore();
	void tick().then(restore);
	setTimeout(restore, 30);
	setTimeout(restore, STRUCTURAL_HOTKEY_DOM_REPAIR_WINDOW_MS);
};

const defaultHotKeys = {
	'mod+z': ({ edytor }) => {
		prevent(() => {
			suppressHistoryHotkeyDomDrift(edytor);
			const stackItem = edytor.undoManager.undoStack.at(-1);
			const selectionSnapshot = getHistorySelectionSnapshot(stackItem);
			const shouldRestoreSelection = beginHistoryCommandRestore(edytor);
			edytor.selection.queueNextUndoSelectionSnapshot();
			edytor.undoManager.undo();
			restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestoreSelection);
			void refreshDomAfterHistoryChange(edytor, {
				restoreSelection: false,
				shouldRestoreSelection
			}).then(() =>
				restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestoreSelection)
			);
		});
	},
	'mod+shift+z': ({ edytor, prevent }) => {
		prevent(() => {
			suppressHistoryHotkeyDomDrift(edytor);
			const stackItem = edytor.undoManager.redoStack.at(-1);
			const selectionSnapshot = getHistorySelectionSnapshot(stackItem, { preferRestore: true });
			const shouldRestoreSelection = beginHistoryCommandRestore(edytor);
			const selectedBlocks = getSelectedBlocksInDocumentOrder(edytor);
			const redoFallbackBlock =
				selectedBlocks.at(0)?.closestPreviousBlock ?? selectedBlocks.at(-1)?.closestNextBlock;
			edytor.selection.queueNextUndoSelectionSnapshot();
			edytor.undoManager.redo();
			const fallbackText = redoFallbackBlock?.firstEditableText;
			if (fallbackText) {
				edytor.selection.setCollapsedStateAtTextOffset(fallbackText, fallbackText.length);
			} else {
				restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestoreSelection);
			}
			void refreshDomAfterHistoryChange(edytor, {
				restoreSelection: false,
				shouldRestoreSelection
			}).then(() => {
				if (!shouldRestoreSelection()) {
					return;
				}

				if (fallbackText) {
					void edytor.selection.setAtTextOffset(fallbackText, fallbackText.length);
					return;
				}

				void restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestoreSelection);
			});
		});
	},
	'mod+enter': ({ edytor, prevent }) => {
		prevent(() => {
			edytor.undoManager.stopCapturing();
			const newBlock = edytor.selection.state.startText?.parent.splitBlock({
				index: edytor.selection.state.startText?.yText.length,
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
		const selectedBlocks = Array.from(edytor.selection.selectedBlocks.values());
		if (selectedBlocks.length >= 1) {
			prevent(() => {
				const selectedBlock = selectedBlocks
					.toSorted((a, b) => a.path[0] - b.path[0])
					.at(0) as Block;
				let prevBlock = selectedBlock.closestPreviousBlock;

				// If the block is inside an island, we will select the island root
				while (prevBlock?.insideIsland) {
					if (prevBlock.parent instanceof Block) {
						prevBlock = prevBlock.parent;
					}
				}

				if (prevBlock && prevBlock instanceof Block) {
					if (selectedBlock.isNested && selectedBlock.parent === prevBlock) {
						edytor.selection.removeBlockFromSelection(selectedBlock);
					}
					edytor.selection.addBlockToSelection(prevBlock);
				}
			});
		}
	},
	'shift+arrowdown': ({ edytor, prevent }) => {
		const selectedBlocks = Array.from(edytor.selection.selectedBlocks.values());
		if (selectedBlocks.length === 0 && selectNextVoidBlockFromCaret(edytor)) {
			prevent();
			return;
		}

		if (selectedBlocks.length >= 1) {
			prevent(() => {
				const selectedBlock = selectedBlocks
					.toSorted((a, b) => a.path[0] - b.path[0])
					.at(-1) as Block;

				let nextBlock = selectedBlock.definition.island
					? selectedBlock.nextBlock
					: selectedBlock.closestNextBlock;

				while (nextBlock?.isChildOf(selectedBlock)) {
					nextBlock = nextBlock.closestNextBlock;
				}

				if (nextBlock && nextBlock instanceof Block) {
					edytor.selection.addBlockToSelection(nextBlock);
				}
			});
		}
	},
	arrowup: ({ edytor, prevent }) => {
		const selectedBlocks = edytor.selection.selectedBlocks;
		if (selectedBlocks.size === 1) {
			prevent(() => {
				const selectedBlock = selectedBlocks.values().next().value as Block;
				let prevBlock = selectedBlock.closestPreviousBlock;

				// If the block is inside an island, we will select the island root
				while (prevBlock?.insideIsland) {
					if (prevBlock.parent instanceof Block) {
						prevBlock = prevBlock.parent;
					}
				}
				if (prevBlock && prevBlock instanceof Block) {
					edytor.selection.selectBlocks(prevBlock);
					edytor.selection.focusBlocks();
				}
			});
		}
	},
	arrowdown: ({ edytor, prevent }) => {
		const selectedBlocks = edytor.selection.selectedBlocks;
		if (selectedBlocks.size === 1) {
			prevent(() => {
				const selectedBlock = selectedBlocks.values().next().value as Block;
				let nextBlock = selectedBlock.definition.island
					? selectedBlock.nextBlock
					: selectedBlock.closestNextBlock;

				if (nextBlock && nextBlock instanceof Block) {
					edytor.selection.selectBlocks(nextBlock);
					edytor.selection.focusBlocks();
				}
			});
		}
	},
	tab: ({ edytor, prevent }) => {
		prevent(() => {
			suppressStructuralHotkeyDomDrift(edytor);
			edytor.undoManager.stopCapturing();
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
			edytor.undoManager.stopCapturing();
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
						firstSelectedBlock.firstEditableText.yText.length
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
			edytor.undoManager.stopCapturing();
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

					edytor.edytor.node?.focus();
					void edytor.selection.setAtTextOffset(text, text.yText.length);
				};

				void tick().then(focusFallbackBlock);
				setTimeout(focusFallbackBlock, 30);
			}
		}
	},
	delete: ({ event, edytor, prevent }) => {
		defaultHotKeys.backspace({ event, edytor, prevent });
	}
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

	private combination = (e: KeyboardEvent) => {
		const rawKey = e.key.toLowerCase();
		const isReverseTab = reverseTabKeys.has(rawKey);
		const key = isReverseTab ? 'tab' : rawKey;
		let combination = '';

		// Is modifier
		if (e.ctrlKey || e.metaKey) {
			combination += 'mod+';
		}
		// Is alt
		if (e.altKey) {
			combination += 'alt+';
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

		const combination = this.combination(e);
		const hotKeys = this.hotkeys.get(combination);
		if (!hotKeys?.length) return false;
		try {
			hotKeys.forEach((hotKey) => {
				hotKey({ event: e, edytor: this.edytor, prevent });
			});
			return false;
		} catch (error) {
			if (error instanceof PreventionError) {
				e.preventDefault();
				e.stopPropagation();
				error.cb?.();
			}
			return true;
		}
	};
}
