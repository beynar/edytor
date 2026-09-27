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
 * `TextAnchor` wire shape — `selection.createTextAnchor`/`resolveTextAnchor`
 * take and return these; kept structural here to avoid a module cycle.
 */
type CompositionAnchor = ReturnType<Edytor['selection']['createTextAnchor']>;

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
	/**
	 * Merged render deltas captured when the pin engaged — the exact DOM
	 * the IME anchored to — with the tracked composition region spliced
	 * OUT so the live preview can be re-injected per keystroke.
	 */
	baseDeltas: JSONDelta[];
	/**
	 * Offset inside `baseDeltas` where the preview run is spliced — DOM
	 * space, constant for the session (the model-space start lives on
	 * `compositionState.startOffset`, tracked by anchors).
	 */
	previewOffset: number;
	/**
	 * Caret anchor captured during the compositionstart→first-beforeinput
	 * window (no `compositionState` yet) so a remote edit landing in that
	 * window still resolves the real model position for the first write.
	 */
	caretAnchor: CompositionAnchor;
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
	 * Live composition render pin — see {@link CompositionPin}. Acquired
	 * lazily by `_acquireCompositionPin` (from `onCompositionStart`, remote
	 * `_setItems` and local write paths), released lazily the first sync
	 * after `edytor.compositionText` no longer resolves to this wrapper.
	 */
	_compositionPin: CompositionPin | null = null;
	/** The pinned render output (`renderChildren` while locked), `$state` so the template re-reads it. */
	private _pinnedDeltas = $state<JSONDelta[] | null>(null);

	/**
	 * Pending-carrier aliases that resolve to this wrapper (D21) — when a
	 * pending `insertParts` text carrier's atoms merge into this segment,
	 * `Block.reconcileContent` aliases the carrier's retired id here so
	 * in-flight references (`compositionState.textId`, deferred selection
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
		if (this._pinnedDeltas && this.edytor.isComposing && this.edytor.compositionText === this) {
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

	/**
	 * True while this wrapper's DOM node hosts the live composition — the
	 * pin is held AND the session still resolves to this wrapper (a remote
	 * split can hand the region to a sibling segment, releasing the pin).
	 */
	private get _compositionLocked(): boolean {
		return (
			this._compositionPin !== null &&
			this.edytor.isComposing &&
			this.edytor.compositionText === this
		);
	}

	/**
	 * Engage the composition render pin on this wrapper. `_items` keep
	 * tracking model truth (offsets/marks/commit math stay correct); only
	 * the DOM-facing surface freezes. Called once per session — subsequent
	 * calls are no-ops.
	 */
	_acquireCompositionPin = () => {
		const edytor = this.edytor;
		if (this._compositionPin || !edytor.isComposing || edytor.compositionText !== this) {
			return;
		}
		const state = edytor.compositionState;
		// `_items`/render still describe the DOM the IME anchored to — that
		// is the point of the pin. When a region is already tracked, splice
		// it out so the pinned base stays preview-free and the live preview
		// can be re-injected per keystroke at `previewOffset`.
		const regionLength = state ? (state.regionLength ?? state.value.length) : 0;
		const previewOffset = state
			? state.startOffset
			: edytor.selection.state.startText === this
				? edytor.selection.state.yStart
				: 0;
		const baseDeltas = spliceDeltaText(
			mergeRenderDeltas(this.children),
			previewOffset,
			regionLength
		);
		const baseLength = baseDeltas.reduce((n, delta) => n + delta.text.length, 0);
		this._compositionPin = {
			baseDeltas,
			previewOffset: Math.min(Math.max(0, previewOffset), baseLength),
			caretAnchor: null
		};
		edytor._compositionHostText = this;
		this._reanchorCompositionRegion();
	};

	/**
	 * Release the render pin and resync the DOM-facing surface to the model
	 * (`isEmpty`/`endsWithNewline` branches, deferred id rename, remote
	 * edits withheld while composing). Called by every composition exit
	 * path via `edytor._compositionHostText`; `syncDerived` also releases
	 * lazily when the session no longer resolves to this wrapper.
	 */
	_releaseCompositionPin = () => {
		if (!this._compositionPin && !this._pinnedDeltas) {
			return;
		}
		// `syncDerived` detects the dropped lock (`isComposing` is already
		// false on every release path) and clears the pin, applies the
		// deferred id rename, and resyncs `isEmpty`/render.
		this.syncDerived();
	};

	/**
	 * (Re)bind the composition region's CRDT anchors to the tracked
	 * `startOffset`/`regionLength` — called after every write that moves
	 * the region so remote edits resolve against the atoms that are
	 * actually there. `left` affinity on the start anchor + `right` on the
	 * end keeps OUR OWN preview writes inside the region (deletes shrink
	 * it, inserts grow it); remote inserts exactly at an edge are absorbed
	 * and clobbered at commit — a safe failure direction.
	 */
	private _reanchorCompositionRegion = () => {
		const pin = this._compositionPin;
		const edytor = this.edytor;
		const state = edytor.compositionState;
		if (!pin || !this._live) {
			return;
		}
		if (state && edytor.compositionText === this) {
			state.startAnchor = edytor.selection.createTextAnchor(this, state.startOffset, 'left');
			state.endAnchor = edytor.selection.createTextAnchor(
				this,
				state.startOffset + (state.regionLength ?? state.value.length),
				'right'
			);
		} else if (!state && edytor.selection.state.startText === this) {
			// Prefer the selection's maintained anchor — `relativePosition`
			// already rides remote edits, so a remote insert landing between
			// compositionstart and the first beforeinput can't strand the
			// caret position.
			pin.caretAnchor =
				edytor.selection.state.relativePosition ??
				edytor.selection.createTextAnchor(this, edytor.selection.state.yStart, 'left');
		}
	};

	/**
	 * Remote/programmatic writes landed on the host: re-resolve the region
	 * anchors and update `compositionState` in place so commit/cancel
	 * offsets track the atoms the preview actually occupies. When the
	 * region's atoms migrated to another segment (remote split/merge), the
	 * session is handed to that wrapper and this pin releases.
	 */
	private _syncCompositionRegion = () => {
		const edytor = this.edytor;
		const state = edytor.compositionState;
		if (!state || !this._compositionPin) {
			return;
		}
		const region = edytor.resolveCompositionRegion();
		if (!region) {
			return;
		}
		if (region.text !== this) {
			state.textId = region.text.id;
			state.startOffset = region.startOffset;
			state.regionLength = region.length;
			this._compositionPin = null;
			return;
		}
		state.startOffset = region.startOffset;
		state.regionLength = region.length;
	};

	/**
	 * Map an offset the caller derived from the (possibly DOM-frozen)
	 * selection onto the live model — while pinned, `yStart`-style offsets
	 * are DOM-space and stale after remote edits; the region anchors carry
	 * the true positions. Only offsets that target the tracked region
	 * start are remapped; everything else passes through untouched.
	 */
	private _resolveCompositionOffset = (offset: number): number => {
		const edytor = this.edytor;
		const state = edytor.compositionState;
		const pin = this._compositionPin;
		if (!pin || !edytor.isComposing || edytor.compositionText !== this) {
			return offset;
		}
		const isStateTarget = state !== null && offset === state.startOffset;
		const isWindowTarget = state === null && offset === pin.previewOffset;
		if (!isStateTarget && !isWindowTarget) {
			return offset;
		}
		// Region-start anchors first; in the compositionstart→first-input
		// window (no state) the pin's caret anchor is the only model-true
		// position left.
		const anchor = state ? (state.startAnchor ?? pin.caretAnchor) : pin.caretAnchor;
		const resolved = anchor ? edytor.selection.resolveTextAnchor(anchor) : null;
		if (resolved && resolved.text === this) {
			if (state) {
				state.startOffset = resolved.offset;
			}
			return resolved.offset;
		}
		if (state) {
			const region = edytor.resolveCompositionRegion();
			if (region && region.text === this) {
				state.startOffset = region.startOffset;
				return region.startOffset;
			}
		}
		return offset;
	};

	/**
	 * Map a model-space offset to the pinned DOM-space offset (identity
	 * outside the lock). Used for mid-composition caret writes, which must
	 * address the DOM the IME sees — pinned base + preview — not the
	 * post-remote model string.
	 */
	toCompositionDomOffset = (offset: number): number => {
		const pin = this._compositionPin;
		const state = this.edytor.compositionState;
		if (!this._compositionLocked || !pin || !state) {
			return offset;
		}
		return Math.max(0, pin.previewOffset + (offset - state.startOffset));
	};

	private syncDerived = () => {
		const wasEmpty = this.isEmpty;
		const locked = this._compositionLocked;
		if (!locked && (this._compositionPin || this._pinnedDeltas)) {
			this._compositionPin = null;
			this._pinnedDeltas = null;
			if (this.edytor._compositionHostText === this) {
				this.edytor._compositionHostText = null;
			}
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
			// render surface is the pinned base + the live preview
			// re-spliced at `previewOffset` — remote/model churn outside the
			// region never reaches the DOM — and `domVersion` is never
			// bumped, so the content each-key can't remount the span under
			// the IME.
			const pin = this._compositionPin;
			const state = this.edytor.compositionState;
			const previewDelta: JSONDelta | undefined = state?.value
				? {
						text: state.value,
						marks: compositionMarksToDeltaMarks(state.marks),
						id: COMPOSITION_PREVIEW_DELTA_ID
					}
				: undefined;
			this._pinnedDeltas = mergeRenderDeltas(
				spliceDeltaText(pin.baseDeltas, pin.previewOffset, 0, previewDelta)
			);
			this.stringContent = this._items.map((item) => item.text).join('');
			this.isEmpty = isEmpty;
			this.endsWithNewline = this.stringContent.endsWith('\n');
			// Region atoms may have moved (our own rewrite) — rebind anchors.
			this._reanchorCompositionRegion();
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
		// Acquire the pin BEFORE `_items` updates — the pinned base must
		// capture the pre-write render (the DOM the IME anchored to).
		this._acquireCompositionPin();
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
		// `insertAt`/`deleteAt` reach here directly (bypassing `_setItems`) —
		// keep the tracked region honest after our own writes too.
		this._syncCompositionRegion();
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
		// A remote/programmatic split can rebind this wrapper to a new
		// segment ordinal mid-composition — keep the session's `textId`
		// pointing at the same node so the pin + commit writes follow.
		// (When the rename was deferred this is a no-op: `this.id` still
		// holds `oldId`, which `idToText` keeps resolving to us.)
		const compositionState = this.edytor.compositionState;
		if (compositionState && compositionState.textId === oldId) {
			compositionState.textId = this.id;
		}
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
		// Pin BEFORE applying — the pinned base must capture the pre-change
		// render (the DOM the IME anchored to). Then track the region so
		// `compositionState.startOffset`/`regionLength` stay model-true.
		this._acquireCompositionPin();
		// This render rewrites the span's DOM — a live DOM caret inside it
		// can be re-parked by the browser (Gecko clamps into a shortened
		// node). Mark eagerly: observer timing reports too late for engines
		// that dispatch `selectionchange` synchronously.
		this.edytor.markDomSelectionChurn();
		this._items = items;
		this._syncCompositionRegion();
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
		offset = this._resolveCompositionOffset(offset);
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
		const state = this.edytor.compositionState;
		if (
			this._compositionLocked &&
			state &&
			offset === state.startOffset &&
			(length === state.value.length || length === (state.regionLength ?? state.value.length))
		) {
			// Region delete — resolve the anchor-tracked START so remote
			// edits that shifted the region don't delete neighbours. The
			// caller's `length` stands: preview updates delete `value.length`
			// atoms; the commit passes the full resolved `region.length` so
			// remote text absorbed inside the region is clobbered too.
			const region = this.edytor.resolveCompositionRegion();
			if (region && region.text === this) {
				offset = region.startOffset;
				state.startOffset = region.startOffset;
				state.regionLength = region.length;
			}
		}
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
