/**
 * Input attempts (R8, L6, O33, §4.3 `session/attempt`): one per user occurrence.
 *
 * An occurrence — a `beforeinput`, a keydown whose `beforeinput` never comes,
 * a paste, a drop, a line break found in the DOM — becomes one attempt whose
 * intent (one inputType → intent table, misreports overridden) and anchored
 * target (the selection value: anchors, never numbers) are fixed at
 * admission; the facts a command reads are projected from that target when
 * it runs.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdgeSide } from './editing/text.js';
import type { SelectionValue } from './selection.js';

type Kind = 'text' | 'composition' | 'payload' | 'break' | 'delete' | 'history';
export type IntentRow = {
	kind: Kind;
	/** The key a binding sees when no keydown offered it. */
	key?: string;
	/** A delete whose extent the model computes; a declared range only locates the caret edge. */
	dir?: 'back' | 'fwd';
};
const row = (kind: Kind, key?: string, dir?: IntentRow['dir']): IntentRow => ({ kind, key, dir });

/** The one inputType → intent table; everything downstream switches on its rows. */
export const INTENTS: Record<string, IntentRow | undefined> = {
	insertText: row('text'),
	insertReplacementText: row('text'),
	insertFromYank: row('text'),
	insertTranspose: row('text'),
	insertCompositionText: row('composition'),
	insertFromComposition: row('composition'),
	deleteCompositionText: row('composition'),
	insertFromPaste: row('payload'),
	insertFromPasteAsQuotation: row('payload'),
	insertFromDrop: row('payload'),
	insertParagraph: row('break', 'enter'),
	insertLineBreak: row('break', 'shift+enter'),
	deleteContentBackward: row('delete', 'backspace', 'back'),
	deleteContentForward: row('delete', 'delete', 'fwd'),
	deleteWordBackward: row('delete', undefined, 'back'),
	deleteSoftLineBackward: row('delete', undefined, 'back'),
	deleteHardLineBackward: row('delete', undefined, 'back'),
	deleteWordForward: row('delete', undefined, 'fwd'),
	deleteSoftLineForward: row('delete', undefined, 'fwd'),
	deleteHardLineForward: row('delete', undefined, 'fwd'),
	deleteByCut: row('delete'),
	deleteByDrag: row('delete'),
	deleteByComposition: row('delete'),
	deleteContent: row('delete'),
	deleteEntireSoftLine: row('delete'),
	historyUndo: row('history'),
	historyRedo: row('history')
};
export const kindOf = (inputType: string) => INTENTS[inputType]?.kind;

/**
 * The intent of a reported inputType (misreport overrides): a text insertion
 * of `\n`/`\r` is a line break/paragraph, and a line break the engine reports
 * for a key whose keydown announced another intent is that key's intent
 * (Android Backspace reported as `insertParagraph`).
 */
export const intentOf = (reported: string, data: string | null, keyIntent?: string) => {
	const newline = reported === 'insertText' && (data === '\n' || data === '\r');
	if (keyIntent && (newline || kindOf(reported) === 'break')) return keyIntent;
	if (newline) return data === '\n' ? 'insertLineBreak' : 'insertParagraph';
	return reported;
};

/** The target's facts a command reads, projected when the attempt runs. */
const facts = (edytor: Edytor) => {
	const { state } = edytor.selection;
	const { startText } = state;
	return {
		startText,
		endText: state.endText,
		texts: state.texts,
		yStart: state.yStart,
		yEnd: state.yEnd,
		/** The admitted mark-edge side of a caret (R4). */
		edge: state.edge as EdgeSide | undefined,
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

export type Occurrence = {
	/** The inputType the browser reported (or the key's intent). */
	inputType: string;
	data?: string | null;
	dataTransfer?: DataTransfer | null;
	/** The range the browser declared (`getTargetRanges()`, a drop point). */
	declared?: StaticRange | null;
	cancelable: boolean;
	event?: InputEvent;
};

export type Attempt = ReturnType<typeof facts> & {
	id: number;
	/** The intent, fixed at admission. */
	inputType: string;
	reported: string;
	event?: InputEvent;
	cancelable: boolean;
	data: string | null;
	dataTransfer: DataTransfer | null;
	hasDataTransferTextPayload: boolean;
	declared: StaticRange | null;
	/** Admitted from a keydown (the key's intent wins; the browser may never announce it). */
	isStructuralKeyFallback: boolean;
	/** The anchored target, fixed at admission. */
	target: SelectionValue;
};

/** A text intent with no `data` carries its text in the data transfer. */
const payloadOf = (inputType: string, data: string | null, dataTransfer?: DataTransfer | null) =>
	data === null && kindOf(inputType) === 'text'
		? dataTransfer?.getData('text/plain') || null
		: null;

let seq = 0;
/** An attempt for `occurrence` at the current selection. */
export const attemptOf = (edytor: Edytor, occurrence: Occurrence, keyIntent?: string): Attempt => {
	const data = occurrence.data ?? null;
	const payload = payloadOf(occurrence.inputType, data, occurrence.dataTransfer);
	return {
		...facts(edytor),
		id: ++seq,
		inputType: intentOf(occurrence.inputType, data, keyIntent),
		reported: occurrence.inputType,
		event: occurrence.event,
		cancelable: occurrence.cancelable,
		data: data ?? payload,
		dataTransfer: occurrence.dataTransfer ?? null,
		hasDataTransferTextPayload: payload !== null,
		declared: occurrence.declared ?? null,
		isStructuralKeyFallback: Boolean(keyIntent),
		target: edytor.selection.value
	};
};

/** A key binding's intent at the current selection: a command with no browser event. */
export const intentSnapshot = (edytor: Edytor, inputType: string) =>
	attemptOf(edytor, { inputType, cancelable: true });
