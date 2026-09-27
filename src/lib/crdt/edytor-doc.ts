/**
 * EdytorDoc (U06) — the assembled document model.
 *
 * This module binds the three proven engine layers over ONE Y.Doc into the
 * single public surface the command layer (U08) and providers (U07) consume:
 *
 * - `placement/model.ts` (`bindModel`) — stable block registry + placement
 *   candidates; identity-preserving move/nest/split/merge (U03).
 * - `text/model.ts` (`bindText`) — stable backing texts + slice/merge claims;
 *   content ownership survives split/merge without copying atoms (U04).
 * - `text/runs.ts` (`bindRuns`) — the maintained run view: immutable run
 *   snapshots, structural sharing, per-block subscriptions (U05).
 *
 * ── Schema manifest ────────────────────────────────────────────────────
 *
 * Unified `Y.Node` cannot distinguish roles by class (no `Y.Text` vs
 * `Y.Map`), so every semantic role is recorded explicitly in {@link SCHEMA}
 * — the constants table below IS the manifest (node names, root keys, attr
 * names). The replicated half of the contract is the version record: init
 * writes `doc.get('meta').setAttr('v', SCHEMA_VERSION)` (+ `schema` name) so
 * ANY replica — including one that only ever applied updates — can read the
 * schema version before mutating (U07's version gate). `doc.get` on a root
 * emits no update, so the read path stays write-free.
 *
 * Replicated layout:
 *
 * ```
 * doc.get('blocks')                      registry — flat map, blockId → node('block')
 *   └ <blockId>                           id/type/data/del + content/slices/at
 * doc.get('meta')                        version record root
 *   ├ v : number                          SCHEMA_VERSION (LWW attr — concurrent init converges)
 *   └ schema : 'edytor-doc'               SCHEMA_NAME
 * ```
 *
 * ── Deterministic seed (R13, D-3) ───────────────────────────────────────
 *
 * `seed(doc, value)` applies ONE update built in a scratch doc whose writer
 * id is a 32-bit hash of (generation, canonical seed JSON): caller ids are
 * kept, missing ids are derived from the hash and position, ranks come from
 * the rand seam seeded by the hash. Peers seeding the same value therefore
 * write the SAME items — a late identical seed is a no-op and never erases
 * an edit — while different values union (shared ids resolve by registry
 * LWW). An empty value seeds one `defaultType` block. The update is applied
 * with a non-local origin: never an undo step, no attribution stamp.
 * Seeding is explicit: reads never create or normalize state.
 *
 * ── Identity discipline ────────────────────────────────────────────────
 *
 * Relocation (move/nest/unnest/split/merge/delete-with-children) preserves
 * block AND atom identity — the U03/U04 contract. New identity is created
 * ONLY by ops whose purpose is fresh identity: `insertBlock`
 * (caller-assigned ids; nested spec children included), `duplicateBlock`
 * (explicit fresh ids for paste/drag-clone), and `setBlock` content/children
 * replacement (baseline `setBlock` semantics — replacement is a new-identity
 * operation).
 *
 * ── Island/void enforcement (operation-layer, not stored) ──────────────
 *
 * Roles are resolved operation-time via `config.roleOf(type)` — the editor
 * derives them from plugin block definitions, exactly like the baseline's
 * `block.definition.island/void`. They are deliberately NOT replicated block
 * data: the schema stays policy-free, and a replica with different plugins
 * reads the same document. Enforced rules (baseline semantics, see
 * `plugins.ts` + `block.utils.ts`):
 *
 * - `void`: cannot accept children (insert/move/nest into void rejected),
 *   cannot merge either direction, cannot be split. Content edits ARE
 *   allowed — void rendered content (captions) stays editable per the
 *   baseline contract. Deletion is allowed (delete is not editing).
 * - `island`: editable content, but its subtree is structurally sealed —
 *   a block inside an island (`insideIsland`) cannot be moved, nested,
 *   unnested, or merged across the island boundary. Merges INSIDE one
 *   island are allowed; merging an island child into the island itself is
 *   allowed. Moving INTO an island subtree is rejected.
 * - Island merge: when an island block itself is merged (backward or
 *   forward), its children are unnested to the vacated sibling slot and
 *   reset to the default block type — the documented baseline behavior.
 * - Baseline merges NEVER adopt the merged block's children — they unnest
 *   to the vacated slot. The facade exposes both: `mergeBlocks` is the
 *   engine primitive (children adopt into the target — TX09c contract),
 *   `mergeBackward`/`mergeForward` reproduce the baseline command shape.
 *
 * ── Change events ──────────────────────────────────────────────────────
 *
 * `onChange` emits one {@link DocChange} per committed transaction (local
 * AND remote — derived from `doc.on('update')`). The payload names exactly
 * what changed: added subtrees, removed ids, moved ids, meta changes,
 * content changes (as maintained runs) and per-parent child-order changes —
 * enough for an independent mirror to apply the diff without re-reading
 * the document. Updates that produce no semantic diff (e.g. a losing
 * placement candidate or a meta-only write) are suppressed.
 */
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode, YUndoManager } from './engine-api.js';
import { hash32, setDocRand } from './rand.js';
import { bindUndoRepair } from './undo-repair.js';
import {
	AT,
	AT_NODE,
	BLOCK_ATTR_ROOT,
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DATA,
	DEL,
	ID,
	INLINE_NODE,
	LAST_CHANGED_ATTR,
	META_ROOT_KEY,
	REGISTRY_KEY,
	SLICES,
	SLICES_NODE,
	TYPE,
	ATTRIBUTION_ROOT
} from './schema.js';
import {
	bindModel,
	displayParentOf,
	isVisible,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ProjectedBlock
} from './placement/model.js';
import {
	bindText,
	DEAD,
	intervalsOver,
	isMergeClaim,
	isSliceRecord,
	nearestOwned,
	ownerAt,
	type Anchor,
	type Ownership,
	type RangeCursor,
	type SliceEntry,
	type TextBlockRec
} from './text/model.js';
import { bindRuns, type ContentRun, type RunView } from './text/runs.js';
import { bindNodes, type DocBlock } from './nodes.js';
import { walkIdSetStructs, type IdSetLike } from './structs.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import type { AttributionActor } from './attribution/index.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import {
	cloneJson,
	cloneJsonSafe,
	jsonBlockToSpec,
	sanitizeWireJson,
	sanitizeWireString,
	type JSONBlock,
	type JSONDoc,
	type JSONInlineBlock,
	type JSONText
} from '../utils/json.js';

// ── schema manifest ─────────────────────────────────────────────────────

/**
 * The schema manifest — every semantic `Y.Node` role, root key, and attr
 * name in the assembled model. Unified nodes are role-agnostic, so this
 * constants table is the authoritative record a reader uses to interpret
 * `name`/`attr` labels; the replicated `meta.v`/`meta.schema` attrs tell a
 * replica WHICH schema generation a document was written under.
 */
export const SCHEMA = {
	/** Schema generation written by `init` and read by the version gate. */
	version: 1,
	/** Manifest name — stored on `meta.schema`. */
	name: 'edytor-doc',
	roots: {
		/** Flat block registry: blockId → node('block'). */
		registry: REGISTRY_KEY,
		/** Version/manifest record root (attrs: `v`, `schema`). */
		meta: META_ROOT_KEY,
		/**
		 * Legacy attribution metadata root — `a/` ContentMap records written
		 * by the retired U6 per-edit capture pipeline, plus the durable
		 * `c/` replica→actor bindings and `u/` actor profiles still
		 * published by `attribution/attribution.ts` (U2). Reserved here so
		 * user content can never collide with it; existing `a/` state is
		 * preserved verbatim and readable via `attribution.legacy()`.
		 */
		attribution: ATTRIBUTION_ROOT,
		/**
		 * U1 compact per-BLOCK attribution root — `b/<blockId>` records
		 * (`c` createdBy + `k/<actorId>` contributor members). Deliberately
		 * separate from `attribution`: this root stays outside
		 * `createUndoManager`'s scope so contributor union sets survive
		 * undo (see `attribution/block.ts`).
		 */
		blockAttribution: BLOCK_ATTR_ROOT
	},
	/** Named node roles (YNode.name). */
	nodes: {
		block: BLOCK_NODE,
		content: CONTENT_NODE,
		slices: SLICES_NODE,
		at: AT_NODE,
		inline: INLINE_NODE
	},
	/** Attr keys on a block node. */
	blockAttrs: {
		id: ID,
		type: TYPE,
		data: DATA,
		/** Presence = explicitly deleted (deletion-wins flag). */
		del: DEL,
		/**
		 * U1 `lastChangedBy` — the actor id whose state change currently
		 * wins LWW on this block. Lives ON the block node so registry-scoped
		 * undo restores it for free; `contributors`/`createdBy` (monotonic,
		 * undo-immune) live on the `blockAttribution` root instead.
		 */
		lastChanged: LAST_CHANGED_ATTR,
		content: CONTENT,
		slices: SLICES,
		at: AT
	},
	/** Attr keys on an inline-atom node. */
	inlineAttrs: { id: ID, type: TYPE, data: DATA },
	/** Attr keys on the meta root. */
	metaAttrs: { version: 'v', schema: 'schema' },
	/** Placement candidate record: `at["<seq>.<clientId>"] → {p, r}`. */
	placement: { parentKey: 'p', rankKey: 'r' },
	/** Slice-record payloads: `{t,s,e,g?}` / merge claim `{m}`. */
	slice: { textKey: 't', startKey: 's', endKey: 'e', genKey: 'g', mergeKey: 'm' }
} as const;

export const SCHEMA_VERSION = SCHEMA.version;
export const SCHEMA_NAME = SCHEMA.name;
export const META_KEY = SCHEMA.roots.meta;

/** Origin of the seed update's apply — non-local, like any integrated update. */
export const SEED_ORIGIN = Symbol('edytor:seed');

// ── schema gate (module-level: pure doc reads, no engine binding) ──────

/**
 * The replicated schema version (`meta.v`) — `undefined` before init.
 * Read-only: `doc.get` on a root emits no update.
 */
export const schemaVersion = (doc: EngineDoc): number | undefined => {
	const v = doc.get(SCHEMA.roots.meta).getAttr(SCHEMA.metaAttrs.version);
	return typeof v === 'number' ? v : undefined;
};

/** True iff the `blocks` registry holds at least one entry (live or deleted). */
export const registryEmpty = (doc: EngineDoc): boolean =>
	doc.get(SCHEMA.roots.registry).attrKeys().next().done === true;

/**
 * True iff the document carries the schema version record. Content alone —
 * e.g. a raw `doc.get('blocks').setAttr('x', …)` write — is NOT proof of
 * initialization: the gate distinguishes "versioned" from "has any registry
 * state" so rogue unversioned writes never masquerade as an initialized doc.
 * A replica that learned `meta.v` purely by applying updates counts.
 */
export const isInitialized = (doc: EngineDoc): boolean => schemaVersion(doc) !== undefined;

/**
 * A document's relationship to this build's schema:
 *
 * - `unversioned` — registry state exists but `meta.v` is absent. Someone
 *   wrote replicated content without running the schema path (a rogue or
 *   v13-era write). This state must NEVER be persisted/broadcast as a
 *   document update by a provider.
 * - `unsupported` — `meta.v` names a version this build does not speak
 *   (e.g. `99` written by a future build). Content still applies (a replica
 *   cannot refuse structs it already shares a protocol with), but providers
 *   surface a `schema-mismatch` signal so operators can detect skew.
 * - `foreign` — `meta.v` is the supported version but `meta.schema` is
 *   missing or names a DIFFERENT manifest (`'not-edytor'`, a next-gen name,
 *   an app-local doc kind). A valid version number alone does not make the
 *   payload an edytor document — the manifest name is part of the contract
 *   (gate-F1 F5: the version-only check let foreign `meta.schema` values
 *   cross the staging boundary).
 */
export type SchemaProblem = {
	kind: 'unversioned' | 'unsupported' | 'foreign';
	/** The observed `meta.v` (undefined for `unversioned`). */
	version?: number;
	/** The observed `meta.schema` (undefined when absent). */
	schema?: unknown;
};

/** The observed `meta.schema` manifest name (`undefined` when absent). */
const schemaName = (doc: EngineDoc): unknown =>
	doc.get(SCHEMA.roots.meta).getAttr(SCHEMA.metaAttrs.schema);

/**
 * Inspect the document's schema record. `null` = clean (versioned under the
 * supported schema AND manifest name, or completely untouched). Read-only,
 * safe mid-transaction.
 */
export const checkSchema = (doc: EngineDoc): SchemaProblem | null => {
	const v = schemaVersion(doc);
	const name = schemaName(doc);
	if (v === undefined) {
		if (registryEmpty(doc)) {
			// Completely untouched is clean — but a bare FOREIGN manifest
			// name with no other state is still a foreign claim, not a doc
			// this build can speak for. A stray copy of our own name is
			// inert (no registry, no version claim).
			return name === undefined || name === SCHEMA_NAME ? null : { kind: 'foreign', schema: name };
		}
		return { kind: 'unversioned', schema: name };
	}
	if (v !== SCHEMA_VERSION) return { kind: 'unsupported', version: v, schema: name };
	if (name !== SCHEMA_NAME) return { kind: 'foreign', version: v, schema: name };
	return null;
};

/** Error raised by {@link assertSchema} — carries the detected problem. */
export class SchemaMismatchError extends Error {
	constructor(
		public readonly docName: string,
		public readonly problem: SchemaProblem
	) {
		super(
			problem.kind === 'unversioned'
				? `Document "${docName}" carries replicated registry state but no meta.v schema version — refusing to treat it as initialized.`
				: problem.kind === 'unsupported'
					? `Document "${docName}" claims unsupported schema version ${problem.version} (this build speaks ${SCHEMA_VERSION}).`
					: problem.schema === undefined
						? `Document "${docName}" carries meta.v=${problem.version} but no meta.schema manifest name — refusing it as an "${SCHEMA_NAME}" document.`
						: `Document "${docName}" claims foreign schema "${String(problem.schema)}" (this build speaks "${SCHEMA_NAME}").`
		);
		this.name = 'SchemaMismatchError';
	}
}

/**
 * Hard gate — throws {@link SchemaMismatchError} when `checkSchema` reports a
 * problem. Used by migration and by the future U08 `Edytor.sync()` path before
 * mutating a synced document.
 */
export const assertSchema = (doc: EngineDoc, docName = 'doc'): void => {
	const problem = checkSchema(doc);
	if (problem !== null) throw new SchemaMismatchError(docName, problem);
};

/**
 * Error raised by {@link assertUsableDoc} — the doc cannot host a v14 facade.
 * `kind` distinguishes a foreign engine object (a real v13 `yjs` Doc — a
 * different CRDT implementation entirely) from a v14 doc that decodes the
 * legacy v13 Edytor schema (applied v13 update rows awaiting migration).
 */
export class UnsupportedDocError extends Error {
	constructor(public readonly kind: 'foreign' | 'legacy') {
		super(
			kind === 'legacy'
				? 'Document carries the legacy v13 Edytor schema (`content` root) — ' +
						'migrate it via `crdt.migration` before attaching an editor.'
				: 'Document is not a v14 engine doc — the `blocks` registry is not a ' +
						'unified Y.Node. Use `crdt.createDoc()` (or `new Y.Doc()` from ' +
						'`edytor/crdt`); a v13 `yjs` Doc must be migrated via ' +
						'`crdt.migration` (from its stored updates), not passed to the runtime.'
		);
		this.name = 'UnsupportedDocError';
	}
}

/**
 * Document-boundary guard run by {@link EdytorDocBinding.create} before the
 * runs view attaches. The facade only speaks the v14 unified-node surface —
 * without this gate a foreign doc dies obscurely inside `buildView`
 * (`registry.forEachAttr is not a function`), and a legacy-schema doc would be
 * silently misread. Both fail fast with an actionable error instead.
 */
export const assertUsableDoc = (doc: EngineDoc): void => {
	let registry: unknown;
	try {
		registry = typeof doc?.get === 'function' ? doc.get(SCHEMA.roots.registry) : undefined;
	} catch {
		registry = undefined;
	}
	if (!isNodeLike(registry) || typeof registry.forEachAttr !== 'function') {
		throw new UnsupportedDocError('foreign');
	}
	if (isLegacyDoc(doc)) {
		throw new UnsupportedDocError('legacy');
	}
};

/**
 * Raised when a mutating facade op runs after `dispose()` — disposal is
 * terminal for writes (reads stay dead-safe: a stale handle may still be
 * inspected while its document outlives the facade). The facade-level
 * counterpart of `DocumentDestroyedError` — kept in this module because a
 * bare `bindEdytorDoc` facade has no document layer above it.
 */
export class EdytorDocDisposedError extends Error {
	constructor(service?: string) {
		super(`EdytorDoc${service ? `.${service}` : ''}: facade is disposed.`);
		this.name = 'EdytorDocDisposedError';
	}
}

// ── types ───────────────────────────────────────────────────────────────

/** Structural role of a block type (plugin-side policy, resolved per op). */
export type BlockRole = {
	/** Not editable through normal structural flow; no children, no merges. */
	void?: boolean;
	/** Editable, but its subtree is structurally sealed from outside blocks. */
	island?: boolean;
};

/** Configuration for an attached {@link EdytorDoc}. */
export type EdytorDocConfig = {
	/**
	 * Resolve a block `type` to its structural role — the seam where the
	 * editor's plugin definitions plug in (e.g. `(t) => edytor.blocks.get(t)`).
	 * Defaults to no roles (pure engine behavior).
	 */
	roleOf?: (type: string) => BlockRole | undefined;
	/**
	 * Default block type — used for the bootstrap block and for island-merge
	 * child reset. Defaults to `'paragraph'`.
	 */
	defaultType?: string;
	/**
	 * U1 — the local actor getter for compact per-block attribution
	 * (`attribution/block.ts`). Read lazily per op so the document can
	 * pass `() => this.actor` before the actor field is assigned. When
	 * absent the facade performs NO block-attribution writes at all —
	 * bare facades (raw docs, migration seeders, engine-level tests)
	 * stay byte-identical to the unattributed schema.
	 */
	actor?: () => AttributionActor | undefined;
	/**
	 * Opt-in per-block lineage depth (`attribution.history`). `> 0` captures
	 * a subtree checkpoint just before a write displaces the block's current
	 * `lastChangedBy` owner — handoffs, deletes, and undo/redo touches —
	 * ring-trimmed to this many entries on the block's `b/<id>` record.
	 * `0`/absent disables the feature entirely: no captures, no list items,
	 * byte-identical writes. Requires `actor` — unattributed facades never
	 * capture.
	 */
	lineageDepth?: number;
	/**
	 * The document's `writable` guard (O18) — called at the write funnel;
	 * throws while the document is read-only, so an edit is refused rather
	 * than accepted and then dropped by the quarantined transport.
	 */
	assertWritable?: () => void;
};

/**
 * One committed transaction's semantic diff — the payload {@link EdytorDoc.onChange}
 * subscribers receive. Every collection names the affected ids; `order`
 * carries the NEW child-id list per changed parent so a mirror can apply the
 * diff without re-reading the doc.
 */
export type DocChange = {
	/** Transaction origin (local origin object, remote marker, …). */
	origin: unknown;
	/** `transaction.local` — false for remote-applied updates. */
	local: boolean;
	/** Monotonic event counter per facade. */
	version: number;
	/** Newly visible blocks → full projected subtree (incl. content+children). */
	added: Map<BlockId, ProjectedBlock>;
	/** Ids no longer visible (deleted, merged-away, or hidden with subtree). */
	removed: Set<BlockId>;
	/** Ids whose display parent or sibling index changed. */
	moved: Set<BlockId>;
	/** Ids whose `type`/`data` payload changed → new values. */
	meta: Map<BlockId, { type: string; data?: Record<string, unknown> }>;
	/** Ids whose visible content changed → the new maintained runs. */
	content: Map<BlockId, readonly ContentRun[]>;
	/** Parents (`null` = root) whose visible child list changed → new order
	 *  (frozen — shared with the retained snapshot baseline, R4). */
	order: Map<BlockId | null, readonly BlockId[]>;
};

export type EdytorDoc = ReturnType<EdytorDocBinding['create']>;
export type EdytorDocBinding = ReturnType<typeof bindEdytorDoc>;

// ── caret anchors (U09) ────────────────────────────────────────────────

/**
 * Selection-endpoint affinity — which side of a position the anchor binds
 * to (see `T.atomAnchorAt`):
 *
 * - `'left'` — bound to the atom BEFORE the position; resolves right after
 *   it, so a concurrent insert exactly at the position lands to the
 *   anchor's right. Used for carets and range ENDS.
 * - `'right'` — bound to the atom AT the position; resolves right before
 *   it, so a concurrent insert lands to the anchor's left — outside a
 *   range starting here. Used for range STARTS.
 */
export type AnchorAffinity = 'left' | 'right';

/**
 * A selection endpoint bound to BACKING-text atoms — `{b}` is the home
 * block id of the backing text the bound atom lives in (NOT necessarily
 * the block that displays it — merges/splits reroute display while the
 * anchor stays on the same atoms), `a` the engine anchor carrying the
 * affinity in its `a` field (`a < 0` left, `a >= 0` right).
 * JSON-serializable — this is the awareness/undo-snapshot wire shape.
 */
export type DocAnchor = {
	b: BlockId;
	a: Anchor;
	/**
	 * The display block a `-2` seam anchor belongs to (`anchorAt`'s
	 * `blockId`). `a <= -2` alone cannot distinguish "the atom at the
	 * resolved gap is owned by the anchor's block" from "the left
	 * neighbour appended a foreign atom across the seam" — both place a
	 * non-owned atom right of the bound atom. `o` pins the intended
	 * stream so resolution rebases the index onto ITS segs instead of
	 * trusting whichever owner currently sits at the gap.
	 */
	o?: BlockId;
};

// ── internals ───────────────────────────────────────────────────────────

type JsonObj = Record<string, unknown>;

/** Shared frozen empty child list for `DocChange.order` tombstone entries. */
const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/**
 * Canonical key for a content item list — for change detection only.
 * TOTAL against hostile replicated payloads (R4): a remote/raw non-JSON
 * value (`bigint`, a cycle) must not crash diffing — the normalized
 * projection is the comparison surface, deterministic on every replica.
 */
const safeKeyOf = (v: unknown): string => {
	try {
		return JSON.stringify(v ?? null);
	} catch {
		return JSON.stringify(cloneJsonSafe(v ?? null));
	}
};
const contentKeyOf = (items: unknown): string => safeKeyOf(items);
const dataKeyOf = (v: unknown): string => safeKeyOf(v);

/**
 * Order-insensitive JSON structural equality — used for U1 semantic
 * no-op suppression (`setBlockData`/`setBlockType` with the same value
 * must not stamp attribution). Total: non-JSON values compare `false`
 * rather than throwing.
 */
const jsonEquals = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((x, i) => jsonEquals(x, bb[i]));
	}
	// Non-plain-object leaves (Date, engine nodes, class instances — only
	// reachable via raw/foreign writes) compare false even when both carry
	// zero enumerable keys: write-suppression must never silence a real
	// normalization write.
	const ap = Object.getPrototypeOf(a);
	const bp = Object.getPrototypeOf(b);
	if ((ap !== Object.prototype && ap !== null) || (bp !== Object.prototype && bp !== null)) {
		return false;
	}
	const ao = a as JsonObj;
	const bo = b as JsonObj;
	const ak = Object.keys(ao);
	if (ak.length !== Object.keys(bo).length) return false;
	return ak.every((k) => jsonEquals(ao[k], bo[k]));
};

/**
 * Per-event snapshot of the projected tree for diffing.
 *
 * U11: this is a SKELETON snapshot, not a materialized `project()` — the
 * snapshot is taken on every committed transaction and materializing full
 * projected nodes (per-block `contentItemsOf` + `data` clones) measured as
 * the dominant per-commit cost (~4ms of ~5.1ms at 1,000 blocks). Entries
 * keep only cheap comparison surface:
 *
 * - `data` is the LIVE replicated attr ref — compared via `dataKeyOf`
 *   only, and cloned at the boundary if it ever reaches a `DocChange`
 *   payload (`meta`), so subscribers can never mutate engine state.
 * - `contentRef` is the block's CACHED runs array. The runs view reuses
 *   the same frozen array while content is unchanged (structural sharing
 *   in `reconcile`), so `o.contentRef !== n.contentRef` is an O(1)
 *   "maybe changed" check. `runEquals` compares `marks`/`data` by
 *   REFERENCE, so a recomputed-but-equal array is possible — the lazy
 *   `contentKey` (JSON of the merged runs, consistent on both sides of
 *   the diff) confirms an actual change before it is reported.
 * - `nodeFor` materializes the full projected subtree lazily — only
 *   `added` roots ever need it.
 */
type DocSnap = {
	nodes: Map<
		BlockId,
		{
			parent: BlockId | null;
			index: number;
			type: string;
			data: Record<string, unknown> | undefined;
			contentRef: readonly ContentRun[];
			contentKey?: string;
		}
	>;
	/** parentKey (id or null for root) → ordered child ids (frozen —
	 *  the same array is published on a `DocChange` and retained as the
	 *  diff baseline, so it must be immutable — R4). */
	order: Map<BlockId | null, readonly BlockId[]>;
	/** Materialize the projected subtree rooted at `id` (for `added` entries). */
	nodeFor?: (id: BlockId) => ProjectedBlock;
};

/**
 * Bind the assembled model to a concrete engine surface. `Y` must be the
 * vendored v14 module — injected so this file type-checks structurally and
 * never imports vendor `.js` (see `engine-api.ts`).
 */
export const bindEdytorDoc = (Y: EngineApi) => {
	const R = bindRuns(Y);
	// WU7: inject the doc-shared model state so `M.view()` returns the
	// maintained indexes (block records, ownership, placements, children
	// index) instead of rebuilding them per call — typed-node commands,
	// maintained runs, anchors, `DocChange` and rendering all read ONE
	// consistent incremental model.
	const M = bindModel(Y, (doc) => R.modelState(doc));
	const T = bindText(Y);
	// U1 — compact per-block attribution writes (`attribution/block.ts`).
	// One bound instance per engine binding; its suppression memory is
	// per-doc (WeakMap-keyed), so facades on the same doc share it.
	const BA = bindBlockAttribution(Y);

	// R3 — the doc-level undo-resurrection ownership repair lives in
	// `undo-repair.ts` (vendor-internal struct/store/transaction walks —
	// keep the blast radius out of this file). Attached once per doc for
	// the doc's lifetime from `create()` below; the module-level dedupe
	// table spans every binding.
	const attachUndoRepair = bindUndoRepair(Y, {
		collectBlocks: M.collectBlocks,
		computeOwnership: T.computeOwnership,
		undoRepairClaims: T.undoRepairClaims,
		contentNodeName: SCHEMA.nodes.content
	});

	// ── version record / bootstrap (doc-level, facade-free) ────────────
	// `schemaVersion`, `registryEmpty`, `isInitialized`, `checkSchema` and
	// `assertSchema` are module-level (see above) — pure doc reads shared by
	// providers and migration without re-binding.

	/**
	 * U1 — stamp a freshly materialized spec tree (all levels) with
	 * `createdBy`/`contributors`/`lastChangedBy` = `actorId`. Call inside
	 * the creating transaction; the spec's ids are re-sanitized the way
	 * `materializeSpec` stored them.
	 */
	const stampSpecTree = (doc: EngineDoc, spec: BlockSpec, actorId: string): void => {
		const id = sanitizeWireString(spec.id);
		const node = M.blockNodeOf(doc, id);
		if (node !== null) BA.stampCreated(doc, node, id, actorId);
		for (const child of spec.children ?? []) stampSpecTree(doc, child, actorId);
	};

	/**
	 * Stamp the version record (absent only) and, into an EMPTY registry,
	 * bulk-insert `content` — the local materializer: the seed's scratch
	 * doc, migration's rebuild and fixtures. Without `content` it seeds an
	 * unstamped empty doc (see {@link seed}). Idempotent otherwise. It
	 * writes no attribution (authored content goes through the ops).
	 */
	const init = (
		doc: EngineDoc,
		opts: { content?: BlockSpec[]; defaultType?: string } = {}
	): void => {
		const specs = opts.content ?? [];
		if (specs.length === 0 && registryEmpty(doc) && !isInitialized(doc)) {
			return seed(doc, [], opts.defaultType);
		}
		doc.transact(() => {
			const meta = doc.get(META_KEY);
			if (meta.getAttr(SCHEMA.metaAttrs.version) === undefined) {
				// Never downgrade a higher version written by a newer peer —
				// U07's gate decides compatibility; init only stamps absent.
				meta.setAttr(SCHEMA.metaAttrs.version, SCHEMA_VERSION);
				meta.setAttr(SCHEMA.metaAttrs.schema, SCHEMA_NAME);
			}
			if (specs.length === 0 || !registryEmpty(doc)) return;
			// Bulk path (U7): one sibling read + a local rank chain for the
			// whole batch. All-or-nothing: a dup spec id refuses the batch.
			if (!M.insertBlocks(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, specs)) {
				// Malformed initial content (e.g. a duplicated id) — fall back
				// to per-spec insertion so valid blocks still load.
				console.error(
					'[edytor-doc] initial content refused by bulk insert; retrying per-spec (duplicate block ids are skipped)'
				);
				for (const spec of specs) {
					M.insertBlock(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, spec);
				}
			}
		});
	};

	/**
	 * The deterministic seed update (R13, D-3) — see the module header.
	 * Every seeded block also gets an EMPTY `b/` record (no authorship) so
	 * later contributor adds land on one shared node.
	 */
	const seedUpdate = (value: JSONBlock[], defaultType = 'paragraph'): Uint8Array => {
		// Canonical form (object keys sorted, arrays in order): the hash AND
		// the build read it, so key order never splits one template.
		const sorted = (_: string, v: unknown) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
				: v;
		const blocks: JSONBlock[] = JSON.parse(
			JSON.stringify(value.length > 0 ? value : [{ type: defaultType }], sorted)
		);
		const writer = hash32(`yjs-v14/${SCHEMA_NAME}@${SCHEMA_VERSION}:${JSON.stringify(blocks)}`);
		let n = 0;
		const mint = (prefix: string) => `${prefix}${writer.toString(36)}.${n++}`;
		const specs = blocks.map((block) => jsonBlockToSpec(block, false, mint));
		const raw = new Y.Doc();
		raw.clientID = writer;
		const scratch = raw as unknown as EngineDoc;
		let rank = writer; // ranks from the rand seam, seeded by the hash (LCG)
		setDocRand(scratch, () => (rank = (Math.imul(rank, 1664525) + 1013904223) >>> 0) / 2 ** 32);
		init(scratch, { content: specs });
		const records = (spec: BlockSpec): void => {
			BA.ensureRecord(scratch, sanitizeWireString(spec.id));
			spec.children?.forEach(records);
		};
		scratch.transact(() => specs.forEach(records));
		return Y.encodeStateAsUpdate(raw);
	};

	/** Apply the deterministic seed of `value` with the non-local {@link SEED_ORIGIN}. */
	const seed = (doc: EngineDoc, value: JSONBlock[] = [], defaultType?: string): void =>
		Y.applyUpdate(doc as unknown as YDoc, seedUpdate(value, defaultType), SEED_ORIGIN);

	// ── per-doc facade ──────────────────────────────────────────────────

	const create = (doc: EngineDoc, config: EdytorDocConfig = {}) => {
		// Document-boundary check — foreign (v13-engine) and legacy-schema docs
		// fail fast here rather than inside the runs view (see assertUsableDoc).
		assertUsableDoc(doc);
		const roleOf = config.roleOf ?? (() => undefined);
		const defaultType = config.defaultType ?? 'paragraph';
		const runsView: RunView = R.attach(doc);

		// ── model-state version + read invalidation (WU2) ───────────────
		//
		// `stateVersion` is the facade's invalidation token — it bumps on
		// EVERY mutation routed through this facade (each `write` below)
		// and on every committed `update` (local AND remote). The eager
		// `update` listener exists so remote commits invalidate the cached
		// view even before the first `onChange` subscriber attaches (the
		// DocChange listener below attaches lazily — it is for diffing, not
		// for cache correctness).
		//
		// `view`/`anchorView` memoize on `stateVersion`: consecutive reads
		// inside one version share ONE collected view (the U11 cost
		// contract — `view()` is ~1.2ms at 1,000 blocks), while any write
		// between them forces re-collection. This is what makes command-
		// layer reads transaction-aware (read-your-writes): an op that
		// mutates then reads mid-transaction always sees its own write.
		//
		// Contract caveat: the guarantee covers writes routed through this
		// facade (any op, or `transact(fn)` containing facade ops). RAW
		// engine writes through the `model`/`text`/`doc` escape hatches
		// bypass `write` — inside a transaction they can leave the memoized
		// view stale until the commit's `update` invalidates it. The
		// application layer never does this; keep it that way.
		let stateVersion = 0;
		const invalidate = (): void => {
			stateVersion++;
		};
		doc.on('update', invalidate);

		/**
		 * Terminal flag — set by `dispose()`. Mutating ops funnel through
		 * `write`, so gating there covers every facade write + `transact` +
		 * `init` + `createUndoManager`; reads stay dead-safe on purpose
		 * (a stale handle remains inspectable while its doc outlives the
		 * facade — e.g. the document teardown order). D14.
		 */
		let disposed = false;

		// R3 — doc-level undo-resurrection ownership repair (extracted to
		// `undo-repair.ts`). Attached once per doc for the doc's lifetime —
		// raw `Y.UndoManager` consumers get the same repair as
		// `createUndoManager()`, extra facades cannot double-write, and an
		// undo after the last `dispose()` is still repaired (Gate-H).
		attachUndoRepair(doc);
		// Lineage ring watermark repair — concurrent partition appends can
		// merge a ring past every writer's `depth`; this converges the
		// stored ring back to the entries' own watermark after remote
		// applies. Once per doc, doc-lifetime, no-op when nothing is over.
		BA.attachRingTrim(doc);

		/**
		 * Mutation boundary — every facade write funnels through `write`.
		 * The entry invalidate drops the memoized view so reads issued
		 * mid-transaction recompute; the exit invalidate guarantees the
		 * next post-write read recomputes too. Composed ops wrap their
		 * inner engine writes individually so a read between two inner
		 * writes stays fresh.
		 */
		const write = <R>(fn: () => R): R => {
			if (disposed) {
				throw new EdytorDocDisposedError();
			}
			config.assertWritable?.();
			invalidate();
			try {
				return fn();
			} finally {
				invalidate();
			}
		};

		// ── U1 block attribution (attribution/block.ts) ─────────────────
		//
		// Every stamped op below writes its `b/`/`l` metadata INSIDE the
		// operation's own `doc.transact` — content and metadata commit in
		// ONE update; there is no observer-driven follow-up transaction.
		// With no configured `actor` the facade performs no attribution
		// writes at all (bare facades stay byte-identical).
		//
		// Suppression is op-level: the helpers are invoked only after the
		// underlying model write provably ran (op boolean + explicit
		// no-op guards — `deleteText` range clamp, empty-string insert,
		// same-value type/data), and `BA.stamp*` itself suppresses the
		// `l` restamp / contributor re-add. Pure moves and `del` writes
		// are never stamped (parents are not marked for child-order
		// changes; deletes persist records by not touching them).

		const actorOf = (): AttributionActor | undefined => config.actor?.();

		/** The actor changed `id`'s state → contributors.add + lastChangedBy. */
		const stampTouched = (id: BlockId, pending?: PendingLineage): void => {
			const actor = actorOf();
			if (actor === undefined) return;
			const node = M.blockNodeOf(doc, id);
			if (node !== null) BA.stampChange(doc, node, id, actor.id);
			commitLineage(id, pending);
		};

		/** A materialized spec tree → created stamps at every level. */
		const stampCreatedSpec = (spec: BlockSpec): void => {
			const actor = actorOf();
			if (actor === undefined) return;
			stampSpecTree(doc, spec, actor.id);
		};

		/**
		 * Merge survivor stamping: the merger touches `intoId` and the
		 * absorbed block's contributor set unions into it (`createdBy`
		 * stays with the survivor's original creation).
		 */
		const stampMerged = (intoId: BlockId, fromId: BlockId, pending?: PendingLineage): void => {
			const actor = actorOf();
			if (actor === undefined) return;
			const node = M.blockNodeOf(doc, intoId);
			if (node !== null) BA.stampChange(doc, node, intoId, actor.id);
			BA.unionContributors(doc, intoId, fromId);
			commitLineage(intoId, pending);
		};

		// ── opt-in bounded lineage ring (config.lineageDepth) ────────────
		//
		// `lineagePending(id)` runs BEFORE an op's model write: when the
		// write would displace the current `l` winner it captures the
		// block's subtree JSON (pre-state) plus the displaced owner. The
		// post-write stamp then commits the entry to the record's ring
		// (`commitLineage`), so refused writes and same-actor edits
		// (`l === actor`) leave no trace — the ring stores transitions,
		// not keystrokes. Deletes capture too: the entry lands on the
		// orphaned record, which stays readable via `history()`.

		const lineageDepth = (() => {
			const d = config.lineageDepth ?? 0;
			// NaN/Infinity/fractional values would silently disable the
			// ring's trim bound (`len > depth` never fires) — refuse them
			// at the boundary rather than grow unbounded rings.
			if (!Number.isInteger(d) || d < 0) {
				throw new RangeError(
					`EdytorDoc lineage.depth must be a non-negative integer, got ${JSON.stringify(d)}`
				);
			}
			return d;
		})();

		/** A pre-write capture awaiting its op's post-write commit. */
		type PendingLineage = { a?: string; by: string; t: number; j: JSONBlock };

		/** `id`'s subtree as a `JSONBlock` — the same shape `toJSON` emits. */
		const subtreeJSON = (id: BlockId): JSONBlock | undefined => {
			const emit = (bid: BlockId): JSONBlock | undefined => {
				const node = M.blockNodeOf(doc, bid);
				if (node === null) return undefined;
				const block: JSONBlock = {
					type: String(node.getAttr(TYPE) ?? ''),
					id: bid,
					data: (node.getAttr(DATA) ?? {}) as JSONBlock['data']
				};
				const content = runsView.contentJSON(bid) as JSONBlock['content'];
				if (content !== undefined && content.length > 0) block.content = cloneJson(content);
				const childBlocks: JSONBlock[] = [];
				for (const kid of childrenIds(bid)) {
					const j = emit(kid);
					if (j !== undefined) childBlocks.push(j);
				}
				if (childBlocks.length > 0) block.children = childBlocks;
				return block;
			};
			return emit(id);
		};

		/**
		 * Capture `id`'s displaced state when the current actor is NOT the
		 * `l` winner — the entry describes "what this edit overwrote".
		 * Returns `undefined` (no capture) when the feature is off, no actor
		 * is configured, the block is unattributed-by-me already
		 * (`l === actor`), or the block doesn't exist.
		 */
		const lineagePending = (
			id: BlockId,
			opts?: { force?: boolean }
		): PendingLineage | undefined => {
			if (lineageDepth <= 0) return undefined;
			const actor = actorOf();
			if (actor === undefined) return undefined;
			const node = M.blockNodeOf(doc, id);
			if (node === null) return undefined;
			const l = node.getAttr(LAST_CHANGED_ATTR);
			// `force` is for destructive paths (delete, undo/redo) where the
			// state is lost regardless of who owns `l` — same-actor
			// suppression would silently drop the only recovery copy.
			if (opts?.force !== true && l === actor.id) return undefined;
			const j = subtreeJSON(id);
			if (j === undefined) return undefined;
			return { ...(typeof l === 'string' ? { a: l } : {}), by: actor.id, t: Date.now(), j };
		};

		/** Commit a pending capture — same transaction as the op's stamp. */
		const commitLineage = (id: BlockId, pending: PendingLineage | undefined): void => {
			if (pending !== undefined) BA.appendLineage(doc, id, pending, lineageDepth);
		};

		// WU7: `view()` is the shared per-document model state — when a
		// facade is attached, `M.view()` returns the maintained indexes
		// (synced mid-transaction for read-your-writes) instead of
		// collectBlocks+computeOwnership+resolvePlacements per call.
		const collectView = () => M.view(doc);
		type View = ReturnType<typeof collectView>;

		let viewToken = -1;
		let cachedView: View | null = null;

		/**
		 * One consistent replicated-state view (blocks + ownership +
		 * placements), memoized on `stateVersion`. The returned object is
		 * SHARED — callers must not mutate it.
		 */
		const view = (): View => {
			if (viewToken !== stateVersion) {
				cachedView = collectView();
				viewToken = stateVersion;
			}
			return cachedView!;
		};

		// ── reads ────────────────────────────────────────────────────────

		const blockTypeOf = (id: BlockId): string | undefined => {
			const t = M.blockNodeOf(doc, id)?.getAttr(SCHEMA.blockAttrs.type);
			return typeof t === 'string' ? t : undefined;
		};

		const blockDataOf = (id: BlockId): Record<string, unknown> | undefined => {
			const d = M.blockNodeOf(doc, id)?.getAttr(SCHEMA.blockAttrs.data);
			// `cloneJsonSafe`: the read path stays total even when the stored
			// attr holds a non-JSON value that bypassed boundary validation
			// (raw write / remote payload) — never crash a read (R4).
			return d !== undefined && d !== null ? (cloneJsonSafe(d) as JsonObj) : undefined;
		};

		/**
		 * Ordered visible children of `parent` inside an already-collected
		 * view. Navigation helpers walk many levels; each public entry point
		 * collects ONE view and threads it through (U11: `view()` is ~1.2ms
		 * at 1,000 blocks — per-level collection made doc-order walks
		 * O(depth × n)).
		 */
		const childrenIdsIn = (v: View, parent: BlockId | null): BlockId[] =>
			(v.kids.get(parent) ?? []).map((k) => k.id);

		/** Ordered visible children of `parent` (`null` = root) — canonical read. */
		const childrenIds = (parent: BlockId | null): BlockId[] => childrenIdsIn(view(), parent);

		const positionOf = (id: BlockId): Destination | null => M.positionOf(doc, id);

		/** Index path from the root (`[i, j, …]`), or null when hidden/absent. */
		const pathOf = (id: BlockId): number[] | null => {
			const v = view();
			const path: number[] = [];
			let cur: BlockId | null = id;
			while (cur !== null) {
				const pos = M.positionInView(v.blocks, v.placements, v.own, cur);
				if (!pos) return null;
				path.unshift(pos.index);
				cur = pos.parent;
			}
			return path;
		};

		/** Display ancestors of `id`, nearest first (`null` parent = root → stop). */
		const ancestorsOf = (id: BlockId, v: View = view()): BlockId[] => {
			const out: BlockId[] = [];
			let cur: Destination | null = M.positionInView(v.blocks, v.placements, v.own, id);
			while (cur !== null && cur.parent !== null) {
				out.push(cur.parent);
				cur = M.positionInView(v.blocks, v.placements, v.own, cur.parent);
			}
			return out;
		};

		// ── roles (island/void) ───────────────────────────────────────────

		const roleOfId = (id: BlockId): BlockRole => {
			const t = blockTypeOf(id);
			return t !== undefined ? (roleOf(t) ?? {}) : {};
		};
		const isVoid = (id: BlockId): boolean => roleOfId(id).void === true;
		const isIsland = (id: BlockId): boolean => roleOfId(id).island === true;
		/** Nearest island-typed display ancestor of `id`, or null. */
		const islandOf = (id: BlockId, v: View = view()): BlockId | null =>
			ancestorsOf(id, v).find((a) => isIsland(a)) ?? null;
		/** True iff `id` sits strictly inside an island subtree. */
		const insideIsland = (id: BlockId, v?: View): boolean => islandOf(id, v) !== null;

		/**
		 * Can `parent` accept children as a MOVE/NEST destination? Baseline
		 * `moveBlock` rejects void / island / insideIsland targets — the
		 * island subtree is sealed from outside structure. (`insertBlock`
		 * is looser — baseline `addChildBlock` builds island interiors.)
		 */
		const canAcceptMove = (parent: BlockId | null): boolean => {
			if (parent === null) return true;
			const v = view();
			return !isVoid(parent) && !isIsland(parent) && !insideIsland(parent, v);
		};

		// ── navigation helpers (baseline closestPrevious/NextBlock) ───────

		const deepestLast = (id: BlockId, v: View): BlockId => {
			let cur = id;
			for (;;) {
				const kids = childrenIdsIn(v, cur);
				if (kids.length === 0) return cur;
				cur = kids[kids.length - 1];
			}
		};

		/**
		 * Previous block in flattened document order: the previous sibling's
		 * deepest last descendant, or the parent when `id` is a first child —
		 * mirrors baseline `closestPreviousBlock`.
		 */
		const previousInDocOrder = (id: BlockId): BlockId | null => {
			const v = view();
			const pos = M.positionInView(v.blocks, v.placements, v.own, id);
			if (!pos) return null;
			if (pos.index === 0) return pos.parent;
			const sibs = childrenIdsIn(v, pos.parent);
			return deepestLast(sibs[pos.index - 1], v);
		};

		/**
		 * Next block in document order: first child; else next sibling; else
		 * climb to the nearest ancestor's next sibling — mirrors baseline
		 * `closestNextBlock` (island/void blocks do not climb: their "next"
		 * stops at their own sibling list).
		 */
		const nextInDocOrder = (id: BlockId): BlockId | null => {
			const v = view();
			const kids = childrenIdsIn(v, id);
			if (kids.length > 0) return kids[0];
			let cur = id;
			for (;;) {
				const pos = M.positionInView(v.blocks, v.placements, v.own, cur);
				if (!pos) return null;
				const sibs = childrenIdsIn(v, pos.parent);
				const next = sibs[pos.index + 1];
				if (next !== undefined) return next;
				// Island/void blocks do not merge outward — stop at their
				// sibling list instead of climbing past the boundary.
				if (isIsland(cur) || isVoid(cur)) return null;
				if (pos.parent === null) return null;
				cur = pos.parent;
			}
		};

		// ── change events ─────────────────────────────────────────────────

		let changeVersion = 0;
		let listening = false;
		let prev: DocSnap | null = null;
		const subs = new Set<(change: DocChange) => void>();

		const takeSnap = (): DocSnap => {
			const { blocks, kids } = view();
			// `kids` is the view's maintained children index — ONE O(n)
			// bucketing pass, rebuilt only when placements move (WU7). See
			// the DocSnap comment: materializing projected nodes per commit
			// was the dominant change-event cost (U11 measurement).
			const nodes: DocSnap['nodes'] = new Map();
			const order: DocSnap['order'] = new Map();
			for (const [parent, ks] of kids) {
				// Frozen: the same array is retained as the NEXT commit's
				// diff baseline AND published on `DocChange.order` — a
				// subscriber mutating it must not corrupt the baseline (R4).
				order.set(parent, Object.freeze(ks.map((k) => k.id)));
				ks.forEach((k, index) => {
					const rec = blocks.get(k.id)!;
					nodes.set(k.id, {
						parent,
						index,
						type: rec.type,
						data: rec.data as Record<string, unknown> | undefined,
						contentRef: runsView.runs(k.id)
					});
				});
			}
			// Full projected subtrees come from the canonical materializer —
			// `M.project`'s emit is the single implementation of
			// `ProjectedBlock` (S14). Built lazily ONCE per snapshot and only
			// when `diffSnaps` meets an added root, then indexed by id so
			// each `added` lookup stays O(1). This snapshot's own skeleton
			// walk above already covers the visible tree; the second O(doc)
			// pass lands only on commits that actually add blocks.
			let projectedById: Map<BlockId, ProjectedBlock> | null = null;
			const nodeFor = (id: BlockId): ProjectedBlock => {
				if (projectedById === null) {
					projectedById = new Map();
					const indexInto = (bs: ProjectedBlock[]): void => {
						for (const b of bs) {
							projectedById!.set(b.id, b);
							indexInto(b.children);
						}
					};
					indexInto(M.project(doc).children);
				}
				// `id` came from this snapshot's `nodes` — every entry is
				// visible, so it must be present in the same view's
				// projection (same committed state, read synchronously).
				return projectedById.get(id)!;
			};
			return { nodes, order, nodeFor };
		};

		/** All ids inside a projected subtree (including the root). */
		const subtreeIds = (b: ProjectedBlock, out: Set<BlockId>): void => {
			out.add(b.id);
			for (const c of b.children) subtreeIds(c, out);
		};

		const diffSnaps = (
			before: DocSnap,
			after: DocSnap,
			origin: unknown,
			local: boolean
		): DocChange | null => {
			const added = new Map<BlockId, ProjectedBlock>();
			const removed = new Set<BlockId>();
			const moved = new Set<BlockId>();
			const meta = new Map<BlockId, { type: string; data?: JsonObj }>();
			const content = new Map<BlockId, readonly ContentRun[]>();
			const order = new Map<BlockId | null, readonly BlockId[]>();
			// Pass 1: added subtree ROOTS — descendants are carried inside the
			// root's spec, so they must not also appear as their own added /
			// moved / meta / content entries.
			const covered = new Set<BlockId>();
			for (const id of after.nodes.keys()) {
				if (!before.nodes.has(id)) {
					// Full projected subtree materialized ONLY for added roots.
					const node = after.nodeFor!(id);
					added.set(id, node);
					subtreeIds(node, covered);
				}
			}
			// Pass 2: per-node diffs for pre-existing blocks.
			for (const [id, n] of after.nodes) {
				if (covered.has(id)) continue;
				const o = before.nodes.get(id)!;
				if (o.parent !== n.parent || o.index !== n.index) moved.add(id);
				if (o.type !== n.type || dataKeyOf(o.data) !== dataKeyOf(n.data)) {
					// `n.data` is a live replicated ref — clone at the
					// DocChange boundary so subscribers can't reach engine
					// state (takeSnap deliberately does not clone per block).
					meta.set(id, {
						type: n.type,
						data:
							n.data === undefined || n.data === null
								? undefined
								: (cloneJsonSafe(n.data) as JsonObj)
					});
				}
				// O(1) "maybe changed": the runs view hands back the SAME
				// frozen array while content is unchanged (structural
				// sharing). A ref mismatch can still be a recomputed-but-
				// equal array (`runEquals` compares marks/data by ref), so
				// confirm with the JSON key before reporting a diff.
				if (o.contentRef !== n.contentRef) {
					const ko = (o.contentKey ??= contentKeyOf(o.contentRef));
					const kn = (n.contentKey ??= contentKeyOf(n.contentRef));
					if (ko !== kn) content.set(id, n.contentRef);
				}
			}
			// Pass 3: removed subtree ROOTS — an id whose strict ancestor (in
			// the BEFORE tree) is also absent in `after` is covered by that
			// ancestor's removal; the mirror detaches the whole subtree.
			for (const [id, o] of before.nodes) {
				if (after.nodes.has(id)) continue;
				let coveredByRemoved = false;
				let p = o.parent;
				while (p !== null) {
					if (!after.nodes.has(p)) {
						coveredByRemoved = true;
						break;
					}
					p = before.nodes.get(p)?.parent ?? null;
				}
				if (!coveredByRemoved) removed.add(id);
			}
			// Pass 4: child-order changes. A parent's new list is authoritative.
			for (const [parent, ids] of after.order) {
				const prevIds = before.order.get(parent);
				if (!prevIds || prevIds.join('\u0000') !== ids.join('\u0000')) order.set(parent, ids);
			}
			// A parent whose entire child list vanished still needs an entry —
			// its old order is stale otherwise.
			for (const [parent] of before.order) {
				if (!after.order.has(parent)) order.set(parent, EMPTY_IDS);
			}
			if (
				added.size === 0 &&
				removed.size === 0 &&
				moved.size === 0 &&
				meta.size === 0 &&
				content.size === 0 &&
				order.size === 0
			) {
				return null;
			}
			return {
				origin,
				local,
				version: ++changeVersion,
				added,
				removed,
				moved,
				meta,
				content,
				order
			};
		};

		/**
		 * Last registry commit this facade's snapshot reflects — the shared
		 * state's per-commit sequence (its run-view version). An `update`
		 * that didn't touch the registry leaves `seq` unchanged → nothing
		 * to diff (meta-root writes, no-ops). WU7.
		 */
		let lastSeenSeq = 0;

		/**
		 * DocChange FAST PATH (WU7): the commit touched only `content`/
		 * `meta` facets — no placements, ownership structure or registry
		 * churn — so the previous skeleton is patched for exactly the
		 * touched ids instead of re-walking the document. Eligibility and
		 * the touched sets come from the shared state's `commitInfo`.
		 * Defensive fallback: any touched id missing from the previous
		 * skeleton (invisible before, visible now) escalates to a full
		 * snapshot+diff — correctness over speed.
		 */
		const diffFast = (
			content: ReadonlySet<BlockId>,
			meta: ReadonlySet<BlockId>,
			origin: unknown,
			local: boolean
		): DocChange | null => {
			const before = prev!;
			const v = view();
			// Pass 1 — validate WITHOUT mutating: every touched id must be
			// tracked in the skeleton or provably invisible (deleted/hidden/
			// unreachable). An id that is visible but untracked can't be
			// patched → escalate to a full diff BEFORE any `prev` writes —
			// a half-patched skeleton would swallow the already-applied diffs.
			const mustEscalate = (id: BlockId): boolean => {
				if (before.nodes.has(id)) return false;
				const rec = v.blocks.get(id);
				if (!rec || rec.deleted || v.own.hidden(id)) return false;
				return v.placements.has(id); // visible-but-untracked — suspicious
			};
			for (const id of content) if (mustEscalate(id)) return fullDiff(origin, local);
			for (const id of meta) if (mustEscalate(id)) return fullDiff(origin, local);
			// Pass 2 — diff + patch the skeleton for the tracked ids.
			const contentDiff = new Map<BlockId, readonly ContentRun[]>();
			const metaDiff = new Map<BlockId, { type: string; data?: JsonObj }>();
			for (const id of content) {
				const n = before.nodes.get(id);
				if (!n) continue; // invisible — nothing to patch
				const nr = runsView.runs(id);
				if (n.contentRef !== nr) {
					const ko = (n.contentKey ??= contentKeyOf(n.contentRef));
					const kn = contentKeyOf(nr);
					if (ko !== kn) {
						contentDiff.set(id, nr);
						n.contentRef = nr;
						n.contentKey = kn;
					} else {
						n.contentRef = nr; // recomputed-but-equal — adopt the ref
					}
				}
			}
			for (const id of meta) {
				const n = before.nodes.get(id);
				if (!n) continue;
				const rec = v.blocks.get(id);
				const nt = rec?.type ?? 'unknown';
				const nd = rec?.data;
				if (n.type !== nt || dataKeyOf(n.data) !== dataKeyOf(nd)) {
					metaDiff.set(id, {
						type: nt,
						data: nd === undefined || nd === null ? undefined : (cloneJsonSafe(nd) as JsonObj)
					});
					n.type = nt;
					n.data = nd as Record<string, unknown> | undefined;
				}
			}
			if (contentDiff.size === 0 && metaDiff.size === 0) return null;
			return {
				origin,
				local,
				version: ++changeVersion,
				added: new Map(),
				removed: new Set(),
				moved: new Set(),
				meta: metaDiff,
				content: contentDiff,
				order: new Map()
			};
		};

		/** Structural-commit path — full skeleton snapshot + diff. */
		const fullDiff = (origin: unknown, local: boolean): DocChange | null => {
			const after = takeSnap();
			const change = diffSnaps(
				prev ?? { nodes: new Map(), order: new Map(), nodeFor: undefined },
				after,
				origin,
				local
			);
			prev = after;
			return change;
		};

		const updateHandler = (_update: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown) => {
			const info = runsView.commitInfo();
			const local = (tr as { local?: boolean } | null)?.local === true;
			if (info.seq === lastSeenSeq) return; // update didn't touch the registry
			lastSeenSeq = info.seq;
			const change =
				prev !== null && info.fast
					? diffFast(info.content, info.meta, origin, local)
					: fullDiff(origin, local);
			if (change) {
				// R5 listener isolation (callAll convention): a throwing
				// subscriber must not starve later subscribers — and must not
				// escape mid-cleanup, where it would skip the transaction
				// queue's remaining cleanups (update fires inside the
				// engine's cleanup `finally`). Invoke all, then rethrow the
				// first error to the committer.
				let firstErr: unknown;
				let threw = false;
				for (const cb of subs) {
					try {
						cb(change);
					} catch (e) {
						if (!threw) {
							threw = true;
							firstErr = e;
						}
					}
				}
				if (threw) throw firstErr;
			}
		};

		/**
		 * Subscribe to semantic changes — one {@link DocChange} per committed
		 * transaction, local and remote. Attaches the underlying doc listener
		 * lazily on first subscribe; no writes, ever (observer paths are
		 * read-only). Returns an unsubscribe.
		 */
		const onChange = (cb: (change: DocChange) => void): (() => void) => {
			subs.add(cb);
			if (!listening) {
				prev = takeSnap();
				lastSeenSeq = runsView.commitInfo().seq;
				doc.on('update', updateHandler);
				listening = true;
			}
			return () => {
				subs.delete(cb);
				// D9 — the listener and its diff baseline are demand-driven:
				// with no subscribers left, detach the `update` handler and
				// drop `prev`/`lastSeenSeq` so commits perform no diff work.
				// The next subscription re-baselines lazily.
				if (subs.size === 0 && listening) {
					doc.off('update', updateHandler);
					prev = null;
					lastSeenSeq = 0;
					listening = false;
				}
			};
		};

		const dispose = (): void => {
			disposed = true;
			doc.off('update', invalidate);
			if (listening) doc.off('update', updateHandler);
			listening = false;
			prev = null;
			subs.clear();
			// The doc-shared undo-repair observer intentionally survives
			// `dispose` — it is attached once per doc for the doc's lifetime
			// (undo-after-last-dispose must still be repaired — Gate-H), and
			// is freed with the doc via {@link undoRepairAttached}.
			// Releases this facade's lease on the doc-shared RunView — the
			// view itself is torn down only when the LAST facade releases it
			// (or the doc is destroyed). See text/runs.ts `attach`.
			runsView.dispose();
		};

		/**
		 * The supported undo seam (gate-2 finding 10 — the U08 rule):
		 * a UndoManager SCOPED TO THE BLOCK REGISTRY, attached only after the
		 * doc carries the schema version record.
		 *
		 * Why this shape:
		 *
		 * - Scope `blocks` — the `meta` root (version stamp, schema name) is
		 *   outside it, so `init`'s version write and any schema-version
		 *   transition are undo-inert: undo can never strip `meta.v` or
		 *   resurrect a stale schema version.
		 * - Attach-after-init — the deterministic bootstrap insert IS inside
		 *   the registry; if the manager attached before `init`, a user undo
		 *   could remove it and leave a "versioned but empty" doc that
		 *   nothing re-bootstraps. This factory runs `init` first (a no-op
		 *   on already-initialized docs), so the bootstrap always predates
		 *   capture.
		 * - Remote/provider writes never enter the stack: applied updates
		 *   carry a non-null foreign origin and non-local transactions, so
		 *   the default `trackedOrigins`/`transaction.local` filter drops
		 *   them.
		 *
		 * `opts` are the engine's UndoManager options (captureTimeout,
		 * trackedOrigins, …) passed through verbatim — callers can add
		 * origins but should not widen the scope beyond the registry.
		 */
		const createUndoManager = (
			opts: ConstructorParameters<EngineApi['UndoManager']>[1] = {}
		): YUndoManager => {
			if (disposed) {
				throw new EdytorDocDisposedError('createUndoManager');
			}
			write(() => {
				if (!isInitialized(doc)) init(doc);
			});
			const um = new Y.UndoManager(M.registryOf(doc) as unknown as YNode, opts) as YUndoManager;
			// Lineage: undo/redo replays displace the state every touched
			// block currently shows — capture each block's subtree BEFORE
			// the replay runs (`force`: the state is lost regardless of
			// who owns `l`, and undo is precisely what the ring exists to
			// recover from). The captures commit under the default origin
			// BEFORE popStackItem's transaction — outside undo scope like
			// every other `b/` write, and never re-captured by the replay.
			if (lineageDepth > 0) {
				const captureTouched = (stack: { inserts?: unknown; deletes?: unknown }[]): void => {
					const item = stack[stack.length - 1];
					if (item === undefined || actorOf() === undefined) return;
					const touched = new Set<BlockId>();
					const collect = (idSet: unknown): void => {
						if (idSet === null || typeof idSet !== 'object' || !('clients' in idSet)) return;
						walkIdSetStructs(Y, doc, idSet as IdSetLike, (s) => {
							let n = s.parent as EngineNode | null;
							while (n !== null && typeof n === 'object' && typeof n.getAttr === 'function') {
								if (n.name === BLOCK_NODE) {
									const bid = n.getAttr(ID);
									if (typeof bid === 'string') touched.add(bid);
									break;
								}
								n = (n._item?.parent ?? null) as EngineNode | null;
							}
						});
					};
					collect(item.inserts);
					collect(item.deletes);
					if (touched.size === 0) return;
					doc.transact(() => {
						for (const bid of touched) {
							commitLineage(bid, lineagePending(bid, { force: true }));
						}
					});
				};
				const undoInner = um.undo.bind(um);
				const redoInner = um.redo.bind(um);
				um.undo = () => {
					captureTouched(um.undoStack);
					return undoInner();
				};
				um.redo = () => {
					captureTouched(um.redoStack);
					return redoInner();
				};
			}
			return um;
		};

		// ── structural ops ────────────────────────────────────────────────

		/**
		 * Insert a block (spec may carry children/content/data — ids are
		 * caller-assigned and must be fresh; the whole spec validates
		 * atomically). Rejected without mutation or update when the parent
		 * is unresolvable or `void` (voids cannot accept children). Inserting
		 * INSIDE an island is allowed — island interiors are built this way.
		 */
		const insertBlock = (dest: Destination, spec: BlockSpec): boolean =>
			write(() =>
				doc.transact(() => {
					if (dest.parent !== null && isVoid(dest.parent)) return false;
					const ok = M.insertBlock(doc, dest, spec);
					// U1: fresh ids are authored here — createdBy/contributors/
					// lastChangedBy on every spec-tree block, same commit.
					if (ok) stampCreatedSpec(spec);
					return ok;
				})
			);

		/** Relocate `id` — identity preserved; island/void rules enforced. */
		const moveBlock = (id: BlockId, dest: Destination): boolean =>
			write(() => {
				if (insideIsland(id)) return false; // island subtrees are sealed
				if (!canAcceptMove(dest.parent)) return false;
				return M.moveBlock(doc, id, dest);
			});

		/**
		 * Grouped move — ONE transaction (one undo step), per-member conflict
		 * resolution, all-or-nothing locally. Same island/void rules as
		 * `moveBlock`, evaluated for every member before any write.
		 */
		const moveBlocks = (ids: BlockId[], dest: Destination): boolean =>
			write(() => {
				for (const id of ids) {
					if (insideIsland(id)) return false;
				}
				if (!canAcceptMove(dest.parent)) return false;
				return M.moveBlocks(doc, ids, dest);
			});

		/** Move `id` to the last position under `newParentId`. */
		const nestBlock = (id: BlockId, newParentId: BlockId): boolean =>
			write(() => {
				if (insideIsland(id)) return false;
				if (!canAcceptMove(newParentId)) return false;
				return M.nestBlock(doc, id, newParentId);
			});

		/**
		 * Move `id` beside its parent (index = parent index + 1). Refused for
		 * blocks inside an island — unnesting across the boundary would
		 * escape the sealed subtree (baseline checked neither move nor
		 * unnest for this; the facade closes the hole).
		 */
		const unNestBlock = (id: BlockId): boolean =>
			write(() => {
				if (insideIsland(id)) return false;
				const pos = M.positionOf(doc, id);
				if (!pos || pos.parent === null) return false;
				const ppos = M.positionOf(doc, pos.parent);
				if (!ppos) return false;
				if (!canAcceptMove(ppos.parent)) return false;
				return M.unNestBlock(doc, id);
			});

		/**
		 * Split `id` at content `offset` — the tail's slice records move to a
		 * new sibling `newId` (no atom copies), children follow the sibling.
		 * Refused on `void` blocks (no structural flow through voids).
		 */
		const splitBlock = (id: BlockId, offset: number, newId: BlockId): boolean =>
			write(() =>
				doc.transact(() => {
					if (isVoid(id)) return false;
					const lin = lineagePending(id);
					const ok = M.splitBlock(doc, id, offset, newId);
					if (ok) {
						// U1: the tail is authored by the splitter and INHERITS
						// the source's contributor set — read BEFORE the
						// splitter's own stamp lands on the source, so the
						// inherited set is exactly the pre-split contributors
						// (the splitter's authorship is carried by
						// createdBy/lastChangedBy, not a contributor add).
						const actor = actorOf();
						const nid = sanitizeWireString(newId);
						const node = M.blockNodeOf(doc, nid);
						if (actor !== undefined && node !== null) {
							BA.stampCreated(doc, node, nid, actor.id, id);
						}
						// The split changed the source's state (its tail
						// slices moved out) → the splitter touches it.
						stampTouched(id, lin);
					}
					return ok;
				})
			);

		/**
		 * Engine merge primitive: `from`'s content is claimed by `into`, its
		 * children ADOPTED into `into`'s child list, and `from` is hidden via
		 * the claim (undo restores it). Role rules: `void` blocks cannot
		 * merge either direction; a merge may not cross an island boundary
		 * (except a child merging into its own island — that stays inside).
		 */
		const mergeBlocks = (fromId: BlockId, intoId: BlockId): boolean =>
			write(() =>
				doc.transact(() => {
					if (fromId === intoId) return false;
					if (isVoid(fromId) || isVoid(intoId)) return false;
					const islandFrom = islandOf(fromId);
					const islandInto = islandOf(intoId);
					if (islandFrom !== islandInto && intoId !== islandFrom) return false;
					const lin = lineagePending(intoId);
					// `from` is destroyed by the merge like a delete — force-
					// capture its final state onto its own (soon-orphaned) ring.
					const fromLin = lineagePending(fromId, { force: true });
					const ok = M.mergeBlocks(doc, fromId, intoId);
					// U1: survivor keeps its createdBy, unions the absorbed
					// block's contributors, and records the merger.
					if (ok) {
						commitLineage(fromId, fromLin);
						stampMerged(intoId, fromId, lin);
					}
					return ok;
				})
			);

		/**
		 * Baseline-shaped merge (both `mergeBlockBackward` and
		 * `mergeBlockForward` share this form): `from`'s children are unnested
		 * to `from`'s vacated sibling slot — NOT adopted into `into` — and,
		 * when `from` is an island, reset to the default type; then `from`'s
		 * content claims into `into`. One transaction.
		 */
		const mergeUnnesting = (fromId: BlockId, intoId: BlockId): boolean =>
			write(() => {
				if (fromId === intoId) return false;
				if (isVoid(fromId) || isVoid(intoId)) return false;
				const islandFrom = islandOf(fromId);
				if (islandFrom !== islandOf(intoId) && intoId !== islandFrom) return false;
				const pos = M.positionOf(doc, fromId);
				if (!pos) return false;
				return doc.transact(() => {
					const kids = childrenIds(fromId);
					const reset = isIsland(fromId);
					const resetKids: BlockId[] = [];
					const kidPend = new Map<BlockId, PendingLineage | undefined>();
					for (let i = 0; i < kids.length; i++) {
						write(() => M.moveBlock(doc, kids[i], { parent: pos.parent, index: pos.index + i }));
						if (reset)
							write(() => {
								const kn = M.blockNodeOf(doc, kids[i]);
								if (kn !== null) {
									const nt = sanitizeWireString(defaultType);
									// U1: the reset is a real type change → the
									// merger touched that child. A same-value reset
									// is a semantic no-op — not stamped.
									if (kn.getAttr(SCHEMA.blockAttrs.type) !== nt) {
										resetKids.push(kids[i]);
										kidPend.set(kids[i], lineagePending(kids[i]));
									}
									kn.setAttr(SCHEMA.blockAttrs.type, nt);
								}
							});
					}
					const lin = lineagePending(intoId);
					const fromLin = lineagePending(fromId, { force: true });
					const ok = write(() => M.mergeBlocks(doc, fromId, intoId));
					if (ok) {
						commitLineage(fromId, fromLin);
						stampMerged(intoId, fromId, lin);
						for (const kid of resetKids) stampTouched(kid, kidPend.get(kid));
					}
					return ok;
				});
			});

		/**
		 * Baseline `mergeBlockBackward`: merge `id` into the previous block
		 * in document order (deepest last descendant of the previous sibling,
		 * or the parent for a first child). No previous block → merges
		 * forward when empty, else refuses — the baseline fallback.
		 */
		const mergeBackward = (id: BlockId): BlockId | null =>
			write(() => {
				if (isVoid(id)) return null;
				const prev = previousInDocOrder(id);
				if (prev === null) {
					// Baseline: no previous block → empty blocks merge forward.
					const kids = childrenIds(id);
					const len = displayLength(id);
					if (kids.length === 0 && len === 0) return mergeForward(id);
					return null;
				}
				return mergeUnnesting(id, prev) ? prev : null;
			});

		/**
		 * Baseline `mergeBlockForward`: pull the next block in document order
		 * into `id` (its children unnest to its vacated slot).
		 */
		const mergeForward = (id: BlockId): BlockId | null =>
			write(() => {
				if (isVoid(id)) return null;
				const next = nextInDocOrder(id);
				if (next === null) return null;
				return mergeUnnesting(next, id) ? id : null;
			});

		/**
		 * Delete `id` (explicit `del` flag — wins over concurrent moves).
		 * `keepChildren` reparents the children to `id`'s vacated slot with
		 * their identity PRESERVED — an intentional improvement over the
		 * baseline, which cloned children into fresh `Block`s.
		 */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): boolean =>
			write(() => {
				// Deletes stamp no attribution (the record persists by not
				// touching it) but DO capture lineage — `force` because the
				// subtree is destroyed regardless of who owns `l`. The entry
				// lands on the orphaned `b/<id>` record, which stays readable
				// via `attribution.history` — "restore what X deleted".
				const lin = lineagePending(id, { force: true });
				if (!opts.keepChildren) {
					const ok = write(() => M.deleteBlock(doc, id));
					if (ok) commitLineage(id, lin);
					return ok;
				}
				const pos = M.positionOf(doc, id);
				if (!pos) return false;
				const kids = childrenIds(id);
				return doc.transact(() => {
					for (let i = 0; i < kids.length; i++) {
						write(() => M.moveBlock(doc, kids[i], { parent: pos.parent, index: pos.index + i }));
					}
					const ok = write(() => M.deleteBlock(doc, id));
					if (ok) commitLineage(id, lin);
					return ok;
				});
			});

		// ── metadata / replacement ops ────────────────────────────────────

		/** Set the block type (attr write — the block keeps its identity). */
		const setBlockType = (id: BlockId, type: string): boolean =>
			write(() =>
				doc.transact(() => {
					const node = M.liveNodeOf(doc, id);
					if (!node) return false;
					// Boundary normalization (F2-M1) — lone surrogates become
					// U+FFFD, matching what the wire encode would deliver.
					const clean = sanitizeWireString(type);
					// U1 semantic no-op: writing the same value is suppressed
					// entirely — no item churn, no update, no attribution.
					if (node.getAttr(SCHEMA.blockAttrs.type) === clean) return true;
					const lin = lineagePending(id);
					node.setAttr(SCHEMA.blockAttrs.type, clean);
					stampTouched(id, lin);
					return true;
				})
			);

		/** Replace the block's `data` payload (whole-attr write). */
		const setBlockData = (id: BlockId, data: Record<string, unknown>): boolean =>
			write(() =>
				doc.transact(() => {
					const node = M.liveNodeOf(doc, id);
					if (!node) return false;
					const clean = sanitizeWireJson(data);
					if (jsonEquals(node.getAttr(SCHEMA.blockAttrs.data), clean)) return true;
					const lin = lineagePending(id);
					node.setAttr(SCHEMA.blockAttrs.data, clean);
					stampTouched(id, lin);
					return true;
				})
			);

		/**
		 * Display length in atoms (chars + inline atoms) of `id`'s content —
		 * computed from the LIVE view so mid-transaction callers (e.g.
		 * `setBlock` deleting prior content) read post-write state.
		 */
		const displayLength = (id: BlockId): number => {
			const { blocks, own } = view();
			let n = 0;
			for (const item of T.contentItemsOf(id, blocks, own) as ContentItem[]) {
				n += item.kind === 'text' ? item.text.length : 1;
			}
			return n;
		};

		/**
		 * U1 same-value suppression for mark writes: the engine's
		 * `formatText` already skips items whose folded mark state equals
		 * the target (`insertFormats`/`minimizeFormatChanges` in the
		 * vendored ynode), so a range whose atoms ALL already satisfy
		 * `marks` writes zero content items — stamping anyway would emit
		 * an attribution-only commit on a semantic no-op. Folded mark
		 * state is read per piece through the live range cursor, so
		 * inline atoms inside the range are covered too (their `formats`
		 * reflect the cursor's folded state even though runs don't
		 * surface marks on inlines).
		 *
		 * Returns `true` when the write would be a semantic no-op. Must
		 * be evaluated BEFORE the model write — post-write every range
		 * trivially satisfies the check. (S13: this re-walks the folded
		 * marks the engine's `minimizeFormatChanges` resolves again —
		 * a `wroteItems` verdict on the format ops would retire this
		 * scan.)
		 */
		const marksAlready = (
			id: BlockId,
			offset: number,
			length: number,
			marks: Record<string, unknown>
		): boolean => {
			// Same sanitize as `formatRangeIn` so the comparison runs on the
			// exact payload the engine would write.
			const entries = Object.entries(sanitizeWireJson(marks) as Record<string, unknown>);
			const { blocks, own } = view();
			const segs = T.flatten(id, blocks, own);
			const total = T.ownedLength(segs);
			const at = Math.max(0, Math.min(offset, total));
			const end = Math.min(total, at + Math.max(0, length));
			if (entries.length === 0 || end <= at) return true;
			let base = 0;
			const cursors = new Map<string, RangeCursor>();
			for (const seg of segs) {
				const len = seg.i1 - seg.i0;
				const lo = Math.max(at, base);
				const hi = Math.min(end, base + len);
				if (lo < hi) {
					const text = blocks.get(seg.t)?.content;
					if (text === undefined || text === null) return false;
					let cur = cursors.get(seg.t);
					if (cur === undefined) cursors.set(seg.t, (cur = T.openRangeCursor(text)));
					for (const piece of cur.read(seg.i0 + (lo - base), seg.i0 + (hi - base))) {
						if (piece.len === 0 || piece.deleted) continue;
						for (const [k, v] of entries) {
							// `?? null` mirrors the engine's `currentFormats.get(k) ?? null`.
							if (!jsonEquals(piece.formats?.[k] ?? null, v ?? null)) return false;
						}
					}
				}
				base += len;
				if (base >= end) break;
			}
			return true;
		};

		/**
		 * Resolved display content of `id` — the canonical `ContentItem[]`
		 * (text runs + inline atoms in display order) from the live view, so
		 * it reflects writes made earlier in the same transaction. `[]` for
		 * absent/deleted blocks. This is the transaction-aware counterpart
		 * of the commit-synced {@link runsView} read surface.
		 *
		 * R4: the range reader emits BORROWED `marks`/`data` (cursor format
		 * state / the replicated inline attr) — every item's payload is
		 * swapped for the view's canonical frozen instance before it crosses
		 * the public boundary, so callers can't mutate engine state through
		 * the snapshot. Item wrappers and the array stay fresh and mutable.
		 */
		const contentItems = (id: BlockId): ContentItem[] => {
			// The maintained view's canonical item read — interned payloads,
			// transaction-aware via the same `modelCtx` view() consults.
			return runsView.contentItems(id);
		};

		/** Registry membership — the block exists (may be `del`-flagged or merged away). */
		const hasBlock = (id: BlockId): boolean => M.blockNodeOf(doc, id) !== null;

		/**
		 * Projected-tree membership — `id` renders in `project()`'s tree (live,
		 * not merged away, every display ancestor visible). This is
		 * `positionInView` minus its sibling-index materialization: the
		 * `childrenOf` scan there can never fail once the ancestor walk passes
		 * (a visible block always lands in its display parent's child list), so
		 * the boolean oracle is O(depth) instead of O(#placements) per call.
		 * Hot paths that only need the null-vs-node verdict of
		 * `positionOf(id) !== null` (e.g. the text-segment refresh, which
		 * distinguishes hidden/deleted from empty-content `[]`) use this
		 * instead of materializing the position.
		 */
		const isVisibleBlock = (id: BlockId): boolean => {
			const { blocks, placements, own } = view();
			if (!isVisible(blocks, own, id)) return false;
			const pl = placements.get(id);
			if (pl === undefined) return false;
			const first = displayParentOf(own, pl);
			if (first === DEAD) return false;
			// Walk the display-ancestor chain: any dead or invisible ancestor
			// hides the whole subtree (mirrors `positionInView`).
			let cur: BlockId | null = first;
			const seen = new Set<BlockId>();
			while (cur !== null && !seen.has(cur)) {
				seen.add(cur);
				if (!isVisible(blocks, own, cur)) return false;
				const cp = placements.get(cur);
				if (cp === undefined) return false;
				const next = displayParentOf(own, cp);
				if (next === DEAD) return false;
				cur = next;
			}
			return true;
		};

		// ── caret anchors (U09) ──────────────────────────────────────────
		// Anchors bind selection endpoints to BACKING-text atoms — the
		// identity that survives split/merge/move. Both reads below compute
		// a FRESH ownership view (`view()`) so they are correct mid-transaction
		// (the maintained runs view only refreshes at commit). A handful of
		// calls per gesture; O(doc) per call.

		/**
		 * Display offset inside `B` where backing text `t`'s slice-list
		 * records would emit — the seam an unowned anchor falls back to.
		 * Walks `B`'s flattened entry order accumulating owned-atom
		 * contributions; the offset where the walk first reaches `t` (a
		 * merge-claim chain entering `t`'s list, or the first `t`-covering
		 * record when `B === t`) is the emission point — for a merge this
		 * is exactly the merge seam where restored content reappears.
		 */
		const emissionOffset = (
			blocks: Map<BlockId, TextBlockRec>,
			own: Ownership,
			B: BlockId,
			t: BlockId
		): number => {
			let off = 0;
			let found: number | null = null;
			const contribution = (entry: SliceEntry): number => {
				const p = entry.payload;
				if (!isSliceRecord(p)) return 0;
				const text = blocks.get(p.t)?.content;
				if (!text) return 0;
				const range = own.resolvedRange(entry, text);
				if (range === null) return 0;
				// Owned atoms this record emits under B = the widths of its
				// winning intervals inside its own resolved range (WU6 —
				// was a per-position count over the dense owner/claim rows).
				let n = 0;
				for (const iv of intervalsOver(own.intervals.get(p.t), range[0], range[1])) {
					if (iv.owner === B && iv.claim === entry) {
						n += Math.min(iv.i1, range[1]) - Math.max(iv.i0, range[0]);
					}
				}
				return n;
			};
			const walk = (listId: BlockId, seen: Set<BlockId>): void => {
				if (found !== null || seen.has(listId)) return;
				seen.add(listId);
				if (listId === t && listId !== B) {
					found = off;
					return;
				}
				const rec = blocks.get(listId);
				if (!rec) return;
				for (const e of rec.entries) {
					if (found !== null) return;
					if (isSliceRecord(e.payload)) {
						if (e.payload.t === t) {
							found = off;
							return;
						}
						off += contribution(e);
					} else if (isMergeClaim(e.payload)) {
						walk(e.payload.m, seen);
					}
				}
			};
			walk(B, new Set());
			return found ?? off;
		};

		/**
		 * Display offset inside `blockId` → backing-text anchor. The seg
		 * containing the position's affinity-side atom supplies the backing
		 * text + index; at cross-seg/cross-text seams the affinity picks the
		 * side ('left' → the seg ending at the position, 'right' → the seg
		 * starting there). An empty display binds to the block's OWN
		 * backing text at index 0 (where typed content will land).
		 * `null` when the block has no backing text.
		 */
		const anchorAt = (
			blockId: BlockId,
			offset: number,
			affinity: AnchorAffinity = 'left'
		): DocAnchor | null => {
			const assoc = affinity === 'left' ? -1 : 0;
			const { blocks, own } = view();
			const rec = blocks.get(blockId);
			if (!rec?.content) return null;
			const segs = T.flatten(blockId, blocks, own);
			if (segs.length === 0) {
				return { b: blockId, a: T.atomAnchorAt(doc, rec.content, 0, assoc) };
			}
			let acc = 0;
			for (let s = 0; s < segs.length; s++) {
				const seg = segs[s];
				const w = seg.i1 - seg.i0;
				const inside = assoc < 0 ? offset <= acc + w : offset < acc + w;
				if (inside) {
					const text = blocks.get(seg.t)?.content;
					if (!text) return null;
					const inner = Math.min(Math.max(offset - acc, 0), w);
					if (assoc < 0 && inner === 0) {
						// Left affinity at a seg start must bind the previous atom
						// of THIS BLOCK'S OWN display stream — the backing-text
						// neighbour at `seg.i0 - 1` can belong to a different
						// owner (a split sharing one backing, or routed merge
						// content), which would resolve the anchor into the
						// wrong block. At the stream's own start there is no
						// in-stream left atom: the seg's backing start resolves
						// the live-start sentinel on its own when `seg.i0 === 0`.
						const prev = segs[s - 1];
						if (prev) {
							const prevText = blocks.get(prev.t)?.content;
							if (!prevText) return null;
							return { b: prev.t, a: T.atomAnchorAt(doc, prevText, prev.i1, -1) };
						}
						if (seg.i0 > 0) {
							// Mid-backing stream start: bind LEFT to the
							// backing neighbour atom but tag the anchor
							// `a: -2` — left INSERT affinity (an insert at
							// the seam lands right of the caret, exactly
							// like any other caret anchor) with the owner
							// facet flipped to the RIGHT-hand atom, this
							// block's own first atom. An untagged left
							// anchor would resolve into the neighbour's
							// owner (encoding collision at a shared seam);
							// a right-bound anchor would ride PAST inserts
							// at the gap — the `nにello` corruption.
							return { b: seg.t, a: T.atomAnchorAt(doc, text, seg.i0, -2), o: blockId };
						}
					}
					return { b: seg.t, a: T.atomAnchorAt(doc, text, seg.i0 + inner, assoc) };
				}
				acc += w;
			}
			const last = segs[segs.length - 1];
			const text = blocks.get(last.t)?.content;
			if (!text) return null;
			return { b: last.t, a: T.atomAnchorAt(doc, text, last.i1, assoc) };
		};

		/**
		 * Backing-text anchor → current display position
		 * `{blockId, offset}`:
		 *
		 * 1. Resolve the engine anchor to a live gap index inside the
		 *    backing text (`null` → the bound item is not yet integrated —
		 *    the position converges once it arrives).
		 * 2. The gap's owner is the owner of the affinity-side adjacent
		 *    atom (left atom first for left affinity, right atom for
		 *    right), the other side as fallback. Moved/merged atoms keep
		 *    their anchor — the position follows them into whichever block
		 *    now displays them.
		 * 3. Neither adjacent atom owned → scan outward for the nearest
		 *    owned atom in the same backing text (affinity direction
		 *    first); the position lands adjacent to it.
		 * 4. No atom of the backing text owned anywhere → resolve to
		 *    `ownerOf(t)` — the block the backing text's slice list routes
		 *    to (a merge keeps a home) — at the emission seam
		 *    ({@link emissionOffset}). A dead/deleted owner → `null`
		 *    (caller falls back to text-id/path restoration).
		 */
		const resolveAnchor = (anchor: DocAnchor): { blockId: BlockId; offset: number } | null => {
			const { blocks, own } = view();
			const t = anchor.b;
			const text = blocks.get(t)?.content;
			if (!text) return null;
			const i = T.resolveAnchor(doc, text, anchor.a);
			if (i === null) return null;
			const ivs = own.intervals.get(t);
			const len = text.length;
			const ownedAt = (j: number): BlockId | undefined =>
				j >= 0 && j < len ? ownerAt(ivs, j) : undefined;
			// `assoc`'s sign alone cannot encode both degrees of freedom a
			// seam position needs. `a >= 0` and `a === -1` follow the
			// affinity side; `a <= -2` (minted by `anchorAt` at a
			// mid-backing stream start) is a LEFT-insert-affinity anchor
			// whose owner facet is the RIGHT-hand atom — the gap is the
			// start of the block whose stream begins there, not the end of
			// whatever owns the atom before it. The engine reads any
			// `assoc < 0` identically (left-sticky), so position math is
			// unaffected — only the owner pick flips.
			const assoc = anchor.a.a;
			// `o` is usable only while it is ALIVE AND SELF-OWNING —
			// `ownerOf` follows the claim chain, so a merged-away block
			// resolves to its surviving claimer (not DEAD); a deleted
			// block resolves DEAD. Either way the seam belongs to the
			// claim chain now: fall through to generic atom-following.
			if (assoc <= -2 && anchor.o !== undefined && own.ownerOf(anchor.o) === anchor.o) {
				// `a <= -2` + `o`: a left-insert-affinity caret minted at a
				// block's stream start on a mid-backing seam. The bound atom
				// belongs to the LEFT neighbour; `i` is the gap right after
				// it. Ownership at that gap is unreliable — an insert into
				// the left neighbour lands a foreign atom exactly at `i`
				// (`alpha`+X before the `Hello` caret) and would pull the
				// caret across the block boundary. Rebase `i` onto the
				// ANCHOR'S OWN block stream instead: the position is the
				// display offset where that gap falls inside `o`'s segs —
				// before foreign atoms at the seam, inside `o`'s own atoms
				// if `o`'s claim extended over the bound atom. Inserts into
				// `o` at the seam land right of the gap (left affinity), so
				// composition still resolves before them.
				const o = anchor.o;
				let off = 0;
				let seamEnd: number | null = null;
				for (const seg of T.flatten(o, blocks, own)) {
					const w = seg.i1 - seg.i0;
					if (seg.t === t) {
						if (i <= seg.i1) {
							return {
								blockId: o,
								offset: off + Math.min(Math.max(i - seg.i0, 0), w)
							};
						}
						seamEnd = off + w;
					}
					off += w;
				}
				// `i` past `o`'s last atom in this text → the seam sits at
				// that atom's stream position. `o` live but holding no
				// atoms in this text at all → the seam's destination
				// emptied in place (a merge would have KILLED `o`, and a
				// backing change moves the caret to `o`'s start either
				// way) — the caret belongs at the empty block's start,
				// not inside the neighbour's surviving content.
				if (seamEnd !== null) return { blockId: o, offset: seamEnd };
				return { blockId: o, offset: 0 };
			}
			const preferRightFacet = assoc >= 0 || assoc <= -2;
			let hit: { j: number; after: boolean } | null = null;
			const adjacent: [number, boolean][] = preferRightFacet
				? [
						[i, false],
						[i - 1, true]
					]
				: [
						[i - 1, true],
						[i, false]
					];
			for (const [j, after] of adjacent) {
				if (ownedAt(j) !== undefined) {
					hit = { j, after };
					break;
				}
			}
			if (hit === null) {
				// Interval-boundary hops — the same outward search the dense row
				// scanned position-by-position (WU6).
				const dirs = preferRightFacet ? [1, -1] : [-1, 1];
				for (const dir of dirs) {
					const j = nearestOwned(ivs, i, dir, len);
					if (j >= 0) {
						hit = { j, after: dir < 0 };
						break;
					}
				}
			}
			if (hit === null) {
				const owner = own.ownerOf(t);
				if (owner === DEAD) return null;
				return { blockId: owner, offset: emissionOffset(blocks, own, owner, t) };
			}
			const owner = ownedAt(hit.j)!;
			const segs = T.flatten(owner, blocks, own);
			let off = 0;
			for (const seg of segs) {
				if (seg.t === t && seg.i0 <= hit.j && hit.j < seg.i1) {
					return {
						blockId: owner,
						offset: off + (hit.j - seg.i0) + (hit.after ? 1 : 0)
					};
				}
				off += seg.i1 - seg.i0;
			}
			return { blockId: owner, offset: off };
		};

		/**
		 * Baseline `setBlock`: `type`/`data` update the block in place;
		 * `content`/`children` REPLACE wholesale — explicit replacement is a
		 * new-identity operation (fresh atoms/children), matching the
		 * baseline which rebuilt both from JSON. `children` on a `void`
		 * block is refused (voids cannot accept children). One transaction.
		 */
		const setBlock = (
			id: BlockId,
			value: {
				type?: string;
				data?: Record<string, unknown>;
				content?: (
					| { kind: 'text'; text: string; marks?: Record<string, unknown> }
					| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> }
				)[];
				children?: BlockSpec[];
			}
		): boolean =>
			write(() => {
				if (!M.liveNodeOf(doc, id)) return false;
				if (value.children !== undefined && isVoid(id)) return false;
				return doc.transact(() => {
					// U1: leaf `setBlockType`/`setBlockData` self-stamp when the
					// value actually changes (same-value writes suppressed).
					if (value.type !== undefined) setBlockType(id, value.type);
					if (value.data !== undefined) setBlockData(id, value.data);
					if (value.content !== undefined) {
						// Lineage: capture before the first content mutation.
						// When a type/data write above already displaced `l`,
						// this returns undefined — the bundle captures once.
						const lin = lineagePending(id);
						const len = displayLength(id);
						if (len > 0) write(() => M.deleteText(doc, id, 0, len));
						let wrote = len > 0;
						let off = 0;
						for (const item of value.content) {
							if (item.kind === 'text') {
								// '' inserts are skipped entirely — they write no
								// atom and (pre-fix) still stamped attribution.
								if (item.text !== '') {
									wrote = write(() => M.insertText(doc, id, off, item.text, item.marks)) || wrote;
								}
								off += item.text.length;
							} else {
								wrote = write(() => M.insertInline(doc, id, off, item)) || wrote;
								off += 1;
							}
						}
						// U1: explicit content replacement is authored — stamp
						// only when something was actually deleted or inserted
						// (a `[]`/`''` replace on empty content is a semantic
						// no-op, as is a write the model refused).
						if (wrote) stampTouched(id, lin);
					}
					if (value.children !== undefined) {
						for (const kid of childrenIds(id)) {
							// Lineage: children-replace deletes each kid through
							// the raw model path — force-capture its subtree
							// first (the same destructive capture `deleteBlock`
							// performs) or the only recovery copy is lost.
							const kidLin = lineagePending(kid, { force: true });
							const ok = write(() => M.deleteBlock(doc, kid));
							if (ok) commitLineage(kid, kidLin);
						}
						for (const child of value.children) {
							write(() => {
								// U1: replacement children are fresh identities —
								// authored by this actor. The parent itself is not
								// stamped: its own state (type/data/content) is
								// untouched, matching the pure-move rule.
								if (M.insertBlock(doc, { parent: id, index: Number.MAX_SAFE_INTEGER }, child)) {
									stampCreatedSpec(child);
								}
							});
						}
					}
					return true;
				});
			});

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * projects `id`, remaps every block id through `freshId`, inserts the
		 * spec right after `id`. Returns the new root id, or null when `id`
		 * is unresolvable. Text atoms get new identity too — duplication is
		 * a creation op, not a relocation.
		 */
		const duplicateBlock = (id: BlockId, freshId: (oldId: BlockId) => BlockId): BlockId | null =>
			write(() => {
				const pos = M.positionOf(doc, id);
				if (!pos) return null;
				const spec = (b: ProjectedBlock): BlockSpec => ({
					id: freshId(b.id),
					type: b.type,
					...(b.data !== undefined ? { data: cloneJson(b.data) } : {}),
					content: b.content.map((i) => cloneJson(i)),
					children: b.children.map(spec)
				});
				const stack = [...M.project(doc).children];
				let found: ProjectedBlock | undefined;
				while (stack.length) {
					const b = stack.pop()!;
					if (b.id === id) {
						found = b;
						break;
					}
					stack.push(...b.children);
				}
				if (!found) return null;
				const newSpec = spec(found);
				// insertBlock normalizes caller-supplied ids at the boundary
				// (F2-M1), so report the sanitized form `freshId` produced,
				// not the raw callback output.
				return insertBlock({ parent: pos.parent, index: pos.index + 1 }, newSpec)
					? sanitizeWireString(newSpec.id)
					: null;
			});

		// ── content ops (allowed inside voids — caption contract) ─────────

		const insertText = (
			id: BlockId,
			offset: number,
			text: string,
			marks?: Record<string, unknown>
		): boolean =>
			write(() =>
				doc.transact(() => {
					const lin = text === '' ? undefined : lineagePending(id);
					const ok = M.insertText(doc, id, offset, text, marks);
					// U1: '' is a semantic no-op (no atom written).
					if (ok && text !== '') stampTouched(id, lin);
					return ok;
				})
			);

		const deleteText = (id: BlockId, offset: number, length: number): boolean =>
			write(() =>
				doc.transact(() => {
					// U1: `deleteRange` returns `true` for empty/no-op ranges —
					// resolve the clamped span BEFORE the op so a zero-width
					// result suppresses the stamp. (S13: this re-derives the
					// clamp the model computes again inside `M.deleteText` —
					// consuming the model's verdict needs a widened return
					// shape on the op itself.)
					const total = displayLength(id);
					const at = Math.max(0, Math.min(offset, total));
					const end = Math.min(total, at + Math.max(0, length));
					const lin = end > at ? lineagePending(id) : undefined;
					const ok = M.deleteText(doc, id, offset, length);
					if (ok && end > at) stampTouched(id, lin);
					return ok;
				})
			);

		const setMark = (
			id: BlockId,
			offset: number,
			length: number,
			name: string,
			value: unknown
		): boolean =>
			write(() =>
				doc.transact(() => {
					// U1: evaluated BEFORE the write — a range already carrying
					// this exact mark produces no items → suppress the stamp.
					const noop = marksAlready(id, offset, length, { [name]: value });
					const lin = noop ? undefined : lineagePending(id);
					const ok = M.setMark(doc, id, offset, length, name, value);
					if (ok && !noop) stampTouched(id, lin);
					return ok;
				})
			);

		const unsetMark = (id: BlockId, offset: number, length: number, name: string): boolean =>
			write(() =>
				doc.transact(() => {
					const noop = marksAlready(id, offset, length, { [name]: null });
					const lin = noop ? undefined : lineagePending(id);
					const ok = M.unsetMark(doc, id, offset, length, name);
					if (ok && !noop) stampTouched(id, lin);
					return ok;
				})
			);

		/** Multi-mark format write over a range (values may be null = unset). */
		const formatRange = (
			id: BlockId,
			offset: number,
			length: number,
			marks: Record<string, unknown>
		): boolean =>
			write(() => {
				if (!M.liveNodeOf(doc, id)) return false;
				return doc.transact(() => {
					const { blocks, own } = view();
					// U1: `formatRangeIn` returns false on empty/clamped-away
					// ranges — those never stamp. A range whose atoms already
					// satisfy `marks` writes no items either (engine-level
					// suppression) — suppress the stamp the same way.
					const noop = marksAlready(id, offset, length, marks);
					const lin = noop ? undefined : lineagePending(id);
					const ok = write(() => T.formatRangeIn(doc, blocks, own, id, offset, length, marks));
					if (ok && !noop) stampTouched(id, lin);
					return ok;
				});
			});

		/**
		 * Baseline `removeMarksFromText`: every mark present anywhere in the
		 * range is unset over the range. Names are discovered from the runs
		 * view — no replicated scan needed.
		 */
		const clearMarks = (id: BlockId, offset: number, length: number): boolean => {
			const names = new Set<string>();
			let pos = 0;
			for (const r of runsView.runs(id)) {
				const len = r.kind === 'text' ? (r as { text: string }).text.length : 1;
				if (pos + len > offset && pos < offset + length) {
					for (const k of Object.keys((r as { marks?: JsonObj }).marks ?? {})) names.add(k);
				}
				pos += len;
			}
			if (names.size === 0) return true;
			const clears: JsonObj = {};
			for (const n of names) clears[n] = null;
			return formatRange(id, offset, length, clears);
		};

		const insertInline = (id: BlockId, offset: number, atom: InlineSpec): boolean =>
			write(() =>
				doc.transact(() => {
					const lin = lineagePending(id);
					const ok = M.insertInline(doc, id, offset, atom);
					if (ok) stampTouched(id, lin);
					return ok;
				})
			);

		const removeInline = (id: BlockId, inlineId: string): boolean =>
			write(() =>
				doc.transact(() => {
					const lin = lineagePending(id);
					const ok = M.removeInline(doc, id, inlineId);
					if (ok) stampTouched(id, lin);
					return ok;
				})
			);

		const setInlineData = (id: BlockId, inlineId: string, data: Record<string, unknown>): boolean =>
			write(() =>
				doc.transact(() => {
					const clean = sanitizeWireJson(data) as Record<string, unknown>;
					// U1 same-value suppression: an identical payload is a
					// semantic no-op — skip the model write entirely (no item
					// churn, no stamp). An inline absent from the projected
					// content falls through to the model's `false` verdict.
					// (S13: the runs scan duplicates the lookup
					// `M.setInlineData` performs — a same-value verdict on
					// the op would retire it.)
					for (const r of runsView.runs(id)) {
						if (r.kind === 'inline' && (r as { id: string }).id === inlineId) {
							if (jsonEquals((r as { data?: unknown }).data, clean)) return true;
							break;
						}
					}
					const lin = lineagePending(id);
					const ok = M.setInlineData(doc, id, inlineId, clean);
					if (ok) stampTouched(id, lin);
					return ok;
				})
			);

		// ── JSON boundary ─────────────────────────────────────────────────

		/**
		 * Public JSON export — `{ children: JSONBlock[] }` matching
		 * `src/lib/utils/json.ts` (baseline `Block.value` shape: `data` always
		 * present, `content`/`children` omitted when empty). Structure comes
		 * from the canonical projection; content from the maintained runs
		 * view's export boundary — the two are guaranteed to agree (AN04).
		 */
		const toJSON = (): JSONDoc => {
			const emit = (b: ProjectedBlock): JSONBlock => {
				const block: JSONBlock = {
					type: b.type,
					id: b.id,
					data: (b.data ?? {}) as JSONBlock['data']
				};
				const content = runsView.contentJSON(b.id) as (JSONText | JSONInlineBlock)[];
				if (content.length > 0) block.content = content;
				if (b.children.length > 0) block.children = b.children.map(emit);
				return block;
			};
			return { children: M.project(doc).children.map(emit) };
		};

		// ── facade object ─────────────────────────────────────────────────

		/**
		 * The typed-node surface (`document.block(id)` handles — see
		 * `nodes.ts`). Created lazily on first use; `bindNodes` caches one
		 * handle per block id, so repeated `facade.block(id)` calls return
		 * the same instance.
		 */
		let nodeApi: ReturnType<typeof bindNodes> | undefined;
		const nodes = () => (nodeApi ??= bindNodes(facade));

		const facade = {
			// lifecycle
			init: (opts?: Parameters<typeof init>[1]) => write(() => init(doc, opts)),
			/** Apply the deterministic seed of `value` (R13) — the document's seed decision. */
			seed: (value: JSONBlock[]) => write(() => seed(doc, value, defaultType)),
			isInitialized: () => isInitialized(doc),
			/** Replicated `meta.v` schema version (the module-level read, bound). */
			schemaVersion: () => schemaVersion(doc),
			/**
			 * The schema gate for this doc — throws {@link SchemaMismatchError}
			 * on unversioned-content or unsupported-version state. Consumers
			 * (U08 `Edytor.sync()`, packed consumers) call it before trusting
			 * a synced doc.
			 */
			checkSchema: () => checkSchema(doc),
			assertSchema: () => assertSchema(doc),
			dispose,
			createUndoManager,
			// reads
			project: () => M.project(doc),
			toJSON,
			childrenIds,
			positionOf,
			pathOf,
			parentOf: (id: BlockId) => positionOf(id)?.parent ?? null,
			ancestorsOf,
			listBlockIds: () => M.listBlockIds(doc),
			blockText: (id: BlockId) => M.blockText(doc, id),
			blockTypeOf,
			blockDataOf,
			/**
			 * U1 — compact per-block attribution (`{createdBy, contributors,
			 * lastChangedBy}`), or `undefined` for unauthored/system blocks.
			 * O(1) per call; live-replicated (remote values read the same).
			 */
			blockAttribution: (id: BlockId): BlockAttribution | undefined => blockAttributionOf(doc, id),
			crdtId: (id: BlockId) => M.crdtId(doc, id),
			resolveBlock: (id: BlockId) => M.resolveBlock(doc, id),
			displayLength,
			contentItems,
			hasBlock,
			isVisibleBlock,
			previousInDocOrder,
			nextInDocOrder,
			// caret anchors (U09) — backing-text-bound selection endpoints
			anchorAt,
			resolveAnchor,
			// roles
			isVoid,
			isIsland,
			islandOf,
			insideIsland,
			// maintained runs (U05 surface, bound to this doc)
			runs: runsView.runs,
			snapshot: runsView.snapshot,
			contentJSON: runsView.contentJSON,
			blockVersion: runsView.blockVersion,
			subscribeBlock: runsView.subscribeBlock,
			// events
			onChange,
			// structural ops
			insertBlock,
			moveBlock,
			moveBlocks,
			nestBlock,
			unNestBlock,
			splitBlock,
			mergeBlocks,
			mergeBackward,
			mergeForward,
			deleteBlock,
			// metadata / replacement
			setBlock,
			setBlockType,
			setBlockData,
			duplicateBlock,
			// content ops
			insertText,
			deleteText,
			setMark,
			unsetMark,
			formatRange,
			clearMarks,
			insertInline,
			removeInline,
			setInlineData,
			// transactions (composed ops already run in one; expose for callers
			// that batch several ops into one undo step / one event)
			transact: <R>(fn: () => R, origin?: unknown): R => write(() => doc.transact(fn, origin)),
			// escape hatch for U08/debugging — the bound engine layers.
			model: M,
			text: T,
			runsView,
			// ── model-state version + typed node surface (WU2) ──────────
			/**
			 * Monotonic model-state version token — bumps on every mutation
			 * routed through this facade and on every committed `update`
			 * (local and remote). Read surfaces that memoize on it (the
			 * editor's projected-tree cache) always observe post-write
			 * state — this is the read-your-writes contract.
			 */
			get version() {
				return stateVersion;
			},
			/**
			 * The typed handle over one document block — the domain command
			 * surface (see `nodes.ts` for the contract: display offsets,
			 * transaction-aware reads, dead-safe). Handles are cached per
			 * id; a handle for an absent id reports `exists`/`live`/`visible`
			 * false and refuses ops.
			 */
			block: (id: BlockId): DocBlock => nodes().block(id)
		};
		return facade;
	};

	return {
		/** The schema manifest constants table. */
		SCHEMA,
		SCHEMA_VERSION,
		SCHEMA_NAME,
		META_KEY,
		/** Doc-level API (no facade needed). */
		init,
		seed,
		isInitialized,
		schemaVersion,
		registryEmpty,
		checkSchema,
		assertSchema,
		SchemaMismatchError,
		/** Attach the per-doc facade. */
		create,
		/** The bound engine layers (same instances the facades use). */
		model: M,
		text: T,
		runs: R
	};
};
