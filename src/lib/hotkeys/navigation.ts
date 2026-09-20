import type { Edytor } from '../edytor.svelte.js';
import type { HotKey, HotKeyCombination } from '../hotkeys.js';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import { Text } from '../text/text.svelte.js';
import { clearDomSelection } from '../selection/domSelection.js';

type TextPosition = {
	text: Text;
	offset: number;
};

const moveToCurrentBlockBoundary = (
	edytor: Edytor,
	boundary: 'start' | 'end',
	extendSelection: boolean
) => {
	const { startBlock, startText, yStart } = edytor.selection.state;
	if (!startBlock || !startText) {
		return;
	}

	const boundaryText =
		boundary === 'start'
			? (startBlock.firstEditableText ?? startBlock.firstText)
			: (startBlock.lastEditableText ?? startBlock.lastText);
	const boundaryOffset = boundary === 'start' ? 0 : boundaryText.length;

	if (!extendSelection) {
		void edytor.selection.setAtTextOffset(boundaryText, boundaryOffset);
		return;
	}

	if (boundary === 'start') {
		void edytor.selection.setAtRange(boundaryText, boundaryOffset, startText, yStart);
		return;
	}

	void edytor.selection.setAtRange(startText, yStart, boundaryText, boundaryOffset);
};

const moveToDocumentBoundary = (
	edytor: Edytor,
	boundary: 'start' | 'end',
	extendSelection: boolean
) => {
	const { root } = edytor;
	const { startText, yStart } = edytor.selection.state;
	if (!root || !startText) {
		return;
	}

	const boundaryText =
		boundary === 'start'
			? (root.firstEditableText ?? root.firstText)
			: (root.lastEditableText ?? root.lastText);
	if (!boundaryText) {
		return;
	}

	const boundaryOffset = boundary === 'start' ? 0 : boundaryText.length;

	if (!extendSelection) {
		void edytor.selection.setAtTextOffset(boundaryText, boundaryOffset);
		return;
	}

	if (boundary === 'start') {
		void edytor.selection.setAtRange(boundaryText, boundaryOffset, startText, yStart);
		return;
	}

	void edytor.selection.setAtRange(startText, yStart, boundaryText, boundaryOffset);
};

const getCharacters = (value: string) => {
	let index = 0;
	return Array.from(value).map((character) => {
		const start = index;
		index += character.length;
		return {
			character,
			start,
			end: index
		};
	});
};

const isWordCharacter = (character: string) => /[\p{L}\p{N}_]/u.test(character);

const getPreviousWordStartOffset = (value: string, offset: number) => {
	const characters = getCharacters(value).filter((character) => character.end <= offset);
	let index = characters.length - 1;

	while (index >= 0 && !isWordCharacter(characters[index].character)) {
		index--;
	}
	if (index < 0) {
		return offset;
	}

	while (index > 0 && isWordCharacter(characters[index - 1].character)) {
		index--;
	}

	return characters[index].start;
};

const getNextWordEndOffset = (value: string, offset: number) => {
	const characters = getCharacters(value).filter((character) => character.start >= offset);
	let index = 0;

	while (index < characters.length && !isWordCharacter(characters[index].character)) {
		index++;
	}
	if (index >= characters.length) {
		return offset;
	}

	while (index + 1 < characters.length && isWordCharacter(characters[index + 1].character)) {
		index++;
	}

	return characters[index].end;
};

const getPreviousWordPosition = (text: Text, offset: number): TextPosition | null => {
	if (offset > 0) {
		const wordOffset = getPreviousWordStartOffset(text.stringContent, offset);
		if (wordOffset !== offset) {
			return { text, offset: wordOffset };
		}
	}

	const index = text.parent.content.indexOf(text);
	const previousPart = text.parent.content[index - 1];
	if (previousPart instanceof InlineBlock) {
		const previousText = text.parent.content[index - 2];
		return previousText instanceof Text
			? { text: previousText, offset: previousText.length }
			: null;
	}

	if (previousPart instanceof Text) {
		return {
			text: previousPart,
			offset: getPreviousWordStartOffset(previousPart.stringContent, previousPart.length)
		};
	}

	const previousBlock = text.parent.closestPreviousBlock;
	const previousText = previousBlock?.lastEditableText ?? previousBlock?.lastText;
	return previousText ? { text: previousText, offset: previousText.length } : null;
};

const getNextWordPosition = (text: Text, offset: number): TextPosition | null => {
	if (offset < text.length) {
		const wordOffset = getNextWordEndOffset(text.stringContent, offset);
		if (wordOffset !== offset) {
			return { text, offset: wordOffset };
		}
	}

	const index = text.parent.content.indexOf(text);
	const nextPart = text.parent.content[index + 1];
	if (nextPart instanceof InlineBlock) {
		const nextText = text.parent.content[index + 2];
		return nextText instanceof Text ? { text: nextText, offset: 0 } : null;
	}

	if (nextPart instanceof Text) {
		return {
			text: nextPart,
			offset: getNextWordEndOffset(nextPart.stringContent, 0)
		};
	}

	const nextBlock = text.parent.closestNextBlock;
	const nextText = nextBlock?.firstEditableText ?? nextBlock?.firstText;
	return nextText ? { text: nextText, offset: 0 } : null;
};

const getInlineBlockBetweenBoundaryPositions = (
	firstText: Text,
	firstOffset: number,
	secondText: Text,
	secondOffset: number
) => {
	if (firstText.parent !== secondText.parent) {
		return null;
	}

	const content = firstText.parent.content;
	const firstIndex = content.indexOf(firstText);
	const secondIndex = content.indexOf(secondText);
	if (firstIndex === -1 || secondIndex === -1 || firstIndex === secondIndex) {
		return null;
	}

	const [beforeText, beforeOffset, beforeIndex, afterText, afterOffset, afterIndex] =
		firstIndex < secondIndex
			? [firstText, firstOffset, firstIndex, secondText, secondOffset, secondIndex]
			: [secondText, secondOffset, secondIndex, firstText, firstOffset, firstIndex];
	if (beforeOffset !== beforeText.length || afterOffset !== 0) {
		return null;
	}

	const selectedParts = content.slice(beforeIndex + 1, afterIndex);
	return selectedParts.length === 1 && selectedParts[0] instanceof InlineBlock
		? selectedParts[0]
		: null;
};

const selectInlineBlock = (edytor: Edytor, inlineBlock: InlineBlock) => {
	edytor.selection.selectedInlineBlock.clear();
	edytor.selection.selectedInlineBlock.add(inlineBlock);
	edytor.selection.inlineBlockDeletionTarget = inlineBlock;
	edytor.selection.ignoreNextSelectionChange = true;
	clearDomSelection(edytor.node);
};

const collapseToTextPosition = (edytor: Edytor, text: Text, offset: number) => {
	edytor.selection.clearInlineBlockSelection();
	edytor.selection.setCollapsedStateAtTextOffset(text, offset);
	void edytor.selection.setAtTextOffset(text, offset);
};

const getTextDirection = (text: Text) => {
	if (typeof window === 'undefined' || !text.node?.isConnected) {
		return 'ltr';
	}

	return window.getComputedStyle(text.node).direction === 'rtl' ? 'rtl' : 'ltr';
};

const getVisualHorizontalDirection = (
	text: Text,
	key: 'ArrowLeft' | 'ArrowRight'
): 'backward' | 'forward' => {
	const isRtl = getTextDirection(text) === 'rtl';
	if (key === 'ArrowLeft') {
		return isRtl ? 'forward' : 'backward';
	}

	return isRtl ? 'backward' : 'forward';
};

const moveAcrossInlineBoundary = (
	edytor: Edytor,
	key: 'ArrowLeft' | 'ArrowRight',
	extendSelection: boolean
) => {
	const selectedInlineBlock =
		edytor.selection.selectedInlineBlock.values().next().value ??
		edytor.selection.inlineBlockDeletionTarget;
	if (!extendSelection && selectedInlineBlock) {
		const content = selectedInlineBlock.parent.content;
		const index = content.indexOf(selectedInlineBlock);
		const previousText = content[index - 1];
		const nextText = content[index + 1];
		let directionText: Text | null = null;
		if (previousText instanceof Text) {
			directionText = previousText;
		} else if (nextText instanceof Text) {
			directionText = nextText;
		}

		if (index === -1 || !directionText) {
			edytor.selection.clearInlineBlockSelection();
			return true;
		}

		const direction = getVisualHorizontalDirection(directionText, key);
		if (direction === 'backward' && previousText instanceof Text) {
			collapseToTextPosition(edytor, previousText, previousText.length);
			return true;
		}

		if (direction === 'forward' && nextText instanceof Text) {
			collapseToTextPosition(edytor, nextText, 0);
			return true;
		}
	}

	const { startText, yStart, isCollapsed } = edytor.selection.state;
	if (!startText || !isCollapsed) {
		return false;
	}

	const direction = getVisualHorizontalDirection(startText, key);
	const content = startText.parent.content;
	const index = content.indexOf(startText);
	if (index === -1) {
		return false;
	}

	if (direction === 'forward') {
		const inlineBlock = content[index + 1];
		const nextText = content[index + 2];
		if (yStart !== startText.length || !(inlineBlock instanceof InlineBlock)) {
			return false;
		}

		if (extendSelection) {
			selectInlineBlock(edytor, inlineBlock);
			return true;
		}

		if (nextText instanceof Text) {
			collapseToTextPosition(edytor, nextText, 0);
			return true;
		}
		return false;
	}

	const inlineBlock = content[index - 1];
	const previousText = content[index - 2];
	if (yStart !== 0 || !(inlineBlock instanceof InlineBlock)) {
		return false;
	}

	if (extendSelection) {
		selectInlineBlock(edytor, inlineBlock);
		return true;
	}

	if (previousText instanceof Text) {
		collapseToTextPosition(edytor, previousText, previousText.length);
		return true;
	}
	return false;
};

const moveByWord = (
	edytor: Edytor,
	direction: 'backward' | 'forward',
	extendSelection: boolean
) => {
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	const activeText = direction === 'backward' ? startText : (endText ?? startText);
	const activeOffset = direction === 'backward' ? yStart : yEnd;
	if (!activeText) {
		return;
	}

	if (!extendSelection && !isCollapsed) {
		void edytor.selection.setAtTextOffset(activeText, activeOffset);
		return;
	}

	const nextPosition =
		direction === 'backward'
			? getPreviousWordPosition(activeText, activeOffset)
			: getNextWordPosition(activeText, activeOffset);
	if (!nextPosition) {
		return;
	}

	if (!extendSelection) {
		void edytor.selection.setAtTextOffset(nextPosition.text, nextPosition.offset);
		return;
	}

	const inlineBlock = getInlineBlockBetweenBoundaryPositions(
		activeText,
		activeOffset,
		nextPosition.text,
		nextPosition.offset
	);
	if (inlineBlock) {
		selectInlineBlock(edytor, inlineBlock);
		return;
	}

	if (direction === 'backward') {
		void edytor.selection.setAtRange(
			nextPosition.text,
			nextPosition.offset,
			activeText,
			activeOffset
		);
		return;
	}

	void edytor.selection.setAtRange(
		activeText,
		activeOffset,
		nextPosition.text,
		nextPosition.offset
	);
};

const shouldUseAltWordNavigation = (edytor: Edytor) => edytor.hotKeys.isMac;
const shouldUseModWordNavigation = (edytor: Edytor) => !edytor.hotKeys.isMac;

export const navigationHotKeys = {
	arrowleft: ({ event, edytor, prevent }) => {
		if (moveAcrossInlineBoundary(edytor, event.key as 'ArrowLeft', false)) {
			prevent();
		}
	},
	arrowright: ({ event, edytor, prevent }) => {
		if (moveAcrossInlineBoundary(edytor, event.key as 'ArrowRight', false)) {
			prevent();
		}
	},
	'shift+arrowleft': ({ event, edytor, prevent }) => {
		if (moveAcrossInlineBoundary(edytor, event.key as 'ArrowLeft', true)) {
			prevent();
		}
	},
	'shift+arrowright': ({ event, edytor, prevent }) => {
		if (moveAcrossInlineBoundary(edytor, event.key as 'ArrowRight', true)) {
			prevent();
		}
	},
	home: ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'start', false));
		}
	},
	end: ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'end', false));
		}
	},
	'shift+home': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'start', true));
		}
	},
	'shift+end': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToCurrentBlockBoundary(edytor, 'end', true));
		}
	},
	pageup: ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'start', false));
		}
	},
	pagedown: ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'end', false));
		}
	},
	'shift+pageup': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'start', true));
		}
	},
	'shift+pagedown': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'end', true));
		}
	},
	'mod+arrowup': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'start', false));
		}
	},
	'mod+arrowdown': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'end', false));
		}
	},
	'mod+shift+arrowup': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'start', true));
		}
	},
	'mod+shift+arrowdown': ({ edytor, prevent }) => {
		if (edytor.selection.state.startText) {
			prevent(() => moveToDocumentBoundary(edytor, 'end', true));
		}
	},
	'alt+arrowleft': ({ edytor, prevent }) => {
		if (shouldUseAltWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'backward', false));
		}
	},
	'alt+arrowright': ({ edytor, prevent }) => {
		if (shouldUseAltWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'forward', false));
		}
	},
	'alt+shift+arrowleft': ({ edytor, prevent }) => {
		if (shouldUseAltWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'backward', true));
		}
	},
	'alt+shift+arrowright': ({ edytor, prevent }) => {
		if (shouldUseAltWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'forward', true));
		}
	},
	'mod+arrowleft': ({ edytor, prevent }) => {
		if (shouldUseModWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'backward', false));
		}
	},
	'mod+arrowright': ({ edytor, prevent }) => {
		if (shouldUseModWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'forward', false));
		}
	},
	'mod+shift+arrowleft': ({ edytor, prevent }) => {
		if (shouldUseModWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'backward', true));
		}
	},
	'mod+shift+arrowright': ({ edytor, prevent }) => {
		if (shouldUseModWordNavigation(edytor) && edytor.selection.state.startText) {
			prevent(() => moveByWord(edytor, 'forward', true));
		}
	}
} satisfies Partial<Record<HotKeyCombination, HotKey>>;
