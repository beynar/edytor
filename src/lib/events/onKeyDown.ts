/* eslint-disable @typescript-eslint/no-explicit-any */
import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	if (this.readonly) return;

	try {
		if (this.hotKeys.isHotkey(e)) {
			return;
		}

		if (e.key === 'Tab') {
			if (!this.selection.state.isIsland) {
				e.preventDefault();
				e.stopPropagation();
				const { yStart, startText } = this.selection.state;
				const newBlock = this.selection.state.startText?.parent.nestBlock();
				const index = startText?.index;
				if (newBlock && index !== undefined) {
					const textToFocus = newBlock.content[index] as Text;
					this.selection.setAtTextOffset(textToFocus, yStart);
				}
			}
		}

		if (e.key === 'Escape') {
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
	} catch (error) {
		if (error instanceof PreventionError) {
			error.cb?.();
		} else {
			throw error;
		}
	}
}
