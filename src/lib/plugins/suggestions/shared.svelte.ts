/**
 * Shared suggestions (site `editor/suggestions`, the `sugg.*` rows of
 * `docs/editor-delete-contract.md`): suggestions that live in the document,
 * so every replica, the room and a reload see them with their author.
 *
 * - **Suggesting mode** (`suggesting`): the view's writes are a suggestion
 *   of its user's (the dispatcher's plan writer, `written`), continued
 *   while they touch the block it last wrote in or a neighbour, a new one
 *   elsewhere. Only text and blocks are suggested: a move, a merge, a
 *   retype, a data change or a format is refused and announced.
 * - **Decisions** are one command each (`acceptSuggestion`,
 *   `rejectSuggestion`, payload `{ changes }`) of a view that may decide;
 *   its author may reject it too (`discard`, by a writer of theirs).
 * - **An app's answer** (`add`) is written live as it streams, only what
 *   changed per chunk (`write`, `sugg.ai.live`), one suggestion of its own
 *   (`via: 'ai'`), outside the history.
 * - **The view** draws each pending run in the overlay in its author's
 *   colour (`SuggestionRuns`) and marks the blocks a suggestion made or
 *   removes (`data-edytor-suggested`).
 *
 * The document part (`crdt/doc/suggest.ts`) holds the records, what is
 * pending and the decisions' writes; built over the view's document by this
 * plugin, its `toJSON()` leaves pending suggestions out.
 */
import { mount, unmount } from 'svelte';
import type { ChangePayload, Plugin } from '$lib/plugins.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { NOOP, REFUSED } from '$lib/crdt/doc/plan.js';
import { suggestionsOf, type DocSuggest, type SuggestedChange } from '$lib/crdt/doc/suggest.js';
import type { BlockId } from '$lib/crdt/index.js';
import type { OpResult, Plan, Prepared } from '$lib/crdt/edytor-doc.js';
import type { DocPosition } from '$lib/crdt/rangeDelete.js';
import type { InlineSpec } from '$lib/crdt/placement/model.js';
import { canonKey } from '$lib/crdt/text/ranges.js';
import { labelsOf, suggestionsEnglish } from '$lib/labels.js';
import { jsonBlockToSpec, type JSONBlock, type JSONText } from '$lib/utils/json.js';
import { project, textSelection } from '$lib/session/selection.js';
import {
	Suggestion,
	type AnySuggestion,
	type ResolvedAt,
	type SharedSuggestion,
	type SuggestionAt,
	type SuggestionContent,
	type SuggestionOptions,
	type SuggestionRange,
	type SuggestionStatus,
	type Suggestions
} from '$lib/session/suggestions.svelte.js';

/** What `add` takes: a suggestion's options, and who writes it for its author. */
export type SharedSuggestionOptions = SuggestionOptions & {
	/** Who writes it for its author (default `'ai'`): a reviewer sees "Ada (AI)". */
	via?: string;
};
import SuggestionRuns from './SuggestionRuns.svelte';

/** A block change's mark (`marked`): its kind's, but for these. */
const MARKS: Record<string, string> = { block: 'inserted', remove: 'removed' };

/** Two blocks alike but for their ids. */
const same = (a: JSONBlock, b: JSONBlock) =>
	canonKey({ ...a, id: 0 }) === canonKey({ ...b, id: 0 });
/**
 * The runs `next` adds after `prev`'s content when it extends it (one kind
 * and data, `prev`'s content its start), else `null`.
 */
const grown = (prev: JSONBlock, next: JSONBlock) => {
	const [a, b] = [prev.content ?? [], next.content ?? []];
	if (!same({ ...prev, content: [] }, { ...next, content: [] }) || b.length < a.length) return null;
	const last = a.at(-1) as JSONText | undefined;
	const tail = b[a.length - 1] as JSONText | undefined;
	const head = a.length - (last && 'text' in last && tail && 'text' in tail ? 1 : 0);
	if (a.slice(0, head).some((run, i) => canonKey(run) !== canonKey(b[i]))) return null;
	if (
		head < a.length &&
		(canonKey(last!.marks) !== canonKey(tail!.marks) || !tail!.text.startsWith(last!.text))
	)
		return null;
	const rest = b.slice(a.length);
	return head < a.length && tail!.text.length > last!.text.length
		? [{ ...tail!, text: tail!.text.slice(last!.text.length) }, ...rest]
		: rest;
};

/** The blocks position `at` names (a text range: its ends' blocks). */
const blocksOf = (edytor: Edytor, at: ResolvedAt): BlockId[] => {
	if (!('replace' in at)) return [Object.values(at)[0] as BlockId];
	const { replace } = at;
	if (Array.isArray(replace)) return [...replace];
	const { anchor, focus } = replace as SuggestionRange;
	const { start, end } = project(textSelection(anchor, focus), edytor.facade);
	return start && end ? [start.block, end.block] : [];
};

const controllers = new WeakMap<Edytor, SharedSuggestionsController>();

/** The shared suggestions plugin's controller of `edytor`; `undefined` when the plugin is not listed. */
export const sharedSuggestionsController = (
	edytor: Edytor
): SharedSuggestionsController | undefined => controllers.get(edytor);

/** A shared suggestion of the list: this view's (`add`), or another view's. */
class Shared extends Suggestion {
	#c: SharedSuggestionsController;
	#via: string;
	/** @internal What this view wrote of it so far (`write`): its blocks, with their ids. */
	written: JSONBlock[] = [];

	constructor(
		layer: Suggestions,
		at: ResolvedAt | null,
		kind: string,
		options: SharedSuggestionOptions,
		status: SuggestionStatus
	) {
		super(layer, at as ResolvedAt, kind, options, status);
		(this as { shared: boolean }).shared = true;
		this.#c = controllers.get(layer.edytor)!;
		this.#via = options.via ?? 'ai';
		// What this view adds is written live, while it is listed; another view's it never writes.
		const { update, append } = this;
		this.update = (content) => {
			if (!at || !this.live) return;
			update(content);
			this.#c.write(this);
		};
		this.append = (text) => {
			if (!at || !this.live) return;
			append(text);
			this.#c.write(this);
		};
	}

	/** Its record in the document. */
	get #record() {
		void this.#c.edytor.suggestions.revision;
		return this.#c.part.records().find((r) => r.id === this.id);
	}
	get by(): string | undefined {
		return this.#record?.by;
	}
	get via(): string | undefined {
		return this.#record?.via ?? this.#via;
	}
	get changes(): readonly SuggestedChange[] {
		return this.#c.changes().filter((c) => c.suggestion === this.id);
	}
	get canDecide(): boolean {
		return this.#c.decides();
	}
	get mine(): boolean {
		return this.by === this.#c.edytor.document.actor.id;
	}

	override accept = (): OpResult => this.#c.decide(this.changes, true);
	reject = (): OpResult => this.#c.decide(this.changes, false);
	/** Drop it and reject it (its author's withdrawal). */
	override discard = (): void => {
		this.#c.drop(this);
		this.reject();
	};
}

/** A shared suggestion, as the list types it (to the compiler, `Shared` is a view-local one's class). */
const make = (...args: ConstructorParameters<typeof Shared>) =>
	new Shared(...args) as unknown as SharedSuggestion;

/**
 * The shared suggestions of a view (`sharedSuggestionsController(edytor)`):
 * suggesting mode, the pending changes, the decisions.
 */
export class SharedSuggestionsController {
	#suggesting = $state(false);
	/** This view's writer, its open suggestion and the block it last wrote in (the grouping). */
	#writer = 0;
	#open: string | null = null;
	/** The writer its author's rejections are written by when this view may not decide (never a record's writer, whose id lists propose). */
	#decider = 0;
	#last: BlockId | null = null;
	/** A decision runs: its writes are the decider's, never suggested. */
	#deciding = false;
	/** The ones this view added (`add`), and the ones other views made, as this view lists them. */
	#mine = $state.raw<readonly SharedSuggestion[]>([]);
	#others = new Map<string, SharedSuggestion>();

	/** @internal */
	constructor(readonly edytor: Edytor) {}

	/** @internal The document's shared suggestions (`crdt/doc/suggest.ts`). */
	get part(): DocSuggest {
		return suggestionsOf(this.edytor.facade);
	}

	/**
	 * Suggesting mode: this view's writes are a shared suggestion of its
	 * author's (`sugg.*`), a move refused. Set by the app (a toggle); always
	 * on for a user the room lets only suggest (`document.access`).
	 */
	get suggesting(): boolean {
		void this.edytor.suggestions.revision;
		return this.#suggesting || this.edytor.document.access === 'suggest';
	}
	set suggesting(on: boolean) {
		// A switch ends the undo step and the open suggestion.
		this.edytor.undoManager?.stopCapturing();
		this.#open = null;
		this.#suggesting = on;
	}

	/** Every pending change of a shared suggestion, in document order (reactive). */
	changes = (): readonly SuggestedChange[] => {
		void [this.edytor.suggestions.revision, this.edytor.valueRevision];
		return this.edytor.root ? this.part.changes() : [];
	};

	/**
	 * Propose `content` at `at`, shared: written live into the document as
	 * it streams (`update`, `append`), one suggestion of its own every
	 * collaborator sees and reviews. At an `end` (a completion of this
	 * view's line), a view-local one. Throws as `edytor.suggestions.add`.
	 */
	add = (
		at: SuggestionAt,
		content?: SuggestionContent,
		options: SharedSuggestionOptions = {}
	): AnySuggestion => {
		const { suggestions, facade, document } = this.edytor;
		const resolved = suggestions.resolve(at);
		if ('end' in resolved) return suggestions.add(at, content, options);
		const anchor = blocksOf(this.edytor, resolved)[0]!;
		const parent = 'inside' in resolved ? anchor : (facade.parentOf(anchor) ?? null);
		const kind = document.defaultChild(
			parent === null ? null : (facade.blockTypeOf(parent) ?? null)
		);
		const status = options.status ?? (content === undefined ? 'streaming' : 'ready');
		const suggestion = make(suggestions, resolved, kind, options, status);
		this.#mine = [...this.#mine.filter((s) => s.id !== suggestion.id), suggestion];
		if (content !== undefined) suggestion.update(content);
		suggestions.revision++;
		return suggestion;
	};

	/** @internal Drop `suggestion` from this view's own. */
	drop = (suggestion: object) => {
		this.#mine = this.#mine.filter((s) => s !== suggestion);
		this.edytor.suggestions.revision++;
	};

	/** @internal The list with the shared ones (`Suggestions.shared`): this view's while pending or streaming, then the others'. */
	list = (mine: readonly Suggestion[]): readonly AnySuggestion[] => {
		const shared = new Set(this.changes().map((c) => c.suggestion));
		const own = this.#mine.filter((s) => s.status === 'streaming' || shared.has(s.id));
		for (const s of own) shared.delete(s.id);
		const others = [...shared].map(
			(id) =>
				this.#others.get(id) ??
				this.#others.set(id, make(this.edytor.suggestions, null, '', { id }, 'ready')).get(id)!
		);
		return [...mine, ...own, ...others];
	};

	/** @internal This view may accept or reject: it may write and is no suggest-only user's. */
	decides = (): boolean =>
		this.edytor.dispatcher.permits() && this.edytor.document.access === 'write';

	/**
	 * @internal `plan` written as this view's suggestion while it suggests
	 * (the dispatcher's plan writer), with where its caret is now; `null`
	 * while it does not. It continues the open suggestion while it writes in
	 * the block that one last wrote in or a neighbour; a plan the document
	 * refuses to suggest (a move, a merge, a retype, a data change, a
	 * format: `sugg.refused`) is refused and announced.
	 */
	written = (plan: Plan): OpResult | null => {
		if (!this.suggesting || this.#deciding) return null;
		const { facade } = this.edytor;
		const part = this.part;
		const block = plan.effect.textRanges[0]?.block ?? plan.ids[0] ?? null;
		const last = this.#last;
		const near =
			block === last || (!!last && [facade.next(last), facade.previous(last)].includes(block));
		const out = part.apply(near ? this.#open : null, plan, (this.#writer ||= part.writer()));
		if (out.result.status === 'refused') this.#refused();
		this.#open = out.id ?? this.#open;
		if (out.result.status === 'applied') this.#last = block;
		// Its caret stands where the plan's does with the proposed text shown.
		if (out.at) (plan as { at?: DocPosition }).at = out.at;
		return out.result;
	};

	/** @internal Nothing moves through a suggestion (`sugg.refused`): a move is refused, and said. */
	moves = ({ operation, prevent }: ChangePayload) => {
		if (operation !== 'moveBlocks' || !this.suggesting || this.#deciding) return;
		this.#refused();
		prevent();
	};

	/** Said to assistive technology: what the view tried is not suggested. */
	#refused() {
		this.edytor.announcer.say(
			labelsOf(this.edytor, 'suggestions', suggestionsEnglish).notSuggested
		);
	}

	/**
	 * Accept (`accept`) or reject shared `changes`: one command
	 * (`acceptSuggestion`, `rejectSuggestion`, its payload `{ changes }`),
	 * one undo step, refused unless this view decides. Its writes are id
	 * lists (the text that stays settled in its record, the text that goes
	 * held by this view's user) and the view's operations (`deleteBlock`,
	 * `mergeBlocks`).
	 */
	decide = (changes: readonly SuggestedChange[], accept: boolean): OpResult => {
		const { edytor } = this;
		const part = this.part;
		const operation = accept ? 'acceptSuggestion' : 'rejectSuggestion';
		if (!changes.length) return NOOP;
		// Its author may reject it, written by a writer of theirs (a suggest-only user's view too).
		const author =
			!this.decides() &&
			!accept &&
			changes.every((c) => (edytor.suggestions.get(c.suggestion) as SharedSuggestion)?.mine) &&
			(this.#decider ||= part.writer());
		if (!this.decides() && !author)
			return (void edytor.dispatcher.record({ operation, status: 'refused' }), REFUSED);
		const block = edytor.idToBlock.get(changes[0]!.block) ?? edytor.root!;
		// A decision is a step of its own: typing after it is another.
		edytor.undoManager?.stopCapturing();
		edytor.dispatcher.dispatch(operation, { changes }, { block }, () => {
			this.#deciding = true;
			try {
				part.run(
					part.decide(changes, accept),
					(op, args) =>
						(edytor as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!(...args),
					author || undefined
				);
			} finally {
				this.#deciding = false;
			}
		});
		edytor.undoManager?.stopCapturing();
		return edytor.dispatcher.last?.status === 'applied' ? { status: 'applied', ids: [] } : NOOP;
	};

	/** Accept (or reject) every pending shared suggestion: one command, one undo step. */
	acceptAll = (): OpResult => this.decide(this.changes(), true);
	rejectAll = (): OpResult => this.decide(this.changes(), false);

	/**
	 * @internal How a shared suggestion marks block `id` (`data-edytor-suggested`):
	 * `inserted` or `split` (it made the block), `removed` (it proposes
	 * deleting it); `undefined`: none.
	 */
	marked = (id: string): string | undefined => {
		void [this.edytor.suggestions.revision, this.edytor.valueRevision];
		const kind = this.part.at(id).find((c) => c.kind !== 'insert' && c.kind !== 'delete')?.kind;
		return kind && (MARKS[kind] ?? kind);
	};

	/** @internal The colour of suggestion `id`'s author (its profile's), for its runs. */
	colorOf = (id: string): string | undefined =>
		this.edytor.document.attribution.actors.get(
			this.part.records().find((r) => r.id === id)?.by as string
		)?.color;

	/**
	 * @internal Write shared `suggestion`'s content as it is now (`update`,
	 * `append`), live (`sugg.ai.live`): the first time at its position (a
	 * `replace` proposed for deletion), then only what changed — its equal
	 * blocks kept, its last block's text extended when the new one extends
	 * it, the rest replaced. Its own writer's blocks, outside the undo history.
	 */
	write = (suggestion: Shared) => {
		const { facade, dispatcher } = this.edytor;
		const { id, at, content: next } = suggestion;
		if (!at || !dispatcher.permits()) return;
		const { prepare } = facade;
		const part = this.part;
		const prev = suggestion.written;
		const put = (plan: Prepared) => void part.apply(id, plan);
		dispatcher.outside(() => {
			if (!part.records().some((r) => r.id === id)) {
				part.open({ id, via: suggestion.via, label: suggestion.label });
				if ('replace' in at) {
					const { replace } = at;
					if (Array.isArray(replace)) put(prepare.deleteBlocks(replace));
					else {
						const { anchor, focus } = replace as SuggestionRange;
						const { start, end } = project(textSelection(anchor, focus), facade);
						if (start && end) put(prepare.replaceRange(start, end));
					}
				}
			}
			let p = 0;
			while (p < prev.length && p < next.length && same(prev[p]!, next[p]!)) p++;
			const runs = p === prev.length - 1 && p < next.length ? grown(prev[p]!, next[p]!) : null;
			if (runs) {
				const block = prev[p]!.id!;
				for (const run of runs) {
					const offset = facade.displayLength(block);
					put(
						'text' in run
							? prepare.insertText(block, offset, run.text, run.marks ?? {})
							: prepare.insertInline(block, offset, run as InlineSpec)
					);
				}
				prev[p] = { ...next[p]!, id: block };
				p++;
			}
			const doomed = prev.splice(p).map((b) => b.id!);
			if (doomed.length) put(prepare.deleteBlocks(doomed));
			const specs = next.slice(p).map((b) => jsonBlockToSpec(b, true));
			const dest = p ? facade.positionOf(prev[p - 1]!.id!) : this.#slot(at);
			if (specs.length && dest) {
				put(prepare.insertBlocks({ parent: dest.parent, index: dest.index + (p ? 1 : 0) }, specs));
				prev.push(...specs.map((spec, i) => ({ ...next[p + i]!, id: spec.id })));
			}
		});
	};

	/** Where a shared suggestion's blocks go: its position's slot (a `replace`: after what it replaces). */
	#slot = (at: ResolvedAt) => {
		const { facade } = this.edytor;
		if ('inside' in at) return { parent: at.inside, index: facade.childrenIds(at.inside).length };
		const before = 'before' in at;
		const ids = blocksOf(this.edytor, at);
		const pos = facade.positionOf((before ? ids[0] : ids.toSorted(facade.compare).at(-1))!);
		return pos && { parent: pos.parent, index: pos.index + (before ? 0 : 1) };
	};

	/** @internal Mounted: the list follows the records and the access, the runs are drawn in the overlay. */
	attach = () => {
		const { edytor } = this;
		const bump = () => edytor.suggestions.revision++;
		// The room's access arrives as the document joins: read again once it is ready.
		const offs = [this.part.onChange(bump), edytor.document.onReady(bump)];
		const runs = mount(SuggestionRuns, {
			target: edytor.overlay.layer!,
			props: { edytor, shared: this }
		});
		return () => {
			for (const off of offs) off();
			void unmount(runs);
		};
	};

	/** @internal Its block's mark (`data-edytor-suggested`), kept on `node` while it is attached. */
	mark = (node: HTMLElement, id: BlockId) =>
		$effect.root(() => {
			$effect(() => {
				const kind = this.marked(id);
				if (kind) node.setAttribute('data-edytor-suggested', kind);
				else node.removeAttribute('data-edytor-suggested');
			});
		});
}

/**
 * Shared suggestions (Google Docs' suggesting mode): suggestions that live
 * in the document, which every collaborator sees with its author and a
 * writer accepts or rejects. With it, `edytor.suggestions.list` holds the
 * shared ones, and its controller (`sharedSuggestionsController(edytor)`)
 * suggests while `suggesting` is set and writes an answer live into the
 * document (`add`). Without it, a document's suggestions read as plain
 * content.
 */
export const createSharedSuggestionsPlugin = (): Plugin => (edytor) => {
	const shared = new SharedSuggestionsController(edytor);
	controllers.set(edytor, shared);
	// The document leaves its pending suggestions out of `toJSON()` from now on.
	void shared.part;
	edytor.suggestions.shared = shared.list;
	edytor.dispatcher.writer = shared.written;
	// While it suggests, the view offers no move (each is refused, `moves`).
	const canMove = edytor.canMove;
	edytor.canMove = (request) => !shared.suggesting && canMove(request);
	return {
		onBeforeOperation: shared.moves,
		onEdytorAttached: shared.attach,
		onBlockAttached: ({ node, block }) => shared.mark(node, block.id)
	};
};
