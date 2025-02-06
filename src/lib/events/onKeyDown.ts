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
				this.selection.state.startText?.parent.nestBlock();
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

			// Manage block selection on arrow keys if there is only one block selected
			if (this.selection.selectedBlocks.size === 1) {
				const selectedBlock = this.selection.selectedBlocks.values().next().value as Block;
				if (e.key === 'ArrowUp') {
					let prevBlock = selectedBlock.closestPreviousBlock;

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
