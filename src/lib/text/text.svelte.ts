import { Edytor } from '../edytor.svelte.js';
import { tick } from 'svelte';
import { type JSONText, type SerializableContent } from '$lib/utils/json.js';
import { Block } from '../block/block.svelte.js';
import {
	batch,
	deleteText,
	removeMarksFromText,
	getMarksAtRange,
	insertText,
	markText,
	setText,
	splitText
} from './text.utils.js';
import { deltaToJson, runsToDeltas } from './deltas.js';
import { id } from '$lib/utils.js';
import { climb } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from './removeStalePlaceholders.js';
import type { ContentItem, OpResult } from '$lib/crdt/index.js';

/** A write through the block's model that the document did not refuse. */
const accepted = (r: OpResult | undefined): boolean => r !== undefined && r.status !== 'refused';

export type TextRunItem = {
	text: string;
	marks?: Record<string, unknown>;
};

/** Text items of one segment → splice `deleteLen` chars at `offset`, optionally inserting `insert`. */
export const spliceTextItems = (
	items: readonly TextRunItem[],
	offset: number,
	deleteLen: number,
	insert?: TextRunItem
): TextRunItem[] => {
	const out: TextRunItem[] = [];
	let pos = 0;
	let inserted = false;
	const pushInsert = () => {
		if (!inserted && insert && insert.text.length > 0) {
			out.push({ text: insert.text, ...(insert.marks ? { marks: { ...insert.marks } } : {}) });
		}
		inserted = true;
	};
	for (const item of items) {
		const start = pos;
		const end = pos + item.text.length;
		pos = end;
		if (end <= offset || start >= offset + deleteLen) {
			// JSON-payload contract: omit the marks key entirely when absent —
			// `marks: undefined` would be silently dropped by serialization.
			const { marks, ...rest } = item;
			out.push(marks ? { ...rest, marks: { ...marks } } : rest);
			continue;
		}
		const head = item.text.slice(0, Math.max(0, offset - start));
		const tail = item.text.slice(Math.min(item.text.length, offset + deleteLen - start));
		if (head) out.push({ text: head, ...(item.marks ? { marks: { ...item.marks } } : {}) });
		if (!inserted && start <= offset && offset <= end) pushInsert();
		if (tail) out.push({ text: tail, ...(item.marks ? { marks: { ...item.marks } } : {}) });
	}
	pushInsert();
	return out.filter((i) => i.text.length > 0);
};

/** Set/unset marks over a range of detached text items (`null` value removes the key). */
export const formatTextItems = (
	items: readonly TextRunItem[],
	offset: number,
	length: number,
	attributes: Record<string, unknown>
): TextRunItem[] => {
	const out: TextRunItem[] = [];
	let pos = 0;
	for (const item of items) {
		const start = pos;
		const end = pos + item.text.length;
		pos = end;
		if (end <= offset || start >= offset + length) {
			out.push(item);
			continue;
		}
		const head = item.text.slice(0, Math.max(0, offset - start));
		const mid = item.text.slice(
			Math.max(0, offset - start),
			Math.min(item.text.length, offset + length - start)
		);
		const tail = item.text.slice(Math.min(item.text.length, offset + length - start));
		const base = item.marks ? { ...item.marks } : undefined;
		if (head) out.push({ text: head, ...(base ? { marks: { ...base } } : {}) });
		if (mid) {
			const marks = { ...(base ?? {}) } as Record<string, unknown>;
			for (const [k, v] of Object.entries(attributes)) {
				if (v === null) delete marks[k];
				else marks[k] = v;
			}
			out.push({ text: mid, ...(Object.keys(marks).length ? { marks } : {}) });
		}
		if (tail) out.push({ text: tail, ...(base ? { marks: { ...base } } : {}) });
	}
	return out.filter((i) => i.text.length > 0);
};

export class Text {
	readonly = false;
	parent: Block;
	edytor: Edytor;
	/** Position among the parent's content parts (the mirror's; operations read it until R3/R4). */
	index = 0;
	node: HTMLElement | undefined;
	// Used when user toggles mark without selection range.
	markOnNextInsert: undefined | Record<string, SerializableContent | null> = undefined;
	id: string;

	/**
	 * Run items backing this segment — bound parts mirror the facade's items
	 * (`{kind:'text'}` runs of the segment); detached wrappers keep a pending
	 * spec buffer (like v13's unintegrated `Y.Text`).
	 */
	_items: TextRunItem[] = [];
	/** True while this wrapper maps a live segment of its parent's content. */
	_live = false;
	/** Text-segment ordinal inside the parent (`t:{blockId}:{segOrd}` id source). */
	_segOrd = -1;

	get value(): JSONText[] {
		return deltaToJson(runsToDeltas(this._items)[0]);
	}

	/** The segment's text (derived from its items on read; nothing renders from it, R2). */
	get stringContent(): string {
		return this._items.map((item) => item.text).join('');
	}

	get isEmpty(): boolean {
		return this.stringContent.length === 0;
	}

	get endsWithNewline(): boolean {
		return this.stringContent.endsWith('\n');
	}

	get length() {
		return this.stringContent.length;
	}

	/** Display offset of this segment inside the parent block's content (atoms). */
	get segStart() {
		return this.parent.partOffsetOf(this);
	}

	get isInDocument() {
		return this._live && this.parent.content.includes(this);
	}

	/**
	 * Re-read the items and re-create this block's text elements from its
	 * cell — the repair of a DOM the browser or a foreign script changed
	 * (typing and model commits never remount). Never while the IME owns the
	 * element. The remount can re-park a live DOM caret: the churn is marked
	 * so a same-task selectionchange echo is drift, not user intent.
	 */
	refreshFromModel = () => {
		this.refreshFromProject();
		if (this.edytor.pin.owns(this.node)) return;
		this.edytor.markDomSelectionChurn();
		this.edytor.cells?.remount(this.parent.id);
	};

	/**
	 * Re-derive `_items` from the document (mid-transaction safe, scoped to
	 * the block: `Block.projectedParts`). A hidden or deleted block keeps its
	 * last-known items (the pending reconcile kills the wrapper).
	 */
	refreshFromProject = () => {
		if (!this._live) return;
		const mine = this.parent.projectedParts()?.filter((part) => part.kind === 'text')[this._segOrd];
		if (mine?.kind === 'text') this._items = mine.items;
	};

	/** Bind this wrapper to segment `segOrd` of the parent (reconcile/adoption path). */
	_bind = (segOrd: number, items: TextRunItem[]) => {
		this._segOrd = segOrd;
		this._live = true;
		// The id is no render key (segments are keyed causally, R2): it follows at once.
		const nextId = `t:${this.parent._blockId ?? 'detached'}:${segOrd}`;
		if (nextId !== this.id) {
			if (this.edytor.idToText.get(this.id) === this) this.edytor.idToText.delete(this.id);
			this.id = nextId;
			this.node?.setAttribute('data-edytor-id', nextId);
		}
		this.edytor.idToText.set(this.id, this);
		this._setItems(items);
	};

	/** Mark the wrapper dead — the segment it mirrored no longer exists. */
	_kill = () => {
		this.edytor.markDomSelectionChurn();
		this._live = false;
		this._segOrd = -1;
		this._items = [];
		if (this.edytor.idToText.get(this.id) === this) {
			this.edytor.idToText.delete(this.id);
		}
		if (this.node && this.edytor.nodeToText.get(this.node) === this) {
			this.edytor.nodeToText.delete(this.node);
		}
	};

	/** Slice this segment's JSON value from `index` — non-destructive (used by addInlineBlock). */
	_sliceFrom = (index: number): JSONText[] => {
		const out: JSONText[] = [];
		let pos = 0;
		for (const item of this._items) {
			const end = pos + item.text.length;
			if (end > index) {
				out.push({
					text: item.text.slice(Math.max(0, index - pos)),
					...(item.marks ? { marks: { ...item.marks } as JSONText['marks'] } : {})
				});
			}
			pos = end;
		}
		return out;
	};

	private _setItems = (items: TextRunItem[]) => {
		// This render rewrites the span's DOM — a live DOM caret inside it
		// can be re-parked by the browser (Gecko clamps into a shortened
		// node). Mark eagerly: observer timing reports too late for engines
		// that dispatch `selectionchange` synchronously.
		this.edytor.markDomSelectionChurn();
		this._items = items;
		void tick().then(() => scheduleRemoveStalePlaceholders(this));
	};

	constructor({
		parent,
		content,
		segment
	}: { parent: Block } & (
		| { segment?: undefined; content: string | JSONText[] }
		| { segment: { segOrd: number; items: ContentItem[] }; content?: undefined }
	)) {
		this.parent = parent;
		this.edytor = parent.edytor;
		if (segment !== undefined) {
			this._segOrd = segment.segOrd;
			this._live = true;
			this._items = segment.items
				.filter((item): item is ContentItem & { kind: 'text' } => item.kind === 'text')
				.map((item) => ({
					text: item.text,
					...(item.marks ? { marks: item.marks } : {})
				}));
			this.id = `t:${parent._blockId ?? 'detached'}:${segment.segOrd}`;
		} else {
			this.id = id('t');
			this._items =
				typeof content === 'string'
					? [{ text: content }]
					: (content ?? []).map((part) => ({
							text: part.text,
							...(part.marks ? { marks: { ...part.marks } as Record<string, unknown> } : {})
						}));
		}
		this.edytor.idToText.set(this.id, this);
	}

	// ── typed segment mutation surface ──────────────────────────────────
	//
	// `insertAt`/`deleteAt`/`formatAt` are the offset-based primitives the
	// operation layer (`text.utils`), event handlers, and plugins call to
	// mutate this segment. They replace the old `yText` adapter:
	//
	// - BOUND wrappers (`_live` under a bound parent) route through the
	//   typed node — `parent.model.insertText(segStart + offset, …)` — and
	//   refresh `_items` from the post-write projection (the projection is
	//   memoized on `facade.version`, so it reflects writes made earlier in
	//   the same transaction — read-your-writes).
	// - DETACHED wrappers splice the pending `_items` buffer — the spec a
	//   later `insertParts` carries into the document (the old adapter's
	//   unbound branch).
	//
	// Offsets are SEGMENT-LOCAL display atoms (UTF-16 units); `segStart`
	// maps them into the block's display space before the typed node
	// applies its ownership/flattening mapping into backing text.

	/** True while this wrapper can write through its parent's model node. */
	private get _writable(): boolean {
		return this._live && this.parent._bound === true;
	}

	/** Insert `text` (optionally marked) at segment-local `offset`. */
	insertAt = (offset: number, text: string, marks?: Record<string, unknown> | null): boolean => {
		if (this._writable) {
			const applied = accepted(
				this.parent.model?.insertText(this.segStart + offset, text, marks ?? undefined)
			);
			if (applied) {
				this.refreshFromProject();
			}
			return applied;
		}
		this._items = spliceTextItems(this._items, offset, 0, {
			text,
			...(marks != null ? { marks: { ...marks } } : {})
		});
		return true;
	};

	/** Delete `length` atoms at segment-local `offset`. */
	deleteAt = (offset: number, length: number): boolean => {
		if (this._writable) {
			const applied = accepted(this.parent.model?.deleteText(this.segStart + offset, length));
			if (applied) {
				this.refreshFromProject();
			}
			return applied;
		}
		this._items = spliceTextItems(this._items, offset, length);
		return true;
	};

	/**
	 * Multi-mark format over `[offset, offset+length)` — `null` values
	 * remove the mark (same contract as the old `yText.format`).
	 */
	formatAt = (offset: number, length: number, attributes: Record<string, unknown>): boolean => {
		if (this._writable) {
			const applied = accepted(
				this.parent.model?.format(this.segStart + offset, length, attributes)
			);
			if (applied) {
				this.refreshFromProject();
			}
			return applied;
		}
		this._items = formatTextItems(this._items, offset, length, attributes);
		return true;
	};

	private batch = batch.bind(this);
	getMarksAtRange = getMarksAtRange.bind(this);
	insertText = this.batch('insertText', insertText.bind(this));
	deleteText = this.batch('deleteText', deleteText.bind(this));
	splitText = this.batch('splitText', splitText.bind(this));
	setText = this.batch('setText', setText.bind(this));
	markText = this.batch('markText', markText.bind(this));
	removeMarksFromText = this.batch('removeMarksFromText', removeMarksFromText.bind(this));

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.idToText.set(this.id, this);
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		let pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onTextAttached?.({ node, text: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		let insideVoid = this.parent.definition.void;
		climb(this.parent, (block) => {
			if (block instanceof Block && block.definition.void) {
				insideVoid = true;
				return true;
			}
		});

		if (insideVoid) {
			node.contentEditable = 'true';
			node.style.outline = 'none';
		}

		// A span (re)mount under a live selection endpoint re-parks the DOM
		// caret — mark the churn before the browser's echo can be mistaken
		// for a user move.
		this.edytor.markDomSelectionChurn();
		// A display that waited for a mounted destination runs in the next pass.
		this.edytor.projector?.mounted(this);

		return {
			destroy: () => {
				if (this.node === node) {
					this.node = undefined;
					if (this.edytor.idToText.get(this.id) === this) {
						this.edytor.idToText.delete(this.id);
					}
				}
				if (this.edytor.nodeToText.get(node) === this) {
					this.edytor.nodeToText.delete(node);
				}
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
