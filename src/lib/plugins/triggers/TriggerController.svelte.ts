/**
 * A trigger's suggestion menu: a character typed at a text's start or after
 * whitespace (`/`, `@`, `[[`) opens a menu at the caret; the text typed
 * after it is the query. One controller per trigger: the range (held as
 * anchors, so a peer's edits elsewhere move it), the query, the keyboard's
 * row, an IME's commit carrying the trigger with its query, and the pick
 * that replaces the trigger and its query, their removal leading the pick's
 * first operation (one plan, one undo step). The slash menu is one
 * (`SlashMenuController`), a plugin's `triggers` are the others.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import type { Trigger, TriggerContext } from '$lib/plugins.js';
import type { Popup } from '$lib/surface/popups.svelte.js';
import type { SelectionValue } from '$lib/session/selection.js';
import { inCodeLines } from '$lib/session/inputRules.js';
import { inPage } from '../chrome.js';
import { ChromeList } from '../list.svelte.js';

/** Where the trigger is now: its text, the trigger's start and the query's end in it. */
export type TriggerRange = { text: Text; triggerStart: number; queryEnd: number };

/** A trigger opens at a text's start or after whitespace, never inside a word (`1/2`, `a@b`). */
const startsTrigger = (text: Text, offset: number) =>
	offset === 0 || /\s/.test(text.stringContent[offset - 1] ?? '');

/** What `items` and `onPick` read: the trigger's block, its range in block offsets, the query. */
const contextOf = (
	edytor: Edytor,
	text: Text,
	start: number,
	end: number,
	query: string
): TriggerContext => {
	const block = text.parent;
	return {
		edytor,
		block,
		from: text.segStart + start,
		to: text.segStart + end,
		query,
		caret: (offset) => void edytor.dispatcher.caret({ block, offset })
	};
};

export abstract class TextTriggerController extends ChromeList {
	isOpen = $state(false);
	query = $state('');
	/** The trigger's start and the query's end, held as anchors so peers' edits move them. */
	protected activeRange: { trigger: TextAnchor; end: TextAnchor } | null = null;
	/** A pick is running: its own selection changes close nothing. */
	protected picking = false;

	constructor(
		edytor: Edytor,
		/** The text that opens the menu. */
		readonly char: string,
		/** The popup's owner name (`edytor.popups`), unique per view. */
		owner: string
	) {
		super(
			edytor,
			owner,
			'listbox',
			(node) => this.isOpen && this.popupOf(inPage(node, this.rowId(this.index)))
		);
	}

	/** The editor is readonly: the menu closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	/** The record `popup` publishes, `active` the highlighted row's id when it is in the page. */
	protected popupOf(active: string | undefined): Popup {
		return { id: this.listId, haspopup: 'listbox', active };
	}

	/** Whether a trigger typed in `block` opens the menu. */
	protected abstract admits(block: Block): boolean;
	/** The query changed (or was set again): close the menu, or load its rows. */
	protected abstract queried(query: string): void;

	/** After an `insertText`: the trigger opens, the query grows, or the menu closes. */
	handleTextInsertion(text: Text, block: Block, start: number, value: string) {
		if (this.edytor.readonly) return this.close();
		// A trigger typed alone, or committed by an IME with its query (`/h`).
		const at = this.admits(block) ? this.triggerAt(text, start, value) : -1;
		if (at !== -1) this.open(text, at, start + value.length);
		// Typing at the query's end extends it; typing anywhere else closes the menu.
		else if (this.activeRange) {
			const range = this.range;
			if (text === range?.text && start === range.queryEnd) this.setEnd(text, start + value.length);
			else this.close();
		}
	}

	/**
	 * Where `value`, inserted at `start` of `text` (already written), completes
	 * the trigger: its start, or -1. A trigger of several characters (`[[`)
	 * completes with its last one.
	 */
	private triggerAt(text: Text, start: number, value: string) {
		const content = text.stringContent;
		const { char } = this;
		for (let at = Math.max(0, start - char.length + 1); at <= start; at++) {
			if (at + char.length > start + value.length) break;
			if (content.startsWith(char, at) && startsTrigger(text, at)) return at;
		}
		return -1;
	}

	/** The caret moved: it stays after the trigger, in its text, and marks the query's end. */
	reconcileSelection() {
		if (!this.activeRange || this.picking) return;
		const range = this.range;
		const { startText, yStart } = this.edytor.selection.textRange();
		const { isCollapsed } = this.edytor.selection.projection;
		if (
			range &&
			isCollapsed &&
			startText === range.text &&
			yStart >= range.triggerStart + this.char.length &&
			range.text.stringContent.startsWith(this.char, range.triggerStart)
		)
			this.setEnd(range.text, yStart);
		else this.close();
	}

	close() {
		this.isOpen = false;
		this.query = '';
		this.index = 0;
		this.activeRange = null;
	}

	/** The range where its anchors resolve now: one text, the trigger before the query end. */
	protected get range(): TriggerRange | null {
		const { selection } = this.edytor;
		const trigger = this.activeRange && selection.resolveTextAnchor(this.activeRange.trigger);
		const end = this.activeRange && selection.resolveTextAnchor(this.activeRange.end);
		if (!trigger || !end || trigger.text !== end.text) return null;
		if (end.offset < trigger.offset + this.char.length) return null;
		return { text: trigger.text, triggerStart: trigger.offset, queryEnd: end.offset };
	}

	/**
	 * Replace the trigger and its query: `body` runs at a caret where the
	 * trigger starts, their removal leading its first operation (one plan:
	 * a refusal keeps them, and the caret goes back to the query's end). A
	 * body that runs no operation synchronously (a command that writes
	 * later) runs after the removal; one that answers `false`, running
	 * nothing, keeps them. A body that sets no caret leaves it where the
	 * trigger was.
	 */
	protected async replaceTrigger<R>(
		body: (ctx: TriggerContext) => R,
		/** Whether the trigger's caret is still the selection, to be placed after `body`. */
		owns: (text: Text, held: SelectionValue) => boolean = (_, held) =>
			this.edytor.selection.value === held
	): Promise<Awaited<R> | undefined> {
		const range = this.range;
		if (!range) return undefined;
		this.picking = true;
		try {
			const { edytor, query } = this;
			const { selection, dispatcher } = edytor;
			const { text, triggerStart, queryEnd } = range;
			const end = Math.min(queryEnd, text.length);
			const ctx = contextOf(edytor, text, triggerStart, end, query);
			const { block, from, to } = ctx;
			this.close();
			selection.selectText(text, triggerStart);
			const held = selection.value;
			const removal = edytor.facade.prepare.deleteText(block.id, from, to - from);
			const run = dispatcher.lead(removal, () => body(ctx));
			const index = text.index;
			// Nothing took the lead: the trigger goes on its own, unless the body declined.
			if (!run.taken && run.out !== false && index !== -1)
				edytor.deleteText(block.id, from, to - from);
			const kept = run.out === false || (run.taken && dispatcher.last?.status === 'refused');
			const out = await run.out;
			if (owns(text, held)) dispatcher.caret(text, kept ? end : triggerStart);
			return out;
		} finally {
			this.picking = false;
		}
	}

	protected setEnd(text: Text, queryEnd: number) {
		const end = this.edytor.selection.createTextAnchor(text, queryEnd, 'left');
		if (this.activeRange && end) this.activeRange.end = end;
		this.syncQueryFromText();
	}

	protected open(text: Text, triggerStart: number, queryEnd: number) {
		const { selection } = this.edytor;
		const trigger = selection.createTextAnchor(text, triggerStart, 'right');
		const end = selection.createTextAnchor(text, queryEnd, 'left');
		if (!trigger || !end) return;
		this.activeRange = { trigger, end };
		this.isOpen = true;
		this.query = '';
		this.index = 0;
		this.syncQueryFromText(true);
	}

	private syncQueryFromText(opened = false) {
		const range = this.range;
		if (!range) return;
		const { text, triggerStart, queryEnd } = range;
		const query = text.stringContent.slice(triggerStart + this.char.length, queryEnd);
		// A new query highlights its first match again (Notion).
		if (query !== this.query) this.index = 0;
		const changed = opened || query !== this.query;
		this.query = query;
		if (changed) this.queried(query);
		else this.index = Math.max(0, Math.min(this.index, this.count - 1));
	}
}

/** The label a row shows: a string itself, else its `label`, `title` or `name`. */
const defaultLabel = (item: unknown): string => {
	if (typeof item === 'string' || typeof item === 'number') return String(item);
	const record = (item ?? {}) as Record<string, unknown>;
	const label = record.label ?? record.title ?? record.name ?? record.id;
	return typeof label === 'string' || typeof label === 'number' ? String(label) : '';
};

/** A plugin's trigger (`triggers`): rows from its `items(query)`, a pick its `onPick`. */
export class TriggerMenuController<T = unknown> extends TextTriggerController {
	/** The rows for the query (the newest answered; a pending search keeps the last). */
	items = $state.raw<readonly T[]>([]);
	/** A search for the query is pending. */
	loading = $state(false);
	/** The newest search: an older one's answer is dropped. */
	#request = 0;
	/** Enter came while the query's search was pending: its answer's first row is picked. */
	#pickOnAnswer = false;

	constructor(
		edytor: Edytor,
		readonly trigger: Trigger<T>,
		owner: string
	) {
		super(edytor, trigger.char, owner);
	}

	protected get count() {
		return this.isOpen ? this.items.length : 0;
	}

	protected admits(block: Block) {
		if (this.trigger.enabled) return this.trigger.enabled(block);
		return !inCodeLines(this.edytor, block);
	}

	labelOf = (item: T) => (this.trigger.label ? this.trigger.label(item) : defaultLabel(item));

	keyOf = (item: T): string => {
		if (this.trigger.key) return this.trigger.key(item);
		const id = (item as { id?: unknown } | null)?.id;
		return typeof id === 'string' || typeof id === 'number' ? String(id) : this.labelOf(item);
	};

	protected queried(query: string) {
		// A query that opens with whitespace is prose (`a @ b`): the menu closes.
		if (/^\s/.test(query)) return this.close();
		const range = this.range;
		if (!range) return;
		const ctx = contextOf(this.edytor, range.text, range.triggerStart, range.queryEnd, query);
		// A pick waiting on the previous query's search is dropped with it.
		this.#pickOnAnswer = false;
		const request = ++this.#request;
		let rows: readonly T[] | Promise<readonly T[]>;
		try {
			rows = this.trigger.items(query, ctx);
		} catch (error) {
			console.error('[edytor] a trigger’s items threw', error);
			rows = [];
		}
		if (typeof (rows as Promise<unknown>)?.then !== 'function')
			return this.answered(rows as readonly T[]);
		this.loading = true;
		(rows as Promise<readonly T[]>).then(
			(answer) => request === this.#request && this.answered(answer),
			(error) => {
				console.error('[edytor] a trigger’s items rejected', error);
				if (request === this.#request) this.answered([]);
			}
		);
	}

	/** The rows for the query: none after a word and a space is prose, and the menu closes. */
	private answered(rows: readonly T[]) {
		if (!this.isOpen) return;
		this.loading = false;
		const pick = this.#pickOnAnswer;
		this.#pickOnAnswer = false;
		this.items = Array.isArray(rows) ? rows : [];
		if (!this.items.length && /\s$/.test(this.query)) return this.close();
		this.index = Math.max(0, Math.min(this.index, this.items.length - 1));
		if (pick) void this.pickSelected();
	}

	close() {
		super.close();
		this.#request++;
		this.#pickOnAnswer = false;
		this.items = [];
		this.loading = false;
	}

	/**
	 * Pick the keyboard's row. While the query's search is pending, the rows
	 * shown are an older query's: the pick waits for the answer and takes its
	 * highlighted (first) row, if any.
	 */
	pickSelected() {
		if (this.loading) {
			this.#pickOnAnswer = true;
			return Promise.resolve(undefined);
		}
		const item = this.items[this.index];
		return item === undefined ? Promise.resolve(undefined) : this.pick(item);
	}

	/** Replace the trigger and its query with `item` (`onPick`). */
	pick(item: T) {
		return this.replaceTrigger((ctx) => this.trigger.onPick(item, ctx));
	}
}
