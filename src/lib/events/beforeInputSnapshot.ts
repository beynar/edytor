import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';

export type BeforeInputSnapshot = {
	event: InputEvent;
	inputType: InputEvent['inputType'];
	isStructuralKeyFallback: boolean;
	data: InputEvent['data'];
	dataTransfer: InputEvent['dataTransfer'];
	hasDataTransferTextPayload: boolean;
	startText: Text | null;
	endText: Text | null;
	texts: Text[];
	yStart: number;
	yEnd: number;
	length: number;
	isCollapsed: boolean;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	isAtStartOfBlock: boolean;
	isAtEndOfBlock: boolean;
	isAtStartOfText: boolean;
	isAtEndOfText: boolean;
	islandRoot: NonNullable<Edytor['selection']['state']['islandRoot']> | null;
	isVoidEditableElement: boolean;
	isFirstChildOfDocument: boolean;
	isNested: boolean;
	isLastChild: boolean;
};

const isNativeLineBreakTextInput = (event: InputEvent) =>
	event.inputType === 'insertText' && (event.data === '\n' || event.data === '\r');

export const getEffectiveBeforeInputType = (
	event: InputEvent,
	structuralKeyFallbackInputType: InputEvent['inputType'] | null
) => {
	if (
		structuralKeyFallbackInputType &&
		(isNativeLineBreakTextInput(event) ||
			event.inputType === 'insertParagraph' ||
			event.inputType === 'insertLineBreak')
	) {
		return structuralKeyFallbackInputType;
	}

	if (isNativeLineBreakTextInput(event)) {
		return event.data === '\n' ? 'insertLineBreak' : 'insertParagraph';
	}

	return event.inputType;
};

const getTextInsertionDataTransferPayload = (event: InputEvent) => {
	if (
		event.data !== null ||
		(event.inputType !== 'insertText' &&
			event.inputType !== 'insertReplacementText' &&
			event.inputType !== 'insertTranspose' &&
			event.inputType !== 'insertFromYank')
	) {
		return null;
	}

	const text = event.dataTransfer?.getData('text/plain') ?? '';
	return text.length > 0 ? text : null;
};

export const createBeforeInputSnapshot = (
	edytor: Edytor,
	event: InputEvent,
	structuralKeyFallbackInputType: InputEvent['inputType'] | null
): BeforeInputSnapshot => {
	const {
		yStart,
		length,
		isCollapsed,
		isTextSpanning,
		isAtStartOfBlock,
		isAtStartOfText,
		endText,
		isAtEndOfText,
		isBlockSpanning,
		startText,
		isAtEndOfBlock,
		yEnd,
		islandRoot,
		texts,
		isVoidEditableElement
	} = edytor.selection.state;
	const dataTransferTextPayload = getTextInsertionDataTransferPayload(event);

	return {
		event,
		inputType: getEffectiveBeforeInputType(event, structuralKeyFallbackInputType),
		isStructuralKeyFallback: Boolean(structuralKeyFallbackInputType),
		dataTransfer: event.dataTransfer,
		data: event.data ?? dataTransferTextPayload,
		hasDataTransferTextPayload: dataTransferTextPayload !== null,
		startText,
		endText,
		texts,
		yStart,
		yEnd,
		length,
		isCollapsed,
		isTextSpanning,
		isBlockSpanning,
		isAtStartOfBlock: Boolean(isAtStartOfBlock),
		isAtEndOfBlock: Boolean(isAtEndOfBlock),
		isAtStartOfText: Boolean(isAtStartOfText),
		isAtEndOfText: Boolean(isAtEndOfText),
		islandRoot,
		isVoidEditableElement,
		isFirstChildOfDocument: startText?.parent === edytor.root?.children.at(0),
		isNested: Boolean(startText && startText.parent.parent !== edytor.root),
		isLastChild: startText?.parent.parent?.children.at(-1) === startText?.parent
	};
};

export const isTabTextInput = (snapshot: BeforeInputSnapshot) =>
	snapshot.inputType === 'insertText' && snapshot.data === '\t';
