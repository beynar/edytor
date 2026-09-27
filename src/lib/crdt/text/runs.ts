/**
 * The per-document index (R6, §2.4 "Per-doc index" and "Change report") —
 * the ONE owner of every fact derived from the replicated document: block
 * records, ownership, resolved placements, the children index and document
 * order, and each block's visible content as ordered, immutable runs.
 *
 * Lifetime: the engine doc's. `bindRuns(Y).attach(doc)` returns the doc's
 * one index (built on first use, torn down on the doc's `destroy`); every
 * binding, facade and model read on that doc goes through it.
 *
 * A *run* is one {@link ContentItem}: a text span with its mark set, or one
 * inline atom. `index.runs(b)` returns a frozen snapshot array; consumers may
 * key renderers on run-object identity — unaffected runs are reused
 * verbatim across recomputes (prefix/suffix structural sharing), and equal
 * mark/data objects are interned so `===` holds for unchanged formatting.
 *
 * The fold (see `docs/crdt-v14-richtext-adr.md` for the run contract):
 *
 * - One classifier maps a changed `(type, parentSub)` pair to the block and
 *   the facet it entered through (`content`, `slices`, `at`, a delete mark,
 *   `type`/`data`, or the registry entry itself); one routine folds a set of
 *   such pairs into the indexes.
 * - A transaction is folded ONCE at commit, from `transaction.changed`
 *   (which also carries the undo repair's follow-up writes).
 * - A read inside an open transaction first folds the PENDING part: the
 *   structs the transaction's insert/delete sets gained since the last fold.
 *   The watermark is those sets' lengths, the folded part a copy of them —
 *   `transaction.changed` cannot serve here, because it does not grow on a
 *   second edit to an already-changed type (attack F11), and re-folding it
 *   on every read made batching quadratic (probe C10).
 * - Forward dependencies: every cached block records which backing TEXTS
 *   its flatten consulted and which SLICE LISTS it walked. Reverse effects:
 *   every slice list records which texts its records ever covered and which
 *   blocks its merge claims ever targeted (union — never shrunk, so removed
 *   records still invalidate their old range).
 * - `content` on block X → rebuild X's atom-ownership row + invalidate the
 *   blocks consulting text X (narrowed to the edited spans when the fold
 *   can locate them). `slices`/delete marks on X → bump the ownership
 *   structure version + invalidate every consumer of X's effects. `at` →
 *   placements only; `type`/`data` → the record's metadata only.
 *
 * Publication is COMMIT-BOUND (R5): a mid-transaction read refreshes the
 * cache for read-your-writes, but `subscribeBlock` listeners and the change
 * report observe committed state only — nested transactions publish once,
 * and a transaction that nets out unchanged publishes nothing.
 *
 * The change report `{added, removed, moved, meta, content, order}` is the
 * fold against the last published index: the blocks the commit's folds
 * touched or invalidated are compared with what was published for them;
 * when the children index was rebuilt, the reachable tree is compared too.
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
import type {
	EngineApi,
	EngineDeepEvent,
	EngineDoc,
	EngineNode,
	EngineTransaction,
	YDoc
} from '../engine-api.js';
import type {
	BlockId,
	BlockRec,
	ContentItem,
	DocOrder,
	ModelView,
	ProjectedBlock,
	ResolvedPlacement
} from '../placement/model.js';
import {
	candidatesOf,
	childrenIndex,
	displayIndex,
	documentOrder,
	REGISTRY_KEY,
	resolvePlacements
} from '../placement/model.js';
import {
	bindText,
	canonKey,
	computeOwners,
	DEAD,
	deepFreeze,
	gatherClaims,
	intervalsOver,
	isMergeClaim,
	isSliceRecord,
	protectItems,
	readRange,
	readSliceEntries,
	sweepOwnership,
	type OwnedSeg,
	type OwnInterval,
	type Owner,
	type Ownership,
	type RangeCursor,
	type RangeReadStats,
	type SliceEntry,
	type SliceRecord,
	type TextBlockRec
} from './model.js';
import {
	AT,
	CONTENT,
	DATA,
	hasDeleteMark,
	ID,
	LAST_CHANGED_ATTR,
	SLICES,
	TYPE
} from '../schema.js';
import { walkIdSetStructs, type IdSetLike, type StoreStruct } from '../structs.js';
import { cloneJsonSafe } from '../../utils/json.js';

/**
 * One visible run of a block — the maintained form of `ContentItem`.
 * `marks`/`data` are interned: equal payloads share one frozen instance,
 * so `===` compares formatting without deep walks. U2 removed the U7
 * per-run `attribution` field — ordinary text carries no authorship
 * decoration and runs never split at author boundaries; durable
 * attribution is the compact per-block record (`blockattr`, U1).
 */
export type ContentRun =
	| {
			kind: 'text';
			text: string;
			marks?: Record<string, unknown>;
	  }
	| {
			kind: 'inline';
			id: string;
			type: string;
			data?: Record<string, unknown>;
	  };

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

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

// Schema attr names come from `../schema.js` (the shared leaf — S10).
// `DEAD` is imported from ./model.js — the shared unique-symbol sentinel
// (a literal 'dead' string collided with the valid caller block id).

/**
 * The facet name of a block's registry entry itself (inserted or removed) —
 * every other facet is named by the block attr it entered through.
 */
export const ENTRY_FACET = '';

/**
 * Facets of a block node that can change derived state: `at` (placement
 * candidate writes — invalidate the placement/order facets but never the
 * content facets) and `meta` (type/data payload writes — invalidate only
 * metadata projections).
 */
type Facet = 'content' | 'structure' | 'at' | 'meta' | 'ignore';

const facetOf = (attr: string): Facet => {
	if (attr === CONTENT) return 'content';
	// Per-writer delete marks (`del.<writer>`) fall through to 'structure' below.
	if (attr === SLICES) return 'structure';
	// `at` changes placements/display order — never content.
	if (attr === AT) return 'at';
	// Payload attrs change only the block's metadata projection — a move or
	// data write must not trigger run recomputes.
	if (attr === ID || attr === TYPE || attr === DATA) return 'meta';
	// U1: the `l` lastChangedBy stamp (SCHEMA.blockAttrs.lastChanged) is
	// pure attribution bookkeeping — it carries no derived state and must
	// not dirty runs, structure, or placements (and must not poison the
	// claim-refinement fast path when it shares a commit with `slices`).
	if (attr === LAST_CHANGED_ATTR) return 'ignore';
	// Unknown attr — a future schema extension; treat as structural so its
	// consumers recompute rather than silently serving stale runs.
	return 'structure';
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

/** Shared empty snapshot — returned for absent/hidden blocks. */
const EMPTY_RUNS = Object.freeze([]) as readonly ContentRun[];
/** Shared frozen empty child list for a report's emptied-parent `order` entries. */
const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

/**
 * Element-wise run equality — what `subscribeBlock` publication compares
 * (R5): `runEquals` matches marks/data by interned REFERENCE, so a
 * recomputed-but-identical snapshot still reads as "no change".
 */
const sameRuns = (a: readonly ContentRun[] | undefined, b: readonly ContentRun[]): boolean => {
	if (a === b) return true;
	if (a === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!runEquals(a[i], b[i])) return false;
	return true;
};

type Deps = { texts: Set<string>; lists: Set<string> };

type Cached = { runs: readonly ContentRun[]; deps: Deps };

/**
 * One commit's change report (§2.4) — the fold against the last published
 * index. Collections name the affected ids; `order` carries the NEW child-id
 * list per changed parent (frozen), so a mirror can apply it without
 * re-reading the doc. Visible = reachable from the root in the children index.
 */
export type IndexReport = {
	/** Newly visible blocks → their projected subtree (incl. content + children). */
	added: Map<BlockId, ProjectedBlock>;
	/** Roots of subtrees no longer visible (deleted, merged away, or hidden). */
	removed: Set<BlockId>;
	/** Ids whose display parent or sibling index changed. */
	moved: Set<BlockId>;
	/** Ids whose `type`/`data` payload changed → the new values. */
	meta: Map<BlockId, { type: string; data?: Record<string, unknown> }>;
	/** Ids whose visible content changed → the new runs. */
	content: Map<BlockId, readonly ContentRun[]>;
	/** Parents (`null` = root) whose visible child list changed → the new order. */
	order: Map<BlockId | null, readonly BlockId[]>;
};

/** What the folds since {@link RunView.track} saw: facets per block, and whether anything was written. */
export type Folded = { touched: Map<BlockId, Set<string>>; wrote: boolean };

type AtomRow = {
	/** Ordered disjoint winner intervals for the text (WU6 — the old dense
	 *  per-position owner/claim rows are gone; see `sweepOwnership`). */
	ivs: OwnInterval[];
	maxG: number;
	builtAt: number;
};

type Effects = { texts: Set<string>; lists: Set<string> };

export type RunViewDebug = {
	/** Total run recomputes since attach (or last `reset()`). */
	recomputes: number;
	/** Block ids recomputed since last `reset()`. */
	recomputed: Set<BlockId>;
	/**
	 * Sequence items stepped over inside maintained range reads since last
	 * `reset()` (WU8) — the counter that shows reads scale with the range
	 * plus a bounded checkpoint gap, not the whole backing text.
	 */
	readonly itemsWalked: number;
	/** Format markers seen inside maintained range reads (subset of `itemsWalked`). */
	readonly markersWalked: number;
	reset: () => void;
};

/**
 * The per-document index. Every read folds the open transaction's pending
 * writes first (read-your-writes); none mutates replicated state.
 */
export type RunView = {
	/**
	 * The index version — bumps once per fold that changed a derived fact
	 * (a mid-transaction fold of pending writes, or a commit). A prepared
	 * plan is valid only at the version it was prepared against.
	 */
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
	 * Canonical content items of `id` — the same shape `project()` emits.
	 * Interned payloads: `marks`/`data` are the shared frozen instances —
	 * `===` with the payloads `runs(id)` publishes for equal content.
	 */
	contentItems: (id: BlockId) => ContentItem[];
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
	/** Subscribe to every committed registry change — `cb(version)`. */
	subscribe: (cb: (version: number) => void) => () => void;
	/**
	 * Subscribe to ONE block's run changes — `cb(runs)` fires once per
	 * committed transaction, only when the committed snapshot differs from
	 * what listeners last saw (R5). Blocks with subscribers recompute
	 * eagerly at commit; others recompute lazily on read.
	 */
	subscribeBlock: (id: BlockId, cb: (runs: readonly ContentRun[]) => void) => () => void;
	/**
	 * The indexes as a {@link ModelView} (block records, ownership, placements,
	 * children, order). Folds the pending writes of `transaction` (default:
	 * the doc's open transaction) first — an observer running before the
	 * index's own commit fold passes the committing transaction explicitly.
	 */
	view: (transaction?: unknown) => ModelView;
	/** The visible tree, or the subtree rooted at `root`, projected. */
	project: (root?: BlockId) => ProjectedBlock[];
	/**
	 * Track the folds from now on (the write funnel's frame): `end()` folds
	 * what is pending and returns the facets every fold since `track()` saw
	 * per block, and whether the transaction wrote anything meanwhile.
	 */
	track: () => { end: () => Folded };
	/**
	 * Subscribe to the change report — one per commit that changed the
	 * visible document, after the commit (`update`), with its origin and
	 * `transaction.local`. The first subscription takes the baseline.
	 */
	onReport: (cb: (report: IndexReport, origin: unknown, local: boolean) => void) => () => void;
	/** Instrumentation for tests/benchmarks. */
	debug: RunViewDebug;
};

/** One index per engine doc, shared by every binding (the doc's lifetime). */
const indexes = new WeakMap<EngineDoc, RunView>();

export const bindRuns = (Y: EngineApi) => {
	const T = bindText(Y);

	/** The doc's index — built on first use, torn down when the doc is destroyed. */
	const attach = (doc: EngineDoc): RunView => {
		let index = indexes.get(doc);
		if (index === undefined) indexes.set(doc, (index = buildView(doc)));
		return index;
	};

	const buildView = (doc: EngineDoc): RunView => {
		const registry = doc.get(REGISTRY_KEY);

		// ── per-transaction content extents (U8b) ─────────────────────
		//
		// A `content` facet change on block X is a sequence edit inside X's
		// backing text node. `Transaction.changed` names only the touched
		// type — not WHERE in it — so sibling blocks sharing one backing
		// text all used to invalidate on every keystroke. The transaction's
		// `insertSet`/`deleteSet` record exactly which items were written;
		// resolving each item's id to a live index yields the edited spans
		// in post-edit coordinates (a tombstone resolves to the gap it
		// occupied, and its `length` restores the pre-edit span — the same
		// span doubles as the pre-edit frame for old-row checks; the
		// over-approximation only ever touches extra atoms).
		//
		// A block's display of text X is exactly the ownership intervals it
		// wins on X's atom row, so an edit that intersects none of a
		// consumer's intervals cannot change its runs: anchors translate
		// coverage verbatim, and a surviving atom's winning claim can only
		// change where a record boundary moved — which happens only inside
		// an edited span (a boundary also moves when its bound item is
		// deleted, collapsing INTO the delete span). Both the fresh row and
		// the pre-edit row are consulted so an owner that LOST atoms is
		// invalidated alongside the owner that gained them.
		//
		// Anything unclassifiable — non-countable items (ContentFormat
		// markers, whose effect runs to the next same-key marker and so
		// cannot be bounded by the marker's own span), GC/Skip structs,
		// unresolvable positions, or missing engine internals — marks the
		// node's bucket `null`; a wholly unusable transaction yields `null`
		// from the resolver. Both mean "fall back to all consumers".
		//
		// The id-set → struct walk lives in `../structs.js` (S11) — the same
		// `walkIdSetStructs` undo-repair uses; an incomplete walk (missing
		// client list / unlocatable range) degrades the whole index to
		// opaque rather than trusting partial coverage.
		type TxLike = { insertSet?: IdSetLike; deleteSet?: IdSetLike };
		type ExtentMap = Map<EngineNode, [number, number][] | null>;

		const resolveItemSpan = (
			typeId: { client: number; clock: number },
			s: StoreStruct
		): [number, number] | null => {
			const abs = Y.createAbsolutePositionFromRelativePosition(
				Y.createRelativePositionFromJSON({
					type: { client: typeId.client, clock: typeId.clock },
					item: { client: s.id.client, clock: s.id.clock },
					assoc: 0
				}),
				doc as unknown as YDoc,
				false
			);
			if (abs === null) return null;
			return [abs.index, abs.index + Math.max(1, s.length)];
		};

		/**
		 * Lazily-built extent index for one transaction. Returns a lookup:
		 * node → edited spans (`null` = opaque node, `undefined` = the
		 * whole transaction is opaque). Built per fold, over the id sets that
		 * fold covers.
		 */
		const makeExtentIndex = (tr: unknown) => {
			let built: ExtentMap | null | undefined; // undefined = not built
			const build = (): ExtentMap | null => {
				if (built !== undefined) return built;
				built = null;
				const tx = tr as TxLike | null | undefined;
				const insertSet = tx?.insertSet;
				const deleteSet = tx?.deleteSet;
				// A missing `store.clients` is a vendored-layout change: the
				// extent index is a perf refinement, so it degrades to opaque
				// (all-consumers invalidation stays CORRECT) rather than let
				// `clientsOf` throw inside the observer pass. Undo-repair —
				// where silent emptiness corrupts — fails fast instead.
				if (insertSet === undefined || deleteSet === undefined) return null;
				if ((doc as { store?: { clients?: unknown } }).store?.clients === undefined) {
					return null;
				}
				const out: ExtentMap = new Map();
				const visit = (idSet: IdSetLike, deleted: boolean): boolean =>
					walkIdSetStructs(Y, doc, idSet, (s) => {
						const parent = s.parent;
						if (s.parentSub !== null || !isNodeLike(parent)) return;
						const typeId = (parent as EngineNode)._item?.id;
						// A deleted item resolves to its post-delete gap position —
						// but `resolveNarrowed` intersects spans against the STALE
						// atom row whose intervals are pre-edit coordinates. The
						// spaces are incomparable, so a tombstoned span can never
						// reach the owners that held its atoms before the delete.
						// Tombstones degrade the node's bucket to opaque — the
						// all-consumers fallback is the only sound answer.
						if (deleted || s.countable !== true || typeId === undefined) {
							out.set(parent as EngineNode, null);
							return;
						}
						const span = resolveItemSpan(typeId, s);
						if (span === null) {
							out.set(parent as EngineNode, null);
							return;
						}
						let spans = out.get(parent as EngineNode);
						if (spans === null) return;
						if (spans === undefined) out.set(parent as EngineNode, (spans = []));
						spans.push(span);
					});
				const complete = visit(insertSet, false) && visit(deleteSet, true);
				built = complete ? out : null;
				return built;
			};
			return (node: EngineNode): readonly [number, number][] | undefined => {
				const m = build();
				if (m === null) return undefined;
				const spans = m.get(node);
				// Absent bucket contradicts the recorded sequence edit (a
				// null `changed` sub always accompanies an item write) —
				// treat as opaque rather than under-invalidate.
				if (spans === undefined) return undefined;
				return spans ?? undefined;
			};
		};
		type ExtentLookup = ReturnType<typeof makeExtentIndex>;

		// ── incremental replicated-state indexes ─────────────────────────
		// WU7: recs are FULL BlockRecs (node/type/data/cands alongside the
		// text fields) so this same map backs the placement model's view.
		const blocks = new Map<BlockId, BlockRec>();
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

		// ── native bounded range reads (U3) ──────────────────────────────
		// `itemsOfRange` used to render the whole backing text per call;
		// WU8 added an Edytor-side checkpoint index, now replaced by the
		// vendored `Y.RangeCursor`: `computeFresh` opens one cursor per
		// backing text, which seeds itself from the engine's own
		// search-marker checkpoints (planted adaptively by reads AND
		// mutations at the same cadence — no Edytor-side index to maintain
		// or invalidate). A read costs O(checkpoint-gap + range), never
		// O(text); markers self-maintain through engine invalidation, so
		// no `dirtyContentTexts` bookkeeping survives here.
		const rangeStats: RangeReadStats = { items: 0, markers: 0 };

		/**
		 * Single funnel for "text `t`'s items changed" — advances the
		 * atom-row/`dirtyTexts` bookkeeping together.
		 */
		const markTextDirty = (t: string): void => {
			dirtyTexts.add(t);
		};

		// ── run cache ────────────────────────────────────────────────────
		const cache = new Map<BlockId, Cached>();
		const dirty = new Set<BlockId>();
		const stamps = new Map<BlockId, number>();
		const internMap = new Map<string, unknown>();

		// ── subscribers ──────────────────────────────────────────────────
		let version = 0;
		const subs = new Set<(v: number) => void>();
		const blockSubs = new Map<BlockId, Set<(runs: readonly ContentRun[]) => void>>();
		/**
		 * R5 commit-bound publication: `publishedRuns` is the last snapshot
		 * array each subscribed block's listeners actually saw, and
		 * `pendingNotify` queues blocks whose runs changed during an OPEN
		 * transaction (a `runs()` read forces a mid-transaction recompute
		 * for read-your-writes, but listeners must observe committed state
		 * only). `handleEvent` flushes the queue once per commit, so a
		 * mid-transaction read can never publish a half-finished snapshot
		 * and a change-then-revert transaction publishes nothing.
		 */
		const publishedRuns = new Map<BlockId, readonly ContentRun[]>();
		const pendingNotify = new Set<BlockId>();

		const debug: RunViewDebug = {
			recomputes: 0,
			recomputed: new Set<BlockId>(),
			get itemsWalked() {
				return rangeStats.items;
			},
			get markersWalked() {
				return rangeStats.markers;
			},
			reset() {
				debug.recomputes = 0;
				debug.recomputed.clear();
				rangeStats.items = 0;
				rangeStats.markers = 0;
			}
		};

		// ── interning / freezing ─────────────────────────────────────────
		const intern = <T>(v: T): T => {
			// `cloneJsonSafe` is TOTAL even against hostile replicated payloads
			// (a raw `setAttr` write or a remote non-JSON value that bypassed
			// boundary validation): the canonical instance is always the JSON
			// projection, so `canonKey`/`JSON.stringify` downstream can never
			// throw on an interned value — reads project `{big:10n}` to
			// `{big:10}` instead of crashing (R4). Interning the NORMALIZED
			// form also keys it by its own canonical shape (a `Date` no longer
			// collides with `{}`).
			const canon = deepFreeze(cloneJsonSafe(v));
			const key = canonKey(canon);
			let f = internMap.get(key) as T | undefined;
			if (f === undefined) {
				internMap.set(key, (f = canon));
			}
			return f;
		};

		// ── replicated-state index maintenance ───────────────────────────

		const selfSlice = (id: BlockId): SliceEntry => ({
			payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
			stamp: { c: -1, k: -1 },
			seqIndex: 0
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
		const indexEffects = (id: BlockId, entries: readonly SliceEntry[]): void => {
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

		const buildRec = (id: BlockId, node: EngineNode): BlockRec => {
			const slices = node.getAttr(SLICES);
			const slicesNode = isNodeLike(slices) ? slices : undefined;
			const content = node.getAttr(CONTENT);
			const type = node.getAttr(TYPE);
			const entries = slicesNode ? readSliceEntries(slicesNode) : [selfSlice(id)];
			return {
				id,
				node,
				type: typeof type === 'string' ? type : 'unknown',
				data: node.getAttr(DATA),
				deleted: hasDeleteMark(node),
				content: isNodeLike(content) ? content : undefined,
				slicesNode,
				entries,
				cands: candidatesOf(node)
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

		/** `at`-facet refresh: re-read only the placement candidates. */
		const refreshCands = (id: BlockId): void => {
			const rec = blocks.get(id);
			if (!rec) {
				ensureRec(id);
				return;
			}
			rec.cands = candidatesOf(rec.node);
		};

		/** `meta`-facet refresh: re-read only type/data (cheap attr reads). */
		const refreshMeta = (id: BlockId): void => {
			const rec = blocks.get(id);
			if (!rec) {
				ensureRec(id);
				return;
			}
			const type = rec.node.getAttr(TYPE);
			rec.type = typeof type === 'string' ? type : 'unknown';
			rec.data = rec.node.getAttr(DATA);
		};

		// ── lazily-maintained ownership ──────────────────────────────────

		const ensureOwners = (): void => {
			if (ownersVersion >= structureVersion) return;
			owners = computeOwners(blocks);
			ownersVersion = structureVersion;
		};

		/** `b`'s display owner (`DEAD` when deleted or unknown); owners rebuild lazily. */
		const ownerOf = (b: BlockId): Owner => {
			ensureOwners();
			return owners.get(b) ?? DEAD;
		};

		/** Owner → displayed blocks, rebuilt lazily with `owners` (the delete step's marks). */
		let displaysMap = new Map<BlockId, BlockId[]>();
		let displaysAt = -1;
		const displays = (owner: BlockId): readonly BlockId[] => {
			ensureOwners();
			if (displaysAt !== ownersVersion) {
				displaysMap = displayIndex(blocks, ownerOf);
				displaysAt = ownersVersion;
			}
			return displaysMap.get(owner) ?? [];
		};

		// ── lazily-maintained placement / children-index facets (WU7) ────
		//
		// `placements` and `kids` rebuild only when `placementVersion` moves —
		// i.e. on `at` candidate writes, `del` flags, slice-list/claim churn
		// (the composed display edge is `owner(parent)`) and registry entry
		// churn. Content edits never touch them, so a keystroke keeps the
		// previous resolved placements AND children index verbatim.
		let placementsMap: Map<BlockId, ResolvedPlacement> | null = null;
		let kidsMap: Map<BlockId | null, { id: BlockId; rank: string }[]> | null = null;
		let orderCache: DocOrder | null = null;
		let placementsBuiltAt = -1;
		let placementVersion = 0;
		const ensurePlacements = (): void => {
			if (placementsBuiltAt >= placementVersion) return;
			ensureOwners();
			placementsMap = resolvePlacements(blocks, ownerOf);
			kidsMap = childrenIndex(placementsMap, ownShim);
			orderCache = null;
			placementsBuiltAt = placementVersion;
		};

		/**
		 * The index's `Ownership`: owners from the lazily-rebuilt map; a text's
		 * `intervals`/`maxG` from its atom row (only that text's claims are
		 * recomputed, never the whole document); ranges from the anchor cache.
		 */
		const ownShim: Ownership = {
			ownerOf,
			hidden: (b: BlockId): boolean => ownerOf(b) !== b,
			intervals: { get: (t: string) => ensureRow(t).ivs } as Ownership['intervals'],
			resolvedRange: (entry: SliceEntry, text: EngineNode) =>
				rangeOf(entry, text) as [number, number] | null,
			maxG: { get: (t: string) => ensureRow(t).maxG } as Ownership['maxG']
		};

		/**
		 * The index as a `ModelView`. `blocks` is the LIVE record map (consumers
		 * never mutate it); `placements`, `kids` and `order` are getters, so
		 * content-only ops never trigger a rebuild.
		 */
		const ctx: ModelView = {
			blocks,
			own: ownShim,
			get placements() {
				ensurePlacements();
				return placementsMap!;
			},
			get kids() {
				ensurePlacements();
				return kidsMap!;
			},
			get order() {
				ensurePlacements();
				return (orderCache ??= documentOrder(kidsMap!));
			},
			// R4: publication boundary shares THIS interner, so a payload
			// emitted by `project()`/`contentItems()` is `===` the one the
			// runs view holds for equal content — canonical and frozen.
			intern,
			displays
		};

		/**
		 * Claim-multiset fingerprints as of the last COMMITTED registry
		 * state. A mid-transaction fold advances `blocks` recs ahead of the
		 * commit boundary (read-your-writes), so comparing `claimKeySet`
		 * against the live rec at commit time would always report the same
		 * claims and misclassify a real claim write (merge/move) as record
		 * churn. The fingerprint is therefore refreshed only inside the
		 * commit fold, never mid-transaction.
		 */
		const committedClaims = new Map<BlockId, string>();

		// Anchor→range resolution through the maintained cache — the shared
		// `sliceRange` body (model.ts); this WeakMap's lifetime is longer
		// than a view's, so `handleBlockChange` drops a text's entries from
		// the cache whenever its items change (anchor positions shift).
		const rangeOf = (entry: SliceEntry, text: EngineNode): readonly [number, number] | null =>
			T.sliceRange(doc, entry, text, rangeCache);

		/** `(holder, entry)` pairs out of the per-text record index. */
		function* recordPairs(
			byHolder: Map<BlockId, Set<SliceEntry>>
		): IterableIterator<[BlockId, SliceEntry]> {
			for (const [holder, entries] of byHolder) {
				for (const e of entries) yield [holder, e];
			}
		}

		const buildRow = (t: string): AtomRow => {
			// The same per-atom contest computeOwnership runs — one shared
			// `gatherClaims` pass over the maintained per-text record index,
			// evaluated over claim endpoints via sweepOwnership — O(claims
			// log claims), not O(text length). `maxG` tracks every record on
			// the text, live or losing (materializing records write maxG+1
			// to win their range) — its own unfiltered pass, same as
			// computeOwnership.
			let maxG = 0;
			const text = blocks.get(t)?.content;
			const byHolder = recordsByText.get(t);
			let claims: ReturnType<typeof gatherClaims> = [];
			if (text && byHolder) {
				for (const [, e] of recordPairs(byHolder)) {
					const g = (e.payload as SliceRecord).g ?? 0;
					if (g > maxG) maxG = g;
				}
				claims = gatherClaims(blocks, ownerOf, recordPairs(byHolder), rangeOf, { t });
			}
			return { ivs: sweepOwnership(claims), maxG, builtAt: structureVersion };
		};

		const ensureRow = (t: string): AtomRow => {
			let row = atomRows.get(t);
			if (row && row.builtAt >= structureVersion && !dirtyTexts.has(t)) return row;
			row = buildRow(t);
			atomRows.set(t, row);
			dirtyTexts.delete(t);
			return row;
		};

		// ── flatten with dependency capture (S2: THE bindText.flatten walk) ──
		//
		// `flattenTracked` runs the shared `T.flatten` walk over the runs
		// layer's own `Ownership` shim — `intervals.get`/`resolvedRange` on
		// the shim already route through the maintained per-text rows and
		// `rangeCache` — with `track` hooks capturing the invalidation deps:
		// every consulted list (plus its effects) and every record's text.
		const flattenTracked = (b: BlockId): { segs: OwnedSeg[]; deps: Deps } => {
			const deps: Deps = { texts: new Set(), lists: new Set() };
			const segs = T.flatten(b, blocks, ownShim, {
				list: (listId, entries) => {
					deps.lists.add(listId);
					if (entries !== undefined) indexEffects(listId, entries);
				},
				text: (t) => deps.texts.add(t)
			});
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
			// One native cursor per backing text — it seeds itself from the
			// engine's search-marker checkpoints and continues forward across
			// ordered segs, so a read costs gap + range, not text (U3).
			const cursors = new Map<string, RangeCursor>();
			for (const seg of segs) {
				const text = blocks.get(seg.t)?.content;
				if (!text) continue;
				let cur = cursors.get(seg.t);
				if (cur === undefined) cursors.set(seg.t, (cur = T.openRangeCursor(text)));
				for (const item of readRange(cur, seg.i0, seg.i1, rangeStats)) {
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

		/**
		 * Hand `b`'s current snapshot to its `subscribeBlock` listeners —
		 * once per distinct published state (R5). `publishedRuns` records
		 * what listeners last saw, so a deferred mid-transaction recompute
		 * publishes the FINAL runs exactly once at commit and a change-
		 * then-revert transaction publishes nothing.
		 */
		/**
		 * lib0 `callAll` semantics for subscriber callbacks: every listener
		 * in the batch is invoked, THEN the first thrown error propagates
		 * (R5 — a throwing listener must never starve the listeners queued
		 * behind it, and must not wedge the block either: the watermark has
		 * already advanced, so the NEXT commit publishes the next state
		 * rather than re-offering a stale one to the buggy listener).
		 */
		const callEach = <A>(cbs: Iterable<(arg: A) => void>, arg: A): void => {
			let threw = false;
			let firstErr: unknown;
			for (const cb of cbs) {
				try {
					cb(arg);
				} catch (e) {
					if (!threw) {
						threw = true;
						firstErr = e;
					}
				}
			}
			if (threw) throw firstErr;
		};

		const publish = (b: BlockId): void => {
			const listeners = blockSubs.get(b);
			if (listeners === undefined || listeners.size === 0) return;
			const cur = cache.get(b)?.runs ?? EMPTY_RUNS;
			if (sameRuns(publishedRuns.get(b), cur)) return;
			publishedRuns.set(b, cur);
			callEach([...listeners], cur);
		};

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
				if (blockSubs.has(b)) {
					// R5: while a transaction is open this is a MID-TRANSACTION
					// recompute (a `runs()` read forcing read-your-writes) —
					// listeners must not see the half-finished snapshot, so the
					// publication is queued for the commit's `handleEvent`.
					// Outside a transaction — including commit cleanup, where
					// `doc._transaction` is already null — publish directly.
					if (doc._transaction != null) pendingNotify.add(b);
					else publish(b);
				}
			}
		};

		/**
		 * Publish every queued block at the commit boundary. A pending
		 * block still dirty (e.g. after a conservative fallback
		 * invalidation) recomputes its final state first — `computeRuns`
		 * republishes through `publish`, which also coalesces a
		 * mid-transaction intermediate state with the committed one.
		 */
		const flushPending = (): void => {
			// A throwing listener must not abort the rest of the commit's
			// publication batch — collect the first failure per block, drain
			// the queue completely (callbacks may enqueue further
			// notifications), then rethrow the earliest error after the
			// whole batch was served (R5, `callAll` convention).
			let threw = false;
			let firstErr: unknown;
			while (pendingNotify.size > 0) {
				const batch = [...pendingNotify];
				pendingNotify.clear();
				for (const b of batch) {
					try {
						if (dirty.has(b)) computeRuns(b);
						else publish(b);
					} catch (e) {
						if (!threw) {
							threw = true;
							firstErr = e;
						}
					}
				}
			}
			if (threw) throw firstErr;
		};

		const runs = (b: BlockId): readonly ContentRun[] => {
			// Read-your-writes: fold the open transaction's pending writes
			// first. The recompute updates the CACHE immediately; only
			// subscriber publication is deferred to the commit boundary (R5).
			syncPending(openTx());
			if (dirty.has(b) || !cache.has(b)) computeRuns(b);
			return cache.get(b)?.runs ?? EMPTY_RUNS;
		};

		// ── event handling ───────────────────────────────────────────────

		const invalidateBlock = (b: BlockId, invalidated: Set<BlockId>): void => {
			invalidated.add(b);
		};

		// ── deferred narrowed invalidation (U8b) ───────────────────────
		//
		// `pendingNarrow` accumulates `content`-facet changes whose edited
		// spans the transaction could identify; `resolveNarrowed` runs once
		// the changed-entry fold completes — every slices/structure entry
		// applied, every record index current — and intersects each span
		// against the ownership intervals of the text's atom row:
		//
		// - the FRESH row (rebuilt post-edit — `markTextDirty` already ran)
		//   yields the owners of intervals covering gained/changed atoms;
		// - the STALE row kept from before the rebuild yields owners whose
		//   coverage the edit destroyed (a winning record's anchor
		//   collapsing into a delete span shrinks its interval onto the
		//   survivor that now owns those atoms — both sides must recompute).
		//
		// `commitRecordsChurn` marks any claim-preserving `slices` rewrite
		// seen during the fold (recordsChanged) — record ranges move under
		// the same claim set, so interval owners may shift without any
		// structure flag. Together with `flags.structure`, either one
		// collapses every pending entry back to all-consumers (the pre-U8b
		// behavior): narrowing never trades correctness for precision.
		const pendingNarrow: { id: BlockId; spans: readonly [number, number][] }[] = [];
		let commitRecordsChurn = false;

		const resolveNarrowed = (invalidated: Set<BlockId>, collapse: boolean): void => {
			const narrow = !collapse && !commitRecordsChurn;
			for (const { id, spans } of pendingNarrow) {
				if (!narrow) {
					for (const c of textConsumers.get(id) ?? []) invalidateBlock(c, invalidated);
					continue;
				}
				ensureOwners();
				const staleRow = atomRows.get(id);
				const row = ensureRow(id); // rebuilds — id is in dirtyTexts
				for (const [lo, hi] of spans) {
					for (const iv of intervalsOver(row.ivs, lo, hi)) {
						invalidateBlock(iv.owner, invalidated);
					}
					if (staleRow !== undefined && staleRow !== row) {
						for (const iv of intervalsOver(staleRow.ivs, lo, hi)) {
							invalidateBlock(iv.owner, invalidated);
						}
					}
				}
			}
			pendingNarrow.length = 0;
			commitRecordsChurn = false;
		};

		/**
		 * Canonical fingerprint of a list's merge-claim multiset — stamp +
		 * claim target per claim entry, sorted. `computeOwners` reads ONLY
		 * claims, so an identical fingerprint proves `ownerOf`/`hidden`,
		 * placements and the children index cannot have moved: the slices
		 * write was pure record churn (typing re-anchors edge records via
		 * delete+insert on every keystroke) whose blast radius is ranges
		 * and runs, never structure.
		 */
		const claimKeySet = (entries: SliceEntry[] | undefined): string | null => {
			if (entries === undefined) return null;
			const keys: string[] = [];
			for (const e of entries) {
				if (isMergeClaim(e.payload)) keys.push(`${e.stamp.c}.${e.stamp.k}›${e.payload.m}`);
			}
			return keys.sort().join('|');
		};

		// ── the fold ─────────────────────────────────────────────────────

		/** One fold's derived-state effects: invalidated blocks and rebuilt facets. */
		type FoldCtx = { invalidated: Set<BlockId>; structure: boolean; placement: boolean };

		/**
		 * Fold one block's changed facets. `spans` narrows a `content` change
		 * to the edited spans of its backing text (`null`: every consumer).
		 * The committed claim fingerprint advances only at commit.
		 */
		const foldBlock = (
			id: BlockId,
			facets: ReadonlySet<string>,
			spans: readonly [number, number][] | null,
			ctx: FoldCtx,
			atCommit: boolean
		): void => {
			const kinds = new Set<Facet | 'entry'>();
			for (const f of facets) kinds.add(f === ENTRY_FACET ? 'entry' : facetOf(f));
			let structureChanged = false;
			// Record-only `slices` churn (same claim set) — the range-level
			// fanout below still runs, but owners/placements/kids stay put.
			let recordsChanged = false;
			let content = kinds.has('content');
			if (kinds.has('entry')) {
				updateBlockRec(id); // (re)builds or drops the rec + record index
				structureChanged = true;
				// A new entry's slices may carry records/claims onto EXISTING
				// texts (a split tail's materialization).
				content ||= blocks.has(id);
			} else if (kinds.has('structure')) {
				// Refinable only when every structural attr is `slices` (a delete
				// mark or an unknown attr is structure). The baseline is the
				// COMMITTED fingerprint: the live rec may carry this
				// transaction's earlier folds.
				const refinable = [...facets].every((f) => facetOf(f) !== 'structure' || f === SLICES);
				const before = refinable ? (committedClaims.get(id) ?? null) : null;
				updateBlockRec(id);
				const same = before !== null && before === claimKeySet(blocks.get(id)?.entries);
				structureChanged = !same;
				recordsChanged = same;
			} else {
				if (kinds.has('at')) refreshCands(id);
				if (kinds.has('meta')) refreshMeta(id);
				ensureRec(id);
			}
			if (content) {
				markTextDirty(id);
				// Anchor resolutions of records covering this text are stale.
				for (const set of recordsByText.get(id)?.values() ?? []) {
					for (const e of set) rangeCache.delete(e);
				}
				// U8b: with the edited spans known, only owners of the ownership
				// intervals they intersect can have different runs — siblings
				// sharing the backing text whose slices merely translate stay
				// cached. Resolved at the end of the fold (`resolveNarrowed`): a
				// `slices` change folded later in the same pass rewrites the
				// records the row is built from.
				if (spans === null) {
					for (const c of textConsumers.get(id) ?? []) invalidateBlock(c, ctx.invalidated);
				} else {
					pendingNarrow.push({ id, spans });
				}
			}
			if (kinds.has('at')) ctx.placement = true;
			if (structureChanged) ctx.structure = ctx.placement = true;
			if (recordsChanged) commitRecordsChurn = true;
			if (structureChanged || recordsChanged) {
				// Consumers of this list itself (holders/walkers incl. self).
				for (const c of listConsumers.get(id) ?? []) invalidateBlock(c, ctx.invalidated);
				// Everything the list's records ever covered / claims ever targeted.
				const fx = effects.get(id);
				for (const t of fx?.texts ?? []) {
					markTextDirty(t);
					for (const c of textConsumers.get(t) ?? []) invalidateBlock(c, ctx.invalidated);
				}
				for (const l of fx?.lists ?? []) {
					for (const c of listConsumers.get(l) ?? []) invalidateBlock(c, ctx.invalidated);
				}
			}
			if (atCommit) {
				const k = claimKeySet(blocks.get(id)?.entries);
				if (k === null) committedClaims.delete(id);
				else committedClaims.set(id, k);
			}
		};

		const registryNode = registry as unknown as EngineNode;

		/**
		 * The block a changed `(type, parentSub)` pair belongs to, the facet
		 * it entered through (the block attr the chain hangs under), and
		 * whether it is a sequence edit of the block's own `content` (whose
		 * edited spans the transaction can locate). Depth-general: a change
		 * inside an inline atom enters through `content`. `null` outside the
		 * registry subtree.
		 */
		const locate = (type: EngineNode, sub: string | null): [BlockId, string, boolean] | null => {
			if (type === registryNode) return typeof sub === 'string' ? [sub, ENTRY_FACET, false] : null;
			let below: EngineNode | null = null;
			for (let cur = type; ; ) {
				const it = cur._item;
				const parent = it?.parent as EngineNode | undefined;
				if (parent === registryNode) {
					const id = it!.parentSub;
					if (typeof id !== 'string') return null;
					if (below === null) return [id, sub ?? '?', false];
					const facet = below._item?.parentSub ?? CONTENT;
					return [id, facet, sub === null && below === type && facet === CONTENT];
				}
				if (!isNodeLike(parent)) return null;
				below = cur;
				cur = parent;
			}
		};

		/** Frames tracking the folds (the write funnel's `track()`), and the report's candidates. */
		const frames = new Set<Folded>();
		const candidates = new Set<BlockId>();
		let reporting = false;

		/**
		 * THE fold: one pass over a set of changed `(type, parentSub)` pairs,
		 * each block folded once with the union of its facets.
		 */
		const fold = (
			changed: Map<unknown, Set<string | null>>,
			extentOf: ExtentLookup,
			atCommit: boolean
		): Map<BlockId, Set<string>> => {
			const touched = new Map<BlockId, Set<string>>();
			const spans = new Map<BlockId, [number, number][] | null>();
			for (const [type, subs] of changed) {
				for (const sub of subs) {
					const hit = locate(type as EngineNode, sub);
					if (hit === null) continue;
					const [id, facet, seq] = hit;
					let facets = touched.get(id);
					if (facets === undefined) touched.set(id, (facets = new Set()));
					facets.add(facet);
					if (facet !== CONTENT || spans.get(id) === null) continue;
					const edited = seq ? extentOf(type as EngineNode) : undefined;
					if (edited === undefined) spans.set(id, null);
					else spans.set(id, [...(spans.get(id) ?? []), ...edited]);
				}
			}
			const ctx: FoldCtx = { invalidated: new Set(), structure: false, placement: false };
			let derived = false;
			for (const [id, facets] of touched) {
				foldBlock(id, facets, spans.get(id) ?? null, ctx, atCommit);
				derived ||= [...facets].some((f) => f === ENTRY_FACET || facetOf(f) !== 'ignore');
			}
			resolveNarrowed(ctx.invalidated, ctx.structure);
			if (ctx.structure) structureVersion++;
			if (ctx.placement) placementVersion++;
			for (const b of ctx.invalidated) dirty.add(b);
			if (derived) version++;
			if (reporting) {
				for (const id of touched.keys()) candidates.add(id);
				for (const id of ctx.invalidated) candidates.add(id);
			}
			for (const f of frames) {
				for (const [id, facets] of touched) {
					const into = f.touched.get(id);
					if (into === undefined) f.touched.set(id, new Set(facets));
					else for (const x of facets) into.add(x);
				}
			}
			return touched;
		};

		type Tx = {
			insertSet?: IdSetLike;
			deleteSet?: IdSetLike;
			changed?: EngineTransaction['changed'];
		};
		/** The open transaction's folded part: copies of its id sets, and their lengths (the watermark). */
		let cursor: { tr: Tx; ins: IdSetLike; del: IdSetLike; mark: number } | null = null;
		const lengthOf = (set: IdSetLike): number => {
			let n = 0;
			set.clients.forEach((ranges) => {
				for (const r of ranges.getIds()) n += r.len;
			});
			return n;
		};

		/**
		 * Fold the pending part of `tr` — the structs its insert/delete sets
		 * gained since the last fold — before a read inside it. Returns
		 * whether the transaction wrote anything since.
		 */
		const syncPending = (tr: Tx | null | undefined): boolean => {
			if (tr?.insertSet === undefined || tr.deleteSet === undefined) return false;
			if (cursor?.tr !== tr) {
				cursor = { tr, ins: Y.createIdSet(), del: Y.createIdSet(), mark: 0 };
			}
			const mark = lengthOf(tr.insertSet) + lengthOf(tr.deleteSet);
			if (mark === cursor.mark) return false;
			const ins = Y.diffIdSet(tr.insertSet as never, cursor.ins as never) as IdSetLike;
			const del = Y.diffIdSet(tr.deleteSet as never, cursor.del as never) as IdSetLike;
			Y.insertIntoIdSet(cursor.ins as never, ins as never);
			Y.insertIntoIdSet(cursor.del as never, del as never);
			cursor.mark = mark;
			for (const f of frames) f.wrote = true;
			const changed = new Map<EngineNode, Set<string | null>>();
			const note = (s: StoreStruct): void => {
				if (!isNodeLike(s.parent)) return;
				let subs = changed.get(s.parent);
				if (subs === undefined) changed.set(s.parent, (subs = new Set()));
				subs.add(s.parentSub);
			};
			walkIdSetStructs(Y, doc, ins, note);
			walkIdSetStructs(Y, doc, del, note);
			fold(changed, makeExtentIndex({ insertSet: ins, deleteSet: del }), false);
			return true;
		};
		const openTx = (): Tx | null | undefined => doc._transaction as Tx | null | undefined;

		/** The commit: fold `transaction.changed` once, then publish to run listeners. */
		const onCommit = (e: EngineDeepEvent): void => {
			const tr = e.transaction as Tx;
			if (cursor?.tr === tr) cursor = null;
			const touched = fold(tr.changed ?? new Map(), makeExtentIndex(tr), true);
			// R5 listener isolation: a throwing subscriber must not starve the
			// rest of this commit's publication; the earliest error propagates
			// to the committer at the end (lib0's `callAll` convention).
			let firstErr: unknown;
			let threw = false;
			const collect = (f: () => void): void => {
				try {
					f();
				} catch (err) {
					if (!threw) {
						threw = true;
						firstErr = err;
					}
				}
			};
			// Eager recompute only where a listener is attached.
			for (const b of [...blockSubs.keys()]) {
				if (dirty.has(b)) collect(() => computeRuns(b));
			}
			// R5: deferred mid-transaction publications land at the commit.
			collect(flushPending);
			if (touched.size > 0) collect(() => callEach([...subs], version));
			if (threw) throw firstErr;
		};

		// ── projection ───────────────────────────────────────────────────

		/** `id`'s projected subtree — content is the ownership-projected slice list. */
		const projectBlock = (id: BlockId): ProjectedBlock => {
			const rec = blocks.get(id)!;
			const projected: ProjectedBlock = {
				id,
				type: rec.type,
				data:
					rec.data === undefined || rec.data === null
						? undefined
						: (cloneJsonSafe(rec.data) as Record<string, unknown>),
				// R4: publish canonical frozen payloads, never borrowed engine refs.
				content: rec.content
					? (protectItems(
							T.contentItemsOf(id, blocks, ownShim) as ContentItem[],
							intern
						) as ContentItem[])
					: [],
				children: []
			};
			if (!rec.content) projected.malformed = true;
			for (const k of kidsMap!.get(id) ?? []) projected.children.push(projectBlock(k.id));
			return projected;
		};

		// ── the change report: the fold against the last published index ─

		type Published = {
			nodes: Map<
				BlockId,
				{
					parent: BlockId | null;
					index: number;
					type: string;
					data: unknown;
					runs: readonly ContentRun[];
					key?: string;
				}
			>;
			order: Map<BlockId | null, readonly BlockId[]>;
			kids: ModelView['kids'] | null;
		};
		let published: Published | null = null;
		const reportSubs = new Set<(r: IndexReport, origin: unknown, local: boolean) => void>();

		/** The reachable tree — nodes carry `prev`'s published payloads where they exist. */
		const reachable = (prev?: Published['nodes']): Published => {
			ensurePlacements();
			const nodes: Published['nodes'] = new Map();
			const order: Published['order'] = new Map();
			const stack: (BlockId | null)[] = [null];
			for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
				const ks = kidsMap!.get(parent) ?? [];
				if (ks.length === 0) continue;
				order.set(parent, Object.freeze(ks.map((k) => k.id)));
				for (let index = ks.length - 1; index >= 0; index--) stack.push(ks[index].id);
				ks.forEach(({ id }, index) => {
					const old = prev?.get(id);
					const rec = blocks.get(id)!;
					nodes.set(
						id,
						old === undefined
							? { parent, index, type: rec.type, data: rec.data, runs: runs(id) }
							: { ...old, parent, index }
					);
				});
			}
			return { nodes, order, kids: kidsMap };
		};

		const keyOf = (v: unknown): string => {
			try {
				return JSON.stringify(v ?? null);
			} catch {
				return JSON.stringify(cloneJsonSafe(v ?? null));
			}
		};
		const sameIds = (a: readonly BlockId[], b: readonly BlockId[]): boolean =>
			a.length === b.length && a.every((id, i) => id === b[i]);

		/** Build the commit's report and advance the published index to it. */
		const report = (): IndexReport | null => {
			const before = published!;
			ensurePlacements();
			if (kidsMap === before.kids && candidates.size === 0) return null;
			const after = kidsMap === before.kids ? before : reachable(before.nodes);
			const r: IndexReport = {
				added: new Map(),
				removed: new Set(),
				moved: new Set(),
				meta: new Map(),
				content: new Map(),
				order: new Map()
			};
			// Added subtrees carry their descendants: none of them is reported
			// again as moved, retyped or edited.
			const covered = new Set<BlockId>();
			if (after !== before) {
				for (const [parent, ids] of after.order) {
					const prev = before.order.get(parent);
					if (prev === undefined || !sameIds(prev, ids)) r.order.set(parent, ids);
				}
				for (const parent of before.order.keys()) {
					if (!after.order.has(parent)) r.order.set(parent, EMPTY_IDS);
				}
				const register = (b: ProjectedBlock): void => {
					covered.add(b.id);
					if (!before.nodes.has(b.id)) r.added.set(b.id, b);
					else {
						// A block that moved into an added subtree is published with it:
						// its baseline becomes what the subtree carries (K7).
						const n = after.nodes.get(b.id)!;
						const rec = blocks.get(b.id)!;
						Object.assign(n, { type: rec.type, data: rec.data, runs: runs(b.id), key: undefined });
					}
					b.children.forEach(register);
				};
				for (const [id, n] of after.nodes) {
					if (!before.nodes.has(id) && !covered.has(id)) register(projectBlock(id));
					else if (!covered.has(id)) {
						const o = before.nodes.get(id)!;
						if (o.parent !== n.parent || o.index !== n.index) r.moved.add(id);
					}
				}
				// Removed subtree ROOTS: an id whose before-ancestor also left is
				// covered by that ancestor's removal.
				for (const [id, o] of before.nodes) {
					if (after.nodes.has(id)) continue;
					let p = o.parent;
					while (p !== null && after.nodes.has(p)) p = before.nodes.get(p)!.parent;
					if (p === null) r.removed.add(id);
				}
			}
			for (const id of candidates) {
				const n = after.nodes.get(id);
				if (n === undefined || covered.has(id)) continue;
				const rec = blocks.get(id)!;
				if (rec.type !== n.type || keyOf(rec.data) !== keyOf(n.data)) {
					r.meta.set(id, {
						type: rec.type,
						data:
							rec.data === undefined || rec.data === null
								? undefined
								: (cloneJsonSafe(rec.data) as Record<string, unknown>)
					});
					n.type = rec.type;
					n.data = rec.data;
				}
				const next = runs(id);
				if (next !== n.runs) {
					const key = keyOf(next);
					if ((n.key ??= keyOf(n.runs)) !== key) r.content.set(id, next);
					n.runs = next;
					n.key = key;
				}
			}
			candidates.clear();
			published = after;
			const empty =
				r.added.size + r.removed.size + r.moved.size + r.meta.size + r.content.size + r.order.size;
			return empty === 0 ? null : r;
		};

		const onUpdate = (_u: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown): void => {
			const r = report();
			if (r === null) return;
			const local = (tr as { local?: boolean }).local === true;
			callEach(
				[...reportSubs].map((cb) => () => cb(r, origin, local)),
				undefined
			);
		};

		// ── initial scan: index every existing block ────────────────────
		registry.forEachAttr((v: unknown, id: string) => {
			if (isNodeLike(v)) {
				const rec = buildRec(id, v);
				blocks.set(id, rec);
				indexEntries(id, rec.entries);
				const k = claimKeySet(rec.entries);
				if (k !== null) committedClaims.set(id, k);
			}
		});

		const observer = (e: EngineDeepEvent): void => onCommit(e);
		registry.observeDeep(observer);
		/** Derived state lives exactly as long as the doc. */
		const teardown = (): void => {
			registry.unobserveDeep(observer);
			doc.off('destroy', teardown);
			doc.off('update', onUpdate);
			indexes.delete(doc);
		};
		doc.on('destroy', teardown);

		// ── public surface ───────────────────────────────────────────────

		const view: RunView = {
			version: () => {
				syncPending(openTx());
				return version;
			},
			blockVersion: (b: BlockId): number => {
				runs(b);
				return stamps.get(b) ?? 0;
			},
			runs,
			snapshot: (b: BlockId): ContentRun[] => JSON.parse(JSON.stringify(runs(b))) as ContentRun[],
			contentItems: (b: BlockId): ContentItem[] => {
				syncPending(openTx());
				const rec = blocks.get(b);
				if (rec?.content === undefined || rec.deleted) return [];
				return protectItems(T.contentItemsOf(b, blocks, ownShim) as ContentItem[], intern);
			},
			contentJSON: (b: BlockId) =>
				runs(b).map((r) => {
					if (r.kind === 'text') {
						const out: {
							text: string;
							marks?: Record<string, unknown>;
						} = { text: r.text };
						if (r.marks !== undefined) {
							out.marks = JSON.parse(JSON.stringify(r.marks)) as Record<string, unknown>;
						}
						return out;
					}
					// Inline atoms always carry `data` (`{}` when absent) — the
					// public `JSONInlineBlock` shape of `edytor.value`.
					const inl = r as { id: string; type: string; data?: unknown };
					return {
						id: inl.id,
						type: inl.type,
						data: inl.data === undefined ? {} : (JSON.parse(JSON.stringify(inl.data)) as unknown)
					};
				}),
			subscribe: (cb: (v: number) => void) => {
				subs.add(cb);
				return () => subs.delete(cb);
			},
			subscribeBlock: (b: BlockId, cb: (runs: readonly ContentRun[]) => void) => {
				// Prime the baseline BEFORE registering: the listener only
				// ever sees genuine diffs, never the initial compute. The
				// primed array is the published-state watermark `publish`
				// diffs against.
				const baseline = runs(b);
				let set = blockSubs.get(b);
				if (!set) {
					set = new Set();
					blockSubs.set(b, set);
					publishedRuns.set(b, baseline);
				}
				set.add(cb);
				return () => {
					set.delete(cb);
					if (set.size === 0) {
						blockSubs.delete(b);
						publishedRuns.delete(b);
						pendingNotify.delete(b);
					}
				};
			},
			view: (tr?: unknown): ModelView => {
				syncPending((tr as Tx | undefined) ?? openTx());
				return ctx;
			},
			project: (root?: BlockId): ProjectedBlock[] => {
				syncPending(openTx());
				ensurePlacements();
				return root === undefined
					? (kidsMap!.get(null) ?? []).map((k) => projectBlock(k.id))
					: [projectBlock(root)];
			},
			track: () => {
				syncPending(openTx());
				const f: Folded = { touched: new Map(), wrote: false };
				frames.add(f);
				return {
					end: () => {
						syncPending(openTx());
						frames.delete(f);
						return f;
					}
				};
			},
			onReport: (cb) => {
				if (reportSubs.size === 0) {
					syncPending(openTx());
					published = reachable();
					candidates.clear();
					reporting = true;
					doc.on('update', onUpdate);
				}
				reportSubs.add(cb);
				return () => {
					if (!reportSubs.delete(cb) || reportSubs.size > 0) return;
					doc.off('update', onUpdate);
					published = null;
					reporting = false;
					candidates.clear();
				};
			},
			debug
		};
		return view;
	};

	return { attach };
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
 * - Output is frozen. Frozen inputs (the interned `marks`/`data` of a live
 *   `view.runs()` array) are shared verbatim; MUTABLE caller values — a
 *   `snapshot()` clone's payloads, decoration values — are cloned first,
 *   so the freeze never lands on caller-owned data (R4).
 *
 * Typical use: `decorateRuns(view.snapshot(b), prismDecorations)` in a
 * render layer. The returned array is a fresh structure — it shares run
 * sub-objects where unsplit but never mutates the input snapshot.
 */
export const decorateRuns = (
	runs: readonly ContentRun[],
	decorations: readonly LocalDecoration[]
): readonly DecoratedRun[] => {
	/**
	 * Prepare a caller-owned payload for the frozen output (R4): the
	 * emitted objects are deep-frozen, but freezing must never land on the
	 * CALLER's data — a mutable object (a `snapshot()` result's `marks`, a
	 * decoration `value`) is cloned first so the caller's copy stays
	 * mutable. Already-frozen values (the interned `marks`/`data` of a
	 * live `view.runs()` array) pass through verbatim — sharing is safe
	 * and preserves the interned identity. Non-plain values (render
	 * callbacks, class instances) pass through unfrozen — they cannot be
	 * field-cloned and `Object.freeze` on them would corrupt the caller's
	 * live object for no benefit.
	 */
	const freezeOverlayValue = (v: unknown, seen: Set<unknown>): unknown => {
		if (v === null || typeof v !== 'object' || Object.isFrozen(v) || seen.has(v)) return v;
		const proto = Object.getPrototypeOf(v);
		if (proto !== Object.prototype && proto !== null && !Array.isArray(v)) return v;
		seen.add(v);
		try {
			if (Array.isArray(v)) {
				return Object.freeze(v.map((x) => freezeOverlayValue(x, seen)));
			}
			const out: Record<string, unknown> = {};
			for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
				out[k] = freezeOverlayValue(item, seen);
			}
			return Object.freeze(out);
		} finally {
			seen.delete(v);
		}
	};
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
					else m[d.key] = freezeOverlayValue(d.value, new Set());
				}
			}
			// The map is fresh per run — freeze it too; the run-wrapper
			// freeze below is shallow.
			return m && Object.keys(m).length > 0 ? Object.freeze(m) : undefined;
		};
		if (run.kind !== 'text') {
			const inl = run as { id: string; type: string; data?: Record<string, unknown> };
			const d = decoMap(r0, r1);
			out.push({
				kind: 'inline',
				id: inl.id,
				type: inl.type,
				...(inl.data === undefined
					? {}
					: {
							data: freezeOverlayValue(inl.data, new Set()) as Record<string, unknown>
						}),
				...(d === undefined ? {} : { decorations: d })
			});
			continue;
		}
		const text = (run as { text: string }).text;
		const marks = (run as { marks?: Record<string, unknown> }).marks;
		const marksOut =
			marks === undefined
				? undefined
				: (freezeOverlayValue(marks, new Set()) as Record<string, unknown>);
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
				...(marksOut === undefined ? {} : { marks: marksOut }),
				...(d === undefined ? {} : { decorations: d })
			});
		}
	}
	// The emitted payloads are frozen (or passed-through-frozen) already —
	// only the fresh run wrappers need the freeze.
	return Object.freeze(out.map((r) => Object.freeze(r)));
};

export type RunsApi = ReturnType<typeof bindRuns>;
