import type { Plugin } from '$lib/plugins.js';
import { branded } from '../brand.js';
import type { HotKey } from '$lib/session/keymap.js';
import type { BlockMoveDirection } from '$lib/session/moves.js';
import {
	getSelectionBlocks,
	movable,
	outermost,
	selectMoved
} from '$lib/selection/replaceSelection.js';

/**
 * One relative step for the selected blocks; with `caret`, the block
 * holding the caret moves too (Notion's Mod+Shift+Up/Down; a code line's
 * code block), the caret riding along, and so do the blocks a text range
 * spans (`getSelectionBlocks`, as a handle drag takes them), the range kept.
 * Claimed only when something can move.
 */
const move =
	(direction: BlockMoveDirection, caret = false): HotKey =>
	({ edytor, prevent }) => {
		const selected = [...edytor.selection.selectedBlocks];
		const { startText } = edytor.selection.textRange();
		const { isCollapsed } = edytor.selection.projection;
		const at = startText?.parent;
		// A code line moves as its code block (`movable`).
		const spanned = () =>
			outermost(movable(isCollapsed ? (at ? [at] : []) : getSelectionBlocks(edytor)));
		// A selected block's selected descendants travel with it (`outermost`), as the menu's Move does.
		const blocks = selected.length ? outermost(movable(selected)) : caret ? spanned() : [];
		if (!blocks.length || !edytor.canMove({ blocks, direction })) return;
		prevent(() => {
			const moved = edytor.move({ blocks, direction });
			if (moved.length && selected.length) selectMoved(edytor, moved, selected);
		});
	};

/** Block moves from the keyboard (Mod+Up/Down, Mod+Shift+Up/Down): apps list it (`createArrowMovePlugin()`), it is not a default. */
export const createArrowMovePlugin = (): Plugin =>
	branded('arrowMove', () => ({
		hotkeys: {
			'mod+arrowdown': move('down'),
			'mod+arrowup': move('up'),
			'mod+shift+arrowdown': move('down', true),
			'mod+shift+arrowup': move('up', true)
		}
	}));
