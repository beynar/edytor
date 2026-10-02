/**
 * Suggestions (site `editor/suggestions`): content one view proposes at a
 * position — AI output, a completion — shown only in that view until it is
 * accepted. Session state: nothing reaches the document, its history,
 * presence, `onChange` or another view before `accept()`, which is one
 * command (`acceptSuggestion`: admission, hooks, one transaction, one undo
 * step) placing the content as a paste places it (`flow.place`, `flow.slot`,
 * `flow.inline`). A suggestion is anchored by block ids (a text range by its
 * anchors): it survives selection changes and edits elsewhere, and is dropped
 * when its block dies. The layer owns the list; the surface renders it.
 */
import type { BlockId, DocAnchor, OpResult } from '../crdt/index.js';
import type { Flow, FlowLine, FlowTarget } from '../crdt/flow.js';
import type { Prepared } from '../crdt/edytor-doc.js';
import type { Edytor } from '../edytor.svelte.js';
import { applyAt, caretOf } from '../edytor.utils.js';
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
	/** A name for the UI (the default bar shows it). */
	label?: string;
	/** Offer "Try again": called by `retry()` once the content is emptied. */
	onRetry?: (suggestion: Suggestion) => void;
};

const REFUSED: OpResult = Object.freeze({ status: 'refused', ids: [] });

/** What a block position shows: before it, after it, as its last children, after its text. */
export type SuggestionsAt = {
	readonly before: readonly Suggestion[];
	readonly after: readonly Suggestion[];
	readonly inside: readonly Suggestion[];
	readonly end: readonly Suggestion[];
	/** A `replace` removes this block. */
	readonly replaced: boolean;
};
const NONE: SuggestionsAt = Object.freeze({
	before: [],
	after: [],
	inside: [],
	end: [],
	replaced: false
});

export class Suggestion {
	readonly id: string;
	/** The position, resolved: `replace: 'selection'` is the selection's blocks or text range. */
	readonly at: ResolvedAt;
	readonly label: string | undefined;
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

	/** Place the content in the document: one command, one undo step (see {@link Suggestions}). */
	accept = (): OpResult => this.#layer.accept(this);

	/** Drop it; writes nothing. */
	discard = () => this.#layer.drop(this);

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
	#list = $state.raw<readonly Suggestion[]>([]);
	/** Bumped by every change of a suggestion: the surface's passes re-run. */
	revision = $state(0);

	constructor(private edytor: Edytor) {}

	/** Every live suggestion, oldest first (reactive). */
	get list(): readonly Suggestion[] {
		return this.#list;
	}
	/** The newest one: what the keys act on. */
	get latest(): Suggestion | undefined {
		return this.#list.at(-1);
	}
	get = (id: string): Suggestion | undefined => this.#list.find((s) => s.id === id);

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
		const kept = this.#list.filter((s) => this.#alive(s.at));
		if (kept.length !== this.#list.length) {
			this.#list = kept;
			this.revision++;
		}
	};

	/** Where suggestions show, by block (reactive; follows the document while any is listed). */
	#places = $derived.by(() => {
		type Place = {
			-readonly [K in keyof SuggestionsAt]: K extends 'replaced' ? boolean : Suggestion[];
		};
		const places = new Map<BlockId, Place>();
		if (!this.#list.length) return places;
		void this.edytor.valueRevision;
		const at = (id: BlockId) => {
			if (!places.has(id))
				places.set(id, { before: [], after: [], inside: [], end: [], replaced: false });
			return places.get(id)!;
		};
		for (const s of this.#list) {
			const { at: where } = s;
			if ('after' in where) at(where.after).after.push(s);
			else if ('before' in where) at(where.before).before.push(s);
			else if ('inside' in where) at(where.inside).inside.push(s);
			else if ('end' in where) {
				at(where.end).end.push(s);
				// Blocks past the first follow the block, as accepting places them.
				if (s.content.length > 1) at(where.end).after.push(s);
			} else {
				const ids = this.#blocks(where);
				if (Array.isArray(where.replace)) for (const id of ids) at(id).replaced = true;
				const last = ids.toSorted(this.edytor.facade.compare).at(-1);
				if (last) at(last).after.push(s);
			}
		}
		return places;
	});

	/** The suggestions shown at block `id`. */
	at = (id: BlockId): SuggestionsAt => this.#places.get(id) ?? NONE;

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
				const caret = applyAt(edytor, plan);
				return range && caret ? applyAt(edytor, place(caret)) : caret;
			},
			prepare
		);
		if (out === undefined || (out === null && edytor.dispatcher.last?.status === 'refused'))
			return REFUSED;
		this.drop(suggestion);
		if (out) edytor.dispatcher.caret(...caretOf.call(edytor, out));
		const status = edytor.dispatcher.last?.status === 'applied' ? 'applied' : 'noop';
		return { status, ids: status === 'applied' ? ids : [] };
	};

	/** The flow target of a block position (at an `end`, the first block's content joins the text). */
	#target = (at: ResolvedAt, flow: Flow): FlowTarget => {
		const { facade } = this.edytor;
		if ('end' in at) {
			const [first, ...rest] = flow.lines;
			if (first)
				flow.lines = [
					{ id: first.id, content: first.content, children: first.children } as FlowLine,
					...rest
				];
			return { block: at.end, offset: facade.displayLength(at.end) };
		}
		if ('replace' in at) return { replace: at.replace as readonly BlockId[] };
		if ('inside' in at)
			return { slot: { parent: at.inside, index: facade.childrenIds(at.inside).length } };
		const id = 'after' in at ? at.after : at.before;
		const { parent, index } = facade.positionOf(id) ?? { parent: null, index: 0 };
		return { slot: { parent, index: index + ('after' in at ? 1 : 0) } };
	};

	/** A range's endpoints in document order, or null when one no longer resolves. */
	#range = ({ anchor, focus }: SuggestionRange) => {
		const { start, end } = project(textSelection(anchor, focus), this.edytor.facade);
		return start && end ? { start, end } : null;
	};

	/** The blocks a position names (a range: its endpoints' blocks). */
	#blocks = (at: ResolvedAt): BlockId[] => {
		if ('after' in at) return [at.after];
		if ('before' in at) return [at.before];
		if ('inside' in at) return [at.inside];
		if ('end' in at) return [at.end];
		if (Array.isArray(at.replace)) return [...(at.replace as readonly BlockId[])];
		const range = this.#range(at.replace as SuggestionRange);
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
				resolved = block ? { after: block } : fail('no selection to replace');
			}
		} else resolved = at as ResolvedAt;
		if (!this.#alive(resolved)) fail('the position names no shown block');
		if ('inside' in resolved) {
			const probe = edytor.facade.prepare.insertBlocks({ parent: resolved.inside, index: 0 }, []);
			if (!('writes' in probe)) fail(`block "${resolved.inside}" holds no children`);
		}
		return resolved;
	};
}
