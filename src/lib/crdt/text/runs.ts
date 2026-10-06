/**
 * The per-document index (R6, §2.4 "Per-doc index" and "Change report") —
 * the ONE owner of every fact derived from the replicated document: block
 * records, the claim graph, the stream table (R2), resolved placements, the
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
 * - Each backing text has a maintained row (`text/rows.ts`, P1): its
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
 * Publication is COMMIT-BOUND (R5): a mid-transaction read refreshes the
 * cache for read-your-writes, but the change report observes committed
 * state only — nested transactions publish once, and a transaction that
 * nets out unchanged publishes nothing.
 *
 * The change report `{added, removed, moved, meta, content, order}` is the
 * fold against the last published index: the blocks the commit's folds
 * touched or invalidated are compared with what was published for them;
 * when the children index was rebuilt, the reachable tree is compared too.
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
	ChildSlot,
	ContentItem,
	DisplayOwnership,
	DocOrder,
	ModelView,
	ProjectedBlock,
	ResolvedPlacement
} from '../placement/model.js';
import {
	candidatesOf,
	bySlot,
	childrenIndex,
	displayIndex,
	displaySlotOf,
	documentOrder,
	REGISTRY_KEY,
	resolvePlacements
} from '../placement/model.js';
import {
	bindText,
	byId,
	canonKey,
	claimGraph,
	cmpStamp,
	DEAD,
	deepFreeze,
	delimiters,
	displayOf,
	isBoundary,
	placeText,
	protectItems,
	readClaims,
	scanText,
	type Claim,
	type Owner,
	type RangeReadStats,
	type Stamp,
	type Stream,
	type TextRow
} from './model.js';
import {
	gapOfItem,
	headOf,
	placeRow,
	rowLength,
	rowOf,
	sameRow,
	segmentAt,
	segmentOfCut,
	segmentOfGap,
	shiftGap,
	streamOfSegment,
	type LiveRow,
	type RowItem
} from './rows.js';
import {
	AT,
	CLAIMS,
	CONTENT,
	DATA,
	DATA_LEAF_PREFIX,
	DOC_DATA_ROOT,
	hasDeleteMark,
	hasWithdrawMark,
	ID,
	isNodeLike,
	LAST_CHANGED_ATTR,
	NONCE,
	TYPE
} from '../schema.js';
import {
	queuedTransactions,
	walkIdSetRanges,
	walkIdSetStructs,
	type IdSetLike,
	type StoreStruct
} from '../structs.js';
import { cloneJsonSafe, sameIds } from '../../utils/json.js';
import { readData } from '../data.js';
import { callEach } from '../protocols/observable.js';

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

/**
 * The facet name of a block's registry entry itself (inserted or removed) —
 * every other facet is named by the block attr it entered through.
 */
export const ENTRY_FACET = '';

/** The facet name of a write to a block's `content` attr itself (a streamless block's own text). */
export const CONTENT_ATTR = '#content';

/**
 * Facets of a block node that can change derived state: `content` (a
 * sequence edit of the block's own text), `structure` (claims, delete marks,
 * the nonce, the `content` attr, unknown attrs), `at` (placement candidates —
 * placements and order only) and `meta` (type/data — metadata only).
 */
type Facet = 'content' | 'structure' | 'at' | 'meta' | 'ignore';

const facetOf = (attr: string): Facet => {
	if (attr === CONTENT) return 'content';
	if (attr === AT) return 'at';
	if (attr === ID || attr === TYPE || attr === DATA || attr.startsWith(DATA_LEAF_PREFIX))
		return 'meta';
	// U1: the `l` lastChangedBy stamp is attribution bookkeeping only.
	if (attr === LAST_CHANGED_ATTR) return 'ignore';
	// `claims`, `n`, `#content`, delete marks and unknown attrs.
	return 'structure';
};

/** A record's `data` as the projection publishes it: a total JSON clone, `undefined` when absent. */
const dataOf = (rec: BlockRec): Record<string, unknown> | undefined =>
	rec.data == null ? undefined : (cloneJsonSafe(rec.data) as Record<string, unknown>);

/** A block node's stored kind (`'unknown'` when the attr is missing or not a string). */
const typeAttr = (node: EngineNode): string => {
	const type = node.getAttr(TYPE);
	return typeof type === 'string' ? type : 'unknown';
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
 * What a cached display read: the homes of the texts it walked, and the blocks
 * it walked or whose claim it read (followed or skipped) — any structural
 * change to one of them invalidates the display.
 */
type Deps = { texts: Set<BlockId>; lists: Set<BlockId> };

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
	 * `reset()` (WU8) — the counter that shows reads scale with the range
	 * plus a bounded checkpoint gap, not the whole backing text.
	 */
	readonly itemsWalked: number;
	/** Format markers seen inside maintained range reads (subset of `itemsWalked`). */
	readonly markersWalked: number;
	/** Fold frames open (`track()` not yet ended): 0 between writes. */
	readonly frames: number;
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
 * (void roles, UW-21b) — a child of such a block displays in its slot.
 * `island`: a block promoted out of an island kind displays as
 * `defaultChild` of its display parent's kind (`null`: the root). `line`:
 * an island declared `lines` holds only lines — each direct child displays
 * as its line kind and holds no children (FW-01, XW-03). `container`: a
 * kind that renders no content and is neither void nor an island (a list)
 * — a block promoted out of one follows like one promoted out of an island
 * (DR-crdt-2). `rendersContent`: no block that renders content ever shows
 * as a kind that does not (its text would vanish, DR-crdt-1). `layout`: a
 * layout kind displays only its items, and only two or more (`layout.*`).
 */
export type DisplayRoles = {
	childless: (type: string) => boolean;
	island: (type: string) => boolean;
	container: (type: string) => boolean;
	rendersContent: (type: string) => boolean;
	defaultChild: (parentType: string | null) => string;
	/** The line kind of an island kind declared `lines` (its `defaultChild`), if any. */
	line: (islandType: string) => string | undefined;
	/** Every line kind the roles declare, present in the document or not (XW-11). */
	lineKinds: () => Iterable<string>;
	/** The item kind of a layout kind (its `defaultChild`), if `type` is one. */
	layout: (type: string) => string | undefined;
	/** Every layout kind the roles declare, present in the document or not. */
	layoutKinds: () => Iterable<string>;
};

/**
 * Whether two kinds shape the display alike — both show children or
 * neither, both seal an island or neither, both hold the same lines, and
 * both are line kinds or neither (a line kind shows as its slot's kind, so
 * the block joins or leaves the ones a retype re-reads — YW-08). A retype
 * between kinds of different shape re-places (and re-kinds) the block and
 * its children.
 */
const sameShape = (roles: DisplayRoles, a: string, b: string): boolean => {
	const lines = new Set(roles.lineKinds());
	const items = new Set([...roles.layoutKinds()].map((type) => roles.layout(type)));
	return (
		roles.childless(a) === roles.childless(b) &&
		roles.island(a) === roles.island(b) &&
		roles.container(a) === roles.container(b) &&
		roles.line(a) === roles.line(b) &&
		lines.has(a) === lines.has(b) &&
		roles.layout(a) === roles.layout(b) &&
		items.has(a) === items.has(b)
	);
};

/** One index per engine doc, shared by every binding (the doc's lifetime). */
const indexes = new WeakMap<EngineDoc, RunView>();

/**
 * Test lanes turn this on (`globalThis.__EDYTOR_INDEX_CHECKS__`, set before
 * the index loads): after every fold the index checks each fact it keeps
 * incrementally against a rebuild from the replicated state and throws on
 * the first difference. Off in production.
 */
export const indexChecks = {
	on: (globalThis as { __EDYTOR_INDEX_CHECKS__?: unknown }).__EDYTOR_INDEX_CHECKS__ === true
};

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
		/** The document's own data (`crdt/data.ts`): outside the registry, reported apart. */
		const dataRoot = doc.get(DOC_DATA_ROOT);
		const docData = (): Record<string, unknown> => cloneJsonSafe(readData(dataRoot) ?? {});
		let dataChanged = false;

		// ── the edits of one fold (L7 narrowing, P1) ──────────────────
		//
		// A keystroke inserts or deletes countable items in one backing text.
		// The fold records each edited item (the part the fold's id sets
		// cover) per text; `foldTexts` places it in its row's gap by walking to
		// the nearest boundary, so the row moves by the edit's units and only
		// the display owner of that gap's stream recomputes. A boundary item
		// written or removed makes the row rescan; a format marker (its effect
		// runs to the next same-key marker) or an unresolvable id makes the
		// text opaque: every consumer recomputes.
		type TextEdit = { item: RowItem; len: number; del: boolean };
		type TextEdits = { edits: TextEdit[]; scan: boolean; opaque: boolean };
		const NO_EDITS: TextEdits = Object.freeze({
			edits: [],
			scan: false,
			opaque: false
		}) as TextEdits;
		const holdsBoundary = (s: StoreStruct, from: number, to: number): boolean => {
			const arr = s.content?.arr;
			if (arr === undefined) return false;
			for (let k = from - s.id.clock; k < to - s.id.clock; k++) if (isBoundary(arr[k])) return true;
			return false;
		};
		/** The edits the id sets `ins`/`del` (what the fold has not folded yet) hold, per text. */
		const makeEditIndex = (ins: IdSetLike | undefined, del: IdSetLike | undefined) => {
			let built: Map<EngineNode, TextEdits> | null | undefined;
			const build = (): Map<EngineNode, TextEdits> | null => {
				if (built !== undefined) return built;
				if (ins === undefined || del === undefined) return (built = null);
				const out = new Map<EngineNode, TextEdits>();
				const visit = (idSet: IdSetLike, deleted: boolean): boolean =>
					walkIdSetRanges(Y, doc, idSet, (s, from, to) => {
						const parent = s.parent as EngineNode;
						if (s.parentSub !== null || !isNodeLike(parent)) return;
						let e = out.get(parent);
						if (e === undefined) out.set(parent, (e = { edits: [], scan: false, opaque: false }));
						// A format marker moves no unit; its effect reaches past the edit.
						if (s.countable !== true) return void (e.opaque = true);
						// Written and removed within the fold: nothing moved.
						if (deleted ? ins.has(s.id.client, from) : s.deleted) return;
						if (holdsBoundary(s, from, to)) return void (e.scan = true);
						e.edits.push({ item: s as RowItem, len: to - from, del: deleted });
					});
				built = visit(ins, false) && visit(del, true) ? out : null;
				return built;
			};
			/** `node`'s edits (`null`: unknown — rescan, every consumer recomputes). */
			return (node: EngineNode): TextEdits | null => {
				const map = build();
				return map === null ? null : (map.get(node) ?? NO_EDITS);
			};
		};
		type EditLookup = ReturnType<typeof makeEditIndex>;

		// ── the replicated-state index ──────────────────────────────────
		const blocks = new Map<BlockId, BlockRec>();
		/** Withdrawn blocks without a delete mark (`hist.undo.withdraw`), see {@link settle}. */
		const shells = new Set<BlockId>();
		/** Union-ever claim targets per holder (never shrinks: a dropped claim still invalidates). */
		const effects = new Map<BlockId, Set<BlockId>>();
		/** Forward dependencies of cached runs: backing text (by home) / walked block → consumers. */
		const textConsumers = new Map<BlockId, Set<BlockId>>();
		const listConsumers = new Map<BlockId, Set<BlockId>>();

		// ── the claim graph (P3: maintained) ─────────────────────────────
		// `top(m)` is the max-stamp claim on `m` held by a live block; each
		// block's owner follows `top` up (`claimGraph`). A structural change
		// of a block (its claims, its delete mark, its record) re-decides the
		// `top` of the blocks it claims (before and after) and the owners of
		// those blocks and of every block whose `top` chain reaches them —
		// never the whole graph.
		const owners = new Map<BlockId, Owner>();
		const topOf = new Map<BlockId, { claimer: BlockId; stamp: Stamp }>();
		/** Claimer → the blocks it tops. */
		const topInv = new Map<BlockId, Set<BlockId>>();
		/** Claimed block → the blocks whose claims list names it (live or not). */
		const claimersOf = new Map<BlockId, Set<BlockId>>();
		/** Owner → the blocks it displays (itself included while it owns itself). */
		const displaysMap = new Map<BlockId, Set<BlockId>>();
		/** Blocks whose claims, delete mark or record changed since the last owner pass. */
		const ownerSeeds = new Set<BlockId>();
		/** Blocks whose owner changed since the last placement pass. */
		const ownerChanged = new Set<BlockId>();
		let ownersBuilt = false;
		const addTo = <K, V>(index: Map<K, Set<V>>, key: K, value: V): void => {
			let set = index.get(key);
			if (set === undefined) index.set(key, (set = new Set()));
			set.add(value);
		};
		const dropFrom = <K, V>(index: Map<K, Set<V>>, key: K, value: V): void => {
			const set = index.get(key);
			set?.delete(value);
			if (set?.size === 0) index.delete(key);
		};
		/** The max-stamp claim on `m` held by a live block. */
		const topClaim = (m: BlockId): { claimer: BlockId; stamp: Stamp } | undefined => {
			let best: { claimer: BlockId; stamp: Stamp } | undefined;
			for (const holder of claimersOf.get(m) ?? []) {
				const rec = blocks.get(holder);
				if (rec === undefined || rec.deleted) continue;
				for (const c of rec.claims)
					if (c.m === m && (best === undefined || cmpStamp(c.stamp, best.stamp) > 0))
						best = { claimer: holder, stamp: c.stamp };
			}
			return best;
		};
		const setTop = (m: BlockId, t: { claimer: BlockId; stamp: Stamp } | undefined): boolean => {
			const old = topOf.get(m);
			if (old?.claimer === t?.claimer && (old === undefined || cmpStamp(old.stamp, t!.stamp) === 0))
				return false;
			if (old !== undefined) dropFrom(topInv, old.claimer, m);
			if (t === undefined) topOf.delete(m);
			else {
				topOf.set(m, t);
				addTo(topInv, t.claimer, m);
			}
			return true;
		};
		/** `owner(b)` along `top` (`claimGraph`'s walk), memoized into `owners`. */
		const walkOwner = (b: BlockId): void => {
			const path: BlockId[] = [];
			let cur = b;
			let result: Owner;
			for (;;) {
				const known = owners.get(cur);
				if (known !== undefined) {
					result = known;
					break;
				}
				const rec = blocks.get(cur);
				if (!rec || rec.deleted) {
					result = DEAD;
					break;
				}
				const at = path.indexOf(cur);
				if (at >= 0) {
					let best = topOf.get(path[at])!;
					for (const member of path.slice(at)) {
						const t = topOf.get(member)!;
						if (cmpStamp(t.stamp, best.stamp) > 0) best = t;
					}
					result = best.claimer;
					break;
				}
				const t = topOf.get(cur);
				if (t === undefined) {
					result = cur;
					break;
				}
				path.push(cur);
				cur = t.claimer;
			}
			if (blocks.has(cur)) owners.set(cur, result);
			for (const x of path) owners.set(x, result);
		};
		const setDisplay = (b: BlockId, from: Owner | undefined, to: Owner | undefined): void => {
			if (typeof from === 'string') dropFrom(displaysMap, from, b);
			if (typeof to === 'string') addTo(displaysMap, to, b);
		};
		const ensureOwners = (): void => {
			if (!ownersBuilt) {
				ownersBuilt = true;
				ownerSeeds.clear();
				const graph = claimGraph(blocks);
				owners.clear();
				for (const [b, o] of graph.owners) if (blocks.has(b)) owners.set(b, o);
				topOf.clear();
				topInv.clear();
				claimersOf.clear();
				for (const [holder, rec] of blocks)
					for (const c of rec.claims) addTo(claimersOf, c.m, holder);
				for (const m of claimersOf.keys()) setTop(m, topClaim(m));
				displaysMap.clear();
				for (const b of blocks.keys()) setDisplay(b, undefined, owners.get(b));
				return;
			}
			if (ownerSeeds.size === 0) return;
			// The tops a seed's claims (now, and those it dropped: noted in `claimersOf` changes) decide.
			const affected = new Set<BlockId>();
			const stack: BlockId[] = [];
			for (const x of ownerSeeds) {
				stack.push(x);
				for (const m of claimTargets.get(x) ?? []) if (setTop(m, topClaim(m))) stack.push(m);
				for (const c of blocks.get(x)?.claims ?? [])
					if (setTop(c.m, topClaim(c.m))) stack.push(c.m);
			}
			ownerSeeds.clear();
			claimTargets.clear();
			for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
				if (affected.has(x)) continue;
				affected.add(x);
				for (const m of topInv.get(x) ?? []) stack.push(m);
			}
			const before = new Map<BlockId, Owner | undefined>();
			for (const x of affected) {
				before.set(x, owners.get(x));
				owners.delete(x);
			}
			for (const x of affected) if (blocks.has(x)) walkOwner(x);
			for (const [x, was] of before) {
				const now = owners.get(x);
				if (now === was) continue;
				setDisplay(x, was, now);
				ownerChanged.add(x);
			}
		};
		/** The claims each seed held before its record changed (their tops are re-decided too). */
		const claimTargets = new Map<BlockId, Set<BlockId>>();
		const ownerOf = (b: BlockId): Owner => {
			ensureOwners();
			return owners.get(b) ?? DEAD;
		};

		// ── the stream table (R2, P1) ────────────────────────────────────
		// One maintained row per backing text (keyed by its home block): its
		// live boundaries and the units between them (`text/rows.ts`), the
		// delimiting boundary of each block, and each block's segment. An edit
		// that writes or removes no boundary moves its row by its units
		// (`shiftGap`); a row is rescanned only when its boundary set (or its
		// text) changed, and only the delimiters of the blocks its boundaries
		// name are re-decided, so only the rows those delimiters cut re-place.
		const rows = new Map<BlockId, LiveRow>();
		let delim = new Map<BlockId, string>();
		/** Every live boundary naming a block, by block: key → its row and nonce. */
		const boundsBy = new Map<BlockId, Map<string, { home: BlockId; n: unknown }>>();
		/** Each block's segment: its row and the cut that opens it (`null`: the row's segment 0). */
		const streamIx = new Map<BlockId, { home: BlockId; cut: string | null }>();
		/** Each row's segments at its last placement: segment 0's block, then each cut's key and block. */
		type Placed = { head: BlockId | null; keys: string[]; blocks: BlockId[] };
		const placed = new Map<BlockId, Placed>();
		const streamOf = (b: BlockId): Stream | undefined => {
			const at = streamIx.get(b);
			const row = at && rows.get(at.home);
			if (row === undefined) return undefined;
			const k = segmentOfCut(row, at!.cut);
			return k < 0 ? undefined : streamOfSegment(row, k, b);
		};
		const streamsIn = (home: BlockId): Stream[] => {
			const row = rows.get(home);
			const out: Stream[] = [];
			for (let k = 0; row !== undefined && k <= row.cuts.length; k++) {
				const b = headOf(row, k);
				if (b !== null) out.push(streamOfSegment(row, k, b));
			}
			return out;
		};
		const streamAt = (home: BlockId, i: number): Stream | undefined => {
			const row = rows.get(home);
			if (row === undefined) return undefined;
			const k = segmentAt(row, i);
			const b = headOf(row, k);
			if (b === null) return undefined;
			const st = streamOfSegment(row, k, b);
			return st.start <= i && i <= st.end ? st : undefined;
		};
		/** Record `home`'s new row (or none); the blocks its boundary set change names join `named`. */
		const setRow = (home: BlockId, row: LiveRow | undefined, named: Set<BlockId>): void => {
			const old = rows.get(home);
			if (row === undefined) rows.delete(home);
			else rows.set(home, row);
			if (old?.key === row?.key) return;
			for (const b of old?.bounds ?? []) {
				if (row?.keyIndex.has(b.key)) continue;
				const by = boundsBy.get(b.s);
				by?.delete(b.key);
				if (by?.size === 0) boundsBy.delete(b.s);
				named.add(b.s);
			}
			for (const b of row?.bounds ?? []) {
				if (old?.keyIndex.has(b.key)) continue;
				let by = boundsBy.get(b.s);
				if (by === undefined) boundsBy.set(b.s, (by = new Map()));
				by.set(b.key, { home, n: b.n });
				named.add(b.s);
			}
		};
		/** A fresh row of `home`'s text (none without one). */
		const scanRow = (home: BlockId): LiveRow | undefined => {
			const text = blocks.get(home)?.content;
			return text === undefined ? undefined : rowOf(scanText(home, text));
		};
		/** Re-decide the delimiting boundary of each block in `named`; the rows a change cuts join `homes`. */
		const refreshDelims = (named: Iterable<BlockId>, homes: Set<BlockId>): void => {
			for (const s of named) {
				const n = blocks.get(s)?.n;
				let best: string | undefined;
				if (blocks.has(s))
					for (const [key, b] of boundsBy.get(s) ?? [])
						if (b.n === n && (best === undefined || byId(key, best) < 0)) best = key;
				const old = delim.get(s);
				if (old === best) continue;
				if (best === undefined) delim.delete(s);
				else delim.set(s, best);
				const was = old === undefined ? undefined : boundsBy.get(s)?.get(old)?.home;
				if (was !== undefined) homes.add(was);
				if (best !== undefined) homes.add(boundsBy.get(s)!.get(best)!.home);
				if (rows.has(s) || placed.has(s)) homes.add(s);
			}
		};
		/**
		 * Place `home`'s row; invalidate the blocks whose segment changed (or
		 * appeared, or went). A segment is its two delimiting cuts, so only the
		 * segments between the longest common prefix and suffix of the old and
		 * new cut lists can differ: the others keep their entries untouched.
		 */
		const placeHome = (home: BlockId, invalidated: Set<BlockId>): void => {
			const row = rows.get(home);
			const before = placed.get(home) ?? { head: null, keys: [], blocks: [] };
			const now: Placed = { head: null, keys: [], blocks: [] };
			if (row !== undefined) {
				placeRow(row, delim);
				now.head = row.head;
				for (const j of row.cuts) {
					now.keys.push(row.bounds[j].key);
					now.blocks.push(row.bounds[j].s);
				}
			}
			if (row === undefined) placed.delete(home);
			else placed.set(home, now);
			const [a, b] = [before.keys, now.keys];
			let p = 0;
			while (p < a.length && p < b.length && a[p] === b[p]) p++;
			let q = 0;
			while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q])
				q++;
			// Segment k ends at cut k: it changed iff k lies in [p, n - q] (segment 0 also with its block).
			const from = before.head === now.head ? p : 0;
			const changed = (blk: BlockId | null): void => {
				if (blk === null) return;
				invalidated.add(blk);
				for (const c of listConsumers.get(blk) ?? []) invalidated.add(c);
			};
			const blockOf = (x: Placed, k: number) => (k === 0 ? x.head : x.blocks[k - 1]);
			for (let k = from; k <= a.length - q; k++) {
				const blk = blockOf(before, k);
				if (blk !== null && streamIx.get(blk)?.home === home) streamIx.delete(blk);
				changed(blk);
			}
			for (let k = from; k <= b.length - q; k++) {
				const blk = blockOf(now, k);
				if (blk === null) continue;
				streamIx.set(blk, { home, cut: k === 0 ? null : b[k - 1] });
				changed(blk);
			}
		};
		/** Rebuild the delimiters and every row's segments (the first build). */
		const rebuildTable = (invalidated: Set<BlockId>): void => {
			boundsBy.clear();
			for (const [home, row] of rows)
				for (const b of row.bounds) {
					let by = boundsBy.get(b.s);
					if (by === undefined) boundsBy.set(b.s, (by = new Map()));
					by.set(b.key, { home, n: b.n });
				}
			delim = new Map();
			const homes = new Set<BlockId>([...rows.keys(), ...placed.keys()]);
			refreshDelims(boundsBy.keys(), homes);
			for (const home of homes) placeHome(home, invalidated);
		};

		/** The role table the display reads; `null` → none. */
		let roles: DisplayRoles | null = null;
		/** A stored kind changed since the last report: derived kinds may follow it (XW-08). */
		let retyped = false;
		/** `ask` of `b`'s stored kind; `undefined` without roles or a record. */
		const role = <T>(b: BlockId, ask: (r: DisplayRoles, type: string) => T): T | undefined => {
			const type = blocks.get(b)?.type;
			return roles === null || type === undefined ? undefined : ask(roles, type);
		};
		/** The line kind of `b` when it is an island declared `lines`. */
		const lineKind = (b: BlockId): string | undefined => role(b, (r, type) => r.line(type));
		/** The item kind of `b` when it is a layout. */
		const itemKind = (b: BlockId): string | undefined => role(b, (r, type) => r.layout(type));
		/** The live blocks the layout rules do not display (`layout.*`), per placement build. */
		let dissolved = new Set<BlockId>();
		const ownShim: DisplayOwnership = {
			ownerOf,
			hidden: (b) => ownerOf(b) !== b || dissolved.has(b),
			childless: (b) => role(b, (r, type) => r.childless(type)) === true,
			island: (b) => role(b, (r, type) => r.island(type)) === true,
			container: (b) => role(b, (r, type) => r.container(type)) === true,
			lined: (b) => lineKind(b) !== undefined,
			passes: (b) => dissolved.has(b),
			sheds: (owner, child) => {
				const item = itemKind(owner);
				return item !== undefined && blocks.get(child)?.type !== item;
			},
			top: (m) => {
				ensureOwners();
				return topOf.get(m)?.claimer;
			},
			streamOf,
			streamsIn,
			streamAt,
			display: (b) => displayOf(b, blocks, ownShim)
		};

		/** The blocks `owner` displays (the delete step's marks). */
		const displays = (owner: BlockId): readonly BlockId[] => {
			ensureOwners();
			return [...(displaysMap.get(owner) ?? [])];
		};

		// ── placements and the children index (P3: maintained) ────────────
		// A structural change re-decides only what it can change: the winning
		// placement of the blocks whose candidates (or whose parent's
		// registry entry) changed, and the display slot of every block whose
		// slot walk (`displaySlotOf`) reads one that changed — its stored
		// subtree, through the blocks it displays — patched into the parents'
		// child lists. While every block shows its winning candidate (no
		// cycle rejected, none rehomed), a block's placement is its argmax
		// (`resolvePlacements` accepts it), so only a cycle through a changed
		// display edge needs the global resolution, which then runs whole.
		// The layout rules re-run only on the layouts a change reaches.
		/** Resolved placements. */
		const placementsMap = new Map<BlockId, ResolvedPlacement>();
		/** Resolved parent → the blocks placed under it. */
		const kidsOf = new Map<BlockId | null, Set<BlockId>>();
		/** A block's argmax candidate parent → the blocks naming it (its entry decides theirs). */
		const byArgParent = new Map<BlockId, Set<BlockId>>();
		/** A slot in a children index: its display parent, rank and the island it displays out of. */
		type Slot = { parent: BlockId | null; rank: string; reset?: BlockId };
		/** The children index without the layout rules (what they read), and with them. */
		let kids0 = new Map<BlockId | null, ChildSlot[]>();
		let slots0 = new Map<BlockId, Slot>();
		let kidsMap = kids0;
		/** Each visible block's slot (display parent, rank, the island it displays out of). */
		let slots = slots0;
		/** The document holds a layout or an item kind: `kids0` and `kidsMap` differ. */
		let layoutMode = false;
		/** The line kinds the roles declare, and those of the lines islands the document holds. */
		let lineKinds = new Set<string>();
		/**
		 * The blocks whose shown kind follows their slot — displayed out of
		 * an island, then in a lined island or of a line kind — which the
		 * report re-reads after a retype.
		 */
		const following = new Set<BlockId>();
		let orderCache: DocOrder | null = null;
		/** Bumps whenever a child list changes (the report compares it). */
		let kidsVersion = 0;
		/** The next pass rebuilds everything (first build, roles, an irregular state). */
		let placementFull = true;
		/** Some block shows no argmax candidate (a cycle rejected one, or none): passes run whole. */
		let irregular = false;
		/** Blocks whose candidates or record changed, whose display state changed. */
		const placementSeeds = new Set<BlockId>();
		const stateSeeds = new Set<BlockId>();
		/** Per block: whether its kind is a layout, an item, a lines island (with its line kind). */
		const kindsOf = new Map<BlockId, { layout: boolean; item: boolean; line?: string }>();
		let layoutBlocks = 0;
		let itemBlocks = 0;
		const lineCounts = new Map<string, number>();
		/** The item kinds the roles declare. */
		const declaredItems = (): Set<string> => {
			const items = new Set<string>();
			for (const type of roles?.layoutKinds() ?? []) items.add(roles!.layout(type)!);
			return items;
		};
		let itemKinds = new Set<string>();
		/** Re-count `id`'s kind facts; a fact the roles never declared forces a full pass. */
		const noteKind = (id: BlockId): void => {
			const old = kindsOf.get(id);
			const type = blocks.get(id)?.type;
			const now =
				type === undefined
					? undefined
					: { layout: itemKind(id) !== undefined, item: itemKinds.has(type), line: lineKind(id) };
			if (old?.layout) layoutBlocks--;
			if (old?.item) itemBlocks--;
			if (old?.line !== undefined) lineCounts.set(old.line, lineCounts.get(old.line)! - 1);
			if (now === undefined) kindsOf.delete(id);
			else kindsOf.set(id, now);
			if (now?.layout) layoutBlocks++;
			if (now?.item) itemBlocks++;
			if (now?.line !== undefined) lineCounts.set(now.line, (lineCounts.get(now.line) ?? 0) + 1);
			const item = itemKind(id);
			if (item !== undefined && !itemKinds.has(item)) placementFull = true;
			if (now?.line !== undefined && !lineKinds.has(now.line)) placementFull = true;
			if (layoutMode !== layoutBlocks + itemBlocks > 0) placementFull = true;
		};
		/** The argmax candidate's parent (a registry entry or the root), and its index entry. */
		const argParent = (rec: BlockRec | undefined): BlockId | null | undefined => rec?.cands[0]?.p;
		const noteCands = (id: BlockId, before: BlockId | null | undefined): void => {
			const after = argParent(blocks.get(id));
			if (before === after) return;
			if (typeof before === 'string') dropFrom(byArgParent, before, id);
			if (typeof after === 'string') addTo(byArgParent, after, id);
		};
		/**
		 * The layout rules over a children index (`layout.*`): the live blocks
		 * they do not display, found in one post-order pass. A layout shows
		 * only its items (`layout.only-items`, already in the index: the
		 * layout sheds the others, `own.sheds`); an item that shows no child,
		 * or shows outside a layout, does not display and hands its children
		 * its slot (`layout.empty-item`, `layout.bare-item`); a layout showing
		 * one item or none does not display, nor does that item
		 * (`layout.single`). Each decision reads the children a node shows
		 * once its own children's were made, so one pass is the fixpoint:
		 * what a dissolve hands up is never an item (an item shows only in a
		 * layout, and a dissolving layout hands up its item's children). The
		 * decisions under a node read only its subtree and whether its parent
		 * is a layout, so a pass can start at any node (`from`).
		 */
		type Shown = { id: BlockId; kids: BlockId[] };
		const dissolveVisit = (
			kids: Map<BlockId | null, ChildSlot[]>,
			out: Set<BlockId>,
			ids: readonly BlockId[],
			layout: boolean
		): Shown[] => {
			const isItem = (b: BlockId) => itemKinds.has(blocks.get(b)?.type ?? '');
			const shown: Shown[] = [];
			for (const id of ids) {
				const own = itemKind(id) !== undefined;
				const sub = dissolveVisit(
					kids,
					out,
					(kids.get(id) ?? []).map((k) => k.id),
					own
				);
				if (own) {
					if (sub.length > 1) shown.push({ id, kids: [] });
					else {
						out.add(id);
						for (const k of sub) {
							out.add(k.id);
							shown.push(...k.kids.map((kid) => ({ id: kid, kids: [] })));
						}
					}
				} else if (isItem(id) && (!layout || sub.length === 0)) {
					out.add(id);
					shown.push(...sub);
				} else shown.push({ id, kids: sub.map((k) => k.id) });
			}
			return shown;
		};
		const dissolve = (kids: Map<BlockId | null, ChildSlot[]>): Set<BlockId> => {
			const out = new Set<BlockId>();
			dissolveVisit(
				kids,
				out,
				(kids.get(null) ?? []).map((k) => k.id),
				false
			);
			return out;
		};
		/** The ownership the layout rules read: none of their decisions applied. */
		const own0: DisplayOwnership = {
			...ownShim,
			hidden: (b) => ownerOf(b) !== b,
			passes: () => false
		};
		/** `id`'s slot in the index `own` reads (none: hidden, or under no live parent). */
		const slotIn = (own: DisplayOwnership, id: BlockId): Slot | undefined => {
			const pl = placementsMap.get(id);
			if (pl === undefined || !blocks.has(id) || own.hidden(id)) return undefined;
			const { parent, rank, reset } = displaySlotOf(own, placementsMap, pl, id);
			if (parent === DEAD) return undefined;
			return reset === null ? { parent, rank } : { parent, rank, reset };
		};
		/** The index of the first slot of `list` not before `x`. */
		const seek = (list: readonly ChildSlot[], x: { id: BlockId; rank: string }): number => {
			let lo = 0;
			let hi = list.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (bySlot(list[mid], x) < 0) lo = mid + 1;
				else hi = mid;
			}
			return lo;
		};
		/**
		 * Re-decide the slots of `affected` in `kids`/`slotMap` (read through
		 * `own`), patching the child lists they leave or join (each list
		 * copied once: a list a reader holds never changes under it). Returns
		 * the blocks whose slot changed, with their parents before and after.
		 */
		const patch = (
			kids: Map<BlockId | null, ChildSlot[]>,
			slotMap: Map<BlockId, Slot>,
			own: DisplayOwnership,
			affected: Iterable<BlockId>
		): Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]> => {
			const changed = new Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>();
			const copies = new Map<BlockId | null, ChildSlot[]>();
			const list = (p: BlockId | null): ChildSlot[] => {
				let l = copies.get(p);
				if (l === undefined) copies.set(p, (l = [...(kids.get(p) ?? [])]));
				return l;
			};
			for (const id of affected) {
				const old = slotMap.get(id);
				const next = slotIn(own, id);
				if (
					old?.parent === next?.parent &&
					old?.rank === next?.rank &&
					old?.reset === next?.reset &&
					(old === undefined) === (next === undefined)
				)
					continue;
				if (old !== undefined) {
					const l = list(old.parent);
					const at = seek(l, { id, rank: old.rank });
					if (l[at]?.id === id) l.splice(at, 1);
				}
				if (next !== undefined) {
					const l = list(next.parent);
					const slot: ChildSlot =
						next.reset === undefined
							? { id, rank: next.rank }
							: { id, rank: next.rank, reset: next.reset };
					l.splice(seek(l, slot), 0, slot);
					slotMap.set(id, next);
				} else slotMap.delete(id);
				changed.set(id, [old?.parent, next?.parent]);
			}
			for (const [p, l] of copies) {
				if (l.length === 0) kids.delete(p);
				else kids.set(p, l);
			}
			return changed;
		};
		/** `seeds` and every block whose slot walk reads one of them: stored subtrees, through what each displays. */
		const reach = (seeds: Iterable<BlockId>): Set<BlockId> => {
			const out = new Set<BlockId>();
			const stack = [...seeds];
			for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
				if (out.has(x)) continue;
				out.add(x);
				for (const c of kidsOf.get(x) ?? []) stack.push(c);
				for (const d of displaysMap.get(x) ?? [])
					if (d !== x) for (const c of kidsOf.get(d) ?? []) stack.push(c);
			}
			return out;
		};
		/** Whether `id` shows as its slot's kind (`following`): read from its slot and kinds. */
		const noteFollowing = (id: BlockId): void => {
			const slot = slots.get(id);
			const follows =
				slot !== undefined &&
				(slot.reset !== undefined ||
					(slot.parent !== null && lineKind(slot.parent) !== undefined) ||
					lineKinds.has(blocks.get(id)?.type ?? ''));
			if (follows) following.add(id);
			else following.delete(id);
		};
		/** The placement `resolvePlacements` gives `id` while every block shows its argmax. */
		const argmaxOf = (id: BlockId): ResolvedPlacement | null | undefined => {
			const rec = blocks.get(id);
			if (rec === undefined) return undefined;
			const c = rec.cands[0];
			if (c === undefined) return null;
			const p = c.p !== null && !blocks.has(c.p) ? null : c.p;
			return { parent: p, rank: c.r };
		};
		/** A display edge walk from `id`'s parent reaches `id` (or loops): the argmax graph has a cycle. */
		const cyclic = (id: BlockId): boolean => {
			let steps = 0;
			for (let cur = placementsMap.get(id)?.parent ?? null; cur !== null; ) {
				const o = ownerOf(cur);
				const at = o === DEAD ? cur : o;
				if (at === id || ++steps > blocks.size) return true;
				const cp = placementsMap.get(at);
				if (cp === undefined) return false;
				cur = cp.parent;
			}
			return false;
		};
		const setPlacement = (id: BlockId, pl: ResolvedPlacement | undefined): void => {
			const old = placementsMap.get(id);
			if (old !== undefined) dropFrom(kidsOf, old.parent, id);
			if (pl === undefined) placementsMap.delete(id);
			else {
				placementsMap.set(id, pl);
				addTo(kidsOf, pl.parent, id);
			}
		};
		/** Everything rebuilt from the records (the first build, roles, an irregular state). */
		const rebuildPlacements = (): void => {
			placementFull = false;
			placementSeeds.clear();
			stateSeeds.clear();
			ownerChanged.clear();
			itemKinds = declaredItems();
			for (const b of blocks.keys()) {
				const item = itemKind(b);
				if (item !== undefined) itemKinds.add(item);
			}
			lineKinds = new Set(roles?.lineKinds());
			kindsOf.clear();
			[layoutBlocks, itemBlocks] = [0, 0];
			lineCounts.clear();
			for (const b of blocks.keys()) noteKind(b);
			for (const line of lineCounts.keys()) lineKinds.add(line);
			placementFull = false;
			const resolved = resolvePlacements(blocks, ownerOf);
			placementsMap.clear();
			kidsOf.clear();
			irregular = false;
			for (const [id, pl] of resolved) {
				setPlacement(id, pl);
				const arg = argmaxOf(id);
				if (!arg || arg.parent !== pl.parent || arg.rank !== pl.rank) irregular = true;
			}
			layoutMode = layoutBlocks + itemBlocks > 0;
			dissolved = new Set();
			const index = (own: DisplayOwnership, map: Map<BlockId | null, ChildSlot[]>) => {
				const at = new Map<BlockId, Slot>();
				for (const [parent, list] of map)
					for (const { id, rank, reset } of list)
						at.set(id, reset === undefined ? { parent, rank } : { parent, rank, reset });
				void own;
				return at;
			};
			kids0 = childrenIndex(placementsMap, own0);
			slots0 = index(own0, kids0);
			if (layoutMode) {
				dissolved = dissolve(kids0);
				kidsMap = childrenIndex(placementsMap, ownShim);
				slots = index(ownShim, kidsMap);
			} else [kidsMap, slots] = [kids0, slots0];
			following.clear();
			for (const id of slots.keys()) noteFollowing(id);
			orderCache = null;
			kidsVersion++;
		};
		/**
		 * Re-run the layout rules on the layouts `changed` (blocks whose slot
		 * in `kids0` changed, with their parents) and `kinds` reach: from each
		 * one up through layouts and items, the topmost such ancestor's
		 * subtree. Returns the blocks whose dissolved state flipped.
		 */
		const redissolve = (
			changed: Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>,
			kinds: Iterable<BlockId>
		): Set<BlockId> => {
			const flips = new Set<BlockId>();
			const isLayoutish = (b: BlockId) => {
				const k = kindsOf.get(b);
				return k !== undefined && (k.layout || k.item);
			};
			const roots = new Set<BlockId>();
			const climb = (b: BlockId | null | undefined): void => {
				let top: BlockId | undefined;
				for (let x = b; typeof x === 'string' && isLayoutish(x); x = slots0.get(x)?.parent) top = x;
				if (top !== undefined) roots.add(top);
			};
			for (const [id, [from, to]] of changed) {
				climb(id);
				climb(from);
				climb(to);
			}
			for (const id of kinds) {
				// Its kind decides its own rule, its parent's count and its children's (`layout`).
				climb(id);
				climb(slots0.get(id)?.parent);
				for (const k of kids0.get(id) ?? []) climb(k.id);
				// Only a layout or an item dissolves: a block that left those kinds shows again.
				if (!isLayoutish(id) && dissolved.delete(id)) flips.add(id);
			}
			for (const root of roots) {
				if (!slots0.has(root)) continue;
				const parent = slots0.get(root)!.parent;
				const nodes: BlockId[] = [];
				const stack = [root];
				for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
					nodes.push(x);
					for (const k of kids0.get(x) ?? []) stack.push(k.id);
				}
				const out = new Set<BlockId>();
				dissolveVisit(kids0, out, [root], parent !== null && itemKind(parent) !== undefined);
				for (const x of nodes) {
					if (out.has(x) === dissolved.has(x)) continue;
					if (out.has(x)) dissolved.add(x);
					else dissolved.delete(x);
					flips.add(x);
				}
			}
			// A block that left the index (hidden, removed) dissolves no more.
			for (const id of changed.keys()) if (!slots0.has(id) && dissolved.delete(id)) flips.add(id);
			return flips;
		};
		const ensurePlacements = (): void => {
			ensureOwners();
			if (placementFull || irregular) {
				if (placementFull || placementSeeds.size + stateSeeds.size + ownerChanged.size > 0)
					rebuildPlacements();
				return;
			}
			if (placementSeeds.size + stateSeeds.size + ownerChanged.size === 0) return;
			const moved = new Set<BlockId>();
			for (const id of placementSeeds) {
				const next = argmaxOf(id);
				if (next === null) return rebuildPlacements();
				const old = placementsMap.get(id);
				if (old?.parent === next?.parent && old?.rank === next?.rank) continue;
				setPlacement(id, next);
				moved.add(id);
			}
			// A changed display edge closing a cycle needs the global resolution.
			for (const id of moved) if (cyclic(id)) return rebuildPlacements();
			for (const o of ownerChanged)
				for (const c of kidsOf.get(o) ?? []) if (cyclic(c)) return rebuildPlacements();
			const seeds = new Set<BlockId>([...moved, ...stateSeeds, ...ownerChanged]);
			const kinds = [...stateSeeds];
			placementSeeds.clear();
			stateSeeds.clear();
			ownerChanged.clear();
			const affected = reach(seeds);
			let touched: Iterable<BlockId> = affected;
			const changed = patch(kids0, slots0, own0, affected);
			let any = changed.size > 0;
			if (layoutMode) {
				const flips = redissolve(changed, kinds);
				const again = flips.size > 0 ? reach([...affected, ...flips]) : affected;
				any = patch(kidsMap, slots, ownShim, again).size > 0 || any;
				touched = again;
			}
			for (const id of touched) noteFollowing(id);
			if (any) {
				orderCache = null;
				kidsVersion++;
			}
		};

		/**
		 * The kind `id` displays as — THE shown-kind rule, read from its slot
		 * and the role table. A block directly in an island declared `lines`
		 * shows its line kind. A block of a line kind anywhere else shows its
		 * display parent's default child — an undo can put a line a peer
		 * retyped back in its island, or leave one a peer moved away outside
		 * it (FW-01 sweep) — and so does a block displayed out of an island
		 * or a container (a list, DR-crdt-2) that still has its default child
		 * kind (RW-01), unless an outer container shows it as one of its
		 * items (a nested list's item, SW8-roles-4). A block that renders
		 * content never shows as a kind that does not (DR-crdt-1): a line kind
		 * then shows the document's default kind (ZW-06). A block stored as the
		 * document's default kind directly in a list shows as its item
		 * (`itemOf`, AW-04). Any other shows its stored kind (a retype shows). Read from the stored kinds
		 * at call time: a retype rebuilds no placement.
		 */
		/**
		 * A plain block (the document's default kind) directly in a container
		 * whose item is a kind of its own that renders content (a list) shows
		 * as that item — the read-time side of the facade's `fitted`: a race
		 * (a peer's lift of an item another peer's outdent moves, a concurrent
		 * undo of a retype) or an explicit write never shows a bare paragraph
		 * in a list (AW-04). Anywhere else it shows `plain`.
		 */
		const itemOf = (under: BlockId, plain: string): string => {
			const parent = typeOf(under);
			if (!roles!.container(parent)) return plain;
			const item = roles!.defaultChild(parent);
			return roles!.rendersContent(item) ? item : plain;
		};

		const typeOf = (id: BlockId): string => {
			const stored = blocks.get(id)?.type ?? 'unknown';
			const slot = slots.get(id);
			if (roles === null || slot === undefined) return stored;
			const { parent: under, reset } = slot;
			const line = under === null || lineKinds.size === 0 ? undefined : lineKind(under);
			if (line !== undefined) return line;
			const lined = lineKinds.has(stored);
			const from = reset === undefined ? undefined : (blocks.get(reset)?.type ?? null);
			if (!lined && (from === undefined || stored !== roles.defaultChild(from)))
				return stored === roles.defaultChild(null) && under !== null
					? itemOf(under, stored)
					: stored;
			// Out of a removed list, inside an outer list of its kind: still an item. A
			// container whose item is the document's default kind (a column) holds no
			// items of its own: a paragraph under one is no list's item.
			if (!lined && typeof from === 'string' && roles.container(from))
				for (let u = under; u !== null; u = slots.get(u)?.parent ?? null) {
					const t = typeOf(u);
					if (
						roles.container(t) &&
						roles.defaultChild(t) === stored &&
						stored !== roles.defaultChild(null)
					)
						return stored;
				}
			const kind = roles.defaultChild(under === null ? null : typeOf(under));
			if (roles.rendersContent(kind) || !roles.rendersContent(stored)) return kind;
			// Never a line kind outside its island, even where the slot's kind shows nothing (ZW-06).
			return lined ? roles.defaultChild(null) : stored;
		};

		const rangeStats: RangeReadStats = { items: 0, markers: 0 };

		// ── run cache ────────────────────────────────────────────────────
		const cache = new Map<BlockId, Cached>();
		const dirty = new Set<BlockId>();
		const internMap = new Map<string, unknown>();

		let version = 0;

		const debug: RunViewDebug = {
			recomputes: 0,
			recomputed: new Set<BlockId>(),
			get itemsWalked() {
				return rangeStats.items;
			},
			get markersWalked() {
				return rangeStats.markers;
			},
			get frames() {
				return frames.size;
			},
			reset() {
				debug.recomputes = 0;
				debug.recomputed.clear();
				rangeStats.items = 0;
				rangeStats.markers = 0;
			}
		};

		// ── interning / freezing ─────────────────────────────────────────
		// `cloneJsonSafe` is total even against hostile replicated payloads,
		// and interning the normalized form keys it by its own canonical shape.
		// The shared instance is built FROM that key (sorted keys): it must not
		// remember the key order its first reader happened to fold, or
		// `toJSON` would depend on when the view was read.
		const intern = <T>(v: T): T => {
			const key = canonKey(cloneJsonSafe(v));
			let f = internMap.get(key) as T | undefined;
			if (f === undefined) internMap.set(key, (f = deepFreeze(JSON.parse(key)) as T));
			return f;
		};

		// ── records ──────────────────────────────────────────────────────

		const buildRec = (id: BlockId, node: EngineNode): BlockRec => {
			const list = node.getAttr(CLAIMS);
			const claimsNode = isNodeLike(list) ? list : undefined;
			const content = node.getAttr(CONTENT);
			return {
				id,
				node,
				type: typeAttr(node),
				data: readData(node),
				n: node.getAttr(NONCE),
				deleted: hasDeleteMark(node),
				content: isNodeLike(content) ? content : undefined,
				claimsNode,
				claims: readClaims(claimsNode),
				cands: candidatesOf(node)
			};
		};

		const noteEffects = (id: BlockId, rec: BlockRec | undefined): void => {
			let fx = effects.get(id);
			if (fx === undefined) effects.set(id, (fx = new Set()));
			for (const c of rec?.claims ?? []) fx.add(c.m);
		};

		/**
		 * Rebuild (or create, or drop) block `id`'s record, and note what the
		 * maintained facts must re-decide: its owner and the tops of the
		 * blocks it claims (P3), its placement — and, when its entry came or
		 * went, the placements of the blocks whose candidate names it.
		 */
		const updateBlockRec = (id: BlockId): void => {
			const old = blocks.get(id);
			const node = registry.getAttr(id);
			if (!isNodeLike(node)) blocks.delete(id);
			else blocks.set(id, buildRec(id, node));
			const rec = blocks.get(id);
			noteEffects(id, rec);
			noteShell(id);
			const was = new Set(old?.claims.map((c) => c.m));
			const now = new Set(rec?.claims.map((c) => c.m));
			for (const m of was)
				if (!now.has(m)) {
					dropFrom(claimersOf, m, id);
					addTo(claimTargets, id, m);
				}
			for (const m of now) if (!was.has(m)) addTo(claimersOf, m, id);
			ownerSeeds.add(id);
			noteCands(id, argParent(old));
			placementSeeds.add(id);
			if ((old === undefined) !== (rec === undefined)) {
				stateSeeds.add(id);
				for (const c of byArgParent.get(id) ?? []) placementSeeds.add(c);
			}
			if (old?.type !== rec?.type) {
				noteKind(id);
				if (
					old === undefined ||
					rec === undefined ||
					roles === null ||
					!sameShape(roles, old.type, rec.type)
				)
					stateSeeds.add(id);
			}
		};
		/** A withdrawn block without a delete mark: its `deleted` is settled after each fold. */
		const noteShell = (id: BlockId): void => {
			const rec = blocks.get(id);
			if (rec !== undefined && !rec.deleted && hasWithdrawMark(rec.node)) shells.add(id);
			else shells.delete(id);
		};
		const ensureRec = (id: BlockId): void => {
			if (!blocks.has(id)) updateBlockRec(id);
		};

		const ctx: ModelView = {
			blocks,
			own: ownShim,
			get placements() {
				ensurePlacements();
				return placementsMap;
			},
			get kids() {
				ensurePlacements();
				return kidsMap;
			},
			get order() {
				ensurePlacements();
				return (orderCache ??= documentOrder(kidsMap));
			},
			// R4: the publication boundary shares THIS interner, so a payload
			// emitted by `project()`/`contentItems()` is `===` the runs' one.
			intern,
			displays
		};

		// ── dep bookkeeping ──────────────────────────────────────────────

		const drop = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
			for (const k of keys) {
				const set = index.get(k);
				set?.delete(b);
				if (set?.size === 0) index.delete(k);
			}
		};
		const add = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
			for (const k of keys) {
				let set = index.get(k);
				if (set === undefined) index.set(k, (set = new Set()));
				set.add(b);
			}
		};
		const applyDeps = (b: BlockId, deps: Deps): void => {
			const old = cache.get(b)?.deps;
			if (old) {
				drop(textConsumers, old.texts, b);
				drop(listConsumers, old.lists, b);
			}
			add(textConsumers, deps.texts, b);
			add(listConsumers, deps.lists, b);
		};

		// ── snapshot construction ────────────────────────────────────────

		const freezeFresh = (r: ContentRun): ContentRun => Object.freeze(r) as ContentRun;

		/** The normalized fresh runs of `b` (interned payloads, equal marks merged) and their deps. */
		const computeFresh = (b: BlockId): { fresh: ContentRun[]; deps: Deps } => {
			const deps: Deps = { texts: new Set(), lists: new Set([b]) };
			const segs =
				displayOf(b, blocks, ownShim, (x, home) => {
					deps.lists.add(x);
					if (home !== undefined) deps.texts.add(home);
					// Every claim on a walked list is read, followed or not: a claim
					// skipped for a dead target or a higher claimer becomes effective
					// when that target revives or its winning claim goes away.
					for (const c of blocks.get(x)?.claims ?? []) deps.lists.add(c.m);
				}) ?? [];
			const fresh: ContentRun[] = [];
			for (const item of T.readSegs(segs, rangeStats)) {
				if (item.kind === 'text') {
					const last = fresh[fresh.length - 1];
					const marks = item.marks === undefined ? undefined : intern(item.marks);
					if (last && last.kind === 'text' && last.marks === marks) {
						(last as { text: string }).text += item.text;
					} else {
						fresh.push({
							kind: 'text',
							text: item.text,
							...(marks === undefined ? {} : { marks })
						} as ContentRun);
					}
				} else {
					fresh.push({
						kind: 'inline',
						id: item.id,
						type: item.type,
						...(item.data === undefined ? {} : { data: intern(item.data) })
					} as ContentRun);
				}
			}
			return { fresh, deps };
		};

		/**
		 * Structural sharing: reuse unchanged run objects from `old` — maximal
		 * equal prefix + equal suffix; `old` itself when every run is identical.
		 */
		const reconcile = (
			old: readonly ContentRun[] | undefined,
			fresh: ContentRun[]
		): readonly ContentRun[] => {
			if (!old) return Object.freeze(fresh.map(freezeFresh));
			let s = 0;
			const n = Math.min(old.length, fresh.length);
			while (s < n && runEquals(old[s], fresh[s])) s++;
			if (s === old.length && s === fresh.length) return old;
			let eo = old.length - 1;
			let ef = fresh.length - 1;
			while (eo >= s && ef >= s && runEquals(old[eo], fresh[ef])) {
				eo--;
				ef--;
			}
			const out: ContentRun[] = new Array(fresh.length);
			for (let i = 0; i < s; i++) out[i] = old[i];
			for (let i = s; i <= ef; i++) out[i] = freezeFresh(fresh[i]);
			for (let i = eo + 1; i < old.length; i++) out[fresh.length - (old.length - i)] = old[i];
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
		};

		const runs = (b: BlockId): readonly ContentRun[] => {
			// Read-your-writes: fold the open transaction's pending writes first.
			syncAll();
			if (dirty.has(b) || !cache.has(b)) computeRuns(b);
			return cache.get(b)?.runs ?? EMPTY_RUNS;
		};

		// ── the fold ─────────────────────────────────────────────────────

		/** One fold's effects: invalidated blocks, rescanned texts, rebuilt facets. */
		type FoldCtx = {
			invalidated: Set<BlockId>;
			/** Per home block: its text's edits, whether it rescans, whether every reader re-reads. */
			texts: Map<
				BlockId,
				{ edits: TextEdit[]; scan: boolean; opaque: boolean; seen: Set<TextEdits> }
			>;
			/** The blocks whose entry or nonce changed: their delimiters are re-decided. */
			named: Set<BlockId>;
			table: boolean;
			/** The winning parents, before and after, of the blocks the fold touched. */
			parents: Set<BlockId>;
		};
		const parentOf = (id: BlockId): BlockId | null | undefined => blocks.get(id)?.cands[0]?.p;
		/** A structural change of `id`: its readers, and the blocks it claims, re-read. */
		const invalidateBlock = (id: BlockId, ctx: FoldCtx, claimsBefore: Claim[] = []): void => {
			ctx.invalidated.add(id);
			for (const c of listConsumers.get(id) ?? []) ctx.invalidated.add(c);
			for (const m of new Set([...(effects.get(id) ?? []), ...claimsBefore.map((c) => c.m)])) {
				ctx.invalidated.add(m);
				for (const c of listConsumers.get(m) ?? []) ctx.invalidated.add(c);
			}
		};

		/** Note edits of `id`'s own text (`null`: unknown — rescan, every reader re-reads). */
		const noteText = (ctx: FoldCtx, id: BlockId, e: TextEdits | null): void => {
			let t = ctx.texts.get(id);
			if (t === undefined)
				ctx.texts.set(id, (t = { edits: [], scan: false, opaque: false, seen: new Set() }));
			if (e === null) {
				t.scan = t.opaque = true;
				return;
			}
			if (t.seen.has(e)) return;
			t.seen.add(e);
			t.scan ||= e.scan;
			t.opaque ||= e.opaque;
			for (const x of e.edits) t.edits.push(x);
		};

		/** Fold one block's changed facets (`edits`: its own text's, one per changed content node). */
		const foldBlock = (
			id: BlockId,
			facets: ReadonlySet<string>,
			edits: readonly (TextEdits | null)[],
			ctx: FoldCtx
		): void => {
			const kinds = new Set<Facet | 'entry'>();
			for (const f of facets) kinds.add(f === ENTRY_FACET ? 'entry' : facetOf(f));
			const parentBefore = parentOf(id);
			if (typeof parentBefore === 'string') ctx.parents.add(parentBefore);
			if (kinds.has('entry') || kinds.has('structure')) {
				const [claimsBefore, typeBefore] = [blocks.get(id)?.claims, blocks.get(id)?.type];
				updateBlockRec(id);
				// A retype that lands with a structure facet is still a retype.
				if (typeBefore !== undefined && blocks.get(id)?.type !== typeBefore) retyped = true;
				// A new entry, a nonce or an own text can move streams (R2).
				if (kinds.has('entry') || facets.has(NONCE) || facets.has(CONTENT_ATTR)) {
					ctx.table = true;
					ctx.named.add(id);
					noteText(ctx, id, null);
				}
				invalidateBlock(id, ctx, claimsBefore);
			} else {
				ensureRec(id);
				const rec = blocks.get(id);
				if (kinds.has('at') && rec) {
					const before = argParent(rec);
					rec.cands = candidatesOf(rec.node);
					noteCands(id, before);
					placementSeeds.add(id);
				}
				if (kinds.has('meta') && rec) {
					const was = rec.type;
					rec.type = typeAttr(rec.node);
					rec.data = readData(rec.node);
					if (rec.type !== was) {
						retyped = true;
						noteKind(id);
					}
					// A retype that changes the kind's display shape re-parents
					// (or re-kinds) its children.
					if (roles !== null && !sameShape(roles, was, rec.type)) stateSeeds.add(id);
				}
			}
			const parentAfter = parentOf(id);
			if (typeof parentAfter === 'string') ctx.parents.add(parentAfter);
			if (kinds.has('content')) for (const e of edits) noteText(ctx, id, e);
		};

		/**
		 * Move each edited text's row by its edits (or rescan it), re-decide the
		 * delimiters a boundary change names, re-place the rows they cut, and
		 * invalidate the readers: the display owner of each edited stream (L7),
		 * the blocks whose stream changed, every reader of an opaque text.
		 */
		const foldTexts = (ctx: FoldCtx): void => {
			const homes = new Set<BlockId>();
			const gapsOf = new Map<BlockId, number[] | null>();
			const gapsIn = (row: LiveRow, edits: readonly TextEdit[]): number[] | null => {
				const gaps: number[] = [];
				for (const e of edits) {
					const gap = gapOfItem(row, e.item);
					if (gap < 0) return null;
					gaps.push(gap);
				}
				return gaps;
			};
			for (const [home, t] of ctx.texts) {
				const text = blocks.get(home)?.content;
				const row = rows.get(home);
				let gaps: number[] | null = [];
				let fresh = t.scan || row === undefined || text === undefined || row.text !== text;
				if (!fresh) {
					for (const e of t.edits) {
						const gap = gapOfItem(row!, e.item);
						if (gap < 0 || !shiftGap(row!, gap, e.del ? -e.len : e.len)) {
							fresh = true;
							break;
						}
						gaps.push(gap);
					}
					// The engine's own count of live units: a row that disagrees is stale.
					if (!fresh && rowLength(row!) !== (text as unknown as { _length: number })._length)
						fresh = true;
				}
				if (fresh) {
					const next = scanRow(home);
					const same = next !== undefined && row !== undefined && next.key === row.key;
					if (same) [next.cuts, next.head] = [row.cuts, row.head];
					setRow(home, next, ctx.named);
					if (!same) homes.add(home);
					gaps = next === undefined ? [] : gapsIn(next, t.edits);
				}
				gapsOf.set(home, t.opaque ? null : gaps);
			}
			refreshDelims(ctx.named, homes);
			if (homes.size > 0) ctx.table = true;
			for (const home of homes) placeHome(home, ctx.invalidated);
			for (const [home, gaps] of gapsOf) {
				if (gaps === null) {
					for (const c of textConsumers.get(home) ?? []) ctx.invalidated.add(c);
					continue;
				}
				// Only the stream each edit lies in changes its display (L7).
				const row = rows.get(home);
				if (row === undefined) continue;
				for (const gap of gaps) {
					const b = headOf(row, segmentOfGap(row, gap));
					const owner = b === null ? DEAD : ownerOf(b);
					if (typeof owner === 'string') ctx.invalidated.add(owner);
				}
			}
		};

		/** The blocks whose stream lies in a text the fold edited. */
		const editedStreams = (ctx: FoldCtx): BlockId[] =>
			[...ctx.texts.keys()].flatMap((home) => streamsIn(home).map((st) => st.block));
		/** A live unit in `id`'s stream (boundaries excepted). */
		const streamHolds = (id: BlockId): boolean => {
			const st = streamOf(id);
			return st !== undefined && st.end - st.start > st.inert.length;
		};

		/**
		 * Settle the withdrawn blocks (`hist.undo.withdraw`): a shell is deleted
		 * iff it holds nothing — no live unit in its stream and no child (a
		 * block whose winning candidate names it) that is itself not deleted.
		 * The least fixpoint, computed over every shell whenever an `affected`
		 * one may flip (one whose stream still holds a unit keeps its answer),
		 * so every replica settles the same whatever the fold order. A flip is
		 * a structural change of the shell.
		 */
		const settle = (affected: Iterable<BlockId>, ctx: FoldCtx | null): void => {
			if (shells.size === 0) return;
			let quiet = true;
			for (const id of affected) {
				if (!shells.has(id)) continue;
				if (blocks.get(id)?.deleted !== false || !streamHolds(id)) quiet = false;
			}
			if (quiet) return;
			const alive = new Set<BlockId>();
			const up: BlockId[] = [];
			const hold = (id: BlockId): void => {
				if (alive.has(id)) return;
				alive.add(id);
				up.push(id);
			};
			for (const id of shells) if (streamHolds(id)) hold(id);
			for (const [id, rec] of blocks) {
				const p = rec.cands[0]?.p;
				if (!shells.has(id) && !rec.deleted && typeof p === 'string' && shells.has(p)) hold(p);
			}
			for (let id = up.pop(); id !== undefined; id = up.pop()) {
				const p = parentOf(id);
				if (typeof p === 'string' && shells.has(p)) hold(p);
			}
			for (const id of shells) {
				const rec = blocks.get(id)!;
				if (rec.deleted === !alive.has(id)) continue;
				rec.deleted = !alive.has(id);
				ownerSeeds.add(id);
				if (ctx === null) continue;
				invalidateBlock(id, ctx);
			}
		};

		const registryNode = registry as unknown as EngineNode;

		/**
		 * The block a changed `(type, parentSub)` pair belongs to, the facet it
		 * entered through (the block attr the chain hangs under; the `content`
		 * attr itself is {@link CONTENT_ATTR}), and whether it is a sequence
		 * edit of the block's own text. `null` outside the registry subtree.
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
					if (below === null) return [id, sub === CONTENT ? CONTENT_ATTR : (sub ?? '?'), false];
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

		/** THE fold: one pass over changed `(type, parentSub)` pairs, each block folded once. */
		const fold = (
			changed: Map<unknown, Set<string | null>>,
			editsOf: EditLookup
		): Map<BlockId, Set<string>> => {
			const touched = new Map<BlockId, Set<string>>();
			const edits = new Map<BlockId, (TextEdits | null)[]>();
			let derived = changed.has(dataRoot);
			for (const [type, subs] of changed) {
				for (const sub of subs) {
					const hit = locate(type as EngineNode, sub);
					if (hit === null) continue;
					const [id, facet, seq] = hit;
					let facets = touched.get(id);
					if (facets === undefined) touched.set(id, (facets = new Set()));
					facets.add(facet);
					if (facet !== CONTENT) continue;
					// A sequence edit of the block's own text, or a change inside one of its atoms.
					let list = edits.get(id);
					if (list === undefined) edits.set(id, (list = []));
					list.push(seq ? editsOf(type as EngineNode) : null);
				}
			}
			const ctx: FoldCtx = {
				invalidated: new Set(),
				texts: new Map(),
				named: new Set(),
				table: false,
				parents: new Set()
			};
			for (const [id, facets] of touched) {
				foldBlock(id, facets, edits.get(id) ?? [], ctx);
				derived ||= [...facets].some((f) => f === ENTRY_FACET || facetOf(f) !== 'ignore');
			}
			foldTexts(ctx);
			if (shells.size > 0)
				settle(
					ctx.table ? shells : [...touched.keys(), ...ctx.parents, ...editedStreams(ctx)],
					ctx
				);
			for (const b of ctx.invalidated) dirty.add(b);
			if (indexChecks.on) check();
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

		/** {@link indexChecks}: every incrementally maintained fact equals its rebuild. */
		const check = (): void => {
			const fail = (what: string): never => {
				throw new Error(`[edytor index] ${what} differs from its rebuild`);
			};
			const scans = new Map<BlockId, TextRow>();
			for (const rec of blocks.values())
				if (rec.content) scans.set(rec.id, scanText(rec.id, rec.content));
			for (const home of rows.keys()) if (!scans.has(home)) fail(`row ${home}`);
			for (const [home, scan] of scans) {
				const row = rows.get(home);
				if (row === undefined || row.text !== scan.text || !sameRow(row, scan)) fail(`row ${home}`);
			}
			const want = delimiters(blocks, scans.values());
			if (want.size !== delim.size || [...want].some(([b, k]) => delim.get(b) !== k))
				fail('delimiters');
			const streamSig = (st: Stream | undefined) =>
				st && `${st.home}:${st.start}-${st.end}/${st.inert.join(',')}`;
			const placed = new Set<BlockId>();
			for (const [home, scan] of scans)
				for (const st of placeText(scan, want)) {
					placed.add(st.block);
					if (streamSig(streamOf(st.block)) !== streamSig(st))
						fail(`stream of ${st.block} in ${home}`);
				}
			for (const b of streamIx.keys()) if (!placed.has(b)) fail(`stream of ${b}`);
			for (const [b, c] of cache) {
				if (dirty.has(b)) continue;
				const fresh = computeFresh(b).fresh;
				if (keyOf(fresh) !== keyOf(c.runs)) fail(`runs of ${b}`);
			}
			// P3: the claim graph, placements, children index and layout rules.
			ensurePlacements();
			const graph = claimGraph(blocks);
			for (const b of blocks.keys()) {
				if (ownerOf(b) !== (graph.owners.get(b) ?? DEAD)) fail(`owner of ${b}`);
				if (ownShim.top(b) !== graph.top.get(b)) fail(`top of ${b}`);
			}
			const shown = displayIndex(blocks, ownerOf);
			for (const [o, list] of shown)
				if (
					list.length !== (displaysMap.get(o)?.size ?? 0) ||
					list.some((b) => !displaysMap.get(o)!.has(b))
				)
					fail(`displays of ${o}`);
			for (const o of displaysMap.keys()) if (!shown.has(o)) fail(`displays of ${o}`);
			const resolved = resolvePlacements(blocks, ownerOf);
			if (resolved.size !== placementsMap.size) fail('placements');
			for (const [b, pl] of resolved) {
				const mine = placementsMap.get(b);
				if (mine?.parent !== pl.parent || mine.rank !== pl.rank) fail(`placement of ${b}`);
			}
			const same = (x: Map<BlockId | null, ChildSlot[]>, y: Map<BlockId | null, ChildSlot[]>) =>
				x.size === y.size && [...x].every(([p, l]) => keyOf(l) === keyOf(y.get(p) ?? null));
			const k0 = childrenIndex(placementsMap, own0);
			if (!same(k0, kids0)) fail('children index (before the layout rules)');
			const out = dissolve(k0);
			if (out.size !== dissolved.size || [...out].some((b) => !dissolved.has(b))) fail('dissolved');
			if (!same(childrenIndex(placementsMap, ownShim), kidsMap)) fail('children index');
			for (const [p, l] of kidsMap)
				for (const { id, rank, reset } of l) {
					const slot = slots.get(id);
					if (slot?.parent !== p || slot.rank !== rank || slot.reset !== reset)
						fail(`slot of ${id}`);
				}
			const follow = new Set(following);
			for (const id of slots.keys()) noteFollowing(id);
			if (follow.size !== following.size || [...follow].some((b) => !following.has(b)))
				fail('following');
		};

		type Tx = {
			insertSet?: IdSetLike;
			deleteSet?: IdSetLike;
			changed?: EngineTransaction['changed'];
		};
		/** Each transaction's folded part: copies of its id sets, and their lengths (the watermark). */
		const cursors = new WeakMap<Tx, { ins: IdSetLike; del: IdSetLike; mark: number }>();
		/** The transactions whose commit fold ran. */
		const committed = new WeakSet<Tx>();
		const lengthOf = (set: IdSetLike): number => {
			let n = 0;
			set.clients.forEach((ranges) => {
				for (const r of ranges.getIds()) n += r.len;
			});
			return n;
		};

		/**
		 * Fold the pending part of `tr` — the structs its insert/delete sets
		 * gained since the last fold — before a read inside it (read-your-
		 * writes; `transaction.changed` does not grow on a second edit to an
		 * already-changed type, F11).
		 */
		const syncPending = (tr: Tx | null | undefined): boolean => {
			if (tr?.insertSet === undefined || tr.deleteSet === undefined) return false;
			let cursor = cursors.get(tr);
			if (cursor === undefined)
				cursors.set(tr, (cursor = { ins: Y.createIdSet(), del: Y.createIdSet(), mark: 0 }));
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
			fold(changed, makeEditIndex(ins, del));
			return true;
		};
		const openTx = (): Tx | null | undefined => doc._transaction as Tx | null | undefined;
		/**
		 * Fold every transaction whose writes are in the document and whose
		 * commit fold has not run, in their order: the open one, and those a
		 * transaction's cleanup started (an observer's or an `update`
		 * listener's write runs its body at once, its observers later) — a
		 * read in between must not mix their items with an index that never
		 * saw them.
		 */
		const syncAll = (): void => {
			for (const tr of queuedTransactions(doc) as Tx[]) if (!committed.has(tr)) syncPending(tr);
		};

		/** The commit: fold `transaction.changed` once (the report publishes from `update`). */
		const onCommit = (e: EngineDeepEvent): void => {
			const tr = e.transaction as Tx;
			let [ins, del] = [tr.insertSet, tr.deleteSet];
			// The writes a read folded already moved the rows: only the rest
			// are edits now (the facets fold again, idempotent).
			const cursor = cursors.get(tr);
			if (cursor !== undefined && ins !== undefined && del !== undefined) {
				ins = Y.diffIdSet(ins as never, cursor.ins as never) as IdSetLike;
				del = Y.diffIdSet(del as never, cursor.del as never) as IdSetLike;
			}
			cursors.delete(tr);
			committed.add(tr);
			fold(tr.changed ?? new Map(), makeEditIndex(ins, del));
		};

		// ── projection ───────────────────────────────────────────────────

		/** `id`'s visible content items, canonical and frozen (R4). */
		const itemsOf = (id: BlockId): ContentItem[] =>
			protectItems(T.readSegs(ownShim.display(id) ?? []), intern) as ContentItem[];

		const projectBlock = (id: BlockId): ProjectedBlock => {
			const rec = blocks.get(id)!;
			const projected: ProjectedBlock = {
				id,
				type: typeOf(id),
				data: dataOf(rec),
				content: itemsOf(id),
				children: []
			};
			for (const k of kidsMap.get(id) ?? []) projected.children.push(projectBlock(k.id));
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
			/** The children index version it was taken at. */
			kids: number;
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
				const ks = kidsMap.get(parent) ?? [];
				if (ks.length === 0) continue;
				order.set(parent, Object.freeze(ks.map((k) => k.id)));
				for (let index = ks.length - 1; index >= 0; index--) stack.push(ks[index].id);
				ks.forEach(({ id }, index) => {
					const old = prev?.get(id);
					const rec = blocks.get(id)!;
					nodes.set(
						id,
						old === undefined
							? { parent, index, type: typeOf(id), data: rec.data, runs: runs(id) }
							: { ...old, parent, index }
					);
				});
			}
			return { nodes, order, kids: kidsVersion };
		};

		const keyOf = (v: unknown): string => {
			try {
				return JSON.stringify(v ?? null);
			} catch {
				return JSON.stringify(cloneJsonSafe(v ?? null));
			}
		};

		/** The blocks whose shown kind followed their slot at the last report. */
		let followingBefore: BlockId[] = [];
		/** The document data's key at the last report. */
		let dataKey = '';
		/** Build the commit's report and advance the published index to it. */
		const report = (): IndexReport | null => {
			const before = published!;
			ensurePlacements();
			const r: IndexReport = {
				added: new Map(),
				removed: new Set(),
				moved: new Set(),
				meta: new Map(),
				content: new Map(),
				order: new Map()
			};
			// The document's data is news when it differs from what was published.
			if (dataChanged) {
				dataChanged = false;
				const data = docData();
				const key = keyOf(data);
				if (key !== dataKey) [r.data, dataKey] = [data, key];
			}
			if (kidsVersion === before.kids && candidates.size === 0) return r.data ? r : null;
			const after = kidsVersion === before.kids ? before : reachable(before.nodes);
			// Added subtrees carry their new descendants. A descendant that was
			// visible before is reported like any visible block (moved, retyped,
			// edited against its published baseline), so consumers keep it (K7).
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
					if (!before.nodes.has(b.id)) covered.add(b.id);
					b.children.forEach(register);
				};
				for (const [id, n] of after.nodes) {
					if (!before.nodes.has(id)) {
						if (covered.has(id)) continue;
						const b = projectBlock(id);
						r.added.set(id, b);
						register(b);
					} else {
						const o = before.nodes.get(id)!;
						if (o.parent !== n.parent || o.index !== n.index) r.moved.add(id);
					}
				}
				// Removed subtree ROOTS: a removed id whose before-parent stays
				// visible (or is the root). One under a removed parent leaves with
				// it; one under a surviving child of a removed subtree does not.
				for (const [id, o] of before.nodes) {
					if (after.nodes.has(id)) continue;
					if (o.parent === null || after.nodes.has(o.parent)) r.removed.add(id);
				}
			}
			const meta = (id: BlockId, n: NonNullable<ReturnType<typeof after.nodes.get>>) => {
				const rec = blocks.get(id)!;
				const type = typeOf(id);
				r.meta.set(id, { type, data: dataOf(rec) });
				n.type = type;
				n.data = rec.data;
			};
			for (const id of candidates) {
				const n = after.nodes.get(id);
				if (n === undefined || covered.has(id)) continue;
				const rec = blocks.get(id)!;
				if (typeOf(id) !== n.type || keyOf(rec.data) !== keyOf(n.data)) meta(id, n);
				const next = runs(id);
				if (next !== n.runs) {
					const key = keyOf(next);
					if ((n.key ??= keyOf(n.runs)) !== key) r.content.set(id, next);
					n.runs = next;
					n.key = key;
				}
			}
			// A block that starts or stops displaying a kind other than its
			// stored one moved, or its kind follows (or followed) its slot:
			// its kind is news. Without a placement change, only a retype
			// changes a shown kind — the retyped block's (a candidate) and the
			// kinds derived from it: a promoted or stray line shows its display
			// parent's default child (XW-08).
			if (after !== before || retyped) {
				const now = [...following];
				for (const id of [...r.moved, ...now, ...followingBefore]) {
					const n = after.nodes.get(id);
					if (n !== undefined && !candidates.has(id) && !covered.has(id) && typeOf(id) !== n.type)
						meta(id, n);
				}
				followingBefore = now;
			}
			// A plain block directly in a list shows as its item (`itemOf`, AW-04):
			// a block whose shown kind changed re-reads its children's (a worklist:
			// the map visits the entries added meanwhile).
			for (const id of r.meta.keys())
				for (const { id: kid } of kidsMap.get(id) ?? []) {
					const n = after.nodes.get(kid);
					if (n !== undefined && !covered.has(kid) && !r.meta.has(kid) && typeOf(kid) !== n.type)
						meta(kid, n);
				}
			retyped = false;
			candidates.clear();
			published = after;
			const empty =
				r.added.size + r.removed.size + r.moved.size + r.meta.size + r.content.size + r.order.size;
			return empty === 0 && !r.data ? null : r;
		};

		/** Report the commit (or role change) to every subscriber, when it changed the visible document. */
		const publish = (origin: unknown, local: boolean): void => {
			const r = report();
			if (r !== null) callEach('[edytor-doc] change', [...reportSubs], r, origin, local);
		};
		const onUpdate = (_u: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown): void => {
			if ((tr as Tx).changed?.has(dataRoot as never)) dataChanged = true;
			publish(origin, (tr as { local?: boolean }).local === true);
		};

		// ── initial scan: index every existing block ────────────────────
		registry.forEachAttr((v: unknown, id: string) => {
			if (!isNodeLike(v)) return;
			updateBlockRec(id);
			const row = scanRow(id);
			if (row !== undefined) rows.set(id, row);
		});
		rebuildTable(new Set());
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
				return version;
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
				if (roles === null) return undefined;
				syncAll();
				ensurePlacements();
				const shown = blocks.has(id) ? typeOf(id) : undefined;
				return shown === blocks.get(id)?.type ? undefined : shown;
			},
			dissolved: (id) => {
				syncAll();
				ensurePlacements();
				return dissolved.has(id);
			},
			project: (root?: BlockId): ProjectedBlock[] => {
				syncAll();
				ensurePlacements();
				return root === undefined
					? (kidsMap.get(null) ?? []).map((k) => projectBlock(k.id))
					: [projectBlock(root)];
			},
			roles: (next) => {
				roles = next;
				placementFull = true;
				version++;
				// No commit carries a role change: report it now (not inside a
				// transaction, whose commit reports it), so every view follows.
				if (reportSubs.size > 0 && !openTx()) publish(null, false);
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
			onReport: (cb) => {
				if (reportSubs.size === 0) {
					syncAll();
					published = reachable();
					dataKey = keyOf(docData());
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
