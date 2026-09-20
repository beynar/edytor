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
import { deltaToJson, jsonToDelta, runsToDeltas, type JSONDelta } from './deltas.js';
import { id } from '$lib/utils.js';
import { climb } from '$lib/selection/selection.utils.js';
import { scheduleRemoveStalePlaceholders } from './removeStalePlaceholders.js';
import type { ContentItem } from '$lib/crdt/index.js';
import type { YTextLike } from '$lib/crdt/compat.js';

export type TextRunItem = { text: string; marks?: Record<string, unknown> };
type Observer = (event: unknown, transaction: unknown) => void;

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
	yText: YTextLike;
	edytor: Edytor;
	stringContent = $state('');
	index = $state(0);
	node: HTMLElement | undefined;
	// Used to add en empty string in the DOM if the text is empty in order to be abble to focus on it.
	isEmpty = $state(false);
	// Used to add en empty string at the end of the text if it ends with a newline in order to visually render the newline.
	endsWithNewline = $state(false);
	domVersion = $state(0);
	// Used when user toggles mark without selection range.
	markOnNextInsert: undefined | Record<string, SerializableContent | null> = undefined;
	id: string;
	#children = $state<JSONDelta[]>([]);

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
	_observers = new Set<Observer>();

	get value(): JSONText[] {
		return deltaToJson(this.#children);
	}

	get length() {
		return this._items.reduce((n, item) => n + item.text.length, 0);
	}

	get children() {
		const transformer = this.parent.definition.transformText;
		return transformer
			? jsonToDelta(transformer({ text: this, block: this.parent, content: this.value }))
			: this.#children;
	}

	set children(value: JSONDelta[]) {
		this.#children = value;
	}

	/** Display offset of this segment inside the parent block's content (atoms). */
	get segStart() {
		return this.parent.partOffsetOf(this);
	}

	get isInDocument() {
		return this._live && this.parent.content.includes(this);
	}

	private syncDerived = () => {
		const wasEmpty = this.isEmpty;
		this.stringContent = this._items.map((item) => item.text).join('');
		[this.#children, this.isEmpty] = runsToDeltas(this._items);
		this.endsWithNewline = this.stringContent.endsWith('\n');
		if (wasEmpty !== this.isEmpty) {
			this.domVersion += 1;
		}
	};

	refreshFromModel = () => {
		this.refreshFromProject();
		this.domVersion += 1;
	};

	syncFromModel = () => {
		this.refreshFromProject();
	};

	/** Re-derive `_items` from the facade's current projection (mid-transaction safe). */
	refreshFromProject = () => {
		if (!this._live || !this.parent._bound || this.parent._blockId == null) {
			this.syncDerived();
			return;
		}
		const node = this.edytor.projectedBlock(this.parent._blockId);
		if (!node) {
			this.syncDerived();
			return;
		}
		const textParts = this.parent
			.deriveContentParts(node.content)
			.filter((part) => part.kind === 'text');
		const mine = textParts[this._segOrd];
		if (mine && mine.kind === 'text') {
			this._items = mine.items;
		}
		this.syncDerived();
	};

	/** Bind this wrapper to segment `segOrd` of the parent (reconcile/adoption path). */
	_bind = (segOrd: number, items: TextRunItem[]) => {
		const oldId = this.id;
		this._segOrd = segOrd;
		this._live = true;
		const nextId = `t:${this.parent._blockId ?? 'detached'}:${segOrd}`;
		if (nextId !== this.id) {
			this.id = nextId;
			if (this.edytor.idToText.get(oldId) === this) {
				this.edytor.idToText.delete(oldId);
			}
		}
		this.edytor.idToText.set(this.id, this);
		this._setItems(items);
	};

	/** Mark the wrapper dead — the segment it mirrored no longer exists. */
	_kill = () => {
		this._live = false;
		this._segOrd = -1;
		this._items = [];
		this.syncDerived();
		if (this.edytor.idToText.get(this.id) === this) {
			this.edytor.idToText.delete(this.id);
		}
		if (this.node) {
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
		this._items = items;
		const change = this.edytor._mirrorChange;
		if (change && change.origin !== this.edytor.transaction) {
			// Remote/programmatic changes keep the cached model selection in sync.
			this.edytor.selection.restoreRelativePosition(this);
		}
		this.syncDerived();
		for (const cb of this._observers) {
			cb({ target: this.yText }, { origin: change?.origin });
		}
		void tick().then(() => scheduleRemoveStalePlaceholders(this));
	};

	private _observeText = (_event: unknown, _transaction: unknown): void => {
		// Compat shim — the real work happens in `_setItems` during reconcile.
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
				.map((item) => ({ text: item.text, ...(item.marks ? { marks: item.marks } : {}) }));
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
		this.yText = this.createAdapter();
		this.syncDerived();
		this.edytor.idToText.set(this.id, this);

		if (!this.edytor.readonly) {
			this.yText.observe(this._observeText);
		}
	}

	private createAdapter = (): YTextLike => {
		// Adapter getters/method shorthand rebind `this` to the adapter
		// object, so the wrapper instance is captured explicitly.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const bound = () => self._live && self.parent._bound === true;
		const blockId = () => self.parent._blockId as string;
		const facade = () => self.edytor.facade!;
		const bufferMutate = () => {
			self.syncDerived();
			for (const cb of self._observers) {
				cb({ target: self.yText }, { origin: self.edytor.transaction });
			}
		};
		const adapter: YTextLike & { __compatKind: 'text'; __owner: Text } = {
			__compatKind: 'text',
			__owner: self,
			get length() {
				return self.length;
			},
			get doc() {
				return bound() ? self.edytor.doc : null;
			},
			get _item() {
				return { id: null, deleted: !bound() };
			},
			insert(offset, text, marks) {
				// JSON-payload contract: no `marks: undefined` key.
				const insertItem: { text: string; marks?: Record<string, unknown> } = {
					text,
					...(marks != null ? { marks: marks as Record<string, unknown> } : {})
				};
				if (bound()) {
					const applied = facade().insertText(
						blockId(),
						self.segStart + offset,
						text,
						insertItem.marks
					);
					// The facade's maintained runs view only refreshes at commit —
					// update `_items` optimistically so `toJSON`/`length`/`value`
					// reflect writes made earlier in the same transaction (v13
					// `Y.Text` read-your-writes semantics). The mirror reconcile
					// overwrites this with the authoritative projection at commit.
					if (applied) {
						self._items = spliceTextItems(self._items, offset, 0, insertItem);
						self.syncDerived();
					}
				} else {
					self._items = spliceTextItems(self._items, offset, 0, insertItem);
					bufferMutate();
				}
			},
			delete(offset, length) {
				if (bound()) {
					const applied = facade().deleteText(blockId(), self.segStart + offset, length);
					if (applied) {
						self._items = spliceTextItems(self._items, offset, length);
						self.syncDerived();
					}
				} else {
					self._items = spliceTextItems(self._items, offset, length);
					bufferMutate();
				}
			},
			format(offset, length, attributes) {
				if (bound()) {
					const applied = facade().formatRange(
						blockId(),
						self.segStart + offset,
						length,
						attributes
					);
					if (applied) {
						self._items = formatTextItems(self._items, offset, length, attributes);
						self.syncDerived();
					}
				} else {
					self._items = formatTextItems(self._items, offset, length, attributes);
					bufferMutate();
				}
			},
			applyDelta(deltas) {
				let offset = 0;
				for (const delta of deltas as Record<string, any>[]) {
					if (typeof delta.retain === 'number') {
						if (delta.attributes) {
							this.format(offset, delta.retain, delta.attributes);
						}
						offset += delta.retain;
					}
					if (typeof delta.delete === 'number') {
						this.delete(offset, delta.delete);
					}
					if (typeof delta.insert === 'string') {
						this.insert(offset, delta.insert, delta.attributes);
						offset += delta.insert.length;
					} else if (delta.insert !== undefined) {
						offset += 1;
					}
				}
			},
			toJSON() {
				return self.stringContent;
			},
			toString() {
				return self.stringContent;
			},
			getAttribute(name) {
				return name === 'id' ? self.id : undefined;
			},
			setAttribute() {
				// ids are wrapper-derived; attr writes are inert.
			},
			observe: (cb) => {
				self._observers.add(cb);
			},
			unobserve: (cb) => {
				self._observers.delete(cb);
			},
			hasObservers: () => self._observers.size > 0
		};
		return adapter;
	};

	private batch = batch.bind(this);
	getMarksAtRange = getMarksAtRange.bind(this);
	insertText = this.batch('insertText', insertText.bind(this));
	deleteText = this.batch('deleteText', deleteText.bind(this));
	splitText = this.batch('splitText', splitText.bind(this));
	setText = this.batch('setText', setText.bind(this));
	markText = this.batch('markText', markText.bind(this));
	removeMarksFromText = this.batch('removeMarksFromText', removeMarksFromText.bind(this));

	private hasObserver = () => {
		return this._observers.has(this._observeText);
	};

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.idToText.set(this.id, this);
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		if (!this.edytor.readonly && !this.hasObserver()) {
			this.yText.observe(this._observeText);
		}

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

		return {
			destroy: () => {
				if (this.node === node) {
					if (this.hasObserver()) {
						this.yText.unobserve(this._observeText);
					}
					this.node = undefined;
					if (this.edytor.idToText.get(this.id) === this) {
						this.edytor.idToText.delete(this.id);
					}
				}
				this.edytor.nodeToText.delete(node);
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
