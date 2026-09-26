import type { Edytor } from '../edytor.svelte.js';
import type { HotKey, HotKeyCombination } from '../hotkeys.js';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import { Text } from '../text/text.svelte.js';
import { compareBlockPath } from '../block/blockPath.js';
import { clearDomSelection } from '../selection/domSelection.js';
import { getNextGraphemeEnd, getPreviousGraphemeStart } from '../text/text.utils.js';
import { getNextWordEndOffset, getPreviousWordStartOffset } from '../events/wordBoundary.js';

type TextPosition = {
	text: Text;
	offset: number;
};

export const moveToCurrentBlockBoundary = (
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
	edytor.selection.selectInlineBlock(inlineBlock);
	edytor.selection.ignoreNextSelectionChange = true;
	clearDomSelection(edytor.node);
};

const collapseToTextPosition = (edytor: Edytor, text: Text, offset: number) => {
	edytor.selection.clearInlineBlockSelection();
	edytor.selection.setCollapsedStateAtTextOffset(text, offset);
	void edytor.selection.setAtTextOffset(text, offset);
};

const extendToTextPosition = (
	edytor: Edytor,
	anchorText: Text,
	anchorOffset: number,
	focusText: Text,
	focusOffset: number,
	direction: 'backward' | 'forward'
) => {
	if (direction === 'backward') {
		edytor.selection.setRangeStateAtTextOffsets(focusText, focusOffset, anchorText, anchorOffset, {
			isReversed: true
		});
		void edytor.selection.setAtRange(focusText, focusOffset, anchorText, anchorOffset, {
			isReversed: true
		});
		return;
	}

	edytor.selection.setRangeStateAtTextOffsets(anchorText, anchorOffset, focusText, focusOffset, {
		isReversed: false
	});
	void edytor.selection.setAtRange(anchorText, anchorOffset, focusText, focusOffset, {
		isReversed: false
	});
};

const getAdjacentEditableText = (text: Text, direction: 'backward' | 'forward') => {
	let block =
		direction === 'backward' ? text.parent.closestPreviousBlock : text.parent.closestNextBlock;

	while (block) {
		const editableText =
			direction === 'backward' ? block.lastEditableText : block.firstEditableText;
		if (editableText && editableText !== text) {
			return editableText;
		}
		block = direction === 'backward' ? block.closestPreviousBlock : block.closestNextBlock;
	}

	return null;
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

const moveAcrossHorizontalBoundary = (
	edytor: Edytor,
	resolveDirection: (text: Text) => 'backward' | 'forward',
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

		const direction = resolveDirection(directionText);
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

	const direction = resolveDirection(startText);
	const content = startText.parent.content;
	const index = content.indexOf(startText);
	if (index === -1) {
		return false;
	}

	if (direction === 'forward') {
		const inlineBlock = content[index + 1];
		const nextText = content[index + 2];
		if (yStart !== startText.length) {
			return false;
		}

		if (inlineBlock instanceof InlineBlock) {
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

		if (index !== content.length - 1) {
			return false;
		}

		const adjacentText = getAdjacentEditableText(startText, direction);
		if (!adjacentText) {
			return false;
		}

		if (extendSelection) {
			extendToTextPosition(edytor, startText, yStart, adjacentText, 0, direction);
		} else {
			collapseToTextPosition(edytor, adjacentText, 0);
		}
		return true;
	}

	const inlineBlock = content[index - 1];
	const previousText = content[index - 2];
	if (yStart !== 0) {
		return false;
	}

	if (inlineBlock instanceof InlineBlock) {
		if (extendSelection) {
			selectInlineBlock(edytor, inlineBlock);
			return true;
		}

		if (previousText instanceof Text) {
			collapseToTextPosition(edytor, previousText, previousText.length);
			return true;
		}
		return false;
	}

	if (index !== 0) {
		return false;
	}

	const adjacentText = getAdjacentEditableText(startText, direction);
	if (!adjacentText) {
		return false;
	}

	if (extendSelection) {
		extendToTextPosition(edytor, startText, yStart, adjacentText, adjacentText.length, direction);
	} else {
		collapseToTextPosition(edytor, adjacentText, adjacentText.length);
	}
	return true;
};

const moveByWord = (
	edytor: Edytor,
	direction: 'backward' | 'forward',
	extendSelection: boolean
) => {
	const { startText, endText, yStart, yEnd, isCollapsed, isReversed } = edytor.selection.state;
	// The moving edge is the selection's focus — the start for a reversed
	// (right-to-left) selection, the end otherwise — the same rule
	// `moveNodeSelectionHorizontally` applies below.
	const focusText = isReversed ? startText : (endText ?? startText);
	const focusOffset = isReversed ? yStart : yEnd;
	const anchorText = isReversed ? (endText ?? startText) : startText;
	const anchorOffset = isReversed ? yEnd : yStart;
	if (!focusText || !anchorText) {
		return;
	}

	if (!extendSelection && !isCollapsed) {
		// A non-extending word jump off a range collapses onto the
		// document-order edge the direction points at.
		const edgeText = direction === 'backward' ? startText : (endText ?? startText);
		const edgeOffset = direction === 'backward' ? yStart : yEnd;
		if (!edgeText) {
			return;
		}
		void edytor.selection.setAtTextOffset(edgeText, edgeOffset);
		return;
	}

	const nextPosition =
		direction === 'backward'
			? getPreviousWordPosition(focusText, focusOffset)
			: getNextWordPosition(focusText, focusOffset);
	if (!nextPosition) {
		return;
	}

	if (!extendSelection) {
		void edytor.selection.setAtTextOffset(nextPosition.text, nextPosition.offset);
		return;
	}

	const inlineBlock = getInlineBlockBetweenBoundaryPositions(
		focusText,
		focusOffset,
		nextPosition.text,
		nextPosition.offset
	);
	if (inlineBlock) {
		selectInlineBlock(edytor, inlineBlock);
		return;
	}

	// Pass the endpoints in document order so `isReversed` reports the
	// selection's final direction regardless of which side the anchor is on.
	const nextReversed =
		compareTextPositions(anchorText, anchorOffset, nextPosition.text, nextPosition.offset) > 0;
	const [rangeStartText, rangeStartOffset, rangeEndText, rangeEndOffset]: [
		Text,
		number,
		Text,
		number
	] = nextReversed
		? [nextPosition.text, nextPosition.offset, anchorText, anchorOffset]
		: [anchorText, anchorOffset, nextPosition.text, nextPosition.offset];
	edytor.selection.setRangeStateAtTextOffsets(
		rangeStartText,
		rangeStartOffset,
		rangeEndText,
		rangeEndOffset,
		{ isReversed: nextReversed }
	);
	void edytor.selection.setAtRange(rangeStartText, rangeStartOffset, rangeEndText, rangeEndOffset, {
		isReversed: nextReversed
	});
};

/**
 * One horizontal step from `(text, offset)` in the logical direction:
 * a grapheme boundary inside the text when there is room, otherwise the
 * neighbouring text's edge — crossing inline atoms in the block's
 * content and falling back to the adjacent block's editable text.
 */
const getHorizontalExtendDestination = (
	text: Text,
	offset: number,
	direction: 'backward' | 'forward'
): TextPosition | null => {
	if (direction === 'backward' ? offset > 0 : offset < text.length) {
		const value = text.stringContent;
		return {
			text,
			offset:
				direction === 'backward'
					? getPreviousGraphemeStart(value, offset)
					: getNextGraphemeEnd(value, offset)
		};
	}

	const content = text.parent.content;
	const step = direction === 'backward' ? -1 : 1;
	const startIndex = content.indexOf(text);
	if (startIndex !== -1) {
		for (let index = startIndex + step; index >= 0 && index < content.length; index += step) {
			const part = content[index];
			if (part instanceof Text) {
				return { text: part, offset: direction === 'backward' ? part.length : 0 };
			}
		}
	}

	const adjacent = getAdjacentEditableText(text, direction);
	return adjacent
		? { text: adjacent, offset: direction === 'backward' ? adjacent.length : 0 }
		: null;
};

const compareTextPositions = (aText: Text, aOffset: number, bText: Text, bOffset: number) =>
	aText === bText
		? aOffset - bOffset
		: aText.parent === bText.parent
			? aText.index - bText.index
			: compareBlockPath(aText.parent, bText.parent);

/**
 * Deterministic Shift+ArrowLeft/ArrowRight extension for node-bound
 * selections — ranges whose native endpoints sit outside text elements
 * (a block node selection, a stray boundary node). Native horizontal
 * extension of those is engine-defined: Blink can no-op, WebKit flips
 * the range direction, Gecko may land the focus on a stray position.
 * The editor owns that case only — plain text-point ranges keep native
 * char-wise behavior — and applies the standard rule: the focus edge
 * moves one grapheme step in the arrow's logical direction while the
 * anchor stays put. When the focus edge cannot move further the
 * selection collapses onto it.
 */
const moveNodeSelectionHorizontally = (edytor: Edytor, key: 'ArrowLeft' | 'ArrowRight') => {
	const { startText, endText, yStart, yEnd, isReversed } = edytor.selection.state;
	if (
		!startText ||
		!endText ||
		edytor.selection.selectedBlocks.size > 0 ||
		edytor.selection.selectedInlineBlock.size > 0 ||
		!edytor.selection.hasNativeNodeSelection()
	) {
		return false;
	}

	const focusText = isReversed ? startText : endText;
	const focusOffset = isReversed ? yStart : yEnd;
	const anchorText = isReversed ? endText : startText;
	const anchorOffset = isReversed ? yEnd : yStart;
	const direction = getVisualHorizontalDirection(focusText, key);
	let destination = getHorizontalExtendDestination(focusText, focusOffset, direction);
	// A forward destination at the next block's firstText@0 canonicalizes
	// straight back onto the current end edge — applySelectionSnapshot
	// maps an end at a block's first text offset 0 to the previous
	// block's lastText end — leaving the model selection unchanged. Land
	// on the first grapheme boundary inside that text instead (walking
	// past empty boundary texts) so the extension is a real move.
	while (
		destination &&
		destination.offset === 0 &&
		destination.text === destination.text.parent.firstText &&
		destination.text.parent !== anchorText.parent &&
		compareTextPositions(anchorText, anchorOffset, destination.text, destination.offset) < 0
	) {
		const graphemeEnd = getNextGraphemeEnd(destination.text.stringContent, 0);
		if (graphemeEnd > 0) {
			destination = { text: destination.text, offset: graphemeEnd };
			break;
		}
		destination = getHorizontalExtendDestination(destination.text, 0, 'forward');
	}
	if (!destination) {
		collapseToTextPosition(edytor, focusText, focusOffset);
		return true;
	}
	const nextReversed =
		compareTextPositions(anchorText, anchorOffset, destination.text, destination.offset) > 0;
	edytor.selection.setRangeStateAtTextOffsets(
		anchorText,
		anchorOffset,
		destination.text,
		destination.offset,
		{ isReversed: nextReversed }
	);
	void edytor.selection.setAtRange(anchorText, anchorOffset, destination.text, destination.offset, {
		isReversed: nextReversed
	});
	return true;
};

const shouldUseAltWordNavigation = (edytor: Edytor) => edytor.hotKeys.isMac;
const shouldUseModWordNavigation = (edytor: Edytor) => !edytor.hotKeys.isMac;

const arrowKeyDirection = (event: KeyboardEvent) => (text: Text) =>
	getVisualHorizontalDirection(text, event.key as 'ArrowLeft' | 'ArrowRight');

/**
 * Logical (non-visual) one-step caret boundary crossing — used by the
 * macOS Emacs ctrl+b/ctrl+f bindings, which move in document order
 * regardless of text direction.
 */
export const moveCaretAcrossHorizontalBoundary = (
	edytor: Edytor,
	direction: 'backward' | 'forward',
	extendSelection: boolean
) => moveAcrossHorizontalBoundary(edytor, () => direction, extendSelection);

export const navigationHotKeys = {
	arrowleft: ({ event, edytor, prevent }) => {
		if (moveAcrossHorizontalBoundary(edytor, arrowKeyDirection(event), false)) {
			prevent();
		}
	},
	arrowright: ({ event, edytor, prevent }) => {
		if (moveAcrossHorizontalBoundary(edytor, arrowKeyDirection(event), false)) {
			prevent();
		}
	},
	'shift+arrowleft': ({ event, edytor, prevent }) => {
		if (moveAcrossHorizontalBoundary(edytor, arrowKeyDirection(event), true)) {
			prevent();
			return;
		}
		if (moveNodeSelectionHorizontally(edytor, event.key as 'ArrowLeft')) {
			prevent();
		}
	},
	'shift+arrowright': ({ event, edytor, prevent }) => {
		if (moveAcrossHorizontalBoundary(edytor, arrowKeyDirection(event), true)) {
			prevent();
			return;
		}
		if (moveNodeSelectionHorizontally(edytor, event.key as 'ArrowRight')) {
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
