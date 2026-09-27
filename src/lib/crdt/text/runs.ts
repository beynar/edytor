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
 * `subscribeBlock` listeners). Publication is COMMIT-BOUND (R5): a
 * mid-transaction `runs()` read refreshes the cache for read-your-writes
 * but queues subscriber notification for the commit's `handleEvent`, so
 * listeners observe only complete committed snapshots — and none when a
 * transaction nets out unchanged.
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
	ResolvedPlacement
} from '../placement/model.js';
import {
	candidatesOf,
	childrenIndex,
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

type AttrOp = { type?: string; value?: unknown };
type DeltaJSON = {
	type?: string;
	name?: string;
	attrs?: Record<string, AttrOp>;
	children?: unknown[];
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

// Schema attr names come from `../schema.js` (the shared leaf — S10).
// `DEAD` is imported from ./model.js — the shared unique-symbol sentinel
// (a literal 'dead' string collided with the valid caller block id).

/**
 * Facets of a block node that can change derived state. WU7 splits the old
 * `ignore` bucket into `at` (placement candidate writes — invalidate the
 * placement/order facets but never the content facets) and `meta`
 * (type/data payload writes — invalidate only metadata projections).
 */
type Facet = 'content' | 'structure' | 'gone' | 'at' | 'meta' | 'ignore';

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
 * Per-commit invalidation report for `DocChange` fast paths (WU7). The
 * state's observer rebuilds it on every registry event:
 *
 * - `seq` — the view's version AFTER this commit (compared by listeners
 *   against their last-seen value to detect registry-touched updates).
 * - `fast` — true iff the commit touched ONLY `content`/`meta` facets:
 *   no placements, ownership structure, registry entries or deletes, so
 *   a snapshot may be patched for exactly the touched ids.
 * - `content` — block ids whose maintained runs may differ now.
 * - `meta` — block ids whose type/data payload may differ now.
 */
export type CommitInfo = {
	seq: number;
	fast: boolean;
	content: ReadonlySet<BlockId>;
	meta: ReadonlySet<BlockId>;
};

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
	 * Transaction-aware canonical content items of `id` — the same shape
	 * `M.project`/`T.contentItemsOf` emit. Interned payloads: `marks`/`data`
	 * are the shared frozen instances — `===` with the payloads `runs(id)`
	 * publishes for equal content.
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
	/** Subscribe to every observed change — `cb(version)`. */
	subscribe: (cb: (version: number) => void) => () => void;
	/**
	 * Subscribe to ONE block's run changes — `cb(runs)` fires once per
	 * committed transaction, only when the committed snapshot differs from
	 * what listeners last saw (R5). A mid-transaction `runs()` read still
	 * recomputes the cache for read-your-writes, but the notification is
	 * deferred to commit, so subscribers never observe partial state.
	 * Blocks with subscribers recompute eagerly at commit; others
	 * recompute lazily on read.
	 */
	subscribeBlock: (id: BlockId, cb: (runs: readonly ContentRun[]) => void) => () => void;
	/**
	 * The shared model-state ctx (WU7) — the maintained block/ownership/
	 * placement/children indexes behind this view, synced against the
	 * in-flight transaction on every call (read-your-writes). This is what
	 * `bindModel`'s `view()` returns while the state is attached.
	 */
	modelCtx: () => ModelView;
	/** Per-commit invalidation report — see {@link CommitInfo}. */
	commitInfo: () => CommitInfo;
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
			// One view per doc — the first caller builds the shared view.
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
			contentItems: (b) => view.contentItems(b),
			contentJSON: (b) => view.contentJSON(b),
			subscribe: (cb) => view.subscribe(cb),
			subscribeBlock: (b, cb) => view.subscribeBlock(b, cb),
			modelCtx: () => view.modelCtx(),
			commitInfo: () => view.commitInfo(),
			dispose: release,
			debug: view.debug
		};
	};

	/**
	 * The doc's shared `ModelView` when a view is attached — the provider
	 * `bindEdytorDoc` injects into `bindModel` so commands, anchors and
	 * rendering read the SAME maintained indexes (WU7). `undefined` when
	 * no view exists yet (callers fall back to fresh computation).
	 */
	const modelState = (doc: EngineDoc): ModelView | undefined => views.get(doc)?.view.modelCtx();

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
		 * whole transaction is opaque). Rebuilt per call — an in-flight
		 * transaction's sets keep growing between `syncTransaction` folds.
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

		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;

		/** Fresh-checking `ownerOf` for external consumers (shim `own`). */
		const shimOwnerOf = (b: BlockId): Owner => {
			ensureOwners();
			return ownerOf(b);
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
		 * The `Ownership` surface the shared ctx hands to model/text
		 * consumers — backed by the state's own incremental indexes:
		 *
		 * - `ownerOf`/`hidden` read the lazily-rebuilt `owners` map.
		 * - `intervals`/`maxG` are shimmed over the per-text `atomRows` —
		 *   `Map.get(t)` recomputes ONLY that text's row (its claims and
		 *   their anchor resolutions), never the whole document.
		 * - `resolvedRange` shares the run view's anchor-range cache.
		 */
		const ownShim: Ownership = {
			ownerOf: shimOwnerOf,
			hidden: (b: BlockId): boolean => shimOwnerOf(b) !== b,
			intervals: {
				get: (t: string) => {
					ensureOwners();
					return ensureRow(t).ivs;
				}
			} as Ownership['intervals'],
			resolvedRange: (entry: SliceEntry, text: EngineNode) => {
				ensureOwners();
				return rangeOf(entry, text) as [number, number] | null;
			},
			maxG: {
				get: (t: string) => {
					ensureOwners();
					return ensureRow(t).maxG;
				}
			} as Ownership['maxG']
		};

		/**
		 * The shared `ModelView` — what `bindModel`'s `view()` returns when
		 * this state is attached. `blocks` is the LIVE maintained map (safe:
		 * consumers never mutate it); `own` is the shim above; `placements`
		 * and `kids` are getters so content-only ops never trigger a rebuild.
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
			intern
		};

		// ── per-commit change info for DocChange fast paths (WU7) ────────
		//
		// Rebuilt inside `handleEvent`: the set of blocks whose RUNS may
		// have changed (`content`), the set whose type/data may have changed
		// (`meta`), and `fast` — true iff nothing structural, placement- or
		// registry-level happened, so a listener may patch its snapshot for
		// exactly these ids instead of re-walking the document.
		const commitContent = new Set<BlockId>();
		const commitMeta = new Set<BlockId>();
		let commitFast = true;

		/**
		 * Claim-multiset fingerprints as of the last COMMITTED registry
		 * state. `syncTransaction`'s mid-transaction fold advances
		 * `blocks` recs ahead of the commit boundary (read-your-writes), so
		 * comparing `claimKeySet` against the live rec at commit time
		 * always reports `claimsSame` — a real claim write (merge/move)
		 * would be misclassified as record churn, `commitFast` would stay
		 * true, and the order-only change would be invisible to the
		 * `DocChange` fast path (`diffFast` never diffs order) — the
		 * commit would silently never reach `onChange` subscribers.
		 * The fingerprint is therefore refreshed only inside the commit
		 * fold (`atCommit`), never mid-transaction.
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
			// Read-your-writes: `runs()` is reachable mid-transaction through
			// the facade's public run surface — fold the in-flight
			// transaction's changes into the dirty marks first (idempotent).
			// The recompute updates the CACHE immediately; only subscriber
			// publication is deferred to the commit boundary (R5).
			syncTransaction();
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
		 * Which derived facets a block-level change touched. `structure`
		 * forces an owners rebuild (claim graph + entry set); `placement`
		 * forces a placements/children-index rebuild. Either way the flags
		 * feed `commitFast`: a commit is DocChange-fast-path eligible only
		 * when NEITHER fired.
		 */
		type DirtyFlags = { structure: boolean; placement: boolean };

		/**
		 * The op's attr keys, or `[]` when the event carries no attr detail
		 * (insert/delete ops, unrecognized payloads).
		 */
		const opAttrKeys = (op: AttrOp | undefined): string[] => {
			const inner = op?.value as DeltaJSON | undefined;
			const attrs = inner && typeof inner === 'object' ? inner.attrs : undefined;
			return attrs ? Object.keys(attrs) : [];
		};

		/**
		 * Eligible for the claim-set refinement: the op carries attr detail
		 * and EVERY structure-classified attr is `slices`. Other facets may
		 * coexist (`{content,slices}` is the typing shape — their own
		 * branches still run); a `del` or unknown attr forces full
		 * structure.
		 */
		const claimRefinable = (op: AttrOp | undefined): boolean => {
			const keys = opAttrKeys(op);
			if (keys.length === 0) return false;
			const structural = keys.filter((k) => facetOf(k) === 'structure');
			return structural.length > 0 && structural.every((k) => k === SLICES);
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

		const handleBlockChange = (
			id: BlockId,
			op: AttrOp | undefined,
			invalidated: Set<BlockId>,
			flags: DirtyFlags,
			hint?: { content?: readonly [number, number][] },
			atCommit = false
		): void => {
			const facets = facetsOfBlockOp(op);
			let structureChanged = false;
			// Record-only `slices` churn (same claim set) — the range-level
			// fanout below still runs, but owners/placements/kids stay put.
			let recordsChanged = false;
			if (facets.has('gone')) {
				updateBlockRec(id); // drops the rec + prunes record index
				structureChanged = true;
			} else if (facets.has('structure')) {
				// Baseline is the COMMITTED fingerprint — `blocks` recs may
				// already carry this transaction's writes (syncTransaction's
				// mid-transaction fold), so the live rec is not a valid
				// "before" for claim-set comparison.
				const claimsBefore = claimRefinable(op) ? (committedClaims.get(id) ?? null) : null;
				updateBlockRec(id);
				const claimsSame =
					claimsBefore !== null && claimsBefore === claimKeySet(blocks.get(id)?.entries);
				structureChanged = !claimsSame;
				recordsChanged = claimsSame;
			} else if (facets.has('at')) {
				refreshCands(id);
			} else if (facets.has('meta')) {
				refreshMeta(id);
			} else {
				ensureRec(id);
			}
			if (facets.has('content')) {
				markTextDirty(id);
				commitContent.add(id);
				// Anchor resolutions of records covering this text are stale.
				const byHolder = recordsByText.get(id);
				if (byHolder) {
					for (const set of byHolder.values()) {
						for (const e of set) rangeCache.delete(e);
					}
				}
				// U8b: when the transaction identifies the edited spans, only
				// owners of the ownership intervals they intersect can have
				// different runs — siblings sharing the backing text whose
				// slices merely translate stay cached. Resolution is DEFERRED
				// to the end of the changed-entry fold (`resolveNarrowed`):
				// a `slices`/structure entry processed later in the same
				// commit (e.g. an undo-repair claim unioned into the
				// committing transaction's changed map) rewrites the very
				// records the row would be built from, so resolving inline
				// here could read a pre-churn row and miss the real owner.
				if (hint?.content === undefined) {
					for (const c of textConsumers.get(id) ?? []) invalidateBlock(c, invalidated);
				} else {
					pendingNarrow.push({ id, spans: hint.content });
				}
			}
			if (facets.has('meta')) commitMeta.add(id);
			if (facets.has('at')) flags.placement = true;
			if (structureChanged) {
				flags.structure = true;
				flags.placement = true;
			}
			if (recordsChanged) commitRecordsChurn = true;
			if (structureChanged || recordsChanged) {
				commitContent.add(id);
				// Consumers of this list itself (holders/walkers incl. self).
				for (const c of listConsumers.get(id) ?? []) invalidateBlock(c, invalidated);
				// Everything the list's records ever covered / claims ever targeted.
				const fx = effects.get(id);
				if (fx) {
					for (const t of fx.texts) {
						markTextDirty(t);
						for (const c of textConsumers.get(t) ?? []) invalidateBlock(c, invalidated);
					}
					for (const l of fx.lists) {
						for (const c of listConsumers.get(l) ?? []) invalidateBlock(c, invalidated);
					}
				}
			}
			if (atCommit) {
				// Advance the commit-boundary fingerprint — never done by the
				// mid-transaction fold, which must leave the pre-transaction
				// baseline intact for the commit-time claim comparison.
				const k = claimKeySet(blocks.get(id)?.entries);
				if (k === null) committedClaims.delete(id);
				else committedClaims.set(id, k);
			}
		};

		/**
		 * Map one `Transaction.changed` entry back to block/facet coordinates
		 * and apply the same invalidation as the commit path — the WU7
		 * read-your-writes bridge. `type` is the changed shared type, `sub`
		 * the parentSub it reports (blockId on the registry, attr name on a
		 * block node, null for sequence edits). Types outside the registry
		 * subtree (e.g. the `meta` root) are ignored.
		 *
		 * WU9: the ancestor walk is depth-general — a change at ANY depth
		 * inside a block's subtree (e.g. an attr write on an inline atom
		 * nested inside `content`) invalidates through the facet of the
		 * chain node directly below the block, matching the bubbling a
		 * rendered deep delta reports. The old three-level unroll ignored
		 * deeper-than-grandchild changes, which could leave runs stale.
		 */
		const applyTypeChange = (
			type: EngineNode,
			sub: string | null,
			invalidated: Set<BlockId>,
			flags: DirtyFlags,
			extentOf: ExtentLookup,
			atCommit = false
		): void => {
			if (type === (registry as unknown as EngineNode)) {
				// Registry entry inserted/deleted under key `sub` (a blockId).
				if (typeof sub !== 'string') return;
				const live = isNodeLike(registry.getAttr(sub));
				handleBlockChange(
					sub,
					{ type: live ? 'insert' : 'delete' },
					invalidated,
					flags,
					undefined,
					atCommit
				);
				return;
			}
			// Walk the item-parent chain until the registry's direct child.
			// `below` tracks the node one level under `cur`; when `cur`
			// reaches the block, `below` is the block's own child whose
			// parentSub names the facet the change entered through.
			let cur: EngineNode = type;
			let below: EngineNode | null = null;
			for (;;) {
				const it = cur._item;
				if (!it) return; // detached or a non-registry root — outside our subtree
				const parent = it.parent as EngineNode | undefined;
				if (parent === (registry as unknown as EngineNode)) {
					const bid = it.parentSub as BlockId | null | undefined;
					if (typeof bid !== 'string') return;
					if (below === null) {
						// `type` IS a block node — `sub` is the changed attr name.
						handleBlockChange(
							bid,
							{ type: 'modify', value: { attrs: { [sub ?? '?']: {} } } },
							invalidated,
							flags,
							undefined,
							atCommit
						);
						return;
					}
					// `type` is a descendant — invalidate through the facet of
					// the chain node directly under the block (its own
					// parentSub attr name: content/slices/at).
					const facet = below._item?.parentSub ?? 'content';
					// U8b: a sequence edit (sub === null) on the block's own
					// `content` node carries per-item extents — the narrowing
					// hint `handleBlockChange` needs to skip untouched
					// consumers of the shared backing text. Deeper changes
					// (e.g. inside an inline atom) arrive without extents →
					// conservative all-consumers.
					const hint =
						sub === null && below === type && facet === CONTENT
							? { content: extentOf(type) }
							: undefined;
					handleBlockChange(
						bid,
						{ type: 'modify', value: { attrs: { [facet]: {} } } },
						invalidated,
						flags,
						hint,
						atCommit
					);
					return;
				}
				if (!isNodeLike(parent)) return;
				below = cur;
				cur = parent;
			}
		};

		/**
		 * Fold the in-flight transaction's `changed` set into the state's
		 * dirty marks so reads issued mid-transaction see their own writes
		 * (read-your-writes). Idempotent — `Transaction.changed` accumulates
		 * during the transaction, so every call re-marks the same entries;
		 * the commit event then rebuilds the per-commit info from scratch.
		 */
		const syncTransaction = (): void => {
			const changed = doc._transaction?.changed;
			if (!changed || changed.size === 0) return;
			const invalidated = new Set<BlockId>();
			const flags: DirtyFlags = { structure: false, placement: false };
			const extents = makeExtentIndex(doc._transaction);
			for (const [type, subs] of changed) {
				for (const sub of subs) {
					applyTypeChange(type as EngineNode, sub, invalidated, flags, extents);
				}
			}
			resolveNarrowed(invalidated, flags.structure);
			if (flags.structure) structureVersion++;
			if (flags.placement) placementVersion++;
			for (const b of invalidated) dirty.add(b);
		};

		const handleEvent = (e: EngineDeepEvent): void => {
			// Per-commit info rebuild — cleared first so the facade's
			// DocChange fast path sees exactly THIS commit's touched sets.
			commitContent.clear();
			commitMeta.clear();
			commitFast = true;
			const invalidated = new Set<BlockId>();
			const flags: DirtyFlags = { structure: false, placement: false };
			// R5 listener isolation: a throwing subscriber must not starve
			// the rest of this commit's publication — eager recomputes, the
			// deferred queue AND the doc-level version listeners all still
			// run; the earliest error propagates to the committer at the end
			// (the lib0 `callAll` convention the engine's own dispatch uses).
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
			// WU9: derive invalidation from the transaction's `changed` map
			// (the same source the mid-transaction bridge folds through
			// `applyTypeChange`) instead of rendering `event.deltaDeep` — the
			// deep delta is a recursive delta render of the whole subtree
			// with per-attr op objects, produced on every commit event even
			// though this observer is the only consumer. The changed map
			// records exactly the touched (type, parentSub) pairs, so the
			// commit cost becomes proportional to the number of changed
			// types rather than to the deep-delta render size.
			const changed = (e.transaction as EngineTransaction | undefined)?.changed;
			if (changed !== undefined && changed.size > 0) {
				const extents = makeExtentIndex(e.transaction);
				for (const [type, subs2] of changed) {
					for (const sub of subs2) {
						applyTypeChange(type as EngineNode, sub, invalidated, flags, extents, true);
					}
				}
				resolveNarrowed(invalidated, flags.structure);
			} else if (changed === undefined) {
				// Foreign/synthetic event shape without transaction detail —
				// fall back to the rendered deep-delta payload.
				const deep = (e.deltaDeep?.toJSON?.() ?? null) as DeltaJSON | null;
				const attrs = deep && typeof deep === 'object' ? deep.attrs : undefined;
				if (!attrs || typeof attrs !== 'object') {
					// Unrecognized event payload — do not guess: a change reached
					// the registry subtree, so conservatively invalidate every
					// cached block rather than serve stale runs.
					structureVersion++;
					placementVersion++;
					commitFast = false;
					for (const b of cache.keys()) dirty.add(b);
					collect(flushPending);
					version++;
					collect(() => callEach([...subs], version));
					if (threw) throw firstErr;
					return;
				}
				for (const [id, op] of Object.entries(attrs)) {
					handleBlockChange(id, op, invalidated, flags, undefined, true);
				}
				// The legacy fold never narrows (no extent hints), but it can
				// still set `commitRecordsChurn` — clear it so a stale flag
				// does not collapse the NEXT Map-shaped fold's narrowing.
				pendingNarrow.length = 0;
				commitRecordsChurn = false;
			} else {
				// `changed` present but empty — the engine fired an event with
				// no recorded type change; conservatively invalidate rather
				// than serve stale runs.
				structureVersion++;
				placementVersion++;
				commitFast = false;
				for (const b of cache.keys()) dirty.add(b);
				collect(flushPending);
				version++;
				collect(() => callEach([...subs], version));
				if (threw) throw firstErr;
				return;
			}
			if (flags.structure) structureVersion++;
			if (flags.placement) placementVersion++;
			for (const b of invalidated) {
				dirty.add(b);
				commitContent.add(b);
			}
			if (flags.structure || flags.placement) commitFast = false;
			// Eager recompute only where a listener is attached — everything
			// else stays lazy until read.
			for (const b of invalidated) {
				if (blockSubs.has(b) && dirty.has(b)) collect(() => computeRuns(b));
			}
			// R5: deferred mid-transaction publications land here — the
			// commit boundary — so subscribers observe the final runs once.
			collect(flushPending);
			version++;
			collect(() => callEach([...subs], version));
			if (threw) throw firstErr;
		};

		// ── initial scan: index every existing block's slices state ─────
		registry.forEachAttr((v: unknown, id: string) => {
			if (isNodeLike(v)) {
				const rec = buildRec(id, v);
				blocks.set(id, rec);
				indexEntries(id, rec.entries);
				const k = claimKeySet(rec.entries);
				if (k !== null) committedClaims.set(id, k);
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
			committedClaims.clear();
			blockSubs.clear();
			publishedRuns.clear();
			pendingNotify.clear();
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
			contentItems: (b: BlockId): ContentItem[] => {
				// Transaction-aware canonical items — the seam where
				// `project()`/`contentItems()`/DocChange `added` payloads pick
				// up the same projection the run cache publishes.
				syncTransaction();
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
			modelCtx: (): ModelView => {
				// Read-your-writes: fold the in-flight transaction's changed
				// set into the dirty marks before handing out the indexes.
				syncTransaction();
				return ctx;
			},
			commitInfo: (): CommitInfo => ({
				seq: version,
				fast: commitFast,
				content: commitContent,
				meta: commitMeta
			}),
			dispose: teardown,
			debug
		};
		return view;
	};

	return { attach, modelState };
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
