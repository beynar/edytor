/**
 * Input attempts: one per user occurrence.
 *
 * An occurrence — a `beforeinput`, a keydown whose `beforeinput` never comes,
 * a paste, a drop, a line break found in the DOM — becomes one attempt whose
 * intent (one inputType → intent table, misreports overridden), anchored
 * target (the selection value: anchors, never numbers) and owner (the model
 * performs it, or the browser does and the model adopts) are fixed at
 * admission. Its expectation and phase are replaceable: a browser-owned
 * attempt expects one change on its host; a model-owned one owns the DOM
 * drift around it until its deadline. Attempts queue until their expectation
 * is met, contradicted or out of time; an `input` is attributed to the
 * attempt whose expectation it satisfies.
 *
 * Deadlines are the named, counted browser rules: the
 * model-owned drift deadline (here), the missing-`beforeinput` deadline and
 * the Android no-op-Backspace deadline (`events/onBeforeInput`).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
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

/**
 * An occurrence with nowhere to act (Notion: typing with no caret does
 * nothing): a text, delete or line-break intent while the selection value is
 * `none` and the host holds no DOM caret a gesture placed
 * (`projector.placed`): none at all (an undo gave back no selection), or the
 * one the browser parked itself (the editor's own focus, `takeKeys`; a key
 * refused before; any key after a history step or a closing menu gave back
 * `none`). Its declared range is never a target then. A block or atom
 * selection is a target (typing replaces it). A composition's target is its
 * session's, fixed at its start (`composition.targetless`: refused there by
 * the same rule, `untargeted`; `projector.park` over a block selection).
 */
export const targetless = (edytor: Edytor, intent: string) => {
	const kind = kindOf(intent);
	if (kind === 'composition') return edytor.composition.targetless;
	return (kind === 'text' || kind === 'delete' || kind === 'break') && untargeted(edytor);
};

/** Nowhere to act: the selection value is `none` and no gesture placed the host's DOM caret. */
export const untargeted = (edytor: Edytor) =>
	edytor.selection.value.kind === 'none' && !edytor.ports.surface.placed();

/** The target's facts a command reads, projected when the attempt runs. */
const facts = (edytor: Edytor) => {
	const { state, projection } = edytor.selection;
	const { startText } = state;
	// Its block's place by id: no handle for every sibling (the root's on a long page).
	const at = startText && edytor.facade.positionOf(startText.parent.id);
	return {
		startText,
		endText: state.endText,
		texts: state.texts,
		yStart: state.yStart,
		yEnd: state.yEnd,
		/** The admitted mark-edge side of a caret. */
		edge: state.edge as EdgeSide | undefined,
		isCollapsed: state.isCollapsed,
		isTextSpanning: projection.isTextSpanning,
		isBlockSpanning: projection.isBlockSpanning,
		isAtStartOfBlock: projection.isAtStartOfBlock,
		isAtEndOfBlock: projection.isAtEndOfBlock,
		isAtStartOfText: projection.isAtStartOfText,
		isAtEndOfText: projection.isAtEndOfText,
		islandRoot: edytor.idToBlock.get(projection.islandRoot ?? '') ?? null,
		isVoidEditableElement: state.isVoidEditableElement,
		isFirstChildOfDocument: Boolean(at && at.parent === null && at.index === 0),
		isNested: Boolean(startText && startText.parent.parent !== edytor.root),
		isLastChild: Boolean(at && at.index === edytor.facade.childrenIds(at.parent).length - 1)
	};
};

/** How DOM drift around a model-owned attempt is handled: re-render, restore the caret, or also discard structure. */
export type Drift = 'refresh' | 'restore' | 'discard';
export type TextPoint = { text: Text; offset: number };
export type Expect =
	/** The model performs the attempt; DOM changes before its deadline are drift. */
	| { kind: 'drift'; mode: Drift; input: boolean; caret: TextPoint | null }
	/** The browser performs the attempt on `host` (`after`: the text it should leave, when known). */
	| { kind: 'change'; host: Text; after: string | null };

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
	owner: 'model' | 'browser';
	expect: Expect | null;
	phase: 'open' | 'applied' | 'failed' | 'closed';
};

/** A text intent with no `data` carries its text in the data transfer. */
const payloadOf = (inputType: string, data: string | null, dataTransfer?: DataTransfer | null) =>
	data === null && kindOf(inputType) === 'text'
		? dataTransfer?.getData('text/plain') || null
		: null;

let seq = 0;
/** An attempt for `occurrence` at the current selection (not yet queued). */
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
		target: edytor.selection.value,
		owner: 'model',
		expect: null,
		phase: 'open'
	};
};

/** A key binding's intent at the current selection: a command with no browser event. */
export const intentSnapshot = (edytor: Edytor, inputType: string) =>
	attemptOf(edytor, { inputType, cancelable: true });

/** A model-performed command's caret: selected now, and where drift repair puts it back. */
export const caretAt = (edytor: Edytor, text: Text | null | undefined, offset: number) => {
	if (!text) return;
	edytor.attempts.caret(text, offset);
	edytor.selection.setAtTextOffset(text, offset);
};

/** Re-project an attempt's anchored target when it runs later than its admission. */
export const reproject = (edytor: Edytor, attempt: Attempt) =>
	Object.assign(attempt, facts(edytor));

const compatible = (a: string, b: string) =>
	!a || a === b || (kindOf(a) === 'text' && kindOf(b) === 'text');

/** The per-view attempt queue and its model-owned drift deadline. */
export class Attempts {
	#queue: Attempt[] = [];
	#timers = new Map<Attempt, ReturnType<typeof setTimeout>>();
	/** The last attempt admitted. */
	last: Attempt | null = null;

	/** `closed`: an attempt closed (its deadline, a newer one): the observer compares again. */
	constructor(private closed: () => void = () => {}) {}

	/** Queue `attempt`; a model-owned one supersedes every live attempt, a browser-owned one the browser-owned ones. */
	admit = (attempt: Attempt, owner: Attempt['owner'], expect: Expect | null = null) => {
		for (const live of [...this.#queue])
			if (owner === 'model' || live.owner === 'browser') this.close(live);
		Object.assign(attempt, { owner, expect });
		this.#queue.push(attempt);
		this.last = attempt;
		return attempt;
	};

	/** The model owns the DOM drift around `attempt` for `ms` (the model-owned drift deadline). */
	drift = (attempt: Attempt, mode: Drift, ms: number) => {
		attempt.expect = { kind: 'drift', mode, input: true, caret: null };
		this.arm(attempt, ms);
	};

	/** (Re)arm `attempt`'s deadline: it closes `ms` from now. */
	arm = (attempt: Attempt, ms: number) => {
		clearTimeout(this.#timers.get(attempt));
		if (!this.#queue.includes(attempt)) return;
		this.#timers.set(
			attempt,
			setTimeout(() => this.close(attempt), ms)
		);
	};

	close = (attempt: Attempt) => {
		clearTimeout(this.#timers.get(attempt));
		this.#timers.delete(attempt);
		this.#queue = this.#queue.filter((a) => a !== attempt);
		if (attempt.phase === 'open') attempt.phase = 'closed';
		this.closed();
	};

	/** Close every attempt the predicate selects (all by default). */
	clear = (which: (attempt: Attempt) => boolean = () => true) => {
		for (const attempt of [...this.#queue]) if (which(attempt)) this.close(attempt);
	};

	/** The keydown attempt still waiting for its `beforeinput` or its deadline. */
	get key() {
		return this.#queue.find((a) => a.isStructuralKeyFallback && a.phase === 'open') ?? null;
	}

	/** A `beforeinput` confirms the keydown's attempt: the same occurrence, now announced. */
	confirm = () => {
		const key = this.key;
		if (key) this.close(key);
		return key;
	};

	/** The attempt an `input` of `inputType` belongs to: the newest whose expectation it satisfies. */
	inputOf = (inputType: string) =>
		this.#queue.findLast(({ expect, reported }) =>
			expect?.kind === 'drift'
				? expect.input
				: expect?.kind === 'change' && compatible(inputType, reported)
		) ?? null;

	/** A model-owned attempt's drift is live on `host`. */
	drifting = (host: Text) =>
		this.#queue.some((a) => a.expect?.kind === 'drift' && a.startText === host);

	/** The caret a command leaves: where drift repair puts it. */
	caret = (text: Text, offset: number) => {
		const expect = this.#queue.findLast((a) => a.expect?.kind === 'drift')?.expect;
		if (expect?.kind === 'drift') expect.caret = { text, offset };
	};

	/** The open browser-owned attempt whose change is expected on `host`: its adoption owns it. */
	on = (host: Text) =>
		this.#queue.findLast(
			(a) => a.expect?.kind === 'change' && a.expect.host === host && a.phase === 'open'
		) ?? null;

	/** Any model-owned attempt is live (quiescence probes). */
	get busy() {
		return this.#queue.some((a) => a.expect?.kind === 'drift');
	}
}
