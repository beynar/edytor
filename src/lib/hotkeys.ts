import type { Edytor, EdytorOptions } from './edytor.svelte.js';
import type { InitializedPlugin } from './plugins.js';
import { prevent } from './utils.js';

export type HotKey = (payload: { event: KeyboardEvent; edytor: Edytor }) => void;
export type HotKeyModifier = 'mod' | 'alt' | 'ctrl' | 'shift';
type Letter =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z'
	| 'enter';
export type SingleModifierCombination = `${HotKeyModifier}+${Letter}`;
export type DoubleModifierCombination =
	| `mod+alt+${Letter}`
	| `mod+ctrl+${Letter}`
	| `mod+shift+${Letter}`
	| `alt+ctrl+${Letter}`
	| `alt+shift+${Letter}`
	| `ctrl+shift+${Letter}`;

export type HotKeyCombination = SingleModifierCombination | DoubleModifierCombination;

const escapedKeys = new Set(['shift']);

const historyHotKeys = {
	'mod+z': ({ edytor }) => {
		edytor.undoManager.undo();
	},
	'mod+shift+z': ({ edytor }) => {
		edytor.undoManager.redo();
	},
	'mod+enter': ({ edytor, event }) => {
		edytor.plugins.forEach((plugin) => {
			plugin.onEnter?.({ prevent, e: event, meta: true });
		});

		const newBlock = edytor.selection.state.startText?.parent.splitBlock({
			index: edytor.selection.state.startText?.yText.length
		});
		newBlock && edytor.selection.setAtTextOffset(newBlock.content, 0);
	},
	'mod+a': ({ edytor }) => {
		const { startText, islandRoot } = edytor.selection.state;
		if (startText) {
			if (edytor.selection.selectedBlocks.size) {
				edytor.selection.selectBlocks(...edytor.children);
			} else if (edytor.selection.state.isAtStart && edytor.selection.state.isAtEnd) {
				window.getSelection()?.removeAllRanges();
				edytor.selection.selectBlocks(
					edytor.selection.state.isIsland ? islandRoot! : startText.parent
				);
			} else {
				if (edytor.selection.state.isIsland) {
					const firstText = islandRoot?.children[0]?.content;
					let lastText = islandRoot?.children.at(-1)?.content;
					if (firstText && lastText) {
						edytor.selection.setAtTextsRange(firstText, lastText);
					}
				} else {
					edytor.selection.setAtTextRange(startText, 0, startText.yText.length);
				}
			}
		}
	}
} satisfies Record<string, HotKey>;

// Features:
// Case insensitive hotkeys
// Modifier keys in any order
// Hotkeys can be overridden by plugins
// Hotkeys can be overridden by hotkeys object
// Mod to match modifier cmd on mac or ctrl on windows
export class HotKeys {
	private hotkeys = new Map<string, HotKey>();
	// isMac = !(
	//     typeof window != 'undefined' && /Mac|iPod|iPhone|iPad/.test(window.navigator.platform)
	// );
	constructor(
		private edytor: Edytor,
		private hotKeys?: EdytorOptions['hotKeys'],
		private plugins?: InitializedPlugin[]
	) {}

	init = () => {
		// Only init when window is available.
		if (typeof window === 'undefined') return;
		const pluginHotKeys = this.plugins?.reduce(
			(acc, plugin) => {
				return Object.assign(acc, plugin.hotkeys || {});
			},
			{} as Record<string, HotKey>
		);
		// Iterate over hotkeys after plugins are initialized
		// in order to be able to override the plugins hotkeys
		Object.entries(Object.assign({}, historyHotKeys, pluginHotKeys, this.hotKeys || {})).forEach(
			([key, value]) => {
				this.hotkeys.set(this.normalizeKey(key), value);
			}
		);
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
		combination = combination.replace(/\+$/, '');

		// Remove trailing plus if it exists
		return combination;
	};

	isHotkey = (e: KeyboardEvent) => {
		const combination = this.combination(e);
		const hotKey = this.hotkeys.get(combination);
		if (!hotKey) return false;
		e.preventDefault();
		e.stopPropagation();
		hotKey({ event: e, edytor: this.edytor });
		return true;
	};
}
