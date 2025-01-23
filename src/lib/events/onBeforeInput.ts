import type { Edytor } from '../edytor.svelte.js';
import { unNest } from '$lib/operations/nest.js';
import { tick } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';

export async function onBeforeInput(this: Edytor, e: InputEvent) {
	const {
		start,
		yStart,
		startNode,
		isCollapsed,
		isTextSpanning,
		isAtStart,
		length,
		startText,
		isAtEnd
	} = this.selection.state;
	const { inputType, dataTransfer, data } = e;
	console.log({ inputType });
	switch (inputType) {
		case 'insertText': {
			if (data === '. ') {
				startText?.insertText(data!, 'AUTO_DOT');
			} else {
				startText?.insertText(data!);
			}
			break;
		}

		case 'deleteContentForward': {
			if (isTextSpanning) {
				e.preventDefault();
			} else {
				startText?.deleteText('FORWARD', length);
			}
			break;
		}
		case 'deleteContentBackward': {
			if (isTextSpanning) {
				e.preventDefault();
			} else {
				console.log({ isCollapsed, isAtStart });
				if (isCollapsed && isAtStart) {
					e.preventDefault();
					const isEmpty = startText?.yText.length === 0 && startText?.parent.children.length === 0;
					console.log(
						{ isEmpty, text: startText?.yText.toJSON() },
						startText?.yText.length,
						startText?.parent.children.length
					);
					if (isEmpty) {
						const text = this.edytor.transact(() => {
							return startText?.parent.remove();
						});

						this.edytor.selection.setAtTextOffset(text, text.yText.length);
					} else {
						startText?.parent.unNest();
					}
				} else {
					startText?.deleteText('BACKWARD', length);
				}
			}
			break;
		}
		case 'insertLineBreak': {
			e.preventDefault?.();
			startText?.insertText('\n', 'INSERT_LINE_BREAK');
			this.selection.setAtNodeOffset(startNode!, start + 1);

			break;
		}
		case 'insertFromPaste': {
			e.preventDefault?.();
			const text = dataTransfer!.getData('text/plain') as string;
			startText?.insertText(text, 'PASTE');
			this.selection.setAtNodeOffset(startNode!, start + text.length);
			break;
		}
		case 'insertParagraph': {
			e.preventDefault?.();

			if (!startText) {
				return;
			}

			if (isCollapsed) {
				if (isAtEnd || isAtStart) {
					let index = startText.parent?.parent?.children.indexOf(startText.parent);
					if (isAtEnd) {
						index++;
					}
					// Just happen a new block after the current one
					const newBlock = this.edytor.transact(() => {
						return startText.parent?.parent?.addChild(
							{
								type: 'paragraph'
							},
							index
						);
					});

					if (isAtEnd) {
						this.selection.setAtTextOffset(newBlock.content, newBlock.content.yText.length);
					} else {
						this.selection.setAtTextOffset(startText, 0);
					}
				} else {
					const newBlock = startText.parent?.split(yStart);

					this.selection.setAtTextOffset(newBlock.content, 0);
				}
			}

			break;
		}
	}
}
