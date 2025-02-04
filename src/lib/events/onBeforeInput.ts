import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';

export async function onBeforeInput(this: Edytor, e: InputEvent) {
	if (this.readonly) return;
	e.preventDefault();
	const { start, yStart, isCollapsed, isTextSpanning, isAtStart, length, startText, isAtEnd } =
		this.selection.state;
	const { inputType, dataTransfer, data } = e;
	const isNested = startText?.parent.parent !== this.edytor;
	const isLastChild = startText?.parent.parent.children.at(-1) === startText?.parent;
	try {
		switch (inputType) {
			case 'insertText': {
				if (data === '. ') {
					startText?.insertText({ value: data!, isAutoDot: true });
				} else {
					startText?.insertText({ value: data! });
					// We need to immediately shift the selection to the right by the length of the inserted text
					// This is to prevent selection divergence when the text is rapidly inserted
					this.edytor.selection.shift(data!.length);
					// Then we set the caret to the right position of the inserted text
					this.selection.setAtTextOffset(startText!, yStart + data!.length);
				}
				break;
			}

			case 'deleteContentForward': {
				if (isTextSpanning) {
					// TODO: implement this later, it's complicated i think.
				} else {
					if (isCollapsed && isAtEnd) {
						// Before:
						// [Block]
						//   [Text] "Hello|"
						// [NextBlock]
						//   [Text] "World"
						//
						// After:
						// [Block]
						//   [Text] "Hello|World"
						startText?.parent.mergeBlockForward();
						this.edytor.selection.setAtTextOffset(startText!, yStart);
					} else {
						// Before:
						//   [Text] "Hello| World"
						//
						// After:
						//   [Text] "Hello|World"
						startText?.deleteText({ direction: 'FORWARD', length: length || 1 });
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
						// Last nested block need to be unNest
						// Otherwise we just merge the block backward and eventually remove the block or unnest the children
						if (isNested && isLastChild) {
							// Before:
							// [Block]
							//   [Block]
							//     [Text] "|Hello"
							//
							// After:
							// [Block]
							// [Block]
							//   [Text] "|Hello"
							const newBlock = startText?.parent.unNestBlock();
							newBlock && this.edytor.selection.setAtTextOffset(newBlock.content, 0);
						} else {
							// Before:
							// [Block]
							//   [Text] "Hello |World"
							//
							// After:
							// [Block]
							//   [Text] "Hello|World"
							//
							// OR
							//
							// Before:
							// [Block]
							//   [Text] "Hello"
							// [Block]
							//   [Text] "|World"
							//
							// After:
							// [Block]
							//   [Text] "Hello|World"
							//
							// OR
							//
							// Before:
							// [Block]
							//   [Text] "Hello"
							// [Block]
							//   [Text] "|World"
							//	 [Block]
							//   	[Text] "!"
							//
							// After:
							// [Block]
							//   [Text] "Hello|World"
							// [Block]
							//   [Text] "|!"
							const previousBlock = startText?.parent.closestPreviousBlock;
							const offset = previousBlock?.content.yText.length;
							startText?.parent.mergeBlockBackward();
							previousBlock && this.edytor.selection.setAtTextOffset(previousBlock.content, offset);
						}
					} else {
						startText?.deleteText({ direction: 'BACKWARD', length: length || 1 });
						this.selection.setAtTextOffset(startText!, isCollapsed ? yStart - 1 : yStart);
					}
				}
				break;
			}
			case 'insertLineBreak': {
				startText?.insertText({ value: '\n' });
				this.selection.setAtTextOffset(startText!, start + 1);
				break;
			}
			case 'insertFromPaste': {
				const value = dataTransfer!.getData('text/plain') as string;
				startText?.insertText({ value });
				this.selection.setAtTextOffset(startText!, yStart + value.length);
				break;
			}
			case 'insertParagraph': {
				this.edytor.plugins.forEach((plugin) => {
					plugin.onEnter?.({ prevent, e });
				});
				if (!startText) {
					return;
				}
				if (isCollapsed) {
					if (isAtEnd) {
						const newBlock = startText.parent.insertBlockAfter({
							block: {
								type: 'paragraph'
							}
						});
						this.selection.setAtTextOffset(newBlock.content.id, newBlock.content.yText.length);
					} else if (isAtStart) {
						startText.parent?.insertBlockBefore({
							block: {
								type: 'paragraph'
							}
						});
						this.selection.setAtTextOffset(startText, 0);
					} else {
						const newBlock = startText.parent?.splitBlock({ index: yStart });
						newBlock && this.selection.setAtTextOffset(newBlock.content, 0);
					}
				}

				break;
			}
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			error.cb?.();
			return;
		}
		throw error;
	}
}
