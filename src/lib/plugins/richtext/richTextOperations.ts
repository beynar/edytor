import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { SerializableContent } from '$lib/utils/json.js';

export type RichTextMark =
	| 'bold'
	| 'italic'
	| 'underline'
	| 'code'
	| 'link'
	| 'strike'
	| 'superscript'
	| 'subscript'
	| 'color'
	| 'highlight';

export type RichTextLink = {
	href: string;
	target?: string;
};

export const canConvertBlock = (block: Block | null | undefined): block is Block =>
	block !== null &&
	block !== undefined &&
	!block.isRoot &&
	!block.definition.void &&
	!block.definition.island &&
	!block.insideIsland;

const selectedRangeMutates = (edytor: Edytor) => {
	const { yStart, yEnd, texts } = edytor.selection.state;
	return texts.some((text, index) => {
		const isFirst = index === 0;
		const isLast = index === texts.length - 1;
		const start = isFirst ? yStart : 0;
		const end = isLast ? yEnd : text.yText.length;
		return end > start;
	});
};

const formatSelectedTextRange = (
	edytor: Edytor,
	mark: RichTextMark,
	value: SerializableContent | null | undefined,
	toggle: boolean
) => {
	const { yStart, yEnd, startText, endText, texts, isCollapsed, isReversed } =
		edytor.selection.state;
	if (isCollapsed || !startText || !endText) {
		return;
	}

	if (selectedRangeMutates(edytor)) {
		edytor.selection.queueNextUndoSelectionSnapshot();
	}
	edytor.undoManager.stopCapturing();
	texts.forEach((text, index) => {
		const isFirst = index === 0;
		const isLast = index === texts.length - 1;
		text.markText({
			mark,
			value,
			toggle,
			start: isFirst ? yStart : 0,
			end: isLast ? yEnd : text.yText.length
		});
	});
	edytor.selection.setRangeStateAtTextOffsets(startText, yStart, endText, yEnd, { isReversed });
	void edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed }).finally(() =>
		edytor.selection.setRangeStateAtTextOffsets(startText, yStart, endText, yEnd, {
			isReversed
		})
	);
};

const normalizeLink = (link: RichTextLink): Record<string, SerializableContent> => {
	const value: Record<string, SerializableContent> = { href: link.href };
	if (link.target) {
		value.target = link.target;
	}
	return value;
};

export const richTextOperations = (edytor: Edytor) => ({
	canConvertCurrentBlock: () => canConvertBlock(edytor.selection.state.startBlock),
	convertCurrentBlock: ({
		type,
		data = {},
		void: isVoid = false
	}: {
		type: string;
		data?: Record<string, SerializableContent>;
		void?: boolean;
	}) => {
		const block = edytor.selection.state.startBlock;
		if (!canConvertBlock(block)) {
			return null;
		}

		block.setBlock({
			value: isVoid ? { type, data, content: [], children: [] } : { type, data }
		});
		return block;
	},
	removeAllMarksAtRange: () => {
		const { yStart, yEnd, startText, endText, texts, isCollapsed, isReversed } =
			edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				startText.markOnNextInsert = {};
				edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}

		const mutatesSelectedRange = texts.some((text, index) => {
			const isFirst = index === 0;
			const isLast = index === texts.length - 1;
			const start = isFirst ? yStart : 0;
			const end = isLast ? yEnd : text.yText.length;
			return end > start;
		});
		if (mutatesSelectedRange) {
			edytor.selection.queueNextUndoSelectionSnapshot();
		}
		texts.forEach((text, index) => {
			const isFirst = index === 0;
			const isLast = index === texts.length - 1;
			const start = isFirst ? yStart : 0;
			const end = isLast ? yEnd : text.yText.length;
			if (end > start) {
				text.removeMarksFromText({ start, end });
			}
		});
		if (startText) {
			edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed });
		}
	},
	setLinkAtRange: (link: RichTextLink) => {
		formatSelectedTextRange(edytor, 'link', normalizeLink(link), false);
	},
	removeLinkAtRange: () => {
		formatSelectedTextRange(edytor, 'link', null, false);
	},
	setMarkAtRange: (mark: RichTextMark, value?: SerializableContent) => {
		const { yStart, yEnd, startText, endText, texts, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				edytor.undoManager.stopCapturing();
				startText.markText({
					mark,
					value,
					toggle: true,
					start: yStart,
					end: yEnd
				});
				edytor.selection.setAtRange(startText, yStart, endText, yEnd);
			}
			return;
		}

		formatSelectedTextRange(edytor, mark, value, true);
	}
});
