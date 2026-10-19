/**
 * Suggestions (site `editor/suggestions`): content proposed at a position —
 * AI output, a completion, a collaborator's edit to review — in one list,
 * each one view-local or shared (`shared`).
 *
 * - **View-local** (the default): shown only in this view until accepted.
 *   Session state: nothing reaches the document, its history, presence,
 *   `onChange` or another view before `accept()`, one command
 *   (`acceptSuggestion`: admission, hooks, one transaction, one undo step)
 *   placing the content as a paste places it (`flow.place`, `flow.slot`,
 *   `flow.inline`). Anchored by block ids (a text range by its anchors): it
 *   survives selection changes and edits elsewhere, and is dropped when its
 *   block dies.
 * - **Shared** (`crdt/doc/suggest.ts`, `sugg.*`): in the document, so every
 *   replica sees it and its author is known. A view suggests while
 *   `suggesting` is set: its writes go to its open suggestion (`written`,
 *   from `Dispatcher.write`), continued while they touch its last block or
 *   a neighbour, a new one elsewhere; a move is refused and announced. An
 *   app's `add(…, { shared: true })` writes its content live as it streams,
 *   one suggestion of its own (`via: 'ai'`). Accepting and rejecting are
 *   one command each (`acceptSuggestion`, `rejectSuggestion`) of a view
 *   that may decide; its author may reject it too (`discard`).
 *
 * The layer owns the list; the surface renders it.
 */
import { DEV } from 'esm-env';
import type { BlockId, BlockSpec, DocAnchor, OpResult } from '../crdt/index.js';
import type { Flow, FlowLine, FlowTarget } from '../crdt/flow.js';
import type { Prepared } from '../crdt/edytor-doc.js';
import { NOOP, REFUSED, refused } from '../crdt/doc/plan.js';
import type { SuggestedChange } from '../crdt/doc/suggest.js';
import type { Plan } from '../crdt/doc/types.js';
import type { DocPosition } from '../crdt/rangeDelete.js';
import { editorEnglish, labelsOf } from '../labels.js';
import type { Edytor } from '../edytor.svelte.js';
import { textToBlocks } from '../clipboard/textBlocks.js';
import { selectedMembers, viewOf } from '../selection/visibility.js';
import { project, textSelection } from './selection.js';
import { cloneJson, jsonBlockToSpec, type JSONBlock } from '../utils/json.js';
import { id as mint } from '../utils.js';

/** A text range, by its anchors (a text selection's). */
export type SuggestionRange = { readonly anchor: DocAnchor; readonly focus: DocAnchor };

/** Where a suggestion goes. `replace: 'selection'` resolves at creation (see {@link Suggestion.at}). */
export type SuggestionAt =
	| { readonly after: BlockId }
	| { readonly before: BlockId }
	| { readonly inside: BlockId }
	| { readonly end: BlockId }
	| { readonly replace: readonly BlockId[] | 'selection' | SuggestionRange };

/** A position as resolved: block ids, or a text range's anchors. */
export type ResolvedAt = Exclude<SuggestionAt, { replace: 'selection' }>;

/** Blocks, or a string: paragraphs split on blank lines (one text run at an `end`). */
export type SuggestionContent = string | JSONBlock[];

export type SuggestionStatus = 'streaming' | 'ready';

export type SuggestionOptions = {
	/** The suggestion's id (default: minted). Adding one with a listed id replaces it. */
	id?: string;
	/** Default `ready` with content, `streaming` without. */
	status?: SuggestionStatus;
	/** A name for the UI (an app's suggestion bar shows it). */
	label?: string;
	/** Offer "Try again": called by `retry()` once the content is emptied. */
	onRetry?: (suggestion: Suggestion) => void;
	/**
	 * Write it in the document as it streams: every collaborator sees it
	 * written and reviews it (a block position or a `replace`; an `end` is
	 * always this view's).
	 */
	shared?: boolean;
	/** Who wrote a shared one for its author (default `'ai'`): a reviewer sees "Ada (AI)". */
	via?: string;
};

/** What a block position shows: before it, after it, as its last children, after its text. */
export type SuggestionsAt = {
	readonly before: readonly Suggestion[];
	readonly after: readonly Suggestion[];
	readonly inside: readonly Suggestion[];
	readonly end: readonly Suggestion[];
	/** A `replace` removes this block. */
	readonly replaced: boolean;
	/** It removes only blocks that hold nothing (an empty line): the preview shows in their place. */
	readonly inPlace: boolean;
};
/** The block's `data-edytor-suggestion-replaced` (`empty`: folded, the preview stands in its place). */
export const replacedMark = ({ replaced, inPlace }: SuggestionsAt) =>
	replaced ? (inPlace ? 'empty' : '') : null;

type Place = {
	-readonly [K in keyof SuggestionsAt]: K extends 'replaced' | 'inPlace' ? boolean : Suggestion[];
};
const place = (): Place => ({
	before: [],
	after: [],
	inside: [],
	end: [],
	replaced: false,
	inPlace: false
});
const NONE: SuggestionsAt = Object.freeze(place());

/** The block positions, in the order a position names its side. */
const SIDES = ['after', 'before', 'inside', 'end'] as const;
/** The side and block a block position names (none: a `replace`). */
const sideOf = (at: ResolvedAt) => {
	const side = SIDES.find((side) => side in at);
	return side && ([side, (at as Record<typeof side, BlockId>)[side]] as const);
};

/** A block change's mark (`marked`): its kind's, but for these. */
const MARKS: Record<string, string> = { block: 'inserted', remove: 'removed' };

export class Suggestion {
	readonly id: string;
	/**
	 * The position, resolved: `replace: 'selection'` is the selection's
	 * blocks or text range; `null` for a shared suggestion another view
	 * made (its `changes` say where it is).
	 */
	readonly at: ResolvedAt | null;
	readonly label: string | undefined;
	/** In the document: every collaborator sees it and reviews it. */
	readonly shared: boolean;
	#content = $state.raw<readonly JSONBlock[]>([]);
	#status = $state<SuggestionStatus>('ready');
	#layer: Suggestions;
	/** The kind a string's paragraphs take: the anchor's parent's default child. */
	#kind: string;
	#onRetry: SuggestionOptions['onRetry'];
	#via: string | undefined;
	/** @internal A shared one this view writes: the blocks it wrote last. */
	written: BlockId[] = [];

	constructor(
		layer: Suggestions,
		at: ResolvedAt | null,
		kind: string,
		options: SuggestionOptions,
		status: SuggestionStatus
	) {
		this.#layer = layer;
		this.#status = status;
		this.id = options.id ?? mint('s');
		this.at = at;
		this.#kind = kind;
		this.label = options.label;
		this.#onRetry = options.onRetry;
		// An `end` is a completion of this view's line: never shared.
		this.shared = !!options.shared && !(at && 'end' in at);
		this.#via = options.via ?? 'ai';
	}

	/** A shared one's record in the document. */
	get #record() {
		void this.#layer.revision;
		return this.#layer.edytor.facade.suggest.records().find((r) => r.id === this.id);
	}
	/** A shared one's author (an actor id). */
	get by(): string | undefined {
		return this.#record?.by;
	}
	/** Who wrote a shared one for its author (`'ai'`). */
	get via(): string | undefined {
		return this.shared ? (this.#record?.via ?? this.#via) : undefined;
	}
	/** A shared one's pending changes, in document order (reactive); a view-local one has none. */
	get changes(): readonly SuggestedChange[] {
		return this.shared ? this.#layer.changes().filter((c) => c.suggestion === this.id) : [];
	}
	/** This view may accept or reject it (a view-local one: may write). */
	get canDecide(): boolean {
		return this.#layer.decides();
	}
	/** Its author is this view's actor (it may reject a shared one). */
	get mine(): boolean {
		return !this.shared || this.by === this.#layer.edytor.document.actor.id;
	}

	/** The proposed blocks (reactive). */
	get content(): readonly JSONBlock[] {
		return this.#content;
	}
	get status(): SuggestionStatus {
		return this.#status;
	}
	/** An `onRetry` was given: the UI offers "Try again". */
	get retryable(): boolean {
		return this.#onRetry !== undefined;
	}
	/** Listed: not accepted, discarded or dropped (a shared one: with a change pending). */
	get live(): boolean {
		return this.#layer.get(this.id) === this;
	}

	/** Replace the content (call it on each streamed chunk); no-op once not live. */
	update = (content: SuggestionContent) => {
		if (!this.live) return;
		this.#content =
			typeof content !== 'string'
				? cloneJson(content)
				: this.at && 'end' in this.at
					? [{ type: this.#kind, content: [{ text: content }] }]
					: textToBlocks(content, { markdown: false, type: this.#kind });
		this.#layer.write(this);
	};

	/**
	 * Append streamed text to the last block's text (a new paragraph when
	 * there is none); away from an `end`, a blank line starts a new paragraph.
	 */
	append = (text: string) => {
		if (!this.live || !text) return;
		const blocks = [...this.#content];
		const last = blocks.pop() ?? { type: this.#kind, content: [] };
		const content = [...(last.content ?? [])];
		const tail = content.at(-1);
		const plain = tail && !('type' in tail) && !tail.marks ? tail.text : null;
		if (plain !== null) content.pop();
		const [head, ...rest] = (
			this.at && 'end' in this.at
				? [(plain ?? '') + text]
				: ((plain ?? '') + text).split(/\n[ \t]*(?:\n[ \t]*)+/)
		) as [string, ...string[]];
		blocks.push({ ...last, content: [...content, { text: head }] });
		for (const part of rest) blocks.push({ type: this.#kind, content: [{ text: part }] });
		this.#content = blocks;
		this.#layer.write(this);
	};

	/** The stream ended: `status` is `ready`. */
	done = () => {
		if (this.live) this.#status = 'ready';
	};

	/**
	 * Accept it: one command, one undo step (see {@link Suggestions}). A
	 * view-local one is placed in the document; a shared one's changes are
	 * accepted (a view that may not decide is refused).
	 */
	accept = (): OpResult =>
		this.shared ? this.#layer.decide(this.changes, true) : this.#layer.accept(this);

	/** Reject it: a shared one's changes, one command; a view-local one is dropped. */
	reject = (): OpResult =>
		this.shared ? this.#layer.decide(this.changes, false) : (this.#layer.drop(this), NOOP);

	/** Drop it (writes nothing); a shared one is rejected. */
	discard = (): void => {
		this.#layer.drop(this);
		if (this.shared) this.reject();
	};

	/** Empty it, stream again, and ask the app for another answer (`onRetry`). */
	retry = () => {
		if (!this.live || !this.#onRetry) return;
		this.#content = [];
		this.#status = 'streaming';
		this.#layer.revision++;
		this.#onRetry(this);
	};
}

/** The view's suggestions (`edytor.suggestions`). */
export class Suggestions {
	/** The view-local ones and the shared ones this view writes (`add`). */
	#list = $state.raw<readonly Suggestion[]>([]);
	/** Bumped by every change of a suggestion (and of the document's): the surface's passes re-run. */
	revision = $state(0);
	/**
	 * Suggesting mode: this view's writes are a shared suggestion of its
	 * author's (`sugg.*`), a move refused. Set by the app (a toggle), or by
	 * the room for a user who may only suggest.
	 */
	#suggesting = $state(false);
	/** This view's writer, its open suggestion and the block it last wrote in (the grouping). */
	#writer = 0;
	#open: string | null = null;
	/** The writer its author's rejections are written by when this view may not decide (never a record's writer, whose id lists propose). */
	#decider = 0;
	#last: BlockId | null = null;
	/** A decision runs: its writes are the decider's, never suggested. */
	#deciding = false;
	/** The shared suggestions other views made, as this view lists them. */
	#others = new Map<string, Suggestion>();

	/** @internal */
	constructor(readonly edytor: Edytor) {}

	get suggesting(): boolean {
		// A user who may only suggest always does (`room.access.suggest`).
		void this.revision;
		return this.#suggesting || this.edytor.document?.access === 'suggest';
	}
	set suggesting(on: boolean) {
		// A switch ends the undo step and the open suggestion.
		this.edytor.undoManager?.stopCapturing();
		this.#open = null;
		this.#suggesting = on;
	}

	/** Every pending change of a shared suggestion, in document order (reactive). */
	changes = (): readonly SuggestedChange[] => {
		void [this.revision, this.edytor.valueRevision];
		return this.edytor.root ? this.edytor.facade.suggest.changes() : [];
	};

	/** Every suggestion, view-local and shared, oldest first (reactive). */
	get list(): readonly Suggestion[] {
		const shared = new Set(this.changes().map((c) => c.suggestion));
		const mine = this.#list.filter(
			(s) => !s.shared || s.status === 'streaming' || shared.has(s.id)
		);
		for (const s of mine) shared.delete(s.id);
		const others = [...shared].map(
			(id) =>
				this.#others.get(id) ??
				this.#others.set(id, new Suggestion(this, null, '', { id, shared: true }, 'ready')).get(id)!
		);
		return [...mine, ...others];
	}
	/** The newest one this view added: what the keys act on. */
	get latest(): Suggestion | undefined {
		return this.#list.at(-1);
	}
	get = (id: string): Suggestion | undefined => this.list.find((s) => s.id === id);

	/** @internal This view may accept or reject: it may write and is no suggest-only user's. */
	decides = (): boolean =>
		this.edytor.dispatcher.permits() && this.edytor.document.access === 'write';

	/**
	 * @internal `plan` written as this view's suggestion while it suggests
	 * (`Dispatcher.write`), with where its caret is now; `null` while it does
	 * not. It continues the open suggestion while it writes in the block
	 * that one last wrote in or a neighbour; a plan the document refuses to
	 * suggest (a move, a merge, a retype, a data change, a format:
	 * `sugg.refused`) is refused and announced.
	 */
	written = (plan: Plan): { result: OpResult; at?: DocPosition } | null => {
		if (!this.suggesting || this.#deciding) return null;
		const { facade, announcer } = this.edytor;
		if (facade.suggest.refuses(plan, (this.#writer ||= facade.suggest.writer()))) {
			announcer.say(labelsOf(this.edytor, 'editor', editorEnglish).notSuggested);
			return { result: refused('suggesting') };
		}
		const block = plan.effect.textRanges[0]?.block ?? plan.ids[0] ?? null;
		const last = this.#last;
		const near =
			block === last || (!!last && [facade.next(last), facade.previous(last)].includes(block));
		if (!near || !facade.suggest.records().some((r) => r.id === this.#open))
			this.#open = facade.suggest.open({ writer: this.#writer });
		const out = facade.suggest.apply(this.#open!, plan);
		if (out.result.status === 'applied') this.#last = block;
		return out;
	};

	/**
	 * Accept (`accept`) or reject shared `changes`: one command
	 * (`acceptSuggestion`, `rejectSuggestion`, its payload `{ changes }`),
	 * one undo step, refused unless this view decides. Its writes are id
	 * lists (the text that stays settled in its record, the text that goes
	 * held by this view's user) and the view's operations (`deleteBlock`,
	 * `mergeBlocks`, a proposed one run again).
	 */
	decide = (changes: readonly SuggestedChange[], accept: boolean): OpResult => {
		const { edytor } = this;
		const { suggest } = edytor.facade;
		const operation = accept ? 'acceptSuggestion' : 'rejectSuggestion';
		if (!changes.length) return NOOP;
		// Its author may reject it, written by a writer of theirs (a suggest-only user's view too).
		const author =
			!this.decides() &&
			!accept &&
			changes.every((c) => this.get(c.suggestion)?.mine) &&
			(this.#decider ||= suggest.writer());
		if (!this.decides() && !author)
			return (void edytor.dispatcher.record({ operation, status: 'refused' }), REFUSED);
		const block = edytor.idToBlock.get(changes[0]!.block) ?? edytor.root!;
		edytor.dispatcher.dispatch(operation, { changes }, { block }, () => {
			this.#deciding = true;
			try {
				suggest.run(
					suggest.decide(changes, accept),
					(op, args) =>
						(edytor as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!(...args),
					author || undefined
				);
			} finally {
				this.#deciding = false;
			}
		});
		return edytor.dispatcher.last?.status === 'applied' ? { status: 'applied', ids: [] } : NOOP;
	};

	/**
	 * @internal How a shared suggestion marks block `id` (`data-edytor-suggested`):
	 * `inserted` or `split` (it made the block), `removed` (it proposes
	 * deleting it); `undefined`: none.
	 */
	marked = (id: string): string | undefined => {
		void [this.revision, this.edytor.valueRevision];
		const kind = this.edytor.facade.suggest
			.at(id)
			.find((c) => c.kind !== 'insert' && c.kind !== 'delete')?.kind;
		return kind && (MARKS[kind] ?? kind);
	};

	/** @internal The colour of suggestion `id`'s author (its profile's), for its runs. */
	colorOf = (id: string): string | undefined => {
		const by = this.edytor.facade.suggest.records().find((r) => r.id === id)?.by;
		return by === undefined ? undefined : this.edytor.document.attribution.actors.get(by)?.color;
	};

	/** Accept (or reject) every pending shared suggestion: one command, one undo step. */
	acceptAll = (): OpResult => this.decide(this.changes(), true);
	rejectAll = (): OpResult => this.decide(this.changes(), false);

	/**
	 * @internal Write shared `suggestion`'s content as it is now (`update`,
	 * `append`), live (`sugg.ai.live`): the first time at its position (a
	 * `replace` proposed for deletion), then each time in place of what it
	 * wrote before, whole. Its own writer's blocks, outside the undo history.
	 */
	write = (suggestion: Suggestion) => {
		this.revision++;
		const { facade, dispatcher } = this.edytor;
		const { id, at } = suggestion;
		if (!suggestion.shared || !at || !dispatcher.permits()) return;
		const { prepare, suggest } = facade;
		const put = (plan: Prepared) => void suggest.apply(id, plan);
		dispatcher.outside(() => {
			if (!suggest.records().some((r) => r.id === id)) {
				suggest.open({ id, via: suggestion.via, label: suggestion.label });
				const range =
					'replace' in at &&
					!Array.isArray(at.replace) &&
					this.#range(at.replace as SuggestionRange);
				if (range) put(prepare.replaceRange(range.start, range.end));
				else if ('replace' in at) put(prepare.deleteBlocks(at.replace as BlockId[]));
			}
			// What it wrote last goes for real: its writer's alone, in no history step.
			suggest.erase(suggestion.written);
			const specs = suggestion.content.map((b) => jsonBlockToSpec(b, true));
			const dest = this.#slot(at);
			if (specs.length && dest) put(prepare.insertBlocks(dest, specs));
			const ids = (specs: readonly BlockSpec[]): BlockId[] =>
				specs.flatMap((spec) => [spec.id, ...ids(spec.children ?? [])]);
			suggestion.written = ids(specs);
		});
	};

	/** Where a shared suggestion's blocks go: its position's slot (a `replace`: after what it replaces). */
	#slot = (at: ResolvedAt) => {
		const { facade } = this.edytor;
		const [side, id] = sideOf(at) ?? ['after', this.#blocks(at).toSorted(facade.compare).at(-1)!];
		if (side === 'inside') return { parent: id, index: facade.childrenIds(id).length };
		const pos = facade.positionOf(id);
		return pos && { parent: pos.parent, index: pos.index + (side === 'before' ? 0 : 1) };
	};

	/**
	 * Propose `content` at `at`. Throws when the position names no shown
	 * block, a block that holds no children (`inside` a void or a code line),
	 * or no selection (`replace: 'selection'` with none).
	 */
	add = (at: SuggestionAt, content?: SuggestionContent, options: SuggestionOptions = {}) => {
		const resolved = this.#resolve(at);
		const { facade, document } = this.edytor;
		const anchor = this.#blocks(resolved)[0]!;
		const parent = 'inside' in resolved ? anchor : (facade.parentOf(anchor) ?? null);
		const kind = document.defaultChild(
			parent === null ? null : (facade.blockTypeOf(parent) ?? null)
		);
		const status = options.status ?? (content === undefined ? 'streaming' : 'ready');
		const suggestion = new Suggestion(this, resolved, kind, options, status);
		this.#list = [...this.#list.filter((s) => s.id !== suggestion.id), suggestion];
		if (content !== undefined) suggestion.update(content);
		this.revision++;
		return suggestion;
	};

	/** Discard every suggestion. */
	clear = () => {
		this.#list = [];
		this.revision++;
	};

	/** @internal Drop `suggestion` from the list. */
	drop = (suggestion: Suggestion) => {
		if (!this.#list.includes(suggestion)) return;
		this.#list = this.#list.filter((s) => s !== suggestion);
		this.revision++;
	};

	/** After a commit: a suggestion whose block (or range) died is dropped. */
	prune = () => {
		if (!this.#list.length) return;
		const kept = this.#list.filter((s) => s.shared || !s.at || this.#alive(s.at));
		if (kept.length !== this.#list.length) {
			this.#list = kept;
			this.revision++;
		}
	};

	/** Where suggestions show, by block (reactive; follows the document while any is listed). */
	#places = $derived.by(() => {
		const places = new Map<BlockId, Place>();
		if (!this.#list.length) return places;
		void this.edytor.valueRevision;
		const at = (id: BlockId) => places.get(id) ?? places.set(id, place()).get(id)!;
		for (const s of this.#list) {
			const { at: where } = s;
			if (s.shared || !where) continue;
			const named = sideOf(where);
			if (named) {
				const [side, id] = named;
				at(id)[side].push(s);
				// Blocks past the first follow the block, as accepting places them.
				if (side === 'end' && s.content.length > 1) at(id).after.push(s);
			} else if ('replace' in where) {
				const ids = this.#blocks(where);
				if (Array.isArray(where.replace)) {
					const inPlace = ids.every((id) => this.edytor.idToBlock.get(id)?.isEmpty);
					for (const id of ids) Object.assign(at(id), { replaced: true, inPlace });
				}
				const last = ids.toSorted(this.edytor.facade.compare).at(-1);
				if (last) at(last).after.push(s);
			}
		}
		return places;
	});

	/** The suggestions shown at block `id`. */
	at = (id: BlockId): SuggestionsAt => this.#places.get(id) ?? NONE;

	/**
	 * Sibling blocks `ids` in the flow with the suggestions shown before and
	 * after each, then those shown inside `parent` (its last children): `ids`
	 * itself while none is listed, so a children list reads one fact.
	 * @internal
	 */
	around = (ids: readonly BlockId[], parent?: BlockId): readonly (BlockId | Suggestion)[] => {
		const places = this.#places;
		if (!places.size) return ids;
		const flow: (BlockId | Suggestion)[] = [];
		for (const id of ids) {
			const place = places.get(id);
			if (place) flow.push(...place.before, id, ...place.after);
			else flow.push(id);
		}
		if (parent !== undefined) flow.push(...(places.get(parent)?.inside ?? []));
		return flow;
	};

	/**
	 * The one command (`acceptSuggestion`) that writes a suggestion: refused
	 * by a readonly view or a vetoing hook (the suggestion stays); else the
	 * content goes in with fresh ids, the suggestion goes, and the caret ends
	 * the content.
	 */
	accept = (suggestion: Suggestion): OpResult => {
		const { edytor } = this;
		const { at } = suggestion;
		if (!suggestion.live || !at) return REFUSED;
		const flow: Flow = { lines: suggestion.content.map((block) => jsonBlockToSpec(block, true)) };
		const range =
			'replace' in at && !Array.isArray(at.replace)
				? this.#range(at.replace as SuggestionRange)
				: null;
		const view = viewOf(edytor);
		let ids: readonly BlockId[] = [];
		const place = (target: FlowTarget, lines = flow) => {
			const plan = edytor.facade.prepare.insertFlow(target, lines, view);
			ids = plan.ids;
			return plan;
		};
		/** The flow's plan, or for a text range its deletion's (the flow is placed at its caret). */
		const prepare = (): Prepared => {
			if (range) return edytor.facade.prepare.replaceRange(range.start, range.end, view);
			return place(this.#target(at, flow));
		};
		const target = this.#blocks(at)[0];
		const block = (target && edytor.idToBlock.get(target)) || edytor.root!;
		const payload = { suggestion: { id: suggestion.id, at, content: suggestion.content } };
		const out = edytor.dispatcher.dispatch(
			'acceptSuggestion',
			payload,
			{ block },
			(_payload, plan = prepare()) => {
				/** Write a stage in the command; answers the caret it decides. */
				const write = (plan: Prepared) => {
					if (!('writes' in plan) || !plan.at) return null;
					edytor.dispatcher.write(plan);
					return plan.at;
				};
				const caret = write(plan);
				return range && caret ? write(place(caret)) : caret;
			},
			prepare
		);
		if (out === undefined || (out === null && edytor.dispatcher.last?.status === 'refused'))
			return REFUSED;
		this.drop(suggestion);
		if (out) edytor.dispatcher.caret(out);
		const status = edytor.dispatcher.last?.status === 'applied' ? 'applied' : 'noop';
		return { status, ids: status === 'applied' ? ids : [] };
	};

	/** The flow target of a block position (at an `end`, the first block's content joins the text). */
	#target = (at: ResolvedAt, flow: Flow): FlowTarget => {
		const { facade } = this.edytor;
		const [side, id] = sideOf(at) ?? [];
		if (side === 'end') {
			const [first, ...rest] = flow.lines;
			if (first)
				flow.lines = [
					{ id: first.id, content: first.content, children: first.children } as FlowLine,
					...rest
				];
			return { block: id!, offset: facade.displayLength(id!) };
		}
		if (!id) return { replace: (at as { replace: readonly BlockId[] }).replace };
		if (side === 'inside') return { slot: { parent: id, index: facade.childrenIds(id).length } };
		const { parent, index } = facade.positionOf(id) ?? { parent: null, index: 0 };
		return { slot: { parent, index: index + (side === 'after' ? 1 : 0) } };
	};

	/** A range's endpoints in document order, or null when one no longer resolves. */
	#range = ({ anchor, focus }: SuggestionRange) => {
		const { start, end } = project(textSelection(anchor, focus), this.edytor.facade);
		return start && end ? { start, end } : null;
	};

	/** The blocks a position names (a range: its endpoints' blocks). */
	#blocks = (at: ResolvedAt): BlockId[] => {
		const named = sideOf(at);
		if (named) return [named[1]];
		const { replace } = at as { replace: readonly BlockId[] | SuggestionRange };
		if (Array.isArray(replace)) return [...replace];
		const range = this.#range(replace as SuggestionRange);
		return range ? [range.start.block, range.end.block] : [];
	};

	#alive = (at: ResolvedAt) => {
		const blocks = this.#blocks(at);
		return blocks.length > 0 && blocks.every((id) => this.edytor.facade.isVisibleBlock(id));
	};

	#resolve = (at: SuggestionAt): ResolvedAt => {
		const { edytor } = this;
		const fail = (why: string): never => {
			throw new RangeError(`[edytor] suggestions.add: ${why}`);
		};
		let resolved: ResolvedAt;
		if ('replace' in at && at.replace === 'selection') {
			const { value, projection } = edytor.selection;
			if (value.kind === 'blocks') resolved = { replace: selectedMembers(edytor).map((b) => b.id) };
			else if (value.kind === 'text' && !projection.isCollapsed)
				resolved = { replace: { anchor: value.anchor, focus: value.focus } };
			else {
				const block = value.kind === 'atom' ? value.blockId : projection.start?.block;
				resolved = block ? { after: block } : fail(DEV ? 'no selection to replace' : '');
			}
		} else resolved = at as ResolvedAt;
		if (!this.#alive(resolved)) fail(DEV ? 'the position names no shown block' : '');
		if ('inside' in resolved) {
			const probe = edytor.facade.prepare.insertBlocks({ parent: resolved.inside, index: 0 }, []);
			if (!('writes' in probe)) fail(DEV ? `block "${resolved.inside}" holds no children` : '');
		}
		return resolved;
	};
}
