/**
 * The per-document index and its change report —
 * the ONE owner of every fact derived from the replicated document: block
 * records, the claim graph, the stream table, resolved placements, the
 * children index and document order, and each block's visible content as
 * ordered, immutable runs.
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
 *   the facet it entered through (`content`, `claims`, `at`, `n`, a delete
 *   mark, `type`/`data`, or the registry entry itself); one routine folds a
 *   set of such pairs into the indexes.
 * - A transaction is folded ONCE at commit, from `transaction.changed`.
 * - A read first folds the PENDING part of every transaction whose writes
 *   are in the document and whose commit fold has not run: the open one, and
 *   those a transaction's cleanup started (their bodies ran, their observers
 *   have not) — the structs their insert/delete sets gained since the last
 *   fold (the watermark is those sets' lengths). The commit fold takes only
 *   what no read folded.
 * - Each backing text has a maintained row (`text/rows.ts`): its
 *   boundaries and the live units between them. An edit that writes or
 *   removes no boundary moves the row by its units in the gap it lies in
 *   (found by walking the item list to the nearest boundary), never a
 *   rescan; a boundary written or removed rescans that text, re-decides the
 *   delimiters of the blocks its boundaries name, and re-places only the
 *   rows those cut. Every cached block records which texts its display
 *   walked and which blocks it walked or read a claim on (a skipped claim
 *   included); an edit invalidates the display owner of the stream it lies
 *   in, a placement the blocks whose stream's delimiting boundaries changed
 *   (or every reader of the text when the fold cannot say: a format marker,
 *   a change inside an atom).
 *
 * Publication is COMMIT-BOUND: a mid-transaction read refreshes the
 * cache for read-your-writes, but the change report observes committed
 * state only — nested transactions publish once, and a transaction that
 * nets out unchanged publishes nothing.
 *
 * The change report `{added, removed, moved, meta, content, order}` is the
 * fold against the last published index: the blocks the commit's folds
 * touched or invalidated are compared with what was published for them;
 * the child lists the commit patched are compared with the published ones,
 * advancing the published tree in place (after a whole rebuild, the
 * reachable tree is compared).
 *
 * The index is built from parts under `index/`, each over the shared state
 * (`index/state.ts`) and the parts before it: the claim graph
 * (`claims.ts`), the stream table (`streams.ts`), anchored merge claims
 * (`anchored.ts`), the layout rules (`layout.ts`), placements and the
 * children index (`placement.ts`), block records (`records.ts`), the run
 * cache (`cache.ts`), the fold (`fold.ts`), the change report
 * (`report.ts`) and the self-checks (`checks.ts`). This module declares the
 * index's types and wires the parts into the doc's one index.
 */
import type { EngineApi, EngineDeepEvent, EngineDoc } from '../engine-api.js';
import type { BlockId, ContentItem, ModelView, ProjectedBlock } from '../placement/model.js';
import { bindText } from './model.js';
import { isNodeLike } from '../schema.js';
import { cloneJsonSafe } from '../../utils/json.js';
import { indexState, type Tx } from './index/state.js';
import { indexClaims } from './index/claims.js';
import { indexStreams } from './index/streams.js';
import { indexAnchored } from './index/anchored.js';
import { indexLayout } from './index/layout.js';
import { indexPlacement } from './index/placement.js';
import { indexRecords } from './index/records.js';
import { indexCache } from './index/cache.js';
import { indexFold } from './index/fold.js';
import { indexReporter } from './index/report.js';
import { indexSelfChecks } from './index/checks.js';

export { CONTENT_ATTR, ENTRY_FACET, indexChecks } from './index/shared.js';

/**
 * One visible run of a block — the maintained form of `ContentItem`.
 * `marks`/`data` are interned: equal payloads share one frozen instance,
 * so `===` compares formatting without deep walks. A run carries no
 * authorship: runs never split at author boundaries, and durable
 * attribution is the compact per-block record (`blockattr`).
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

/**
 * One commit's change report — the fold against the last published
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
	/** The document's own data, when it changed. */
	data?: Record<string, unknown>;
};

/** What the folds since {@link RunView.track} saw: facets per block, and whether anything was written. */
export type Folded = { touched: Map<BlockId, Set<string>>; wrote: boolean };

export type RunViewDebug = {
	/** Total run recomputes since attach (or last `reset()`). */
	recomputes: number;
	/** Block ids recomputed since last `reset()`. */
	recomputed: Set<BlockId>;
	/**
	 * Sequence items stepped over inside maintained range reads since last
	 * `reset()` — the counter that shows reads scale with the range
	 * plus a bounded checkpoint gap, not the whole backing text.
	 */
	readonly itemsWalked: number;
	/** Format markers seen inside maintained range reads (subset of `itemsWalked`). */
	readonly markersWalked: number;
	/** Fold frames open (`track()` not yet ended): 0 between writes. */
	readonly frames: number;
	/**
	 * Fold passes since last `reset()`: one per commit, one per read that
	 * found pending writes in an open transaction.
	 */
	readonly folds: number;
	/** `(type, key)` pairs those folds located since last `reset()`: the folds' input. */
	readonly foldedPairs: number;
	/**
	 * Structs the reads inside a transaction folded (its pending part) since
	 * last `reset()`: each struct once, whatever the number of reads.
	 */
	readonly foldedStructs: number;
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
	/** Frozen snapshot of `id`'s visible runs (`[]` when absent/hidden). */
	runs: (id: BlockId) => readonly ContentRun[];
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
	 * Set the roles the display reads ({@link DisplayRoles}). Call again
	 * when an answer changes for a kind (roles adopted later); the
	 * placements rebuild and subscribers get the report at once (origin
	 * `null`, not local).
	 */
	roles: (roles: DisplayRoles) => void;
	/** The kind a live block displays as when it is not its stored one (promoted out of an island). */
	displayType: (id: BlockId) => string | undefined;
	/**
	 * `id` is a live block the layout rules do not display — an empty or
	 * bare item, a layout showing one item or none (`layout.*`): hidden
	 * without a delete mark, its children shown in its slot.
	 */
	dissolved: (id: BlockId) => boolean;
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

/**
 * The role table — one answer per kind, which the display and the
 * document's guards both ask. `childless`: kinds that display no children
 * (void roles) — a child of such a block displays in its slot.
 * `island`: a block promoted out of an island kind displays as
 * `defaultChild` of its display parent's kind (`null`: the root). `line`:
 * an island declared `lines` holds only lines — each direct child displays
 * as its line kind and holds no children. `container`: a
 * kind that renders no content and is neither void nor an island (a list)
 * — a block promoted out of one follows like one promoted out of an island. `rendersContent`: no block that renders content ever shows
 * as a kind that does not (its text would vanish). `layout`: a
 * layout kind displays only its items, and only two or more (`layout.*`).
 * `table`: a table kind displays only its rows, a row only its cells, in
 * the table's column order (`table.*`).
 */
export type DisplayRoles = {
	childless: (type: string) => boolean;
	island: (type: string) => boolean;
	container: (type: string) => boolean;
	rendersContent: (type: string) => boolean;
	defaultChild: (parentType: string | null) => string;
	/** The line kind of an island kind declared `lines` (its `defaultChild`), if any. */
	line: (islandType: string) => string | undefined;
	/** Every line kind the roles declare, present in the document or not. */
	lineKinds: () => Iterable<string>;
	/** The item kind of a layout kind (its `defaultChild`), if `type` is one. */
	layout: (type: string) => string | undefined;
	/** Every layout kind the roles declare, present in the document or not. */
	layoutKinds: () => Iterable<string>;
	/** The row kind of a table kind (its `defaultChild`), if `type` is one (`table.*`). */
	table: (type: string) => string | undefined;
	/** Every table kind the roles declare, present in the document or not. */
	tableKinds: () => Iterable<string>;
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
		// The index's parts, each over the state and the parts before it (`index/*`).
		const ix0 = indexState(Y, T, doc);
		const ix1 = Object.assign(ix0, indexClaims(ix0));
		const ix2 = Object.assign(ix1, indexStreams(ix1));
		const ix3 = Object.assign(ix2, indexAnchored(ix2));
		const ix4 = Object.assign(ix3, indexLayout(ix3));
		const ix5 = Object.assign(ix4, indexPlacement(ix4));
		const ix6 = Object.assign(ix5, indexRecords(ix5));
		const ix7 = Object.assign(ix6, indexCache(ix6));
		const ix8 = Object.assign(ix7, indexFold(ix7));
		const ix = Object.assign(ix8, indexReporter(ix8));
		ix.checks = indexSelfChecks(ix);
		const {
			registry,
			blocks,
			rows,
			homeOfText,
			shells,
			placementsMap,
			frames,
			displays,
			ownShim,
			ensurePlacements,
			typeOf,
			order,
			rebuildTable,
			scanRow,
			applyRetargets,
			updateBlockRec,
			syncIncarnations,
			intern,
			debug,
			runs,
			settle,
			syncPending,
			syncAll,
			openTx,
			onCommit,
			committed,
			itemsOf,
			projectBlock,
			publish,
			onUpdate,
			onReport,
			hasSubscribers
		} = ix;

		const ctx: ModelView = {
			blocks,
			own: ownShim,
			get placements() {
				ensurePlacements();
				return placementsMap;
			},
			get kids() {
				ensurePlacements();
				return ix.kidsMap;
			},
			get order() {
				ensurePlacements();
				return order();
			},
			// The publication boundary shares THIS interner, so a payload
			// emitted by `project()`/`contentItems()` is `===` the runs' one.
			intern,
			displays
		};

		// ── initial scan: index every existing block ────────────────────
		registry.forEachAttr((v: unknown, id: string) => {
			if (!isNodeLike(v)) return;
			updateBlockRec(id);
			for (const b of [id, ...syncIncarnations(id)]) {
				const row = scanRow(b);
				if (row !== undefined) {
					rows.set(b, row);
					homeOfText.set(row.text, b);
				}
			}
		});
		rebuildTable(new Set());
		applyRetargets(null);
		settle(shells, null);

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
				syncAll();
				return ix.version;
			},
			runs,
			contentItems: (b: BlockId): ContentItem[] => {
				syncAll();
				return blocks.get(b)?.deleted === false ? itemsOf(b) : [];
			},
			// Inline atoms always carry `data` (`{}` when absent) — the public
			// `JSONInlineBlock` shape of `edytor.value`.
			contentJSON: (b: BlockId) =>
				runs(b).map((r) =>
					r.kind === 'text'
						? { text: r.text, ...(r.marks !== undefined && { marks: cloneJsonSafe(r.marks) }) }
						: { id: r.id, type: r.type, data: r.data === undefined ? {} : cloneJsonSafe(r.data) }
				),
			view: (tr?: unknown): ModelView => {
				syncAll();
				if (tr !== undefined && !committed.has(tr as Tx)) syncPending(tr as Tx);
				return ctx;
			},
			displayType: (id) => {
				if (ix.roles === null) return undefined;
				syncAll();
				ensurePlacements();
				const shown = blocks.has(id) ? typeOf(id) : undefined;
				return shown === blocks.get(id)?.type ? undefined : shown;
			},
			dissolved: (id) => {
				syncAll();
				ensurePlacements();
				return ix.dissolved.has(id);
			},
			project: (root?: BlockId): ProjectedBlock[] => {
				syncAll();
				ensurePlacements();
				return root === undefined
					? (ix.kidsMap.get(null) ?? []).map((k) => projectBlock(k.id))
					: [projectBlock(root)];
			},
			roles: (next) => {
				ix.roles = next;
				ix.placementFull = true;
				ix.version++;
				// No commit carries a role change: report it now (not inside a
				// transaction, whose commit reports it), so every view follows.
				if (hasSubscribers() && !openTx()) publish(null, false);
			},
			track: () => {
				syncAll();
				const f: Folded = { touched: new Map(), wrote: false };
				frames.add(f);
				return {
					end: () => {
						syncAll();
						frames.delete(f);
						return f;
					}
				};
			},
			onReport,
			debug
		};
		return view;
	};

	return { attach };
};
