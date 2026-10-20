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
 * - **Shared** (with the shared suggestions plugin,
 *   `plugins/suggestions/shared.svelte.ts`, `sugg.*`): in the document, so
 *   every replica sees it and its author is known. The plugin adds them and
 *   lists them here (`shared`, the port it sets).
 *
 * The layer owns the list; the surface renders it.
 */
import { DEV } from 'esm-env';
import type { BlockId, DocAnchor, OpResult } from '../crdt/index.js';
import type { Flow, FlowLine, FlowTarget } from '../crdt/flow.js';
import type { Prepared } from '../crdt/edytor-doc.js';
import { REFUSED } from '../crdt/doc/plan.js';
import type { SuggestedChange } from '../crdt/doc/suggest.js';
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

/** A view-local suggestion: shown in this view only, until it is accepted. */
export class Suggestion {
	readonly id: string;
	/** The position, resolved: `replace: 'selection'` is the selection's blocks or text range. */
	readonly at: ResolvedAt;
	readonly label: string | undefined;
	/** View-local: a {@link SharedSuggestion} is in the document. */
	readonly shared = false as const;
	#content = $state.raw<readonly JSONBlock[]>([]);
	#status = $state<SuggestionStatus>('ready');
	#layer: Suggestions;
	/** The kind a string's paragraphs take: the anchor's parent's default child. */
	#kind: string;
	#onRetry: SuggestionOptions['onRetry'];

	constructor(
		layer: Suggestions,
		at: ResolvedAt,
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
	/** Listed: not accepted, discarded or dropped. */
	get live(): boolean {
		return this.#layer.get(this.id) === this;
	}

	/** Replace the content (call it on each streamed chunk); no-op once not live. */
	update = (content: SuggestionContent) => {
		if (!this.live) return;
		this.#content =
			typeof content !== 'string'
				? cloneJson(content)
				: 'end' in this.at
					? [{ type: this.#kind, content: [{ text: content }] }]
					: textToBlocks(content, { markdown: false, type: this.#kind });
		this.#layer.revision++;
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
			'end' in this.at
				? [(plain ?? '') + text]
				: ((plain ?? '') + text).split(/\n[ \t]*(?:\n[ \t]*)+/)
		) as [string, ...string[]];
		blocks.push({ ...last, content: [...content, { text: head }] });
		for (const part of rest) blocks.push({ type: this.#kind, content: [{ text: part }] });
		this.#content = blocks;
		this.#layer.revision++;
	};

	/** The stream ended: `status` is `ready`. */
	done = () => {
		if (this.live) this.#status = 'ready';
	};

	/** Accept it: one command, one undo step, placing it in the document (see {@link Suggestions}). */
	accept = (): OpResult => this.#layer.accept(this);

	/** Drop it (writes nothing). */
	discard = (): void => this.#layer.drop(this);

	/** Empty it, stream again, and ask the app for another answer (`onRetry`). */
	retry = () => {
		if (!this.live || !this.#onRetry) return;
		this.#content = [];
		this.#status = 'streaming';
		this.#layer.revision++;
		this.#onRetry(this);
	};
}

/**
 * A shared suggestion (`createSharedSuggestionsPlugin`): in the document,
 * so every collaborator sees it with its author and reviews it. Its
 * `accept()` and `reject()` are one command each (`acceptSuggestion`,
 * `rejectSuggestion`) of a view that may decide; `discard()` rejects it
 * (its author's withdrawal too).
 */
export interface SharedSuggestion extends Omit<Suggestion, 'shared' | 'at'> {
	readonly shared: true;
	/** Its position as this view added it; `null` for one another view made (its `changes` say where it is). */
	readonly at: ResolvedAt | null;
	/** Its author (an actor id). */
	readonly by: string | undefined;
	/** Who wrote it for its author (`'ai'`): a reviewer sees "Ada (AI)". */
	readonly via: string | undefined;
	/** Its pending changes, in document order (reactive). */
	readonly changes: readonly SuggestedChange[];
	/** This view may accept or reject it. */
	readonly canDecide: boolean;
	/** Its author is this view's actor (it may reject it). */
	readonly mine: boolean;
	/** Reject its changes: one command (`rejectSuggestion`). */
	reject(): OpResult;
}

/** A suggestion of the list: view-local, or shared (with the shared suggestions plugin). */
export type AnySuggestion = Suggestion | SharedSuggestion;

/** The view's suggestions (`edytor.suggestions`). */
export class Suggestions {
	#list = $state.raw<readonly Suggestion[]>([]);
	/** Bumped by every change of a suggestion (and of the document's): the surface's passes re-run. */
	revision = $state(0);
	/**
	 * @internal The shared suggestions plugin's part (`createSharedSuggestionsPlugin`):
	 * the list with the shared ones after this view's own.
	 */
	shared: ((mine: readonly Suggestion[]) => readonly AnySuggestion[]) | undefined;

	/** @internal */
	constructor(readonly edytor: Edytor) {}

	/** Every suggestion, view-local and shared, oldest first (reactive). */
	get list(): readonly AnySuggestion[] {
		return this.shared?.(this.#list) ?? this.#list;
	}
	/** The newest view-local one: what the keys act on. */
	get latest(): Suggestion | undefined {
		return this.#list.at(-1);
	}
	get = (id: string): AnySuggestion | undefined => this.list.find((s) => s.id === id);

	/**
	 * Propose `content` at `at`. Throws when the position names no shown
	 * block, a block that holds no children (`inside` a void or a code line),
	 * or no selection (`replace: 'selection'` with none).
	 */
	add = (at: SuggestionAt, content?: SuggestionContent, options: SuggestionOptions = {}) => {
		const resolved = this.resolve(at);
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
		const kept = this.#list.filter((s) => this.#alive(s.at));
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
		if (!suggestion.live) return REFUSED;
		const { at } = suggestion;
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

	/** @internal `at` resolved: a selection read, a position checked (throws when it names nothing shown). */
	resolve = (at: SuggestionAt): ResolvedAt => {
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
