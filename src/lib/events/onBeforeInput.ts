import type { Edytor } from '$lib/hooks/useEdytor.svelte.js';
import { unNest } from '$lib/operations/nest.js';
import { split } from '$lib/operations/split.js';
import { recursivelyDeleteText } from '$lib/utils/delete.js';
import { getId } from '$lib/utils/getId.js';
import { setCursorAtPosition } from '$lib/utils/setCursor.js';
import { tick } from 'svelte';

export async function onBeforeInput(this: Edytor, e: InputEvent) {
	e.preventDefault?.();
	const yText = this.selection.yStartElement;
	const {
		start,
		insideMark,
		startNode,
		isCollapsed,
		yStartIndex,
		isAtStart,
		length = 1,
		startLeaf
	} = this.selection;
	const { inputType, dataTransfer, data } = e;
	switch (inputType) {
		case 'deleteContentBackward': {
			const willBeEmpty = (yText?.length || Infinity) - length === 0;

			if (isCollapsed && isAtStart) {
				unNest(yText!, this);
			} else {
				if (willBeEmpty) {
					if (yText) {
						this.doc.transact(() => {
							yText?.delete(isCollapsed ? yStartIndex - 1 : yStartIndex, length || 1);
							recursivelyDeleteText(yText);
						});
					}
				} else {
					yText?.delete(isCollapsed ? yStartIndex - 1 : yStartIndex, length || 1);
				}
				tick().then(() => {
					console.log(yText?.toJSON());
				});

				this.selection.start = isCollapsed ? start - 1 : start;
				this.selection.end = isCollapsed ? start - 1 : start;
			}
			break;
		}
		case 'insertFromPaste':
		case 'insertLineBreak':
		case 'insertText': {
			const text =
				inputType === 'insertLineBreak'
					? '\n'
					: inputType === 'insertFromPaste'
						? (dataTransfer!.getData('text/plain') as string)
						: (data as string);

			const isDot = text === '. ';
			this.doc.transact(() => {
				if (isDot && this.lastInsert === ' ') {
					yText?.delete(yStartIndex - 1, 1);
				}
				yText?.insert(yStartIndex, text);
				startNode.textContent = yText.toString();
			});

			this.lastInsert = text;
			console.log({ isAtStart });
			// this.selection.start += text.length - (isDot ? 1 : 0);
			if (isAtStart) {
				tick().then(() => {
					const newNode = startLeaf.firstChild;
					if (newNode?.textContent?.length === data?.length) {
						(startNode as Node).textContent = 'hello';
						setCursorAtPosition(getId(yText), data?.length);
					} else {
						return this.moveCursor(text.length);
					}
				});
			} else {
				return this.moveCursor(text.length);
			}

			break;
		}
		case 'insertParagraph': {
			split(yText!, yStartIndex);
			break;
		}
	}

	// this.setSelection({
	// 	clearSelection,
	// 	yText
	// });
}
