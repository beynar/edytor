import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
import { Text } from '$lib/text/text.svelte.js';
export async function onBeforeInput(this: Edytor, e: InputEvent) {
	const {
		start,
		yStart,
		isCollapsed,
		isTextSpanning,
		isAtStartOfBlock,
		isAtStartOfText,
		isVoid,
		isAtEndOfText,
		length,
		isBlockSpanning,
		startText,
		isAtEndOfBlock,
		yEnd,
		islandRoot,
		texts
	} = this.selection.state;

	if (this.readonly) return;

	const { inputType, dataTransfer, data } = e;
	try {
		// Build virtual keyboard events for plugins hotkeys to listen to before handling the input event
		if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
			const customKeyDownEvent = new KeyboardEvent('keydown', {
				key: 'Enter',
				code: 'Enter',
				shiftKey: e.inputType === 'insertLineBreak'
			});

			this.hotKeys.isHotkey(customKeyDownEvent);
		}
		if (e.inputType === 'deleteContentForward' || e.inputType === 'deleteContentBackward') {
			const customKeyDownEvent = new KeyboardEvent('keydown', {
				key: 'Backspace',
				code: 'Backspace',
				shiftKey: e.inputType === 'deleteContentBackward'
			});

			this.hotKeys.isHotkey(customKeyDownEvent);
		}
		e.preventDefault();
		this.plugins.forEach((plugin) => {
			plugin.onBeforeInput?.({ prevent, e });
		});

		const isNested = startText?.parent.parent !== this.edytor;
		const isLastChild = startText?.parent.parent.children.at(-1) === startText?.parent;

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
				if (!startText) {
					return;
				}
				if (isTextSpanning) {
					// TODO: implement this later, it's complicated i think.
				} else {
					if (isCollapsed && isAtEndOfBlock) {
						// Before:
						// [Block]
						//   [Text] "Hello|"
						// [NextBlock]
						//   [Text] "World"
						//
						// After:
						// [Block]
						//   [Text] "Hello|World"
						startText.parent.mergeBlockForward();
						this.edytor.selection.setAtTextOffset(startText, yStart);
					} else if (isCollapsed && isAtEndOfText) {
						// Before:
						//   [Text] [InlineBlock] [Text]
						//
						// After:
						//   [Text]

						const index = startText.parent.content.indexOf(startText) + 1;
						startText.parent.removeInlineBlock({ index });
						this.selection.setAtTextOffset(startText, yStart);
					} else {
						// Before:
						//   [Text] "Hello| World"
						//
						// After:
						//   [Text] "Hello|World"
						startText.deleteText({ direction: 'FORWARD', length: length || 1 });
						this.selection.setAtTextOffset(startText, yStart);
					}
				}
				break;
			}
			case 'deleteContentBackward': {
				if (isBlockSpanning) {
					// TODO: implement this later, it's complicated i think.
				} else {
					if (!startText) {
						return;
					}
					if (isCollapsed && isAtStartOfBlock) {
						// Last nested block need to be unNest
						// Otherwise we just merge the block backward and eventually remove the block or unnest the children
						if (isNested && isLastChild && !islandRoot) {
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
							newBlock && this.edytor.selection.setAtTextOffset(newBlock.firstText, 0);
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

							if (islandRoot && islandRoot.children.length === 1) {
								this.edytor.selection.selectBlocks(islandRoot);
							} else {
								if (islandRoot && islandRoot.children.length > 1 && startText?.parent.index === 0) {
									return;
								} else {
									const previousBlock = startText?.parent.closestPreviousBlock;
									const previousText = previousBlock?.lastText;
									const offset = previousText?.length;
									startText?.parent.mergeBlockBackward();
									previousText &&
										this.edytor.selection.setAtTextOffset(previousBlock.lastText, offset);
								}
							}
						}
					} else {
						if (isCollapsed && isAtStartOfText) {
							// Before:
							//   [Text] [InlineBlock] [Text]
							//
							// After:
							//   [Text]
							const index = startText.parent.content.indexOf(startText) - 1;
							const previousText = startText.parent.content.at(index - 1);
							const hasPreviousText = previousText && previousText instanceof Text;
							const offset = hasPreviousText ? previousText.yText.length : 0;
							console.log({ hasPreviousText, offset, previousText });
							startText.parent.removeInlineBlock({ index });
							if (hasPreviousText) {
								this.selection.setAtTextOffset(previousText, offset);
							}
						} else if (isTextSpanning) {
							const startText = texts[0];
							const endText = texts[texts.length - 1];
							if (!startText || !endText) {
								return;
							}
							startText.parent.deleteContentAtRange({
								start: [startText.index, yStart],
								end: [endText.index, yEnd]
							});
							this.selection.setAtTextOffset(startText, yStart);
						} else {
							startText?.deleteText({ direction: 'BACKWARD', length: length || 1 });
							this.selection.setAtTextOffset(startText!, isCollapsed ? yStart - 1 : yStart);
						}
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
				if (!startText) {
					return;
				}
				const defaultBlock = this.getDefaultBlock();
				if (isCollapsed) {
					if (isAtEndOfBlock) {
						const newBlock = startText.parent.insertBlockAfter({
							block: {
								type: defaultBlock
							}
						});
						this.selection.setAtTextOffset(newBlock.firstText, newBlock?.firstText?.length);
					} else if (isAtStartOfBlock) {
						startText.parent?.insertBlockBefore({
							block: {
								type: defaultBlock
							}
						});
						this.selection.setAtTextOffset(startText, 0);
					} else {
						const newBlock = startText.parent?.splitBlock({ index: yStart, text: startText });

						newBlock && this.selection.setAtTextOffset(newBlock.firstText, 0);
					}
				}

				break;
			}
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			return error.cb?.();
		}
		throw error;
	}
}
