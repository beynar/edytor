import type { Edytor, EdytorOptions } from './edytor.svelte.js';
import { Text } from './text/text.svelte.js';
import type { InitializedPlugin } from './plugins.js';
import { prevent, PreventionError } from './utils.js';
import { Block } from './block/block.svelte.js';

export type HotKey = (payload: {
	event: KeyboardEvent;
	edytor: Edytor;
	prevent: (cb: () => void) => void;
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
	| 'space'
	| 'escape'
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

const defaultHotKeys = {
	'mod+z': ({ edytor }) => {
		prevent(() => {
			edytor.undoManager.undo();
		});
	},
	'mod+shift+z': ({ edytor, prevent }) => {
		prevent(() => {
			edytor.undoManager.redo();
		});
	},
	'mod+enter': ({ edytor, prevent }) => {
		prevent(() => {
			const newBlock = edytor.selection.state.startText?.parent.splitBlock({
				index: edytor.selection.state.startText?.yText.length,
				text: edytor.selection.state.startText
			});
			if (newBlock && newBlock.content[0] instanceof Text) {
				newBlock && edytor.selection.setAtTextOffset(newBlock.content[0], newBlock.content.length);
			}
		});
	},
	'mod+a': ({ edytor, prevent }) => {
		prevent(() => {
			const { startText, startBlock, islandRoot, isVoid, isIsland, voidRoot } =
				edytor.selection.state;
			if (startText) {
				if (edytor.selection.selectedBlocks.size) {
					edytor.selection.selectBlocks(...edytor.children);
				} else if (
					edytor.selection.state.isAtStartOfBlock &&
					edytor.selection.state.isAtEndOfBlock
				) {
					window.getSelection()?.removeAllRanges();
					edytor.selection.selectBlocks(
						edytor.selection.state.isIsland ? islandRoot! : startText.parent
					);
				} else {
					edytor.selection.setAtBlockRange(startBlock);
				}
			}
		});
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
				console.log({ nextBlock });
				if (nextBlock && nextBlock instanceof Block) {
					edytor.selection.selectBlocks(nextBlock);
					edytor.selection.focusBlocks();
				}
			});
		}
	}
} satisfies Record<string, HotKey>;

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
		if (typeof window === 'undefined') return;

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
		let isMod = false;
		let isCtrl = false;
		const parts = key.toLowerCase().split('+');
		const orderedParts: string[] = [];

		// Add modifiers in the correct order
		if (parts.includes('mod')) orderedParts.push('mod'), (isMod = true);
		if (parts.includes('alt')) orderedParts.push('alt');
		if (parts.includes('ctrl')) orderedParts.push('ctrl'), (isCtrl = true);
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
		const key = e.key.toLowerCase();
		let combination = '';

		// Is modifier
		if (e.ctrlKey || e.metaKey) {
			combination += 'mod+';
		}
		// Is alt
		if (e.altKey) {
			combination += 'alt+';
		}
		// Is ctrl
		if (e.ctrlKey && !e.metaKey) {
			combination += 'ctrl+';
		}
		// Is shift
		if (e.shiftKey) {
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
