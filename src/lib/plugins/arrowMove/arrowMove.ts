import type { Plugin } from '$lib/plugins.js';
import type { HotKey } from '$lib/session/keymap.js';
import type { BlockMoveDirection } from '$lib/session/moves.js';

/**
 * One relative step (D-5) for the selected blocks; with `caret`, the block
 * holding the caret moves too (Notion's Mod+Shift+Up/Down), the caret riding
 * along. Claimed only when something can move.
 */
const move =
	(direction: BlockMoveDirection, caret = false): HotKey =>
	({ edytor, prevent }) => {
		const selected = [...edytor.selection.selectedBlocks];
		const at = edytor.selection.state.startBlock;
		const blocks = selected.length ? selected : caret && at?.movable ? [at] : [];
		if (!blocks.length || !edytor.canMoveBlocks({ blocks, direction })) return;
		prevent(() => {
			const moved = edytor.moveBlocks({ blocks, direction });
			if (moved.length && selected.length) edytor.selection.selectBlocks(...moved);
		});
	};

export const arrowMovePlugin: Plugin = () => ({
	hotkeys: {
		'mod+arrowdown': move('down'),
		'mod+arrowup': move('up'),
		'mod+shift+arrowdown': move('down', true),
		'mod+shift+arrowup': move('up', true)
	}
});
