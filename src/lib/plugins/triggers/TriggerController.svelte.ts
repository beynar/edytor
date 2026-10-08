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

export type TextInsertionPayload = {
	value: string;
	start?: number;
	end?: number;
};

/** Where the trigger is now: its text, the trigger's start and the query's end in it. */
export type TriggerRange = { text: Text; triggerStart: number; queryEnd: number };

/** A trigger opens at a text's start or after whitespace, never inside a word (`1/2`, `a@b`). */
const startsTrigger = (text: Text, offset: number) =>
	offset === 0 || /\s/.test(text.stringContent[offset - 1] ?? '');

export abstract class TextTriggerController {
	isOpen = $state(false);
	query = $state('');
	selectedIndex = $state(0);
	/** The trigger's start and the query's end, held as anchors so peers' edits move them. */
	protected activeRange: { trigger: TextAnchor; end: TextAnchor } | null = null;
	/** A pick is running: its own selection changes close nothing. */
	protected picking = false;

	constructor(
		protected edytor: Edytor,
		/** The text that opens the menu. */
		readonly char: string,
		/** The popup's owner name (`edytor.popups`), unique per view. */
		protected owner: string
	) {}

	/** The editor is readonly: the menu closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	/** The listbox's element id (page-unique), for `aria-controls`. */
	get listId() {
		return this.edytor.popups.idOf(this.owner);
	}

	/** Publish the open menu to the view's root (`edytor.popups`), or withdraw it with `null`. */
	publish = (popup: Popup | null) => this.edytor.popups.set(this.owner, popup);

	/** The rows the keyboard moves through. */
	protected abstract get count(): number;
	/** Whether a trigger typed in `block` opens the menu. */
	protected abstract admits(block: Block): boolean;
	/** The query changed (or was set again): close the menu, or load its rows. */
	protected abstract queried(query: string): void;

	/** After an `insertText`: the trigger opens, the query grows, or the menu closes. */
	handleTextInsertion(text: Text, block: Block, payload: TextInsertionPayload) {
		const { state } = this.edytor.selection;
		const start = payload.start ?? state.yStart;
		const end = payload.end ?? state.yEnd;
		if (this.edytor.readonly) return this.close();
		// A trigger typed alone, or committed by an IME with its query (`/h`).
		const at =
			start === end && this.admits(block) ? this.triggerAt(text, start, payload.value) : -1;
		if (at !== -1) this.open(text, at, start + payload.value.length);
		// Typing at the query's end extends it; typing anywhere else closes the menu.
		else if (this.activeRange) {
			const range = this.range;
			if (text === range?.text && start === range.queryEnd)
				this.setEnd(text, start + payload.value.length);
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
		const { startText, yStart, isCollapsed } = this.edytor.selection.state;
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

	/** Move the keyboard's row (wrapping); `false` when there is nothing to move through. */
	moveSelection(delta: number) {
		// Nothing to move through: the arrows stay the caret's.
		const count = this.isOpen ? this.count : 0;
		if (!count) return false;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		return true;
	}

	close() {
		this.isOpen = false;
		this.query = '';
		this.selectedIndex = 0;
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
			const block = text.parent;
			const [from, to] = [text.segStart + triggerStart, text.segStart + end];
			this.close();
			selection.setAtTextOffset(text, triggerStart);
			const held = selection.value;
			const ctx: TriggerContext = {
				edytor,
				block,
				from,
				to,
				query,
				caret: (offset) => void dispatcher.caret({ block, offset })
			};
			const removal = edytor.facade.prepare.deleteText(block.id, from, to - from);
			const run = dispatcher.lead(removal, () => body(ctx));
			const index = text.index;
			// Nothing took the lead: the trigger goes on its own, unless the body declined.
			if (!run.taken && run.out !== false && index !== -1)
				block.deleteContentAtRange({ start: [index, triggerStart], end: [index, end] });
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
		this.selectedIndex = 0;
		this.syncQueryFromText(true);
	}

	private syncQueryFromText(opened = false) {
		const range = this.range;
		if (!range) return;
		const { text, triggerStart, queryEnd } = range;
		const query = text.stringContent.slice(triggerStart + this.char.length, queryEnd);
		// A new query highlights its first match again (Notion).
		if (query !== this.query) this.selectedIndex = 0;
		const changed = opened || query !== this.query;
		this.query = query;
		if (changed) this.queried(query);
		else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.count - 1));
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

	constructor(
		edytor: Edytor,
		readonly trigger: Trigger<T>,
		owner: string
	) {
		super(edytor, trigger.char, owner);
	}

	protected get count() {
		return this.items.length;
	}

	protected admits(block: Block) {
		if (this.trigger.enabled) return this.trigger.enabled(block);
		return !inCodeLines(this.edytor, block);
	}

	/** The menu's accessible name. */
	get name() {
		return this.trigger.name ?? 'Suggestions';
	}

	/** The text shown when no row matches. */
	get empty() {
		return this.trigger.empty ?? 'No results';
	}

	labelOf = (item: T) => (this.trigger.label ? this.trigger.label(item) : defaultLabel(item));

	keyOf = (item: T): string => {
		if (this.trigger.key) return this.trigger.key(item);
		const id = (item as { id?: unknown } | null)?.id;
		return typeof id === 'string' || typeof id === 'number' ? String(id) : this.labelOf(item);
	};

	/** A row's element id (page-unique), for `aria-activedescendant`. */
	optionId = (item: T) => this.edytor.popups.idOf(`${this.owner}-${this.keyOf(item)}`);

	/** The context `items` and `onPick` read, for the current range. */
	private context(): TriggerContext | null {
		const range = this.range;
		if (!range) return null;
		const { text, triggerStart, queryEnd } = range;
		const block = text.parent;
		const { edytor, query } = this;
		return {
			edytor,
			block,
			from: text.segStart + triggerStart,
			to: text.segStart + queryEnd,
			query,
			caret: (offset) => void edytor.dispatcher.caret({ block, offset })
		};
	}

	protected queried(query: string) {
		// A query that opens with whitespace is prose (`a @ b`): the menu closes.
		if (/^\s/.test(query)) return this.close();
		const ctx = this.context();
		if (!ctx) return;
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
		this.items = Array.isArray(rows) ? rows : [];
		if (!this.items.length && /\s$/.test(this.query)) return this.close();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.items.length - 1));
	}

	close() {
		super.close();
		this.#request++;
		this.items = [];
		this.loading = false;
	}

	/** Pick the keyboard's row. */
	pickSelected() {
		const item = this.items[this.selectedIndex];
		return item === undefined ? Promise.resolve(undefined) : this.pick(item);
	}

	/** Replace the trigger and its query with `item` (`onPick`). */
	pick(item: T) {
		return this.replaceTrigger((ctx) => this.trigger.onPick(item, ctx));
	}
}
