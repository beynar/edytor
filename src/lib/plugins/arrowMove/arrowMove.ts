import type { Block } from '$lib/block/block.svelte.js';
import { type Plugin } from '$lib/plugins.js';
import { tick } from 'svelte';

export const arrowMovePlugin: Plugin = (edytor) => {
	return {
		hotkeys: {
			'mod+arrowdown': ({ prevent }) => {
				const selectedBlocks = edytor.selection.selectedBlocks;
				if (selectedBlocks.size === 1) {
					const selectedBlock = selectedBlocks.values().next().value as Block;
					if (!selectedBlock) return;

					prevent(() => {
						const path = selectedBlock.path;
						console.log({ path: [...path] });

						if (
							selectedBlock.parent &&
							path?.at(-1) === selectedBlock.parent?.children.length - 1
						) {
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
				} else {
					const selectedBlocks = Array.from(edytor.selection.selectedBlocks.values());
					const firstSelectedBlock = selectedBlocks.at(0) as Block;
					const nextBlock = selectedBlocks.at(-1)?.nextBlock;
					if (nextBlock) {
						const path = firstSelectedBlock.path;
						const newBlock = nextBlock?.moveBlock({ path });
					}
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
