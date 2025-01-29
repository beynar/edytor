import { tick } from 'svelte';
import type { Edytor } from '../edytor.svelte.js';

export async function onBeforeInput(this: Edytor, e: InputEvent) {
	if (this.readonly) return;
	e.preventDefault();
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
	const isContentEmpty = startText?.isEmpty;
	const hasChildren = (startText?.parent.children.length || 0) > 0;
	const isEmpty = isContentEmpty && !hasChildren;
	const isNested = startText?.parent.parent !== this.edytor;
	const isLastChild = startText?.parent.parent.children.at(-1) === startText?.parent;

	switch (inputType) {
		case 'insertText': {
			if (data === '. ') {
				startText?.yText.applyDelta([
					{
						retain: yStart - 1
					},
					{
						delete: 1
					},
					{
						insert: '. '
					}
				]);
				this.selection.setAtTextOffset(startText!, yStart + 1);
			} else {
				startText?.yText.insert(yStart, data!);
				this.edytor.selection.shift(data!.length);
				this.selection.setAtTextOffset(startText!, yStart + data!.length);
			}
			break;
		}

		case 'deleteContentForward': {
			if (isTextSpanning) {
				// TODO: implement this later, it's complicated i think.
			} else {
				if (isCollapsed && isAtEnd) {
					startText?.parent.mergeBlockForward();
					this.edytor.selection.setAtTextOffset(startText!, yStart);
				} else {
					startText?.deleteText('FORWARD', length);
					this.selection.setAtTextOffset(startText!, yStart);
				}
			}
			break;
		}
		case 'deleteContentBackward': {
			if (isTextSpanning) {
				// TODO: implement this later, it's complicated i think.
			} else {
				if (isCollapsed && isAtStart) {
					if (isEmpty) {
						const { previousBlock } = startText?.parent;
						const offset = previousBlock?.content.yText.length;
						startText?.parent.remove();
						this.edytor.selection.setAtTextOffset(previousBlock, offset);
					} else if (isContentEmpty) {
						const { previousBlock } = startText?.parent;
						const offset = previousBlock?.content.yText.length;
						startText?.parent.removeAndUnnestChildren();
						this.edytor.selection.setAtTextOffset(previousBlock, offset);
					} else {
						if (isNested) {
							if (isLastChild) {
								console.log('here');
								const newBlock = startText?.parent.unNest();
								newBlock && this.edytor.selection.setAtTextOffset(newBlock.content, 0);
							} else {
								console.log('here');
								const previousBlock = startText?.parent.closestPreviousBlock;
								const offset = previousBlock?.content.yText.length;
								startText?.parent.mergeBlockBackward();
								previousBlock &&
									this.edytor.selection.setAtTextOffset(previousBlock.content, offset);
							}
						} else {
							const previousBlock = startText?.parent.closestPreviousBlock;
							const offset = previousBlock?.content.yText.length;
							startText?.parent.mergeBlockBackward();
							previousBlock && this.edytor.selection.setAtTextOffset(previousBlock.content, offset);
						}
					}
				} else {
					startText?.deleteText('BACKWARD', length || 1);

					this.selection.setAtTextOffset(startText!, yStart);
				}
			}
			break;
		}
		case 'insertLineBreak': {
			e.preventDefault?.();
			startText?.insertText('\n', 'INSERT_LINE_BREAK');
			this.selection.setAtTextOffset(startText!, start + 1);
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
					let index = startText.parent?.index;
					if (isAtEnd) {
						if (hasChildren) {
							const newBlock = startText.parent.addChildWithCurrentChildren({
								type: 'paragraph'
							});
							this.selection.setAtTextOffset(newBlock.content.id, newBlock.content.yText.length);
						} else {
							const newBlock = startText.parent.parent.addChild(
								{
									type: 'paragraph'
								},
								index + 1
							);
							this.selection.setAtTextOffset(newBlock.content.id, newBlock.content.yText.length);
						}
					} else {
						startText.parent?.parent?.addChild(
							{
								type: 'paragraph'
							},
							index
						);
						this.selection.setAtTextOffset(startText, 0);
					}
				} else {
					const newBlock = startText.parent?.split(yStart);
					newBlock && this.selection.setAtTextOffset(newBlock.content, 0);
				}
			}

			break;
		}
	}
}
