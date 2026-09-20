/**
 * Maintained run view (U05) — a block's visible content as ordered,
 * immutable run objects, kept current by engine events instead of
 * whole-document recomputation.
 *
 * A *run* is one {@link ContentItem}: a text span with its mark set, or one
 * inline atom. `view.runs(b)` returns a frozen snapshot array; consumers may
 * key renderers on run-object identity — unaffected runs are reused
 * verbatim across recomputes (prefix/suffix structural sharing), and equal
 * mark/data objects are interned so `===` holds for unchanged formatting.
 *
 * Invalidation (see `docs/crdt-v14-richtext-adr.md` for the full contract):
 *
 * - One `observeDeep` on the registry node delivers `event.deltaDeep` — a
 *   nested modify-delta whose root `attrs` are keyed by block id and whose
 *   per-block `attrs` name the changed facets (`content`, `slices`, `del`,
 *   `at`, payload). A text edit produces a `content` facet; ownership
 *   changes produce `slices`/`del` facets.
 * - Forward dependencies: every cached block records which backing TEXTS
 *   its flatten consulted and which SLICE LISTS it walked. Reverse effects:
 *   every slice list records which texts its records ever covered and which
 *   blocks its merge claims ever targeted (union — never shrunk, so removed
 *   records still invalidate their old range).
 * - `content` change on block X → rebuild X's atom-ownership row +
 *   invalidate blocks consulting text X. `slices`/`del` change on X →
 *   bump the ownership structure version (lazy owner recompute) +
 *   invalidate every consumer of X's effects.
 * - `at`/payload facets are ignored — a move does not change content.
 *
 * Ownership is maintained lazily: the `ownerOf` map rebuilds only after
 * structural events; per-text atom rows rebuild only for touched texts.
 * Runs themselves recompute lazily on read (plus eagerly for blocks with
 * `subscribeBlock` listeners).
 *
 * Delta-cache contract (probed in `tests/crdt/runs/delta-contract.test.ts`):
 * `node.delta` is the engine-maintained LIVE cache — authoritative once the
 * node is integrated, but mutable and shared: NEVER mutate it, NEVER hold
 * it as a snapshot (`clone()` at boundaries), and NEVER read it on a
 * detached node (a pre-integration read materializes an empty cache that is
 * never back-filled — poisoned until `clearCache()`). This module reads
 * `.delta` only through `itemsOfRange` on integrated nodes and snapshots
 * everything that crosses the API boundary.
 */
import type { EngineApi, EngineDeepEvent, EngineDoc, EngineNode } from '../engine-api.js';
import type { BlockId, ContentItem } from '../placement/model.js';
import { REGISTRY_KEY } from '../placement/model.js';
import {
	bindText,
	computeOwners,
	isMergeClaim,
	isSliceRecord,
	readSliceEntries,
	cmpStamp,
	type Owner,
	type SliceEntry,
	type SlicePayload,
	type Stamp,
	type TextBlockRec
} from './model.js';

/** One visible run of a block — the maintained form of `ContentItem`. */
export type ContentRun = ContentItem;

// ── local decorations (AN05) ────────────────────────────────────────────

/**
 * A LOCAL-ONLY decoration over a block's display positions — syntax
 * highlighting, spell-check squiggles, ephemeral suggestions. Decorations
 * are NEVER replicated: they live in a pure overlay computed from run
 * snapshots (`view.runs`/`view.snapshot`), so applying them writes nothing
 * to the document and emits no update.
 *
 * Offsets are display positions: a text character counts 1, an inline atom
 * counts 1 — the same unit as model-level text ops.
 */
export type LocalDecoration = {
	/** Inclusive start display offset. */
	from: number;
	/** Exclusive end display offset. */
	to: number;
	/** Decoration key, e.g. 'syntax.keyword' or 'spell'. */
	key: string;
	value: unknown;
};

/** A run with local decorations overlaid — the readonly render surface. */
export type DecoratedRun =
	| {
			kind: 'text';
			text: string;
			marks?: Record<string, unknown>;
			decorations?: Record<string, unknown>;
	  }
	| {
			kind: 'inline';
			id: string;
			type: string;
			data?: Record<string, unknown>;
			decorations?: Record<string, unknown>;
	  };

type JsonObj = Record<string, unknown>;

type AttrOp = { type?: string; value?: unknown };
type DeltaJSON = {
	type?: string;
	name?: string;
	attrs?: Record<string, AttrOp>;
	children?: unknown[];
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

const CONTENT = 'content';
const SLICES = 'slices';
const DEL = 'del';
const DEAD = 'dead';

/** Facets of a block node that can change the run projection. */
type Facet = 'content' | 'structure' | 'gone' | 'ignore';

const facetOf = (attr: string): Facet => {
	if (attr === CONTENT) return 'content';
	if (attr === SLICES || attr === DEL) return 'structure';
	// `at`/payload attrs never change a block's own content — moves and
	// data writes must not trigger run recomputes.
	if (attr === 'at' || attr === 'id' || attr === 'type' || attr === 'data') return 'ignore';
	// Unknown attr — a future schema extension; treat as structural so its
	// consumers recompute rather than silently serving stale runs.
	return 'structure';
};

const facetsOfBlockOp = (op: AttrOp | undefined): Set<Facet> => {
	const out = new Set<Facet>();
	if (!op || typeof op !== 'object') {
		out.add('structure');
		return out;
	}
	if (op.type === 'insert') {
		// New registry entry — its slices may carry records/claims onto
		// EXISTING texts (splitBlock tail materialization).
		out.add('content');
		out.add('structure');
		return out;
	}
	if (op.type === 'delete') {
		out.add('gone');
		return out;
	}
	const inner = (op.value ?? undefined) as DeltaJSON | undefined;
	const attrs = inner && typeof inner === 'object' ? inner.attrs : undefined;
	if (!attrs) {
		// Modify with no attr detail — cannot classify; invalidate safely.
		out.add('structure');
		out.add('content');
		return out;
	}
	for (const key of Object.keys(attrs)) out.add(facetOf(key));
	if (out.size === 0) out.add('ignore');
	return out;
};

/** Canonical JSON key for interning (sorted keys, recursive). */
const canonKey = (v: unknown): string => {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(canonKey).join(',')}]`;
	const keys = Object.keys(v as JsonObj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonKey((v as JsonObj)[k])}`).join(',')}}`;
};

const deepFreeze = <T>(v: T): T => {
	if (v !== null && typeof v === 'object') {
		for (const k of Object.keys(v as JsonObj)) deepFreeze((v as JsonObj)[k]);
		Object.freeze(v);
	}
	return v;
};

const runEquals = (a: ContentRun, b: ContentRun): boolean => {
	if (a === b) return true;
	if (a.kind !== b.kind) return false;
	if (a.kind === 'text' && b.kind === 'text') {
		return a.text === b.text && a.marks === b.marks;
	}
	if (a.kind === 'inline' && b.kind === 'inline') {
		return a.id === b.id && a.type === b.type && a.data === b.data;
	}
	return false;
};

const sameMarks = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): boolean => a === b || (a !== undefined && b !== undefined && canonKey(a) === canonKey(b));

/**
 * Canonicalize raw content items into runs: adjacent text items whose mark
 * sets are deep-equal merge into a single run (segment boundaries are not
 * observable at the run layer); inline atoms always stand alone. Shared by
 * the maintained view and the `computeAllRuns` baseline so "fresh" and
 * "maintained" agree on the SAME canonical shape.
 */
const mergeRuns = (items: readonly ContentItem[]): ContentRun[] => {
	const out: ContentRun[] = [];
	for (const item of items) {
		if (item.kind === 'text') {
			const last = out[out.length - 1];
			if (last && last.kind === 'text' && sameMarks(last.marks, item.marks)) {
				(last as { text: string }).text += item.text;
			} else {
				// JSON-payload contract: absent marks, not `marks: undefined`.
				out.push({
					kind: 'text',
					text: item.text,
					...(item.marks === undefined ? {} : { marks: item.marks })
				});
			}
		} else {
			out.push(item);
		}
	}
	return out;
};

type Deps = { texts: Set<string>; lists: Set<string> };

type Cached = { runs: readonly ContentRun[]; deps: Deps };

type AtomRow = {
	owners: (BlockId | undefined)[];
	claims: (SliceEntry | undefined)[];
	maxG: number;
	builtAt: number;
};

type Effects = { texts: Set<string>; lists: Set<string> };

export type RunViewDebug = {
	/** Total run recomputes since attach (or last `reset()`). */
	recomputes: number;
	/** Block ids recomputed since last `reset()`. */
	recomputed: Set<BlockId>;
	reset: () => void;
};

/**
 * The maintained view for one doc. All read methods are pure — they never
 * mutate replicated state and never attach listeners beyond the single
 * internal registry observer installed by `attach`.
 */
export type RunView = {
	/** Monotonic observed-change counter — bumps once per registry event. */
	version: () => number;
	/**
	 * Content-changed stamp for `id`: bumps only when the block's snapshot
	 * actually changed (a dirty marking that reconciles to identical runs
	 * does NOT bump). Ensures the recompute lazily.
	 */
	blockVersion: (id: BlockId) => number;
	/** Frozen snapshot of `id`'s visible runs (`[]` when absent/hidden). */
	runs: (id: BlockId) => readonly ContentRun[];
	/** Mutable deep copy of `runs(id)` — for callers that must own the data. */
	snapshot: (id: BlockId) => ContentRun[];
	/**
	 * Public JSON export — `[{text, marks?} | {id, type, data?}]` matching
	 * `JSONText | JSONInlineBlock` from `src/lib/utils/json.ts`. Marks are
	 * omitted when empty; `data` when absent.
	 */
	contentJSON: (
		id: BlockId
	) => (
		| { text: string; marks?: Record<string, unknown> }
		| { id?: string; type: string; data?: unknown }
	)[];
	/** Subscribe to every observed change — `cb(version)`. */
	subscribe: (cb: (version: number) => void) => () => void;
	/**
	 * Subscribe to ONE block's run changes — `cb(runs)` fires only when the
	 * recomputed snapshot actually differs. Blocks with subscribers recompute
	 * eagerly at event time; others recompute lazily on read.
	 */
	subscribeBlock: (id: BlockId, cb: (runs: readonly ContentRun[]) => void) => () => void;
	/** Detach the registry observer and drop all caches. */
	dispose: () => void;
	/** Instrumentation for tests/benchmarks. */
	debug: RunViewDebug;
};

export const bindRuns = (Y: EngineApi) => {
	const T = bindText(Y);

	/**
	 * One live view per doc. `attach` returns a LEASE handle per caller —
	 * releasing (disposing) a handle decrements the refcount and only the
	 * LAST release tears the shared view down (unobserveDeep + cache drop).
	 * The view also tears down on the doc's own `destroy` event. This is the
	 * gate-2 fix: disposing one facade must never kill the doc-shared view
	 * state other facades still read.
	 */
	type ViewRecord = { view: RunView; refs: number };
	const views = new WeakMap<EngineDoc, ViewRecord>();

	const attach = (doc: EngineDoc): RunView => {
		let rec = views.get(doc);
		if (rec === undefined) {
			rec = { view: buildView(doc), refs: 0 };
			views.set(doc, rec);
		}
		rec.refs++;
		let held = true;
		const release = (): void => {
			if (!held) return;
			held = false;
			if (--rec!.refs === 0) rec!.view.dispose();
		};
		const view = rec.view;
		return {
			version: () => view.version(),
			blockVersion: (b) => view.blockVersion(b),
			runs: (b) => view.runs(b),
			snapshot: (b) => view.snapshot(b),
			contentJSON: (b) => view.contentJSON(b),
			subscribe: (cb) => view.subscribe(cb),
			subscribeBlock: (b, cb) => view.subscribeBlock(b, cb),
			dispose: release,
			debug: view.debug
		};
	};

	const buildView = (doc: EngineDoc): RunView => {
		const registry = doc.get(REGISTRY_KEY);

		// ── incremental replicated-state indexes ─────────────────────────
		const blocks = new Map<BlockId, TextBlockRec>();
		/** Current entries read per slices-holder (drives recordsByText pruning). */
		const listEntries = new Map<BlockId, SliceEntry[]>();
		/** Per text: every CURRENT slice record covering it, by holder list. */
		const recordsByText = new Map<string, Map<BlockId, Set<SliceEntry>>>();
		/** Union-ever coverage/claim targets per slices-holder (never shrinks). */
		const effects = new Map<BlockId, Effects>();

		// ── forward dependencies of cached run snapshots ─────────────────
		const textConsumers = new Map<string, Set<BlockId>>();
		const listConsumers = new Map<BlockId, Set<BlockId>>();

		// ── lazily-maintained ownership ──────────────────────────────────
		let owners = new Map<BlockId, Owner>();
		/** `-1` forces the first `ensureOwners` to build (structureVersion is 0). */
		let ownersVersion = -1;
		/** Bumps on every slices/del/registry-structure event. */
		let structureVersion = 0;
		const dirtyTexts = new Set<string>();
		const atomRows = new Map<string, AtomRow>();
		const rangeCache = new WeakMap<SliceEntry, readonly [number, number] | null>();

		// ── run cache ────────────────────────────────────────────────────
		const cache = new Map<BlockId, Cached>();
		const dirty = new Set<BlockId>();
		const stamps = new Map<BlockId, number>();
		const internMap = new Map<string, unknown>();

		// ── subscribers ──────────────────────────────────────────────────
		let version = 0;
		const subs = new Set<(v: number) => void>();
		const blockSubs = new Map<BlockId, Set<(runs: readonly ContentRun[]) => void>>();

		const debug: RunViewDebug = {
			recomputes: 0,
			recomputed: new Set<BlockId>(),
			reset() {
				debug.recomputes = 0;
				debug.recomputed.clear();
			}
		};

		// ── interning / freezing ─────────────────────────────────────────
		const intern = <T>(v: T): T => {
			const key = canonKey(v);
			let f = internMap.get(key) as T | undefined;
			if (f === undefined) {
				f = deepFreeze(JSON.parse(JSON.stringify(v)) as T);
				internMap.set(key, f);
			}
			return f;
		};

		// ── replicated-state index maintenance ───────────────────────────

		const selfSlice = (id: BlockId): SliceEntry => ({
			payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
			stamp: { c: -1, k: -1 },
			seqIndex: 0,
			item: null
		});

		const removeRecordIndex = (t: string, holder: BlockId, e: SliceEntry) => {
			const byHolder = recordsByText.get(t);
			const set = byHolder?.get(holder);
			if (!set) return;
			set.delete(e);
			if (set.size === 0) {
				byHolder!.delete(holder);
				if (byHolder!.size === 0) recordsByText.delete(t);
			}
		};

		const addRecordIndex = (t: string, holder: BlockId, e: SliceEntry) => {
			let byHolder = recordsByText.get(t);
			if (!byHolder) {
				byHolder = new Map();
				recordsByText.set(t, byHolder);
			}
			let set = byHolder.get(holder);
			if (!set) {
				set = new Set();
				byHolder.set(holder, set);
			}
			set.add(e);
		};

		/** Re-index `id`'s current entries (recordsByText is pruned; effects union). */
		const indexEntries = (id: BlockId, entries: SliceEntry[]): void => {
			for (const e of listEntries.get(id) ?? []) {
				if (isSliceRecord(e.payload)) removeRecordIndex(e.payload.t, id, e);
			}
			listEntries.set(id, entries);
			let fx = effects.get(id);
			if (!fx) {
				fx = { texts: new Set(), lists: new Set() };
				effects.set(id, fx);
			}
			for (const e of entries) {
				if (isSliceRecord(e.payload)) {
					addRecordIndex(e.payload.t, id, e);
					fx.texts.add(e.payload.t);
				} else if (isMergeClaim(e.payload)) {
					fx.lists.add(e.payload.m);
				}
			}
		};

		/** Union-only effects update — used by flatten walks on consulted lists. */
		const indexEffects = (id: BlockId, entries: SliceEntry[]): void => {
			let fx = effects.get(id);
			if (!fx) {
				fx = { texts: new Set(), lists: new Set() };
				effects.set(id, fx);
			}
			for (const e of entries) {
				if (isSliceRecord(e.payload)) fx.texts.add(e.payload.t);
				else if (isMergeClaim(e.payload)) fx.lists.add(e.payload.m);
			}
		};

		const buildRec = (id: BlockId, node: EngineNode): TextBlockRec => {
			const slices = node.getAttr(SLICES);
			const slicesNode = isNodeLike(slices) ? slices : undefined;
			const content = node.getAttr(CONTENT);
			const entries = slicesNode ? readSliceEntries(slicesNode) : [selfSlice(id)];
			return {
				id,
				deleted: node.getAttr(DEL) !== undefined,
				content: isNodeLike(content) ? content : undefined,
				slicesNode,
				entries
			};
		};

		/** Rebuild (or create) block `id`'s record + all derived indexes. */
		const updateBlockRec = (id: BlockId): void => {
			const node = registry.getAttr(id);
			if (!isNodeLike(node)) {
				blocks.delete(id);
				indexEntries(id, []);
				return;
			}
			const rec = buildRec(id, node);
			blocks.set(id, rec);
			indexEntries(id, rec.entries);
		};

		/** Create the rec only when absent (cheap — entries read once). */
		const ensureRec = (id: BlockId): void => {
			if (!blocks.has(id)) updateBlockRec(id);
		};

		// ── lazily-maintained ownership ──────────────────────────────────

		const ensureOwners = (): void => {
			if (ownersVersion >= structureVersion) return;
			owners = computeOwners(blocks);
			ownersVersion = structureVersion;
		};

		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;

		const rangeOf = (entry: SliceEntry, text: EngineNode): readonly [number, number] | null => {
			if (rangeCache.has(entry)) return rangeCache.get(entry)!;
			const rec = entry.payload as {
				t: string;
				s: { i: { c: number; k: number } | null; a: number };
				e: { i: { c: number; k: number } | null; a: number };
			};
			const i0 = T.resolveAnchor(doc, text, rec.s);
			const i1 = T.resolveAnchor(doc, text, rec.e);
			const r = i0 === null || i1 === null ? null : ([Math.min(i0, i1), Math.max(i0, i1)] as const);
			rangeCache.set(entry, r);
			return r;
		};

		const buildRow = (t: string): AtomRow => {
			const arr: (BlockId | undefined)[] = [];
			const claims: (SliceEntry | undefined)[] = [];
			const keys: { g: number; s0: number; st: Stamp }[] = [];
			let maxG = 0;
			const text = blocks.get(t)?.content;
			const byHolder = recordsByText.get(t);
			if (text && byHolder) {
				const better = (
					a: { g: number; s0: number; st: Stamp },
					b: { g: number; s0: number; st: Stamp } | undefined
				): boolean =>
					b === undefined ||
					a.g - b.g > 0 ||
					(a.g === b.g && (a.s0 - b.s0 > 0 || (a.s0 === b.s0 && cmpStamp(a.st, b.st) > 0)));
				for (const [holder, entries] of byHolder) {
					const candBlock = ownerOf(holder);
					for (const e of entries) {
						const rec = e.payload as { t: string; g?: number };
						const g = rec.g ?? 0;
						if (g > maxG) maxG = g;
						if (candBlock === DEAD) continue;
						const range = rangeOf(e, text);
						if (range === null) continue;
						const key = { g, s0: range[0], st: e.stamp };
						const hi = Math.min(range[1], text.length);
						for (let i = range[0]; i < hi; i++) {
							if (better(key, keys[i])) {
								keys[i] = key;
								arr[i] = candBlock;
								claims[i] = e;
							}
						}
					}
				}
			}
			return { owners: arr, claims, maxG, builtAt: structureVersion };
		};

		const ensureRow = (t: string): AtomRow => {
			let row = atomRows.get(t);
			if (row && row.builtAt >= structureVersion && !dirtyTexts.has(t)) return row;
			row = buildRow(t);
			atomRows.set(t, row);
			dirtyTexts.delete(t);
			return row;
		};

		// ── flatten with dependency capture (mirrors bindText.flatten) ───

		const flattenTracked = (
			b: BlockId
		): {
			segs: {
				t: string;
				i0: number;
				i1: number;
				holder: BlockId;
				seqIndex: number;
				via: SliceEntry;
			}[];
			deps: Deps;
		} => {
			const segs: {
				t: string;
				i0: number;
				i1: number;
				holder: BlockId;
				seqIndex: number;
				via: SliceEntry;
			}[] = [];
			const deps: Deps = { texts: new Set(), lists: new Set() };
			const emitRecord = (entry: SliceEntry, holder: BlockId, via: SliceEntry): void => {
				const rec = entry.payload as { t: string };
				deps.texts.add(rec.t);
				const text = blocks.get(rec.t)?.content;
				if (!text) return;
				const range = rangeOf(entry, text);
				if (range === null) return;
				const row = ensureRow(rec.t);
				let i = range[0];
				while (i < range[1]) {
					if (row.owners[i] === b && row.claims[i] === entry) {
						const start = i;
						while (i < range[1] && row.owners[i] === b && row.claims[i] === entry) i++;
						segs.push({ t: rec.t, i0: start, i1: i, holder, seqIndex: entry.seqIndex, via });
					} else {
						i++;
					}
				}
			};
			const walk = (listId: BlockId, seen: Set<BlockId>, via: SliceEntry | null): void => {
				if (seen.has(listId)) return;
				seen.add(listId);
				deps.lists.add(listId);
				const rec = blocks.get(listId);
				if (!rec) return;
				indexEffects(listId, rec.entries);
				for (const entry of rec.entries) {
					const p = entry.payload as SlicePayload;
					if (isSliceRecord(p)) emitRecord(entry, listId, via ?? entry);
					else if (isMergeClaim(p)) walk(p.m, seen, via ?? entry);
				}
			};
			walk(b, new Set(), null);
			return { segs, deps };
		};

		// ── dep bookkeeping ──────────────────────────────────────────────

		const dropConsumers = (b: BlockId, deps: Deps): void => {
			for (const t of deps.texts) {
				const set = textConsumers.get(t);
				set?.delete(b);
				if (set?.size === 0) textConsumers.delete(t);
			}
			for (const l of deps.lists) {
				const set = listConsumers.get(l);
				set?.delete(b);
				if (set?.size === 0) listConsumers.delete(l);
			}
		};

		const applyDeps = (b: BlockId, deps: Deps): void => {
			const old = cache.get(b)?.deps;
			if (old) dropConsumers(b, old);
			for (const t of deps.texts) {
				let set = textConsumers.get(t);
				if (!set) {
					set = new Set();
					textConsumers.set(t, set);
				}
				set.add(b);
			}
			for (const l of deps.lists) {
				let set = listConsumers.get(l);
				if (!set) {
					set = new Set();
					listConsumers.set(l, set);
				}
				set.add(b);
			}
		};

		// ── snapshot construction ────────────────────────────────────────

		const freezeFresh = (r: ContentRun): ContentRun => Object.freeze(r) as ContentRun;

		/**
		 * Build the normalized fresh run list: marks/data interned, adjacent
		 * text items with equal marks merged across segment boundaries.
		 */
		const computeFresh = (b: BlockId): { fresh: ContentRun[]; deps: Deps } => {
			ensureOwners();
			const { segs, deps } = flattenTracked(b);
			const fresh: ContentRun[] = [];
			for (const seg of segs) {
				const text = blocks.get(seg.t)?.content;
				if (!text) continue;
				for (const item of T.itemsOfRange(text, seg.i0, seg.i1)) {
					if (item.kind === 'text') {
						const last = fresh[fresh.length - 1];
						const marks = item.marks === undefined ? undefined : intern(item.marks);
						if (last && last.kind === 'text' && last.marks === marks) {
							// Same interned marks — extend the previous run. Built
							// mutable here; frozen by reconcile.
							(last as { text: string }).text += item.text;
						} else {
							fresh.push({
								kind: 'text',
								text: item.text,
								...(marks === undefined ? {} : { marks })
							} as ContentRun);
						}
					} else {
						const inl = item as unknown as {
							id: string;
							type: string;
							data?: Record<string, unknown>;
						};
						fresh.push({
							kind: 'inline',
							id: inl.id,
							type: inl.type,
							...(inl.data === undefined ? {} : { data: intern(inl.data) })
						} as ContentRun);
					}
				}
			}
			return { fresh, deps };
		};

		/**
		 * Structural sharing: reuse unchanged run objects from `old` —
		 * maximal equal prefix + equal suffix around the edited window.
		 * Returns `old` itself when every run reconciles identical.
		 */
		const reconcile = (
			old: readonly ContentRun[] | undefined,
			fresh: ContentRun[]
		): readonly ContentRun[] => {
			if (!old) return Object.freeze(fresh.map(freezeFresh));
			let s = 0;
			const n = Math.min(old.length, fresh.length);
			while (s < n && runEquals(old[s], fresh[s])) s++;
			if (s === old.length && s === fresh.length) return old; // identical
			let eo = old.length - 1;
			let ef = fresh.length - 1;
			while (eo >= s && ef >= s && runEquals(old[eo], fresh[ef])) {
				eo--;
				ef--;
			}
			const out: ContentRun[] = new Array(fresh.length);
			for (let i = 0; i < s; i++) out[i] = old[i];
			for (let i = s; i <= ef; i++) out[i] = freezeFresh(fresh[i]);
			for (let i = eo + 1; i < old.length; i++) {
				out[fresh.length - (old.length - i)] = old[i];
			}
			return Object.freeze(out);
		};

		// ── recompute ────────────────────────────────────────────────────

		const computeRuns = (b: BlockId): void => {
			const old = cache.get(b);
			const { fresh, deps } = computeFresh(b);
			const runs = reconcile(old?.runs, fresh);
			applyDeps(b, deps);
			cache.set(b, { runs, deps });
			dirty.delete(b);
			debug.recomputes++;
			debug.recomputed.add(b);
			if (runs !== old?.runs) {
				stamps.set(b, (stamps.get(b) ?? 0) + 1);
				const listeners = blockSubs.get(b);
				if (listeners) for (const cb of [...listeners]) cb(runs);
			}
		};

		const runs = (b: BlockId): readonly ContentRun[] => {
			if (dirty.has(b) || !cache.has(b)) computeRuns(b);
			return cache.get(b)?.runs ?? Object.freeze([]);
		};

		// ── event handling ───────────────────────────────────────────────

		const invalidateBlock = (b: BlockId, invalidated: Set<BlockId>): void => {
			invalidated.add(b);
		};

		const handleBlockChange = (
			id: BlockId,
			op: AttrOp | undefined,
			invalidated: Set<BlockId>
		): boolean => {
			const facets = facetsOfBlockOp(op);
			let structureChanged = false;
			if (facets.has('gone')) {
				updateBlockRec(id); // drops the rec + prunes record index
				structureChanged = true;
			} else if (facets.has('structure')) {
				updateBlockRec(id);
				structureChanged = true;
			} else {
				ensureRec(id);
			}
			if (facets.has('content')) {
				dirtyTexts.add(id);
				// Anchor resolutions of records covering this text are stale.
				const byHolder = recordsByText.get(id);
				if (byHolder) {
					for (const set of byHolder.values()) {
						for (const e of set) rangeCache.delete(e);
					}
				}
				for (const c of textConsumers.get(id) ?? []) invalidateBlock(c, invalidated);
			}
			if (structureChanged) {
				// Consumers of this list itself (holders/walkers incl. self).
				for (const c of listConsumers.get(id) ?? []) invalidateBlock(c, invalidated);
				// Everything the list's records ever covered / claims ever targeted.
				const fx = effects.get(id);
				if (fx) {
					for (const t of fx.texts) {
						dirtyTexts.add(t);
						for (const c of textConsumers.get(t) ?? []) invalidateBlock(c, invalidated);
					}
					for (const l of fx.lists) {
						for (const c of listConsumers.get(l) ?? []) invalidateBlock(c, invalidated);
					}
				}
			}
			return structureChanged;
		};

		const handleEvent = (e: EngineDeepEvent): void => {
			const deep = (e.deltaDeep?.toJSON?.() ?? null) as DeltaJSON | null;
			const attrs = deep && typeof deep === 'object' ? deep.attrs : undefined;
			if (!attrs || typeof attrs !== 'object') {
				// Unrecognized event payload — do not guess: a change reached the
				// registry subtree, so conservatively invalidate every cached
				// block rather than serve stale runs.
				structureVersion++;
				for (const b of cache.keys()) dirty.add(b);
				version++;
				for (const cb of [...subs]) cb(version);
				return;
			}
			const invalidated = new Set<BlockId>();
			let structureChanged = false;
			for (const [id, op] of Object.entries(attrs)) {
				if (handleBlockChange(id, op, invalidated)) structureChanged = true;
			}
			if (structureChanged) structureVersion++;
			for (const b of invalidated) dirty.add(b);
			// Eager recompute only where a listener is attached — everything
			// else stays lazy until read.
			for (const b of invalidated) {
				if (blockSubs.has(b) && dirty.has(b)) computeRuns(b);
			}
			version++;
			for (const cb of [...subs]) cb(version);
		};

		// ── initial scan: index every existing block's slices state ─────
		registry.forEachAttr((v: unknown, id: string) => {
			if (isNodeLike(v)) {
				const rec = buildRec(id, v);
				blocks.set(id, rec);
				indexEntries(id, rec.entries);
			}
		});

		/**
		 * Real teardown — idempotent. Runs when the LAST lease is released or
		 * the doc is destroyed; an earlier facade `dispose()` only releases
		 * its own lease (see `attach`).
		 */
		let disposed = false;
		function teardown(): void {
			if (disposed) return;
			disposed = true;
			registry.unobserveDeep(observer);
			doc.off('destroy', teardown);
			cache.clear();
			dirty.clear();
			subs.clear();
			blockSubs.clear();
			views.delete(doc);
		}

		const observer = (e: EngineDeepEvent): void => handleEvent(e);
		registry.observeDeep(observer);
		doc.on('destroy', teardown);

		// ── public surface ───────────────────────────────────────────────

		const view: RunView = {
			version: () => version,
			blockVersion: (b: BlockId): number => {
				runs(b);
				return stamps.get(b) ?? 0;
			},
			runs,
			snapshot: (b: BlockId): ContentRun[] => JSON.parse(JSON.stringify(runs(b))) as ContentRun[],
			contentJSON: (b: BlockId) =>
				runs(b).map((r) => {
					if (r.kind === 'text') {
						return r.marks === undefined
							? { text: r.text }
							: {
									text: r.text,
									marks: JSON.parse(JSON.stringify(r.marks)) as Record<string, unknown>
								};
					}
					const inl = r as { id: string; type: string; data?: unknown };
					return inl.data === undefined
						? { id: inl.id, type: inl.type }
						: { id: inl.id, type: inl.type, data: JSON.parse(JSON.stringify(inl.data)) as unknown };
				}),
			subscribe: (cb: (v: number) => void) => {
				subs.add(cb);
				return () => subs.delete(cb);
			},
			subscribeBlock: (b: BlockId, cb: (runs: readonly ContentRun[]) => void) => {
				// Prime the baseline BEFORE registering: the listener only
				// ever sees genuine diffs, never the initial compute.
				runs(b);
				let set = blockSubs.get(b);
				if (!set) {
					set = new Set();
					blockSubs.set(b, set);
				}
				set.add(cb);
				return () => {
					set.delete(cb);
					if (set.size === 0) blockSubs.delete(b);
				};
			},
			dispose: teardown,
			debug
		};
		return view;
	};

	/**
	 * From-scratch baseline: recompute every visible block's runs with no
	 * caches — the honest "full recomputation" comparator for benchmarks and
	 * the fresh-projection oracle for equivalence tests.
	 */
	const computeAllRuns = (doc: EngineDoc): Map<BlockId, readonly ContentRun[]> => {
		const registry = doc.get(REGISTRY_KEY);
		const blocks = new Map<BlockId, TextBlockRec>();
		registry.forEachAttr((v: unknown, id: string) => {
			if (!isNodeLike(v)) return;
			const slices = v.getAttr(SLICES);
			const slicesNode = isNodeLike(slices) ? slices : undefined;
			const content = v.getAttr(CONTENT);
			blocks.set(id, {
				id,
				deleted: v.getAttr(DEL) !== undefined,
				content: isNodeLike(content) ? content : undefined,
				slicesNode,
				entries: slicesNode
					? readSliceEntries(slicesNode)
					: [
							{
								payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
								stamp: { c: -1, k: -1 },
								seqIndex: 0,
								item: null
							}
						]
			});
		});
		const own = T.computeOwnership(doc, blocks);
		const out = new Map<BlockId, readonly ContentRun[]>();
		for (const [id, rec] of blocks) {
			if (rec.deleted || own.hidden(id)) {
				out.set(id, Object.freeze([]));
				continue;
			}
			const items = T.contentItemsOf(id, blocks, own) as ContentItem[];
			out.set(id, Object.freeze(mergeRuns(items)));
		}
		return out;
	};

	return { attach, computeAllRuns };
};

/**
 * Overlay local decorations onto a run snapshot — PURE, no doc writes.
 *
 * Semantics (AN05):
 * - Text runs split at every decoration boundary inside their span; each
 *   resulting piece carries `decorations` = the union of `{key: value}` of
 *   every decoration covering it. Persistent `marks` pass through verbatim
 *   (same interned object — decorations never alias mark objects).
 * - An inline atom is one display position: decorations covering it are
 *   recorded on the run, which is never split.
 * - A decoration `{key, value: undefined}` removes `key` over its range.
 * - Output is deep-frozen; equal decorations intern to shared objects.
 *
 * Typical use: `decorateRuns(view.snapshot(b), prismDecorations)` in a
 * render layer. The returned array is a fresh structure — it shares run
 * sub-objects where unsplit but never mutates the input snapshot.
 */
export const decorateRuns = (
	runs: readonly ContentRun[],
	decorations: readonly LocalDecoration[]
): readonly DecoratedRun[] => {
	// Collect split points + per-run decoration hits in display-offset space.
	const bounds = new Set<number>();
	for (const d of decorations) {
		if (d.to > d.from) {
			bounds.add(d.from);
			bounds.add(d.to);
		}
	}
	const out: DecoratedRun[] = [];
	let pos = 0;
	for (const run of runs) {
		const len = run.kind === 'text' ? (run as { text: string }).text.length : 1;
		const r0 = pos;
		const r1 = pos + len;
		pos = r1;
		// Decorations overlapping [r0, r1).
		const hits = decorations.filter((d) => d.from < r1 && d.to > r0 && d.to > d.from);
		const decoMap = (lo: number, hi: number): Record<string, unknown> | undefined => {
			let m: Record<string, unknown> | undefined;
			// Ordered override: decorations apply in array order per key — a
			// later `value` replaces, a later `undefined` removes the key.
			for (const d of hits) {
				if (d.from < hi && d.to > lo) {
					if (!m) {
						if (d.value === undefined) continue;
						m = {};
					}
					if (d.value === undefined) delete m[d.key];
					else m[d.key] = d.value;
				}
			}
			return m && Object.keys(m).length > 0 ? m : undefined;
		};
		if (run.kind !== 'text') {
			const inl = run as { id: string; type: string; data?: Record<string, unknown> };
			const d = decoMap(r0, r1);
			out.push({
				kind: 'inline',
				id: inl.id,
				type: inl.type,
				...(inl.data === undefined ? {} : { data: inl.data }),
				...(d === undefined ? {} : { decorations: d })
			});
			continue;
		}
		const text = (run as { text: string }).text;
		const marks = (run as { marks?: Record<string, unknown> }).marks;
		// Split this run at decoration boundaries inside it.
		const cuts = [0];
		for (const b of bounds) if (b > r0 && b < r1) cuts.push(b - r0);
		cuts.push(len);
		for (let i = 0; i + 1 < cuts.length; i++) {
			const lo = r0 + cuts[i];
			const hi = r0 + cuts[i + 1];
			const d = decoMap(lo, hi);
			out.push({
				kind: 'text',
				text: text.slice(cuts[i], cuts[i + 1]),
				...(marks === undefined ? {} : { marks }),
				...(d === undefined ? {} : { decorations: d })
			});
		}
	}
	return Object.freeze(out.map((r) => deepFreeze({ ...r })));
};

export type RunsApi = ReturnType<typeof bindRuns>;
