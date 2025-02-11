import type { Block } from '$lib/block/block.svelte.js';
import { type Plugin } from '$lib/plugins.js';
import { tick } from 'svelte';

export const arrowMovePlugin: Plugin = (edytor) => {
	return {
		hotkeys: {
			'mod+arrowdown': ({ prevent, event }) => {
				const selectedBlocks = edytor.selection.selectedBlocks;
				if (selectedBlocks.size === 1) {
					const selectedBlock = selectedBlocks.values().next().value as Block;
					if (!selectedBlock) return;

					prevent(() => {
						const path = selectedBlock.path;

						if (path?.at(-1) === selectedBlock.parent.children.length - 1) {
							// If the block is nested and is the last child, we need to unest the block i.e pop the last path index
							path.pop();
						}
						// Then we just increment the last index
						path[path.length - 1]++;

						if (
							selectedBlock?.nextBlock?.hasChildren &&
							!selectedBlock?.nextBlock?.definition.island
						) {
							path.push(0);
						}

						const newBlock = selectedBlock.moveBlock({ path });
						if (newBlock) {
							tick().then(() => {
								edytor.selection.selectBlocks(newBlock);
							});
						}
					});
				}
			},

			'mod+arrowup': ({ prevent }) => {
				const selectedBlocks = edytor.selection.selectedBlocks;
				if (selectedBlocks.size === 1) {
					const selectedBlock = selectedBlocks.values().next().value as Block;
					if (!selectedBlock) return;

					prevent(() => {
						const path = selectedBlock.path;
						if (path?.at(-1) === 0) {
							// If the block is nested and is the first child, we need to unest the block i.e pop the last path index
							path.pop();
						} else {
							// Other wise just decrement the last index
							path[path.length - 1]--;
						}
						if (
							selectedBlock?.previousBlock?.hasChildren &&
							!selectedBlock?.previousBlock?.definition.island
						) {
							path.push(selectedBlock.previousBlock.children.length);
						}

						const newBlock = selectedBlock.moveBlock({ path });

						if (newBlock) {
							tick().then(() => {
								edytor.selection.selectBlocks(newBlock);
							});
						}
					});
				}
			}
		}
	};
};
