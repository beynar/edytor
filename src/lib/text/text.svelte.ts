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
import type { OpResult } from '$lib/crdt/index.js';

/** A write through the block's model that the document did not refuse. */
const accepted = (r: OpResult | undefined): boolean => r !== undefined && r.status !== 'refused';

export type TextRunItem = {
	text: string;
	marks?: Record<string, unknown>;
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

	/** Run items backing this segment (the facade's `{kind:'text'}` runs of the segment). */
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
	 * Re-create this block's text elements from its cell — the repair of a
	 * DOM the browser or a foreign script changed (typing and model commits
	 * never remount). Never while the IME owns the element. The remount can
	 * re-park a live DOM caret: the churn is marked so a same-task
	 * selectionchange echo is drift, not user intent.
	 */
	refreshFromModel = () => {
		if (this.edytor.pin.owns(this.node)) return;
		this.edytor.markDomSelectionChurn();
		this.edytor.cells?.remount(this.parent.id);
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

	private _setItems = (items: TextRunItem[]) => {
		// This render rewrites the span's DOM — a live DOM caret inside it
		// can be re-parked by the browser (Gecko clamps into a shortened
		// node). Mark eagerly: observer timing reports too late for engines
		// that dispatch `selectionchange` synchronously.
		this.edytor.markDomSelectionChurn();
		this._items = items;
		void tick().then(() => scheduleRemoveStalePlaceholders(this));
	};

	/** A text wrapper a reconcile binds next. */
	constructor({ parent }: { parent: Block }) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.id = id('t');
		this.edytor.idToText.set(this.id, this);
	}

	// ── segment writes ───────────────────────────────────────────────────
	//
	// `insertAt`/`deleteAt`/`formatAt` are the offset-based primitives the
	// operation layer (`text.utils`), event handlers and plugins call. A live
	// wrapper writes through its block's model (`segStart + offset`); the
	// wrapper's items follow at the commit (its change report, R3). Offsets
	// are SEGMENT-LOCAL display atoms (UTF-16 units).

	/** Insert `text` (optionally marked) at segment-local `offset`. */
	insertAt = (offset: number, text: string, marks?: Record<string, unknown> | null): boolean =>
		this._live &&
		accepted(this.parent.model?.insertText(this.segStart + offset, text, marks ?? undefined));

	/** Delete `length` atoms at segment-local `offset`. */
	deleteAt = (offset: number, length: number): boolean =>
		this._live && accepted(this.parent.model?.deleteText(this.segStart + offset, length));

	/** Multi-mark format over `[offset, offset+length)` — `null` values remove the mark. */
	formatAt = (offset: number, length: number, attributes: Record<string, unknown>): boolean =>
		this._live && accepted(this.parent.model?.format(this.segStart + offset, length, attributes));

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
