/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Edytor } from '$lib/edytor.svelte.js';
import { hasMarkAtSelection } from '$lib/operations/hasMark.js';
import { isHotkey } from 'is-hotkey';

export type HotKeys =
	| {
			[Keys in string]: (editor: Edytor) => void;
	  }
	| {
			[Keys in string]: Record<'toggleMark', string>;
	  }
	| {
			[Keys in string]: Record<'setType', string>;
	  };

export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	if (this.readonly) return;
	const isUndo = e.key === 'z' && (e.ctrlKey || e.metaKey);
	const isRedo = e.key === 'Z' && (e.ctrlKey || e.metaKey) && e.shiftKey;
	if (isUndo) {
		e.preventDefault();
		this.undoManager.undo();
	}
	if (isRedo) {
		e.preventDefault();
		this.undoManager.redo();
	}
	if (e.key === 'Tab') {
		e.preventDefault();
		e.stopPropagation();
		this.selection.state.startText?.parent.nest();
	}

	const isModifier = e.ctrlKey || e.metaKey;
	if (isModifier && this.hotKeys) {
		for (const key in this.hotKeys) {
			if (isHotkey(key, e)) {
				e.preventDefault();
				e.stopPropagation();
				const operation = this.hotKeys[key];
				if (typeof operation === 'function') {
					return operation(this);
				} else {
					const [[type, mark]] = Object.entries(operation);
					if (type === 'toggleMark') {
						const hasMark = hasMarkAtSelection(this.selection, mark);
						this.selection.yTextsInRanges.forEach((yText, index, array) => {
							const isFirst = index === 0;
							const isLast = index === array.length - 1;
							const isSolo = isFirst && isLast;

							if (isSolo) {
								yText.format(this.selection.yStartIndex, this.selection.length, {
									[mark]: !hasMark
								});

								// this.onSelectionChange();
							}
							// if(isFirst) {
							//     yText.format(0, this.selection.start, operation);
							// }
						});
					}
					// format text at range
				}
				break;
			}
		}
	}
}
