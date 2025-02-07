/* eslint-disable @typescript-eslint/no-explicit-any */
import { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
import { tick } from 'svelte';
const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	try {
		if (this.readonly) return;

		if (e.key === 'Tab') {
			this.edytor.plugins.forEach((plugin) => {
				plugin.onTab?.({ prevent, e });
			});

			if (!this.selection.state.isIsland) {
				e.preventDefault();
				e.stopPropagation();
				const { yStart } = this.selection.state;
				const newBlock = this.selection.state.startText?.parent.nestBlock();
				if (newBlock) {
					this.selection.setAtTextOffset(newBlock.content, yStart);
				}
			}
		}

		if (e.key === 'Escape') {
			this.edytor.plugins.forEach((plugin) => {
				plugin.onEscape?.({ prevent, e });
			});

			if (this.selection.selectedBlocks.size > 0) {
				e.preventDefault();
				e.stopPropagation();
				const firstSelectedBlock = this.selection.selectedBlocks.values().next().value as Block;
				this.selection.selectBlocks();
				if (firstSelectedBlock.firstEditableText) {
					this.selection.setAtTextOffset(
						firstSelectedBlock.firstEditableText,
						firstSelectedBlock.firstEditableText.yText.length
					);
				}
				return;
			}
		}

		if (arrowKeys.includes(e.key)) {
			this.edytor.plugins.forEach((plugin) => {
				plugin.onArrow?.({
					prevent,
					e,
					direction: e.key.replace('Arrow', '').toLowerCase() as 'up' | 'down' | 'left' | 'right'
				});
			});
			if (e.metaKey) {
				const selectedBlock = this.selection.selectedBlocks.values().next().value as Block;
				if (e.key === 'ArrowUp') {
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
							this.selection.selectBlocks(newBlock);
						});
					}
				}
				if (e.key === 'ArrowDown') {
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
							this.selection.selectBlocks(newBlock);
						});
					}
				}
			} else {
				// Manage block selection on arrow keys if there is only one block selected
				if (this.selection.selectedBlocks.size === 1) {
					const selectedBlock = this.selection.selectedBlocks.values().next().value as Block;
					if (e.key === 'ArrowUp') {
						let prevBlock = selectedBlock.closestPreviousBlock;

						// If the block is inside an island, we will select the island root
						while (prevBlock?.insideIsland) {
							if (prevBlock.parent instanceof Block) {
								prevBlock = prevBlock.parent;
							}
						}
						if (prevBlock && prevBlock instanceof Block) {
							this.selection.selectBlocks(prevBlock);
							this.selection.focusBlocks();
						}
					}
					if (e.key === 'ArrowDown') {
						// if the current block is an island, we won't move the selection down to its children but to the next block
						let nextBlock = selectedBlock.definition.island
							? selectedBlock.nextBlock
							: selectedBlock.closestNextBlock;
						if (nextBlock && nextBlock instanceof Block) {
							this.selection.selectBlocks(nextBlock);
							this.selection.focusBlocks();
						}
					}
				}
			}
		}
		if (this.selection.selectedBlocks.size && e.key === 'Backspace') {
			const selectedBlocks = Array.from(this.selection.selectedBlocks.values());

			this.edytor.plugins.forEach((plugin) => {
				plugin.onDeleteSelectedBlocks?.({ prevent, e, selectedBlocks });
			});

			const firstSelectedBlock = selectedBlocks.at(0) as Block;
			const lastSelectedBlock = selectedBlocks.at(-1) as Block;
			const blockToFocus =
				firstSelectedBlock.closestPreviousBlock || lastSelectedBlock.closestNextBlock;
			this.edytor.transact(() => {
				this.selection.selectedBlocks.forEach((block) => {
					block.removeBlock();
				});
			});

			if (blockToFocus) {
				setTimeout(() => {
					this.edytor.node?.focus();
					this.selection.setAtTextOffset(
						blockToFocus.firstEditableText,
						blockToFocus.firstEditableText?.yText.length
					);
				});
			}
		}

		if (this.hotKeys.isHotkey(e)) {
			return;
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			error.cb?.();
		} else {
			throw error;
		}
	}
}
