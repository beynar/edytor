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
import {
	deltaToJson,
	jsonToDelta,
	mergeRenderDeltas,
	runsToDeltas,
	type JSONDelta,
	type Mark
} from './deltas.js';
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

/**
 * Render pin held while this wrapper's DOM node hosts a live composition
 * (G2/G10 — the "composition node lock"). Svelte's keyed `{#each}` over
 * `renderChildren` would otherwise rewrite — and `domVersion` bumps would
 * remount — the very text nodes the IME is anchored to whenever a remote
 * or programmatic model change lands mid-composition. The pin freezes the
 * BASE render (the DOM the IME anchored to) while re-splicing the live
 * preview delta at `previewOffset` each sync — the preview mirrors what
 * the browser already wrote, so those `{delta.text}` updates are the
 * established baseline; remote/model churn outside the region never
 * reaches the DOM.
 */
type CompositionPin = {
	/** The render when the pin engaged (and its empty filler): kept while the browser itself shows the preview. */
	frozen: JSONDelta[];
	empty: boolean;
	/**
	 * Merged render deltas captured when the pin engaged — the exact DOM
	 * the IME anchored to — with the replaced start target spliced OUT so
	 * the live preview can be re-injected per keystroke.
	 */
	baseDeltas: JSONDelta[];
	/** Offset inside `baseDeltas` where the preview run is spliced — DOM space, constant for the session. */
	previewOffset: number;
};

const COMPOSITION_PREVIEW_DELTA_ID = 'edytor-composition-preview';

const compositionMarksToDeltaMarks = (
	marks: Record<string, SerializableContent | null> | undefined
): Mark[] =>
	marks
		? (Object.entries(marks).filter(([, value]) => value !== null && value !== undefined) as Mark[])
		: [];

/** Splice `deleteLen` chars out of a delta list at `offset`, optionally inserting a delta. */
const spliceDeltaText = (
	deltas: readonly JSONDelta[],
	offset: number,
	deleteLen: number,
	insert?: JSONDelta
): JSONDelta[] => {
	const out: JSONDelta[] = [];
	let pos = 0;
	let inserted = false;
	const pushInsert = () => {
		if (!inserted && insert && insert.text.length > 0) {
			out.push({ ...insert, marks: [...insert.marks] });
		}
		inserted = true;
	};
	for (const delta of deltas) {
		const start = pos;
		const end = pos + delta.text.length;
		pos = end;
		if (end <= offset || start >= offset + deleteLen) {
			out.push({ ...delta, marks: [...delta.marks] });
			continue;
		}
		const head = delta.text.slice(0, Math.max(0, offset - start));
		const tail = delta.text.slice(Math.min(delta.text.length, offset + deleteLen - start));
		if (head) out.push({ text: head, marks: [...delta.marks], id: delta.id });
		if (start <= offset && offset <= end) pushInsert();
		if (tail) out.push({ text: tail, marks: [...delta.marks], id: delta.id });
	}
	pushInsert();
	return out;
};

export class Text {
	readonly = false;
	parent: Block;
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

	/**
	 * Live composition render pin — see {@link CompositionPin}. Acquired by
	 * the composition session at its start, released at its end.
	 */
	_compositionPin: CompositionPin | null = null;
	/** The pinned render output (`renderChildren` while locked), `$state` so the template re-reads it. */
	private _pinnedDeltas = $state<JSONDelta[] | null>(null);

	/**
	 * Pending-carrier aliases that resolve to this wrapper (D21) — when a
	 * pending `insertParts` text carrier's atoms merge into this segment,
	 * `Block.reconcileContent` aliases the carrier's retired id here so
	 * in-flight references (deferred selection
	 * restores, pending-adoption lookups) still resolve. Purged in `_kill`
	 * so a dead id can never resolve to a dead wrapper.
	 */
	_pendingAliases: Set<string> | undefined;

	/**
	 * Memoized `transformText` output (D20) — keyed on the SOURCE delta
	 * identity (`#children` is replaced wholesale by `syncDerived`), the
	 * transformer identity (a block type change re-resolves `definition`,
	 * changing the transformer reference) and `parent.data` identity (all
	 * block-data writes go through `setData`/`_reconcileMeta`, which swap
	 * the object). Without it every `children`/`renderChildren` read re-ran
	 * the transform — e.g. Prism tokenization per access per render pass.
	 */
	private _transformCache: {
		source: JSONDelta[];
		transformer: (payload: { text: Text; block: Block; content: JSONText[] }) => JSONText[];
		data: Record<string, unknown>;
		result: JSONDelta[];
	} | null = null;

	/**
	 * Memoized `mergeRenderDeltas` output — keyed on the `children` array
	 * identity, so repeated `renderChildren` reads share the merge instead
	 * of rebuilding it (and re-allocating delta ids) per access.
	 */
	private _renderCache: { source: JSONDelta[]; result: JSONDelta[] } | null = null;

	get value(): JSONText[] {
		return deltaToJson(this.#children);
	}

	get length() {
		return this._items.reduce((n, item) => n + item.text.length, 0);
	}

	get children() {
		const transformer = this.parent.definition.transformText;
		if (!transformer) {
			return this.#children;
		}
		const parentData = this.parent.data;
		const cache = this._transformCache;
		if (
			cache &&
			cache.source === this.#children &&
			cache.transformer === transformer &&
			cache.data === parentData
		) {
			return cache.result;
		}
		const result = jsonToDelta(
			transformer({ text: this, block: this.parent, content: this.value })
		);
		this._transformCache = {
			source: this.#children,
			transformer,
			data: parentData,
			result
		};
		return result;
	}

	/**
	 * Render deltas — `children` with adjacent same-mark parts merged so
	 * the DOM keeps one mark element per visual run.
	 *
	 * While `_compositionPin` is live this returns the PINNED render (the
	 * DOM the IME anchored to + the current preview run), so remote/model
	 * churn in `#children` never reaches the composition's text nodes.
	 */
	get renderChildren() {
		if (this._pinnedDeltas && this.edytor.composition.host === this) {
			return this._pinnedDeltas;
		}
		const children = this.children;
		if (this._renderCache?.source === children) {
			return this._renderCache.result;
		}
		const result = mergeRenderDeltas(children);
		this._renderCache = { source: children, result };
		return result;
	}

	set children(value: JSONDelta[]) {
		this.#children = value;
	}

	/**
	 * Display offset of this segment inside the parent block's content (atoms).
	 *
	 * Scoped counterpart of `Block.partOffsetOf` — the same projected-parts
	 * lookup over `facade.contentItems(blockId)` (O(this block's content),
	 * transaction-aware) instead of `projectedBlock`'s `facade.project()` +
	 * whole-tree index walk (O(document) per version bump). `segStart` is
	 * read on every keystroke by the typed mutation surface
	 * (`insertAt`/`deleteAt`/`formatAt`) and by selection anchors
	 * (`createTextAnchor`), so keeping it on the full tree would reintroduce
	 * the per-keystroke O(document) rebuild the scoped refresh removed.
	 *
	 * The part→offset mapping mirrors `partOffsetOf` exactly (text branch
	 * only): locate the part among the CURRENT projected parts by `segOrd`,
	 * fall back to its mirror position in `parent.content` when the
	 * projection hasn't adopted it (pending carriers / stale `_segOrd`),
	 * then to a plain mirror walk when the block isn't bound/visible.
	 */
	get segStart() {
		const parent = this.parent;
		const blockId = parent._blockId;
		const facade = this.edytor.facade;
		if (parent._bound && blockId != null && facade.isVisibleBlock(blockId)) {
			const parts = parent.deriveContentParts(facade.contentItems(blockId));
			let index = parts.findIndex((p) => p.kind === 'text' && p.segOrd === this._segOrd);
			if (index === -1) {
				const mirrorIndex = parent.content.indexOf(this);
				if (mirrorIndex !== -1 && mirrorIndex < parts.length) {
					index = mirrorIndex;
				}
			}
			if (index !== -1) {
				let off = 0;
				for (let i = 0; i < index; i++) {
					const p = parts[i];
					off += p.kind === 'text' ? p.items.reduce((n, item) => n + item.text.length, 0) : 1;
				}
				return off;
			}
		}
		let off = 0;
		for (const p of parent.content) {
			if (p === this) return off;
			off += p instanceof Text ? p.length : 1;
		}
		return off;
	}

	get isInDocument() {
		return this._live && this.parent.content.includes(this);
	}

	/** True while this wrapper's DOM node hosts the live composition session. */
	private get _compositionLocked(): boolean {
		return this._compositionPin !== null && this.edytor.composition.host === this;
	}

	/**
	 * Engage the composition render pin: the DOM-facing surface freezes on
	 * the render the IME anchored to, without `[from, to)` (the start target
	 * the session replaces); `_items` keep tracking model truth.
	 */
	_acquireCompositionPin = (from: number, to = from) => {
		if (this._compositionPin) return;
		const previewOffset = Math.max(0, Math.min(from, this.length));
		const frozen = mergeRenderDeltas(this.children);
		const baseDeltas = spliceDeltaText(frozen, previewOffset, Math.max(0, to - previewOffset));
		this._compositionPin = { frozen, empty: this.isEmpty, baseDeltas, previewOffset };
	};

	/** Release the pin and resync the render to the model (withheld edits, deferred id rename). */
	_releaseCompositionPin = () => {
		if (this._compositionPin || this._pinnedDeltas) this.syncDerived();
	};

	/** What the IME shows in the pinned host: its DOM text between the pinned base's two sides. */
	_imeBuffer = (): string | null => {
		const pin = this._compositionPin;
		if (!pin || !this.node) return null;
		const dom = (this.node.textContent ?? '').replace(/\u200B/g, '');
		const base = pin.baseDeltas.map((delta) => delta.text).join('');
		const at = pin.previewOffset;
		const tail = base.length - at;
		if (dom.length < base.length || !dom.startsWith(base.slice(0, at))) return null;
		if (!dom.endsWith(base.slice(at))) return null;
		return dom.slice(at, dom.length - tail);
	};

	private syncDerived = () => {
		const wasEmpty = this.isEmpty;
		const locked = this._compositionLocked;
		if (!locked && (this._compositionPin || this._pinnedDeltas)) {
			this._compositionPin = null;
			this._pinnedDeltas = null;
			// Apply the id rename deferred while pinned — the content
			// each-key may remount the span safely now (composition over).
			const nextId = `t:${this.parent._blockId ?? 'detached'}:${this._segOrd}`;
			if (this._live && nextId !== this.id) {
				const oldId = this.id;
				this.id = nextId;
				if (this.edytor.idToText.get(oldId) === this) {
					this.edytor.idToText.delete(oldId);
				}
				this.edytor.idToText.set(nextId, this);
			}
		}
		const [children, isEmpty] = runsToDeltas(this._items);
		this.#children = children;
		if (locked && this._compositionPin) {
			// `#children`/`stringContent`/`isEmpty`/`endsWithNewline` stay
			// MODEL-TRUE — the preview atoms are in the model, so the
			// mutation observer sees the browser's preview DOM as in-sync
			// and caret writes (`setAtTextOffset`) map to real offsets. The
			// render surface is frozen while the browser shows the preview
			// itself (the IME's node is never rewritten), else the pinned
			// base + the preview re-spliced at `previewOffset` — remote/model
			// churn outside the region never reaches the DOM — and
			// `domVersion` is never bumped, so the content each-key can't
			// remount the span under the IME.
			const pin = this._compositionPin;
			const { preview, marks, native } = this.edytor.composition;
			const previewDelta: JSONDelta | undefined = preview
				? {
						text: preview,
						marks: compositionMarksToDeltaMarks(
							marks as Record<string, SerializableContent | null>
						),
						id: COMPOSITION_PREVIEW_DELTA_ID
					}
				: undefined;
			this._pinnedDeltas = native
				? pin.frozen
				: mergeRenderDeltas(spliceDeltaText(pin.baseDeltas, pin.previewOffset, 0, previewDelta));
			this.stringContent = this._items.map((item) => item.text).join('');
			// The empty filler is the node the IME composes into: kept with the frozen render.
			this.isEmpty = native ? pin.empty : isEmpty;
			this.endsWithNewline = this.stringContent.endsWith('\n');
			return;
		}
		this._pinnedDeltas = null;
		this.stringContent = this._items.map((item) => item.text).join('');
		this.isEmpty = isEmpty;
		this.endsWithNewline = this.stringContent.endsWith('\n');
		if (wasEmpty !== this.isEmpty) {
			this.domVersion += 1;
		}
	};

	refreshFromModel = () => {
		this.refreshFromProject();
		// `domVersion` is part of the content each-key — bumping it remounts
		// the span. Never bump while the composition pin holds: the IME owns
		// that DOM node until `compositionend`. The remount can re-park a
		// live DOM caret — mark the churn eagerly so a same-task
		// selectionchange echo is recognized as drift, not user intent.
		if (!this._compositionLocked) {
			this.edytor.markDomSelectionChurn();
			this.domVersion += 1;
		}
	};

	syncFromModel = () => {
		this.refreshFromProject();
	};

	/**
	 * Re-derive `_items` from the facade's current projection (mid-transaction safe).
	 *
	 * Scoped read: `facade.contentItems(blockId)` is the maintained per-block
	 * surface (transaction-aware via the shared model ctx — read-your-writes
	 * preserved), so a refresh costs O(this block's content) instead of
	 * `projectedBlock`'s `facade.project()` + whole-tree index walk — the old
	 * path did O(document) work per keystroke per text wrapper.
	 *
	 * `isVisibleBlock` carries the `projectedBlock → null` oracle the refresh
	 * relied on: hidden/deleted blocks keep their last-known `_items` (the
	 * pending reconcile kills the wrapper). `contentItems` alone cannot make
	 * that distinction — it emits `[]` for absent blocks AND for empty content.
	 */
	refreshFromProject = () => {
		if (!this._live || !this.parent._bound || this.parent._blockId == null) {
			this.syncDerived();
			return;
		}
		const blockId = this.parent._blockId;
		const facade = this.edytor.facade;
		if (!facade.isVisibleBlock(blockId)) {
			this.syncDerived();
			return;
		}
		const textParts = this.parent
			.deriveContentParts(facade.contentItems(blockId))
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
			if (this._compositionPin) {
				// `getContentKey` reads `this.id` — renaming now would remount
				// the span under the IME. Defer the rename until the pin
				// releases (`syncDerived` applies it); alias the new id so
				// atom-space lookups still land on this wrapper.
				this.edytor.idToText.set(nextId, this);
			} else {
				this.id = nextId;
				if (this.edytor.idToText.get(oldId) === this) {
					this.edytor.idToText.delete(oldId);
				}
			}
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
		this.syncDerived();
		if (this.edytor.idToText.get(this.id) === this) {
			this.edytor.idToText.delete(this.id);
		}
		// Pending-carrier aliases owned by this wrapper die with it (D21) —
		// a dead id resolving to a dead wrapper is worse than no resolution.
		if (this._pendingAliases) {
			for (const aliasId of this._pendingAliases) {
				if (this.edytor.idToText.get(aliasId) === this) {
					this.edytor.idToText.delete(aliasId);
				}
			}
			this._pendingAliases.clear();
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
		const change = this.edytor._mirrorChange;
		if (change && change.origin !== this.edytor.transaction && !this._compositionLocked) {
			// Remote/programmatic changes keep the cached model selection in sync.
			// Skipped while the composition pin holds — the composition owns
			// the caret; writing the DOM selection mid-composition disturbs IMEs.
			this.edytor.selection.restoreRelativePosition(this);
		}
		this.syncDerived();
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
		this.syncDerived();
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
		this.syncDerived();
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
		this.syncDerived();
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
		this.syncDerived();
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
		// A dead-endpoint recovery deferred because its destination was not
		// yet mounted completes now — the DOM node it needed exists.
		this.edytor.selection?.notifyTextMounted();

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
