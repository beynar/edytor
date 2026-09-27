import type { Plugin } from '$lib/plugins.js';
import type { HotKey } from '$lib/session/keymap.js';
import type { BlockMoveDirection } from '$lib/session/moves.js';

/** Mod+Up/Down: the selected blocks take one relative step (D-5). Claimed while blocks are selected. */
const move =
	(direction: BlockMoveDirection): HotKey =>
	({ edytor, prevent }) => {
		const blocks = [...edytor.selection.selectedBlocks];
		if (!blocks.length) return;
		prevent(() => {
			const moved = edytor.moveBlocks({ blocks, direction });
			if (moved.length) edytor.selection.selectBlocks(...moved);
		});
	};

export const arrowMovePlugin: Plugin = () => ({
	hotkeys: { 'mod+arrowdown': move('down'), 'mod+arrowup': move('up') }
});
