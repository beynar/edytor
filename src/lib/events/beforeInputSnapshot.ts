import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { EdgeSide } from '$lib/session/editing/text.js';

export type BeforeInputSnapshot = {
	/** The browser event; absent for an intent a key binding or an extension issues. */
	event?: InputEvent;
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
	/** The admitted mark-edge side of a caret (R4). */
	edge: EdgeSide | undefined;
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

/** A snapshot of a browser `beforeinput`. */
export type EventSnapshot = BeforeInputSnapshot & { event: InputEvent };

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

/** The selection facts every snapshot carries, read once. */
const selectionFacts = (edytor: Edytor) => {
	const { state } = edytor.selection;
	const { startText } = state;
	return {
		startText,
		endText: state.endText,
		texts: state.texts,
		yStart: state.yStart,
		yEnd: state.yEnd,
		edge: state.edge,
		length: state.length,
		isCollapsed: state.isCollapsed,
		isTextSpanning: state.isTextSpanning,
		isBlockSpanning: state.isBlockSpanning,
		isAtStartOfBlock: Boolean(state.isAtStartOfBlock),
		isAtEndOfBlock: Boolean(state.isAtEndOfBlock),
		isAtStartOfText: Boolean(state.isAtStartOfText),
		isAtEndOfText: Boolean(state.isAtEndOfText),
		islandRoot: state.islandRoot,
		isVoidEditableElement: state.isVoidEditableElement,
		isFirstChildOfDocument: startText?.parent === edytor.root?.children.at(0),
		isNested: Boolean(startText && startText.parent.parent !== edytor.root),
		isLastChild: startText?.parent.parent?.children.at(-1) === startText?.parent
	};
};

export const createBeforeInputSnapshot = (
	edytor: Edytor,
	event: InputEvent,
	structuralKeyFallbackInputType: InputEvent['inputType'] | null
): EventSnapshot => {
	const dataTransferTextPayload = getTextInsertionDataTransferPayload(event);
	return {
		...selectionFacts(edytor),
		event,
		inputType: getEffectiveBeforeInputType(event, structuralKeyFallbackInputType),
		isStructuralKeyFallback: Boolean(structuralKeyFallbackInputType),
		dataTransfer: event.dataTransfer,
		data: event.data ?? dataTransferTextPayload,
		hasDataTransferTextPayload: dataTransferTextPayload !== null
	};
};

/** An editing intent at the current selection, with no browser event (a key binding's command). */
export const intentSnapshot = (edytor: Edytor, inputType: string): BeforeInputSnapshot => ({
	...selectionFacts(edytor),
	inputType,
	isStructuralKeyFallback: false,
	dataTransfer: null,
	data: null,
	hasDataTransferTextPayload: false
});

export const isTabTextInput = (snapshot: BeforeInputSnapshot) =>
	snapshot.inputType === 'insertText' && snapshot.data === '\t';
