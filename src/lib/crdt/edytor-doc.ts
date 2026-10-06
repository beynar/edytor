/**
 * EdytorDoc (U06) — the assembled document model.
 *
 * This module binds the three proven engine layers over ONE Y.Doc into the
 * single public surface the command layer (U08) and providers (U07) consume:
 *
 * - `placement/model.ts` (`bindModel`) — stable block registry + placement
 *   candidates; identity-preserving move/nest/split/merge (U03).
 * - `text/model.ts` (`bindText`) — stable backing texts delimited by stream
 *   boundaries + merge claims (R2); split/merge never copy text.
 * - `text/runs.ts` (`bindRuns`) — the maintained run view: immutable run
 *   snapshots, structural sharing, the change report (U05, D9).
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
 *   └ <blockId>                           id/n/type/data/del + content/claims/at
 *                                         (n: incarnation nonce, O23)
 * doc.get('meta')                        version record root
 *   ├ v : number                          SCHEMA_VERSION (LWW attr — concurrent init converges)
 *   └ schema : 'edytor-doc'               SCHEMA_NAME
 * ```
 *
 * ── Deterministic seed (R13, D-3) ───────────────────────────────────────
 *
 * `seed(doc, value)` applies ONE update built in a scratch doc whose writer
 * id is a hash of (generation, canonical seed JSON) in a low band below
 * 2^26: caller ids are kept, missing ids are derived from the hash and
 * position, ranks and incarnation nonces come from the rand seam seeded by
 * the hash. Peers seeding the same value therefore write the SAME items — a
 * late identical seed is a no-op and never erases an edit — while different
 * values union. A shared id resolves by registry LWW (the larger client id):
 * against a block a live replica (uint53 id) wrote, the seed loses; between
 * two different seeds, the larger hash wins and can replace a block edited
 * since (UW-03 residual — never seed a changing snapshot beside a room).
 * An empty value seeds one `defaultType` block. The update is applied
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
 * Roles are resolved operation-time via `config.roleOf(type)`, through one
 * role table (`DisplayRoles`) that the index's display and every guard
 * below ask of a block's shown kind — the editor derives them from plugin
 * block definitions, exactly like the baseline's
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
 *   allowed when the island renders its content (XW-12). Moving or merging
 *   INTO an island subtree is rejected. An island declared `lines` (code)
 *   holds only lines of its `defaultChild` kind, and a line holds no
 *   children (FW-01, XW-03: the display enforces it against undo,
 *   `insertBlocks` refuses a line parent); any other island keeps its
 *   structure. `canPlace` and `canMerge` are the one answer, asked in
 *   advance or by the ops (R5).
 * - Island merge: when an island block itself is merged (backward or
 *   forward), its children are unnested to the vacated sibling slot and
 *   reset to the default child of that slot's parent (`defaultChild`).
 * - Baseline merges NEVER adopt the merged block's children — they unnest
 *   to the vacated slot. The facade exposes both: `mergeBlocks` is the
 *   engine primitive (children adopt into the target — TX09c contract —
 *   by staying under the source, which the target's claim displays, FW-12),
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
import { DEV } from 'esm-env';
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode, YUndoManager } from './engine-api.js';
import { hash32, randOf, setDocRand } from './rand.js';
import {
	AT,
	BLOCK_NODE,
	DATA,
	DATA_LEAF_PREFIX,
	DEL_PREFIX,
	DOC_DATA_ROOT,
	ID,
	INLINE_NODE,
	isNodeLike,
	LAST_CHANGED_ATTR,
	TYPE,
	SCHEMA
} from './schema.js';
import {
	bindModel,
	displayParentOf,
	displaySlotOf,
	isLiveIn,
	promotedRank,
	sourceRank,
	SOURCE_SIDE,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ModelView,
	type ProjectedBlock,
	type SplitTail
} from './placement/model.js';
import {
	bindText,
	DEAD,
	displayOf,
	locate,
	ownedLength,
	ownTextIds,
	type Anchor
} from './text/model.js';
import { bindDeletes } from './text/deletes.js';
import {
	bindRuns,
	ENTRY_FACET,
	type ContentRun,
	type DisplayRoles,
	type Folded,
	type IndexReport,
	type RunView
} from './text/runs.js';
import { callEach } from './protocols/observable.js';
import { bindNodes, type DocBlock } from './nodes.js';
import { followRedone, holdsPending, walkIdSetStructs, type IdSetLike } from './structs.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import type { AttributionActor } from './attribution/index.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import { rangeDeleteOps, type DocPosition } from './rangeDelete.js';
import { flowOps, type FlowContext } from './flow.js';
import {
	dataLeaves,
	isObject,
	itemIds,
	leafKey,
	patchWrites,
	readData,
	writeLeaves,
	type DataPatch,
	type LeafWrite
} from './data.js';
import { id as newId } from '../utils.js';
import {
	cloneJsonSafe,
	jsonBlockToSpec,
	jsonEquals,
	sanitizeSpec,
	sanitizeWireJson,
	sanitizeWireString,
	type JSONBlock,
	type JSONDoc
} from '../utils/json.js';

// ── schema manifest ─────────────────────────────────────────────────────

export { SCHEMA };

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
/** The undo steps a document's history keeps by default (P6): older ones are released. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** The origin of the transaction that releases a dropped history step's content. */
const HISTORY_TRIM = Symbol('edytor.history.trim');

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
	/**
	 * An island of lines (code): each direct child displays as its
	 * `defaultChild` kind and holds no children (FW-01, XW-03). Needs
	 * `island` and a `defaultChild`; other islands keep their structure.
	 */
	lines?: boolean;
	/**
	 * A layout (columns): it displays only its items — its `defaultChild`
	 * kind, a container that renders no content — side by side, and only
	 * while it shows two or more (`layout.*` in the delete contract). Needs
	 * a `defaultChild`.
	 */
	layout?: boolean;
	/**
	 * Data paths written as one leaf (`data.atomic`, H8): a top-level key, or
	 * an array of keys for a nested one (`['link', ['media', 'source']]`). An
	 * assignment there, or anywhere under it, writes the whole value as one
	 * last-writer-wins leaf, so two concurrent assignments never merge into a
	 * value neither wrote: one wins whole.
	 */
	atomic?: readonly (string | readonly string[])[];
};

/** Island-sealing policy for a walk in document order (R5; see `next`). */
export type OrderPolicy = { sealed?: boolean };

/** Configuration for an attached {@link EdytorDoc}. */
export type EdytorDocConfig = {
	/**
	 * Resolve a block `type` to its structural role — the seam where the
	 * editor's plugin definitions plug in (e.g. `(t) => edytor.blocks.get(t)`).
	 * Defaults to no roles (pure engine behavior).
	 */
	roleOf?: (type: string) => BlockRole | undefined;
	/**
	 * Default block type — the bootstrap block and the default child of the
	 * root and of any parent type `defaultChildOf` does not answer.
	 * Defaults to `'paragraph'`.
	 */
	defaultType?: string;
	/**
	 * The adopted default child type per parent type (R5, O9) — the island
	 * merge-out reset applies it against the children's actual new parent.
	 */
	defaultChildOf?: (parentType: string) => string | undefined;
	/** The adopted `rendersContent` per kind (R5, O22); undeclared kinds render theirs. */
	rendersContent?: (type: string) => boolean;
	/**
	 * The kinds `roleOf` answers for — the display reads the line kinds of
	 * the `lines` islands from them, present in the document or not
	 * (XW-11). Absent: only the kinds of the blocks the document holds.
	 */
	kinds?: () => Iterable<string>;
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
	/** The document's own data (`docData()`), when this commit changed it. */
	data?: Record<string, unknown>;
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
 * A selection endpoint (R4): `b` is the home block of the backing text the
 * position lives in (NOT necessarily the block that displays it — merges and
 * splits reroute display while the anchor stays on the same items), `a` an
 * engine relative position whose `a` carries the side (`< 0` left, `>= 0`
 * right). The containing stream and the side are two facts in two fields.
 * JSON-serializable — the presence and history wire shape.
 */
export type DocAnchor = { b: BlockId; a: Anchor };

// ── internals ───────────────────────────────────────────────────────────

type JsonObj = Record<string, unknown>;

/** Shared frozen empty child list for `DocChange.order` tombstone entries. */
const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

/**
 * The observed outcome of one document operation (R6, §2.4) — the one result
 * shape every op returns, empty inputs included. `refused`: the op did not
 * apply and wrote nothing; `noop`: it applied and changed nothing; `applied`:
 * the transaction wrote. Read from the transaction's effects, never predicted.
 */
export type OpResult = {
	readonly status: 'refused' | 'noop' | 'applied';
	/** What the op is about — created, moved, merge target, or its target; empty unless applied. */
	readonly ids: readonly BlockId[];
	/** Why a refused op refused, when it names a reason (`'id-collision'`). */
	readonly reason?: string;
};
/** An op body's refusal: `null`, or the reason it names. */
type Refusal = null | string;
const NOOP: OpResult = Object.freeze({ status: 'noop', ids: EMPTY_IDS });
const refused = (reason: Refusal): OpResult =>
	Object.freeze({ status: 'refused', ids: EMPTY_IDS, ...(reason !== null && { reason }) });

/** A text range an op writes, in display offsets before the write. */
export type TextRange = { block: BlockId; offset: number; length: number };

/**
 * One planned write (R6, §2.4), named by the document operation that
 * performs it — the name a hook matches (D-10). Steps carry everything
 * their write needs (ranks, marks, offsets), decided at prepare time.
 */
export type PlanStep =
	/** `index`: the destination slot at prepare time, as hooks see it (D-10). */
	| {
			op: 'insertBlocks';
			parent: BlockId | null;
			index: number;
			specs: BlockSpec[];
			ranks: string[];
	  }
	| { op: 'moveBlocks'; ids: BlockId[]; parent: BlockId | null; index: number; ranks: string[] }
	/** `marks`: the blocks that get this writer's mark; `removes`: those that leave the document. */
	| { op: 'deleteBlock'; id: BlockId; marks: BlockId[]; removes: BlockId[] }
	| {
			op: 'splitBlock';
			id: BlockId;
			offset: number;
			/** Display atoms moving to the new block. */
			length: number;
			newId: BlockId;
			tail: SplitTail;
			parent: BlockId | null;
			rank: string;
	  }
	/** `at`/`length`: where `from`'s display lands in `into`'s. */
	| { op: 'mergeBlocks'; from: BlockId; into: BlockId; at: number; length: number }
	| { op: 'setBlockType'; id: BlockId; type: string }
	/**
	 * A data patch (`crdt/data.ts`): of block `id`, of its atom `inlineId`
	 * (at display `offset`), or of the document (no `id`). `ops` as asked;
	 * `leaves` the attr writes they plan.
	 */
	| {
			op: 'patchData';
			id?: BlockId;
			inlineId?: string;
			offset?: number;
			ops: DataPatch[];
			leaves: LeafWrite[];
	  }
	| {
			op: 'insertText';
			id: BlockId;
			offset: number;
			text: string;
			marks?: Record<string, unknown>;
	  }
	| { op: 'insertInline'; id: BlockId; offset: number; atom: InlineSpec }
	| { op: 'deleteText'; id: BlockId; offset: number; length: number }
	| { op: 'removeInline'; id: BlockId; offset: number; inlineId: string }
	| {
			op: 'formatRange';
			id: BlockId;
			offset: number;
			length: number;
			marks: Record<string, unknown>;
	  };

/** What a data patch edits: a block, one of its inline atoms, or the document (`null`). */
export type DataTarget = BlockId | null | { block: BlockId; atom: string };

/**
 * What applying a plan does (R6): blocks created, removed (they leave the
 * document), merged (`[from, into]`), moved (a placement written), retyped
 * or given new data (`meta`), and the text ranges written. Derived from the
 * plan's steps; the applied transaction changes exactly this (F-O11).
 */
export type PlanEffect = {
	creates: BlockId[];
	removes: BlockId[];
	merges: [from: BlockId, into: BlockId][];
	moves: BlockId[];
	meta: BlockId[];
	textRanges: TextRange[];
};

/**
 * A prepared operation (R6, §2.4): its steps, their effect, the ids the op
 * is about, and the document version it was prepared against — valid only
 * there, applied in the same synchronous turn.
 */
export type Plan = {
	readonly ids: readonly BlockId[];
	readonly writes: readonly PlanStep[];
	readonly effect: PlanEffect;
	readonly version: number;
	/** Where the op leaves the caret, when it decides one (`deleteRange`). */
	readonly at?: DocPosition;
};
/** `prepare`'s answer: a plan, or the op's refusal. */
export type Prepared = Plan | OpResult;

/** Each prepared op, applied: the op itself. */
type Applied<P> = {
	[K in keyof P]: P[K] extends (...args: infer A) => Prepared ? (...args: A) => OpResult : never;
};
const applied = <P extends Record<string, (...args: never[]) => Prepared>>(
	prepare: P,
	apply: (p: Prepared) => OpResult
): Applied<P> =>
	Object.fromEntries(
		Object.entries(prepare).map(([name, op]) => [name, (...args: never[]) => apply(op(...args))])
	) as Applied<P>;

/** The effect summary of `writes`. */
const effectOf = (writes: readonly PlanStep[]): PlanEffect => {
	const e: PlanEffect = {
		creates: [],
		removes: [],
		merges: [],
		moves: [],
		meta: [],
		textRanges: []
	};
	const text = (block: BlockId, offset: number, length: number): void => {
		if (length > 0) e.textRanges.push({ block, offset, length });
	};
	const created = (sp: BlockSpec): void => {
		e.creates.push(sp.id);
		sp.children?.forEach(created);
	};
	for (const w of writes) {
		if (w.op === 'insertBlocks') w.specs.forEach(created);
		else if (w.op === 'moveBlocks') e.moves.push(...w.ids);
		else if (w.op === 'deleteBlock') e.removes.push(...w.removes);
		else if (w.op === 'splitBlock') {
			e.creates.push(w.newId);
			text(w.id, w.offset, w.length);
		} else if (w.op === 'mergeBlocks') {
			e.merges.push([w.from, w.into]);
			text(w.into, w.at, w.length);
		} else if (w.op === 'setBlockType') e.meta.push(w.id);
		else if (w.op === 'patchData') {
			if (w.inlineId !== undefined) text(w.id!, w.offset!, 1);
			else if (w.id !== undefined) e.meta.push(w.id);
		} else if (w.op === 'insertText') text(w.id, w.offset, w.text.length);
		else if (w.op === 'deleteText' || w.op === 'formatRange') text(w.id, w.offset, w.length);
		else text(w.id, w.offset, 1);
	}
	// Text written into a block the plan creates is part of its creation.
	e.textRanges = e.textRanges.filter((r) => !e.creates.includes(r.block));
	return e;
};

/**
 * Ingress for an id reference (O1): it normalizes exactly like a stored id
 * (`sanitizeSpec`), so a write and a later lookup by the same string agree.
 */
const ref = <I extends string | null>(id: I): I => (id === null ? id : sanitizeWireString(id)) as I;

/**
 * The lineage ring depth, validated — `NaN`/`Infinity`/fractional/negative
 * values would silently disable the ring's trim bound. The one check every
 * entry path (facade creation, document attach and reattach) runs.
 */
export const lineageDepthOf = (depth: number | undefined): number => {
	const d = depth ?? 0;
	if (!Number.isInteger(d) || d < 0) {
		throw new RangeError(`lineage.depth must be a non-negative integer, got ${JSON.stringify(d)}`);
	}
	return d;
};

/**
 * Bind the assembled model to a concrete engine surface. `Y` must be the
 * vendored v14 module — injected so this file type-checks structurally and
 * never imports vendor `.js` (see `engine-api.ts`).
 */
export const bindEdytorDoc = (Y: EngineApi) => {
	// The doc's index (`text/runs.ts`) is the one owner of derived state:
	// commands, runs, anchors, the change report and rendering read it.
	const R = bindRuns(Y);
	const M = bindModel(Y);
	const T = bindText(Y);
	const D = bindDeletes(Y);
	// U1 — compact per-block attribution writes (`attribution/block.ts`).
	// One bound instance per engine binding; its suppression memory is
	// per-doc (WeakMap-keyed), so facades on the same doc share it.
	const BA = bindBlockAttribution(Y);

	// ── version record / bootstrap (doc-level, facade-free) ────────────
	// `schemaVersion`, `registryEmpty`, `isInitialized`, `checkSchema` and
	// `assertSchema` are module-level (see above) — pure doc reads shared by
	// providers and migration without re-binding.

	/**
	 * U1 — stamp a freshly materialized spec tree (all levels) with
	 * `createdBy`/`contributors`/`lastChangedBy` = `actorId`. Call inside
	 * the creating transaction; the spec is the normalized one that was stored.
	 */
	const stampSpecTree = (doc: EngineDoc, spec: BlockSpec, actorId: string): void => {
		const node = M.blockNodeOf(doc, spec.id);
		if (node !== null) BA.stampCreated(doc, node, spec.id, actorId);
		for (const child of spec.children ?? []) stampSpecTree(doc, child, actorId);
	};

	/**
	 * Stamp the version record, absent only: never downgrade a higher
	 * version written by a newer peer — U07's gate decides compatibility.
	 */
	const stamp = (doc: EngineDoc): void => {
		const meta = doc.get(META_KEY);
		if (meta.getAttr(SCHEMA.metaAttrs.version) !== undefined) return;
		meta.setAttr(SCHEMA.metaAttrs.version, SCHEMA_VERSION);
		meta.setAttr(SCHEMA.metaAttrs.schema, SCHEMA_NAME);
	};

	/**
	 * Restore definition (O24, D-22 — migration only): stamp the version
	 * record (absent only) and make `content` the whole document under its
	 * own ids, rewritten in place where they exist (the model's
	 * `restoreBlocks`). Writes no attribution.
	 */
	const restore = (doc: EngineDoc, content: BlockSpec[]): void =>
		doc.transact(() => {
			stamp(doc);
			M.restoreBlocks(doc, content.map(sanitizeSpec));
		});

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
		const specs = (opts.content ?? []).map(sanitizeSpec);
		if (specs.length === 0 && registryEmpty(doc) && !isInitialized(doc)) {
			return seed(doc, [], opts.defaultType);
		}
		doc.transact(() => {
			stamp(doc);
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
	const seedUpdate = (
		value: JSONBlock[],
		defaultType = 'paragraph',
		data?: JsonObj
	): Uint8Array => {
		// Canonical form (object keys sorted, arrays in order): the hash AND
		// the build read it, so key order never splits one template.
		const sorted = (_: string, v: unknown) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
				: v;
		const blocks: JSONBlock[] = JSON.parse(
			JSON.stringify(value.length > 0 ? value : [{ type: defaultType }], sorted)
		);
		// The document's data joins the hash only when it has some (seeds without it keep their
		// writer), in the canonical form too: the build writes its leaves in that key order.
		const own =
			isObject(data) && Object.keys(data).length > 0
				? (JSON.parse(JSON.stringify(sanitizeWireJson(data), sorted)) as JsonObj)
				: undefined;
		const hashed = own === undefined ? blocks : { data: own, blocks };
		// The writer lives in a low band, [1, 2^26): a registry race is won by
		// the larger client id and live replicas draw uint53 ids, so a seed
		// sharing a block id with live content loses to it (UW-03) but for a
		// live id below the band (~2^-27). Two different seeds collide on one
		// writer at ~2^-26. The band moved from the full 32 bits: an id-less
		// template seeded late into a document seeded by an older build
		// mints new ids and shows twice, once.
		const writer =
			hash32(`yjs-v14/${SCHEMA_NAME}@${SCHEMA_VERSION}:${JSON.stringify(hashed)}`) >>> 6 || 1;
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
		scratch.transact(() => {
			specs.forEach(records);
			writeLeaves(scratch.get(DOC_DATA_ROOT), dataLeaves(own));
		});
		return Y.encodeStateAsUpdate(raw);
	};

	/** Apply the deterministic seed of `value` with the non-local {@link SEED_ORIGIN}. */
	const seed = (
		doc: EngineDoc,
		value: JSONBlock[] = [],
		defaultType?: string,
		data?: JsonObj
	): void =>
		Y.applyUpdate(doc as unknown as YDoc, seedUpdate(value, defaultType, data), SEED_ORIGIN);

	// ── per-doc facade ──────────────────────────────────────────────────

	const create = (doc: EngineDoc, config: EdytorDocConfig = {}) => {
		// Document-boundary check — foreign (v13-engine) and legacy-schema docs
		// fail fast here rather than inside the runs view (see assertUsableDoc).
		assertUsableDoc(doc);
		const roleOf = config.roleOf ?? (() => undefined);
		const defaultType = config.defaultType ?? 'paragraph';
		const defaultChildOf = config.defaultChildOf ?? (() => undefined);
		const rendersContentOf = config.rendersContent ?? (() => true);
		const runsView: RunView = R.attach(doc);
		// The role table — the display and every guard below ask it. UW-21b:
		// a void kind displays no children — the index sheds them into its
		// slot at read time, so a child a peer nests or splits under a block
		// another peer retypes to a void shows on every replica. A block
		// promoted out of an island displays as its display parent's default
		// child, as a delete of the island retypes the ones it saw. An island
		// declared `lines` holds only lines of its `defaultChild` kind
		// (FW-01, XW-03). A layout displays only its items — its
		// `defaultChild` kind — and only two or more (`layout.*`).
		const roles: DisplayRoles = {
			childless: (type) => roleOf(type)?.void === true,
			island: (type) => roleOf(type)?.island === true,
			container: (type) =>
				!rendersContentOf(type) && roleOf(type)?.void !== true && roleOf(type)?.island !== true,
			rendersContent: (type) => rendersContentOf(type),
			defaultChild: (type) => (type !== null ? defaultChildOf(type) : undefined) ?? defaultType,
			line: (type) => {
				const role = roleOf(type);
				return role?.island === true && role.lines === true ? defaultChildOf(type) : undefined;
			},
			lineKinds: () => [...(config.kinds?.() ?? [])].flatMap((type) => roles.line(type) ?? []),
			layout: (type) => (roleOf(type)?.layout === true ? defaultChildOf(type) : undefined),
			layoutKinds: () =>
				[...(config.kinds?.() ?? [])].filter((type) => roles.layout(type) !== undefined)
		};
		if (config.roleOf) runsView.roles(roles);

		/**
		 * Terminal flag — set by `dispose()`. Mutating ops funnel through
		 * `write`, so gating there covers every facade write + `transact` +
		 * `init` + `createUndoManager`; reads stay dead-safe on purpose
		 * (a stale handle remains inspectable while its doc outlives the
		 * facade — e.g. the document teardown order). D14.
		 */
		let disposed = false;

		// Lineage ring watermark repair — concurrent partition appends can
		// merge a ring past every writer's `depth`; this converges the
		// stored ring back to the entries' own watermark after remote
		// applies. Once per doc, doc-lifetime, no-op when nothing is over.
		BA.attachRingTrim(doc);

		/** Mutation boundary — every facade write funnels through `write`. */
		const write = <R>(fn: () => R): R => {
			if (disposed) {
				throw new EdytorDocDisposedError();
			}
			config.assertWritable?.();
			return fn();
		};

		// ── the write funnel (R6, O10, O19) ─────────────────────────────
		//
		// Every document op is a prepared plan (R6, below) written by `apply`:
		// one transaction, and a result read from the index's fold of what the
		// frame wrote — `applied` iff the transaction wrote anything (its
		// insert or delete set grew); otherwise `noop`. The plan decides what
		// to write (a same-value attr or format is never planned); the result
		// is observed, never predicted.
		//
		// Each apply opens a frame that tracks the index's folds. When it
		// closes, ONE pass over the facets the fold saw stamps attribution and
		// commits lineage (U1): a block whose registry entry was created gets
		// its `createdBy` record; a block whose content, claims, type or data
		// changed gets a contributor stamp; moves and delete marks stamp
		// nothing. Two intents the effects cannot name are recorded by their
		// steps: a split-born block inherits its source's contributors, and a
		// merge survivor unions the absorbed block's. Lineage is captured
		// before the first write for each target a step names, and committed
		// only for targets the effects show changed, deleted or absorbed. With
		// no configured `actor` the funnel writes no attribution at all.

		const actorOf = (): AttributionActor | undefined => config.actor?.();
		const lineageDepth = lineageDepthOf(config.lineageDepth);

		/** A pre-write capture awaiting its frame's commit. */
		type PendingLineage = { a?: string; by: string; t: number; j: JSONBlock };
		type Frame = {
			lineage: Map<BlockId, PendingLineage>;
			inherit: Map<BlockId, BlockId>;
			unions: [into: BlockId, from: BlockId][];
		};

		/**
		 * Capture `id`'s displaced state when the current actor is NOT the `l`
		 * winner (`force`: destructive paths, where the state is lost whoever
		 * owns `l`). First capture in a frame wins — it is the pre-frame state.
		 */
		const lineagePending = (id: BlockId, force = false): PendingLineage | undefined => {
			const actor = actorOf();
			const node = M.blockNodeOf(doc, id);
			if (lineageDepth <= 0 || actor === undefined || node === null) return undefined;
			const l = node.getAttr(LAST_CHANGED_ATTR);
			if (!force && l === actor.id) return undefined;
			const j = blockJSON(id);
			return { ...(typeof l === 'string' ? { a: l } : {}), by: actor.id, t: Date.now(), j };
		};
		const capture = (f: Frame, id: BlockId, force = false): void => {
			const pending = f.lineage.has(id) ? undefined : lineagePending(id, force);
			if (pending !== undefined) f.lineage.set(id, pending);
		};

		/** The frame's one attribution pass over the facets the fold saw it write. */
		const close = (f: Frame, folded: Folded): void => {
			const actor = actorOf();
			if (actor === undefined || !folded.wrote) return;
			const created = new Set<BlockId>();
			const changed = new Set<BlockId>();
			const gone = new Set<BlockId>(f.unions.map(([, from]) => from));
			for (const [id, facets] of folded.touched) {
				if (facets.has(ENTRY_FACET) && M.blockNodeOf(doc, id) !== null) created.add(id);
				else
					for (const facet of facets) {
						if (facet.startsWith(DEL_PREFIX)) gone.add(id);
						else if (![ENTRY_FACET, AT, ID, LAST_CHANGED_ATTR].includes(facet)) changed.add(id);
					}
			}
			for (const id of created) {
				const node = M.blockNodeOf(doc, id);
				if (node !== null) BA.stampCreated(doc, node, id, actor.id, f.inherit.get(id));
			}
			for (const id of changed) {
				const node = created.has(id) ? null : M.blockNodeOf(doc, id);
				if (node !== null) BA.stampChange(doc, node, id, actor.id);
			}
			for (const [into, from] of f.unions) BA.unionContributors(doc, into, from);
			for (const [id, pending] of f.lineage) {
				if (changed.has(id) || gone.has(id)) BA.appendLineage(doc, id, pending, lineageDepth);
			}
		};

		/**
		 * A streamless block gets its own text before the first write that
		 * needs a stream (`M.ownText`: a writer derived from its dead
		 * incarnation); its attribution record follows the re-minted nonce.
		 */
		const needStream = (id: BlockId): void => {
			if ((M.view(doc).own.display(id) ?? []).length > 0) return;
			const { from, to } = M.ownText(doc, id);
			BA.retarget(doc, id, from, to);
		};

		/** The node a data patch writes: block `id`, its atom `inlineId`, or the document's data root. */
		const dataNode = (id?: BlockId, inlineId?: string): EngineNode | undefined =>
			id === undefined
				? doc.get(DOC_DATA_ROOT)
				: inlineId === undefined
					? (M.blockNodeOf(doc, id) ?? undefined)
					: (T.findAtom(view().own, id, inlineId)?.node as EngineNode | undefined);

		/** One planned step, written (the plan decided it; writers never refuse). */
		const writeStep = (w: PlanStep, f: Frame): void => {
			// Structural steps need no view: delete marks and placements write one node.
			if (w.op === 'deleteBlock')
				return w.marks.forEach((id) =>
					M.blockNodeOf(doc, id)!.setAttr(DEL_PREFIX + doc.clientID, true)
				);
			if (w.op === 'splitBlock' || w.op === 'insertText' || w.op === 'insertInline')
				needStream(w.id);
			const { blocks, own } = M.view(doc);
			const node = (id: BlockId) => M.blockNodeOf(doc, id)!;
			switch (w.op) {
				case 'insertBlocks':
					return w.specs.forEach((sp, i) => M.materializeSpec(doc, sp, w.parent, w.ranks[i]!));
				case 'moveBlocks':
					return w.ids.forEach((id, i) => M.writePlacement(doc, node(id), w.parent, w.ranks[i]!));
				case 'splitBlock':
					f.inherit.set(w.newId, w.id);
					return M.writeSplit(doc, w.id, w.offset, w.newId, w.tail, { p: w.parent, r: w.rank });
				case 'mergeBlocks':
					f.unions.push([w.into, w.from]);
					return T.claimInto(blocks, w.from, w.into);
				case 'setBlockType':
					return void node(w.id).setAttr(TYPE, w.type);
				case 'patchData':
					return writeLeaves(dataNode(w.id, w.inlineId)!, w.leaves);
				case 'insertText':
					return T.insertIntoText(doc, blocks, own, w.id, w.offset, w.text, w.marks);
				case 'insertInline':
					return T.insertIntoText(doc, blocks, own, w.id, w.offset, M.buildInline(w.atom));
				case 'deleteText':
				case 'removeInline':
					return T.deleteRange(doc, blocks, own, w.id, w.offset, 'length' in w ? w.length : 1);
				case 'formatRange':
					return T.formatRangeIn(doc, blocks, own, w.id, w.offset, w.length, w.marks);
			}
		};

		/**
		 * Apply a prepared plan (R6): write exactly its steps in one transaction
		 * and fold the result from what that transaction did. A refusal writes
		 * nothing. A plan is valid only at the version it was prepared against,
		 * in the same synchronous turn: applying it anywhere else throws.
		 */
		const apply = (p: Prepared): OpResult => {
			if (!('writes' in p)) return write(() => p);
			if (p.version !== runsView.version()) {
				throw new Error('[edytor-doc] stale plan: prepared against another document version');
			}
			return write(() =>
				doc.transact(() => {
					const frame = runsView.track();
					const f: Frame = { lineage: new Map(), inherit: new Map(), unions: [] };
					try {
						// Lineage captures every target's pre-write state before the
						// first write; destructive steps capture whoever owns `l`.
						for (const w of p.writes) {
							if (w.op === 'deleteBlock') capture(f, w.id, true);
							else if (w.op === 'mergeBlocks') {
								capture(f, w.from, true);
								capture(f, w.into);
							} else if ('id' in w && w.id !== undefined) capture(f, w.id);
						}
						for (const w of p.writes) writeStep(w, f);
					} catch (error) {
						// The frame would otherwise fold every later commit (DR-rest-3).
						frame.end();
						throw error;
					}
					const folded = frame.end();
					close(f, folded);
					return folded.wrote ? { status: 'applied', ids: p.ids } : NOOP;
				})
			);
		};

		/** The one serializer (L14): `id`'s subtree in the public `JSONBlock` shape. */
		const blockJSON = (id: BlockId): JSONBlock => {
			const type = blockTypeOf(id);
			// A registered block always has a type once its updates are all in (UW-01):
			// `''` is the absent-id shape, or an out-of-order delivery's transient.
			if (DEV && type === undefined && M.blockNodeOf(doc, id) !== null && !holdsPending(doc))
				throw new Error(`[edytor-doc] block ${id} has no type`);
			const block: JSONBlock = {
				type: type ?? '',
				id,
				data: (blockDataOf(id) ?? {}) as JSONBlock['data']
			};
			const content = runsView.contentJSON(id) as JSONBlock['content'] & unknown[];
			if (content.length > 0) block.content = content;
			const children = childrenIds(id);
			if (children.length > 0) block.children = children.map(blockJSON);
			return block;
		};

		/** The doc's index, folded up to the last write (read-your-writes). */
		const view = (): ModelView => runsView.view();
		type View = ModelView;

		// ── reads ────────────────────────────────────────────────────────

		const blockTypeOf = (id: BlockId): string | undefined => {
			const t = runsView.displayType(id) ?? M.blockNodeOf(doc, id)?.getAttr(TYPE);
			return typeof t === 'string' ? t : undefined;
		};

		const blockDataOf = (id: BlockId): Record<string, unknown> | undefined => {
			const node = M.blockNodeOf(doc, id);
			const d = node && readData(node);
			// `cloneJsonSafe`: the read path stays total even when the stored
			// attr holds a non-JSON value that bypassed boundary validation
			// (raw write / remote payload) — never crash a read (R4).
			return d !== undefined && d !== null ? (cloneJsonSafe(d) as JsonObj) : undefined;
		};
		/** The document's own data (`{}` when it has none). */
		const docData = (): JsonObj => cloneJsonSafe(readData(doc.get(DOC_DATA_ROOT)) ?? {});
		/**
		 * The ids of the items of the array at `path` in a block's, an atom's
		 * or the document's data (`[]` where none is): what a path names an
		 * item by (`~…`), so it reaches that item wherever peers move it.
		 */
		const dataItemIds = (target: DataTarget, path: readonly string[]): string[] => {
			const [id, atom] =
				typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
			const node = dataNode(id && ref(id), atom && ref(atom));
			return node && Array.isArray(path) ? itemIds(node, path) : [];
		};

		/** Ordered visible children of `parent` (`null` = root) — canonical read. */
		const childrenIds = (parent: BlockId | null): BlockId[] =>
			(view().kids.get(parent) ?? []).map((k) => k.id);

		const positionOf = (id: BlockId): Destination | null => M.positionOf(doc, id);

		/** Index path from the root (`[i, j, …]`), or null when hidden/absent. */
		const pathOf = (id: BlockId): number[] | null => {
			const v = view();
			const path: number[] = [];
			let cur: BlockId | null = id;
			while (cur !== null) {
				const pos = M.positionInView(v, cur);
				if (!pos) return null;
				path.unshift(pos.index);
				cur = pos.parent;
			}
			return path;
		};

		/** Display ancestors of `id`, nearest first (`null` parent = root → stop). */
		const ancestorsOf = (id: BlockId, v: View = view()): BlockId[] => {
			const out: BlockId[] = [];
			if (!isLiveIn(v, id)) return out;
			for (let p = displayParentOf(v.own, v.placements.get(id)!, v.placements, id); p !== null; ) {
				out.push(p as BlockId);
				p = displayParentOf(v.own, v.placements.get(p as BlockId)!, v.placements, p as BlockId);
			}
			return out;
		};

		/**
		 * The replicated slot of any registered block, dead or live (the seam
		 * of a vanished endpoint, `anchors.seam`): where it displays, or would
		 * ({@link displaySlotOf}) — the raw placement when no live parent is
		 * reachable.
		 */
		const slotOf = (id: BlockId): { parent: BlockId | null; rank: string } | null => {
			const v = view();
			const pl = v.placements.get(id);
			if (!pl) return null;
			const slot = displaySlotOf(v.own, v.placements, pl, id);
			return slot.parent === DEAD ? pl : (slot as { parent: BlockId | null; rank: string });
		};

		// ── roles (island/void) ───────────────────────────────────────────

		/** The role table's answer for `id`'s shown kind (`false` without one). */
		const is = (id: BlockId, role: (type: string) => boolean): boolean => {
			const t = blockTypeOf(id);
			return t !== undefined && role(t);
		};
		const isVoid = (id: BlockId): boolean => is(id, roles.childless);
		const isIsland = (id: BlockId): boolean => is(id, roles.island);
		/** An island that holds only lines (a code block: its role says `lines`). */
		const isLines = (id: BlockId): boolean => is(id, (type) => roles.line(type) !== undefined);
		/** Nearest island-typed display ancestor of `id`, or null. */
		const islandOf = (id: BlockId, v: View = view()): BlockId | null =>
			ancestorsOf(id, v).find((a) => isIsland(a)) ?? null;
		/** True iff `id` sits strictly inside an island subtree. */
		const insideIsland = (id: BlockId, v?: View): boolean => islandOf(id, v) !== null;
		/** `id` is a line — directly in an island declared `lines` — and holds no children (FW-01). */
		const isLine = (id: BlockId): boolean => {
			const parent = positionOf(id)?.parent;
			return parent != null && isLines(parent);
		};
		/** The item kind of `id` when it is a layout (its role says `layout`): its default child. */
		const itemKindOf = (id: BlockId): string | undefined => {
			const type = blockTypeOf(id);
			return type === undefined ? undefined : roles.layout(type);
		};
		/** `id` is a layout (`layout.*`). */
		const isLayout = (id: BlockId): boolean => itemKindOf(id) !== undefined;
		/** `id` is a layout item: of its layout's item kind, directly in it (a column). */
		const isLayoutItem = (id: BlockId): boolean => {
			const parent = positionOf(id)?.parent;
			return parent != null && blockTypeOf(id) === itemKindOf(parent);
		};
		/** `id` is a layout or holds one in its shown subtree (D2, `layout.nest`). */
		const holdsLayout = (id: BlockId): boolean => isLayout(id) || childrenIds(id).some(holdsLayout);
		/** `id` is a layout item or sits inside one. */
		const insideItem = (id: BlockId, v?: View): boolean =>
			[id, ...ancestorsOf(id, v)].some(isLayoutItem);

		// ── structural capability (R5, O8): one answer in advance and at execution ──

		/**
		 * May `ids` be placed under `parent` (`null` = the root)? Every id is
		 * live, distinct and outside any island interior (island subtrees are
		 * sealed); the destination is live, neither void nor an island nor
		 * inside one, and not inside any moved block's own subtree; and every
		 * block fits it as the kind `kindOf` gives (`fits`; a move keeps its
		 * kind) or already sits in it (a reorder changes nothing a list holds:
		 * an image shed into a list still moves among its items, AW-06); and
		 * no layout, nor a block holding one, lands inside a layout item
		 * (D2, `layout.nest`).
		 * Without a `parent`: may these blocks move at all (the drag
		 * affordance). The move ops refuse exactly when this answers `false`.
		 * (`insertBlock` is looser — island interiors are built by inserting
		 * into them.)
		 */
		const canPlace = (
			ids: readonly BlockId[],
			parent?: BlockId | null,
			kindOf: (id: BlockId) => string | undefined = blockTypeOf
		): boolean => {
			const v = view();
			if (ids.length === 0 || new Set(ids).size !== ids.length) return false;
			if (ids.some((id) => !isLiveIn(v, id) || insideIsland(id, v))) return false;
			if (parent === undefined || parent === null) return true;
			if (!isLiveIn(v, parent) || isVoid(parent)) return false;
			const stays = (id: BlockId) => positionOf(id)?.parent === parent;
			if (!ids.every((id) => stays(id) || fits(parent, kindOf(id)))) return false;
			if (insideItem(parent, v) && ids.some(holdsLayout)) return false;
			return ![parent, ...ancestorsOf(parent, v)].some((a) => isIsland(a) || ids.includes(a));
		};

		/**
		 * A container: a block that shows only its children — no content of
		 * its own, neither void nor an island (a list, a table row, a column).
		 */
		const isContainer = (id: BlockId): boolean =>
			!rendersContent(id) && !isVoid(id) && !isIsland(id);
		/**
		 * THE container rule (ZW-01, ZW-14): may a block of `kind` sit directly
		 * under `parent` (`null` = the root)? A container whose default child is
		 * a kind of its own — its item (a list's `list-item`, a columns
		 * layout's `column`) — holds only its items, and containers of them
		 * when the item renders content (a list directly in a list, from JSON
		 * or the API; a layout holds no layout, `layout.fits`); one whose
		 * default child is the document's (a column) holds any block. Every
		 * structural placement asks it: a move is refused where its blocks do
		 * not fit (`canPlace`), Tab nests under a container's last item
		 * (`nestParent`), an outdent or a lift is refused where the block would
		 * not fit, and a block a merge, delete or range sheds into a container
		 * takes its item kind when it is a plain block (`fitted`). Explicit kind
		 * writes (`insertBlocks`, a retype) place what they are told (the
		 * view's Turn into places the kind where it fits first, `liftOut`); a
		 * plain block stored directly in a list still shows as its item (the
		 * index's `typeOf`, AW-04), whatever write or race put it there.
		 */
		const fits = (parent: BlockId | null, kind: string | undefined): boolean =>
			parent === null || fitsIn(blockTypeOf(parent) ?? '', kind);
		/** `fits`, by the parent's kind (a block not written yet: `placeBeside`'s new item). */
		const fitsIn = (parentType: string, kind: string | undefined): boolean => {
			if (!roles.container(parentType)) return true;
			const item = roles.defaultChild(parentType);
			if (item === defaultChild(null) || kind === item) return true;
			return (
				kind !== undefined &&
				roles.container(kind) &&
				roles.defaultChild(kind) === item &&
				rendersContentOf(item)
			);
		};
		/**
		 * `kind`, or — where a plain block (the document's default kind, or
		 * none: a pasted run) does not fit `parent` — `parent`'s item, when
		 * that renders content (a paragraph landing in a list is its item; one
		 * in a columns layout keeps its kind: its text never vanishes). Any
		 * other kind keeps its kind and data wherever a merge, a delete or a
		 * paste sheds it — an image under a bullet stays an image, a heading a
		 * heading, a to-do keeps its check (DR-crdt-1) — as a peer's
		 * concurrent promotion shows it (`typeOf` resets only the default
		 * kind); an outdent or a move that would place one directly in a list
		 * is refused (`fits`).
		 */
		const fitted = (parent: BlockId | null, kind: string | undefined): string | undefined => {
			if (fits(parent, kind) || (kind !== undefined && kind !== defaultChild(null))) return kind;
			const item = defaultChild(parent);
			return rendersContentOf(item) ? item : kind;
		};
		/** A container that goes once it loses every child: it holds no text of its own (a peer's retype can leave some, hidden: it renders none). */
		const emptiable = (id: BlockId): boolean => isContainer(id) && displayLength(id) === 0;
		/**
		 * Where `ids` nest when nested into `parent` (Tab, a drop inside it):
		 * `parent`, or — a container they are no items of — its last child,
		 * and so on down. Tab after a list nests under its last item (Notion);
		 * a last child that holds no children (an image, a code block) is
		 * answered as it is, and `canPlace` refuses it, as Tab right under
		 * that block is refused (AW-07).
		 */
		const nestParent = (ids: readonly BlockId[], parent: BlockId): BlockId => {
			let at = parent;
			while (!ids.every((id) => fits(at, blockTypeOf(id)))) {
				const last = childrenIds(at).at(-1);
				if (last === undefined) break;
				at = last;
			}
			return at;
		};

		/**
		 * May `fromId`'s content merge into `intoId`? Both live and distinct,
		 * neither void, `intoId` renders its content (a list, a table row or a
		 * code block shows none, so a first item, cell or line never merges
		 * into it — XW-12, DR-crdt-2), `fromId` renders its own unless it is
		 * an island (a list or a row never merges as a whole: its items would
		 * leave it — YW-02), and the merge stays on one side of an island
		 * boundary (a block may merge into its own island root — that stays
		 * inside — but nothing from outside merges into an island).
		 */
		const canMerge = (fromId: BlockId, intoId: BlockId): boolean => {
			const v = view();
			if (fromId === intoId || !isLiveIn(v, fromId) || !isLiveIn(v, intoId)) return false;
			if (isVoid(fromId) || isVoid(intoId)) return false;
			if (!rendersContent(intoId) || !(rendersContent(fromId) || isIsland(fromId))) return false;
			const islandFrom = islandOf(fromId, v);
			if (intoId === islandFrom) return true;
			return islandFrom === islandOf(intoId, v) && !isIsland(intoId);
		};

		/** `id`'s shown kind renders its content (R5, O22). */
		const rendersContent = (id: BlockId): boolean => rendersContentOf(blockTypeOf(id) ?? '');

		/** The adopted default child type under `parent` (`null` = the root). */
		const defaultChild = (parent: BlockId | null): string =>
			roles.defaultChild(parent === null ? null : (blockTypeOf(parent) ?? null));
		/**
		 * The kind a new block copies from `id` (a split tail, a flow's tail,
		 * a duplicate and each of its descendants). A type a peer's retype is
		 * replacing can be missing while its new value is pending: the copy
		 * then takes its parent's default child, never a missing type
		 * (SW7-crdt-1, DR-crdt-1: it showed as `unknown` everywhere, for good).
		 */
		const kindToCopy = (id: BlockId): string =>
			blockTypeOf(id) ?? defaultChild(positionOf(id)?.parent ?? null);

		// ── document order (O7): one pre-order over visible blocks ────────

		/** The document order — `view().order`, shared by every consumer. */
		const order = (): readonly BlockId[] => view().order.ids;

		/**
		 * Compare two blocks in document order (negative: `a` first). A block
		 * that is not visible sorts after every visible one.
		 */
		const compare = (a: BlockId, b: BlockId): number => {
			const { at } = view().order;
			return (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || 0;
		};

		/**
		 * The neighbour of `id` in document order (`dir` 1: next, -1: previous).
		 * `sealed` is the island-sealing policy (R5): the walk never enters an
		 * island it did not start in — from outside, an island is one unit
		 * (its root is visited, its interior skipped); from inside, the walk
		 * may leave. Operations that need the seal pass it; the order itself
		 * is never re-derived.
		 */
		const step = (id: BlockId, dir: 1 | -1, policy?: OrderPolicy): BlockId | null => {
			const v = view();
			const { ids, at } = v.order;
			const i = at.get(id);
			if (i === undefined) return null;
			const open = policy?.sealed ? new Set(ancestorsOf(id, v)) : null;
			for (let j = i + dir; j >= 0 && j < ids.length; j += dir) {
				const island = open && islandOf(ids[j], v);
				if (!island || open!.has(island)) return ids[j];
			}
			return null;
		};
		const next = (id: BlockId, policy?: OrderPolicy) => step(id, 1, policy);
		const previous = (id: BlockId, policy?: OrderPolicy) => step(id, -1, policy);

		// ── change events ─────────────────────────────────────────────────

		let changeVersion = 0;
		const subs = new Set<(change: DocChange) => void>();
		let unsubscribe: (() => void) | null = null;
		/** One `DocChange` per commit, from the index's change report (the fold). */
		const emitChange = (report: IndexReport, origin: unknown, local: boolean): void => {
			// R5 listener isolation: a throwing subscriber never starves the rest.
			callEach('[edytor-doc] change', [...subs], {
				origin,
				local,
				version: ++changeVersion,
				...report
			});
		};

		/**
		 * Subscribe to semantic changes — one {@link DocChange} per committed
		 * transaction that changed the visible document, local and remote.
		 * No writes, ever. Returns an unsubscribe; with no subscriber left the
		 * index stops building reports.
		 * One named exception: the composition session's D-20 commit
		 * (`session/composition` `restructured`) writes from its subscriber —
		 * safe because the engine queues a transaction opened in an `update`
		 * handler until the current one finishes, so every listener sees the
		 * structural change's report first and the commit's report after it.
		 */
		const onChange = (cb: (change: DocChange) => void): (() => void) => {
			subs.add(cb);
			unsubscribe ??= runsView.onReport(emitChange);
			return () => {
				subs.delete(cb);
				if (subs.size === 0) {
					unsubscribe?.();
					unsubscribe = null;
				}
			};
		};

		const dispose = (): void => {
			disposed = true;
			unsubscribe?.();
			unsubscribe = null;
			subs.clear();
			// The doc's index lives as long as the doc — other facades on it
			// keep reading it.
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
		type UndoStep = { inserts: IdSetLike; deletes: IdSetLike };
		/** The single-value attrs a history step must never leave undefined. */
		const REPAIRED: Record<string, readonly string[]> = {
			[BLOCK_NODE]: [TYPE, DATA, LAST_CHANGED_ATTR],
			[INLINE_NODE]: [TYPE, DATA]
		};
		/**
		 * Undo repair (UW-01), inside the history transaction. A popped step
		 * deletes its own attr write and re-creates the value that write
		 * overwrote — unless a concurrent write sits between them, where the
		 * engine refuses the restore (the peer's value was deleted at
		 * integration). The attr is then undefined on every replica. For each
		 * block/atom attr the step overwrote whose tip is now deleted, write
		 * back the overwritten value from the step's own `deletes`: undo
		 * reverts to what this writer overwrote (`lastChangedBy` to the
		 * previous author), and the repair syncs like any write.
		 */
		const repairAttrs = (step: UndoStep): void => {
			const lost = new Map<EngineNode, Map<string, unknown>>();
			walkIdSetStructs(Y, doc, step.deletes, (s) => {
				const node = s.parent as EngineNode;
				const key = s.parentSub;
				if (key === null) return;
				if (!key.startsWith(DATA_LEAF_PREFIX) && !REPAIRED[node?.name]?.includes(key)) return;
				if (step.inserts.has(s.id.client, s.id.clock)) return;
				const values = (s as unknown as { content: { getContent(): unknown[] } }).content;
				let attrs = lost.get(node);
				if (attrs === undefined) lost.set(node, (attrs = new Map()));
				attrs.set(key, values.getContent().at(-1));
			});
			for (const [node, attrs] of lost) {
				if (node._item?.deleted) continue;
				for (const [key, value] of attrs)
					if (node.getAttr(key) === undefined) node.setAttr(key, value);
			}
		};

		const createUndoManager = (
			options: ConstructorParameters<EngineApi['UndoManager']>[1] & { limit?: number } = {}
		): YUndoManager => {
			if (disposed) {
				throw new EdytorDocDisposedError('createUndoManager');
			}
			const { limit = DEFAULT_HISTORY_LIMIT, ...opts } = options;
			write(() => {
				if (!isInitialized(doc)) init(doc);
			});
			// Text delete marks (P11): the marks are in scope (an undo removes the
			// undoer's own), and the history restores text only as the marks allow.
			// An undone creation withdraws the block instead of deleting it (P12).
			const marks = D.history(doc, () => um);
			const um: YUndoManager = new Y.UndoManager(
				[M.registryOf(doc), D.scope(doc), doc.get(DOC_DATA_ROOT)] as unknown as YNode[],
				{
					...opts,
					...marks,
					onApply: (tr: unknown, step: UndoStep) => {
						marks.onApply(tr, step);
						repairAttrs(step);
					},
					withdraw: M.withdrawOnUndo(doc)
				} as never
			) as YUndoManager;
			// A streamless block's own text (R2) is shared by every replica that
			// typed into it first: no history step captures it, so undoing the
			// first typing removes the typing and keeps the text (and nonce).
			const skipOwnText = ({ stackItem }: { stackItem: { inserts: unknown } }): void => {
				const ids = ownTextIds.get(doc);
				if (ids !== undefined)
					stackItem.inserts = Y.diffIdSet(stackItem.inserts as never, ids as never);
			};
			um.on('stack-item-added', skipOwnText as never);
			um.on('stack-item-updated', skipOwnText as never);
			// P6: the undo stack keeps its newest `limit` steps. A step that
			// falls off releases what it kept for its undo (its deleted items),
			// and the engine collects their content now, as it would have at
			// the delete without a history (the doc's `gcFilter` still decides:
			// a text copy another replica may have to copy again stays, P11).
			// Only the items themselves are released: a kept container's flag
			// may guard a newer step's items inside it.
			const trim = ({ type }: { type: string }): void => {
				const over = um.undoStack.length - limit;
				if (type !== 'undo' || !(over > 0)) return;
				const dropped = um.undoStack.splice(0, over) as unknown as UndoStep[];
				const gc = (doc as unknown as { gc: boolean }).gc;
				const keepIt = (doc as unknown as { gcFilter: (it: unknown) => boolean }).gcFilter;
				doc.transact((tr) => {
					for (const step of dropped)
						Y.iterateStructsByIdSet(tr as never, step.deletes as never, (s: unknown) => {
							const it = s as { keep?: boolean; deleted: boolean; content?: unknown; gc?: unknown };
							if (it.content === undefined || it.keep !== true) return;
							it.keep = false;
							if (gc && it.deleted && keepIt(it))
								(it as unknown as { gc(tr: unknown, parentGCd: boolean): void }).gc(tr, false);
						});
				}, HISTORY_TRIM);
			};
			um.on('stack-item-added', trim as never);
			// Lineage for undo/redo (O19, F4): the replay displaces the state
			// every block the popped stack item touches, so each one's subtree
			// is captured (`force`: lost whoever owns `l`) from the history
			// transaction's own `beforeTransaction`, before the replay writes.
			// The ring writes join that transaction — one update per undo —
			// and sit outside the manager's scope, so the replay never undoes
			// or re-captures them. Nothing else is stamped for undo/redo: the
			// engine's replay restores `l`, and `contributors` are add-only.
			// An undo run inside an enclosing transaction gets no lineage (it
			// is a defect of its own: it empties the redo stack, F4).
			if (lineageDepth > 0) {
				const onBefore = (tr: { origin: unknown }): void => {
					const stack = um.undoing ? um.undoStack : um.redoing ? um.redoStack : [];
					const item = stack[stack.length - 1] as { inserts?: unknown; deletes?: unknown };
					if (tr.origin !== um || item === undefined || actorOf() === undefined) return;
					try {
						const touched = new Set<BlockId>();
						for (const idSet of [item.inserts, item.deletes]) {
							walkIdSetStructs(Y, doc, idSet as IdSetLike, (s) => {
								let n: unknown = s.parent;
								while (isNodeLike(n)) {
									const bid = n.name === BLOCK_NODE ? n.getAttr(ID) : undefined;
									if (typeof bid === 'string') return void touched.add(bid);
									n = n._item?.parent;
								}
							});
						}
						for (const bid of touched) {
							const pending = lineagePending(bid, true);
							if (pending !== undefined) BA.appendLineage(doc, bid, pending, lineageDepth);
						}
					} catch (err) {
						// Throwing here would leave the engine's transaction open.
						console.error('[edytor-doc] undo lineage capture failed', err);
					}
				};
				(doc as unknown as { on(e: 'beforeTransaction', f: typeof onBefore): void }).on(
					'beforeTransaction',
					onBefore
				);
			}
			return um;
		};

		/** Display length (UTF-16 units + inline atoms) of `id`'s content, read-your-writes. */
		const displayLength = (id: BlockId): number => ownedLength(view().own.display(id) ?? []);

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
		const contentItems = (id: BlockId): ContentItem[] => runsView.contentItems(id);

		/** Registry membership — the block exists (may be delete-marked or merged away). */
		const hasBlock = (id: BlockId): boolean => M.blockNodeOf(doc, id) !== null;

		/** The one liveness answer (`M.isLive`): `id` renders in `project()`. O(depth). */
		const live = (id: BlockId): boolean => M.isLive(doc, id);
		/** A live block that can hold content: it has a claims list (a streamless block gets its own text on first write). */
		const contentTarget = (id: BlockId): boolean =>
			live(id) && view().blocks.get(id)?.claimsNode !== undefined;

		// ── anchors (R4) ─────────────────────────────────────────────────
		// An anchor is the home text id plus a relative position; the stream
		// containing the position says which block displays it. Both reads use
		// the index folded up to the last write, so they hold mid-transaction.

		/**
		 * Display offset in `blockId` → anchor. `'left'` binds the unit before
		 * the position (a caret, a range end: an insert there lands right of
		 * it; at a split-born block's start that unit is the block's boundary),
		 * `'right'` the unit at it (a range start). A streamless block with no
		 * claim binds its own future text's start. `null` for an unknown id.
		 */
		const anchorAt = (
			blockId: BlockId,
			offset: number,
			affinity: AnchorAffinity = 'left'
		): DocAnchor | null => {
			const { blocks, own } = view();
			if (!blocks.has(blockId)) return null;
			// A merged-away or deleted block's items still bind: the anchor
			// follows them to whichever block displays them (or to the seam).
			const segs = displayOf(blockId, blocks, own, undefined, true)!;
			const assoc = affinity === 'left' ? -1 : 0;
			const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))), affinity);
			if (hit === null) return { b: blockId, a: { i: null, a: assoc } };
			return { b: hit.seg.t, a: T.anchorAt(hit.seg.text, hit.idx, assoc) };
		};

		/**
		 * `anchor` rebound to the copy this replica's last undo/redo
		 * re-created of its item (the local `redone` chain): history restores
		 * a selection recorded before a delete through it, so the anchor
		 * binds the restored content instead of its tombstone.
		 */
		const followUndo = (anchor: DocAnchor): DocAnchor => {
			const i = anchor.a.i;
			if (i === null) return anchor;
			const to = followRedone(Y, doc, { client: i.c, clock: i.k });
			return to.client === i.c && to.clock === i.k
				? anchor
				: { ...anchor, a: { ...anchor.a, i: { c: to.client, k: to.clock } } };
		};

		/**
		 * Anchor → `{blockId, offset}` in the block that displays it now: the
		 * position's stream (the one whose delimiting boundary precedes it) and
		 * its display owner. `null` when the item is not integrated yet or the
		 * stream is not displayed (its block deleted or hidden) — the caller
		 * falls back to the seam.
		 */
		const resolveAnchor = (anchor: DocAnchor): { blockId: BlockId; offset: number } | null => {
			const { blocks, own } = view();
			const text = blocks.get(anchor.b)?.content;
			if (text === undefined) {
				// A streamless block's own text does not exist yet: its start.
				return anchor.a.i === null && own.display(anchor.b)?.length === 0
					? { blockId: anchor.b, offset: 0 }
					: null;
			}
			const i = T.resolveAnchor(doc, text, anchor.a);
			if (i === null) return null;
			const s = own.streamAt(anchor.b, i);
			const owner = s === undefined ? DEAD : own.ownerOf(s.block);
			if (typeof owner !== 'string' || !isLiveIn(view(), owner)) return null;
			let offset = 0;
			for (const seg of own.display(owner) ?? []) {
				if (seg.block === s!.block && seg.i0 <= i && i <= seg.i1)
					return { blockId: owner, offset: offset + i - seg.i0 };
				offset += seg.i1 - seg.i0;
			}
			return null;
		};

		/** A replacement content item normalized at ingress. */
		const sanitizeItem = (item: ContentItem): ContentItem =>
			item.kind === 'text'
				? {
						kind: 'text',
						text: ref(item.text),
						...(item.marks && { marks: sanitizeWireJson(item.marks) })
					}
				: sanitizeInline(item);
		const sanitizeInline = <I extends InlineSpec>(item: I): I => ({
			...item,
			id: ref(item.id),
			type: ref(item.type),
			...(item.data !== undefined && { data: sanitizeWireJson(item.data) })
		});

		// ── prepared ops (R6) ─────────────────────────────────────────────
		// Every op is `prepare` (pure: `refused`, or a plan of named steps plus
		// its effect summary, against the current version) then `apply(plan)`;
		// composites compose their steps into one plan, so a hook sees the
		// whole command before any write and a refusal refuses before one.
		// Each prepare normalizes its inputs once, here at ingress (O1): ids
		// and strings as the wire would deliver them, payloads cloned.

		const REFUSED = refused(null);
		/** `exitRanks` parts, in their order at one block. */
		const [HEAD, KEPT, WITH, SELF, AFTER] = [0, 1, 2, 3, 5];
		const plan = (ids: readonly BlockId[], writes: PlanStep[]): Plan => ({
			ids,
			writes,
			effect: effectOf(writes),
			version: runsView.version()
		});

		/** This client's next clock: what its source ranks are tied by (`sourceRank`, DW-05). */
		const clock = () => doc.store?.getClock(doc.clientID) ?? 0;
		/**
		 * `count` ranks at `index` among `parent`'s children, the moving
		 * `exclude` left out. `run`: new blocks, which extend this client's run
		 * after a block it ranked (H1, `order.insert.run`); a move never does
		 * (the rank-growth guard).
		 */
		const ranksFor = (
			parent: BlockId | null,
			index: number,
			count: number,
			exclude: readonly BlockId[] = [],
			run = false
		): string[] => {
			const v = view();
			const all = v.kids.get(parent) ?? [];
			// The moving blocks' own slots left out: index → the list's index past them.
			const gone = exclude
				.map((id) => M.positionInView(v, id))
				.filter((p) => p !== null && p.parent === parent)
				.map((p) => p!.index)
				.sort((a, b) => a - b);
			const raw = (i: number) => {
				for (const g of gone) if (g <= i) i++;
				return i;
			};
			const at = Math.max(0, Math.min(index, all.length - gone.length));
			const pair = [at > 0 ? all[raw(at - 1)] : undefined, all[raw(at)]];
			return M.ranksAt(
				pair as readonly { rank: string }[],
				1,
				count,
				doc.clientID,
				randOf(doc),
				run
			);
		};
		/**
		 * Move `ids` to `ranks` under `parent` (`index`: the slot hooks see).
		 * Every planned move carries the type steps that keep what the moved
		 * blocks show: one displayed out of an island as another kind than its
		 * stored one (`displayType`) gets that kind written, so leaving the
		 * island's slot never brings the island's child kind back (RW-01).
		 */
		const moveTo = (
			ids: BlockId[],
			parent: BlockId | null,
			index: number,
			ranks: string[]
		): PlanStep[] =>
			ids.length === 0
				? []
				: [
						{ op: 'moveBlocks', ids, parent, index, ranks },
						...ids.flatMap((id) => {
							const shown = runsView.displayType(id);
							return shown === undefined ? [] : attr(id, TYPE, shown);
						})
					];
		/** Move `ids` to `index` among `parent`'s children. */
		const move = (ids: BlockId[], parent: BlockId | null, index: number): PlanStep[] =>
			moveTo(ids, parent, index, ranksFor(parent, index, ids.length, ids));
		/**
		 * Ranks for blocks leaving `outer` for the gap right before it (`after`:
		 * right after it), in the order they come from (`sourceRank`, CW-01):
		 * two peers that split or lift out of the same list at once keep the
		 * text in its order, whatever their client ids. Each part names the
		 * block in `outer` it stands at (`at`; one that shows no text of its
		 * own, a list, stands at its first item) and its `part` there:
		 * - `HEAD`: a new list holding the items before `at`;
		 * - `KEPT`, index: a block placed after the items before `at`, which
		 *   stay (a divider inserted after an item: a peer's head that takes
		 *   them sorts before it);
		 * - `WITH`: a new list holding the items before `at` and `at` (`keep`);
		 * - `SELF`: `at` itself leaving (`SELF + 1` when it stands at its first item);
		 * - `AFTER`, index: a block placed after it.
		 * A degenerate gap ranks them as any insert.
		 */
		const exitRanks = (
			outer: BlockId,
			after: boolean,
			parts: readonly { at: BlockId; part: readonly number[] }[]
		): string[] => {
			const { kids } = view();
			const { parent, index } = positionOf(outer)!;
			const sibs = kids.get(parent) ?? [];
			const gap = after ? index + 1 : index;
			const ranks: string[] = [];
			for (let { at, part } of parts) {
				const own = at;
				while (!rendersContent(at) && childrenIds(at).length > 0) at = childrenIds(at)[0]!;
				if (part[0] === SELF && at !== own) part = [SELF + 1];
				const path: string[] = [];
				for (let c = at; c !== outer; c = positionOf(c)!.parent!) {
					const pos = positionOf(c)!;
					path.unshift(kids.get(pos.parent)![pos.index]!.rank);
				}
				const side = after ? SOURCE_SIDE.after : SOURCE_SIDE.before;
				const rank = sourceRank(
					sibs[gap - 1]?.rank,
					sibs[gap]?.rank,
					side,
					path,
					part,
					doc.clientID,
					clock()
				);
				if (rank === null) return ranksFor(parent, gap, parts.length);
				ranks.push(rank);
			}
			return ranks;
		};
		/**
		 * Ranks for the `count` blocks a split of `id` at `at` puts right after
		 * it (Enter, a paste of several lines), by where it splits
		 * (SW12-crdt-1, SW12-crdt-4): two peers splitting one block at once
		 * keep its pieces in text order, whatever their client ids. Counted
		 * from the end — the text after the split point, most first — so a
		 * peer's own edit before its split point (typing, then Enter; a paste
		 * over a selection) does not move it (DR-crdt-7); an unseen edit after
		 * it does (the residual, in the delete contract).
		 */
		const pieceRanks = (id: BlockId, at: number, count: number): string[] => {
			const { parent, index } = positionOf(id)!;
			const sibs = view().kids.get(parent) ?? [];
			const ranks: string[] = [];
			for (let i = 0; i < count; i++) {
				const rank = sourceRank(
					sibs[index]?.rank,
					sibs[index + 1]?.rank,
					SOURCE_SIDE.pieces,
					[],
					[at - displayLength(id), i],
					doc.clientID,
					clock()
				);
				if (rank === null) return ranksFor(parent, index + 1, count);
				ranks.push(rank);
			}
			return ranks;
		};
		/** `exitRanks` for `ids` themselves leaving `outer`. */
		const leaving = (outer: BlockId, after: boolean, ids: readonly BlockId[]) =>
			exitRanks(
				outer,
				after,
				ids.map((at) => ({ at, part: [SELF] }))
			);
		/**
		 * A type step, planned only when the kind differs (the one same-value
		 * guard). A kind counts as the same only when the block is stored and
		 * shown as it: a move in the same plan pins the kind a block shows
		 * (`moveTo`), so a paragraph shown as its list's item (`itemOf`) that
		 * an outdent settles back to a paragraph is written back (DR-crdt-3).
		 */
		const attr = (id: BlockId, key: typeof TYPE, value: string): PlanStep[] => {
			const same = M.blockNodeOf(doc, id)!.getAttr(key) === value;
			if (same && (runsView.displayType(id) ?? value) === value) return [];
			return [{ op: 'setBlockType', id, type: value }];
		};
		/**
		 * The data step of `patches` (sanitized) on a block, one of its atoms or
		 * the document (`crdt/data.ts`): none when it changes nothing, `null`
		 * when a patch is refused.
		 */
		const dataSteps = (target: DataTarget, patches: DataPatch[]): PlanStep[] | null => {
			const [id, inlineId] =
				typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
			const node = dataNode(id, inlineId);
			// A block kind's atomic paths are written as one leaf each (`data.atomic`, H8).
			const type = inlineId === undefined && id !== undefined ? blockTypeOf(id) : undefined;
			const atomic = (type === undefined ? undefined : roleOf(type)?.atomic) ?? [];
			const leaves = node
				? patchWrites(
						node,
						patches,
						doc.clientID,
						randOf(doc),
						atomic.map((p) => leafKey(typeof p === 'string' ? [p] : p))
					)
				: [];
			if (leaves === null) return null; // a patch fits no value there
			if (leaves.length === 0) return [];
			const offset = inlineId === undefined ? undefined : atomOf(id!, inlineId)?.at;
			return [
				{
					op: 'patchData',
					...(id !== undefined && { id }),
					...(inlineId !== undefined && { inlineId, offset }),
					ops: patches,
					leaves
				}
			];
		};
		/** A whole-data replace: a patch of the root. */
		const replaceData = (data: unknown): DataPatch[] => [
			{ path: [], value: sanitizeWireJson(data) }
		];
		/**
		 * `data`'s leaves as sets over `current` (`data.retype.keep`, H4): a
		 * plain object's keys, recursively where `current` holds an object
		 * there too; anything else (an array, a primitive, an empty object, an
		 * object where `current` holds none) as one value at its path. Nothing
		 * else under the root is touched.
		 */
		const leafSets = (data: unknown, current: unknown): DataPatch[] => {
			const out: DataPatch[] = [];
			const plainObject = (v: unknown): v is Record<string, unknown> =>
				v !== null && typeof v === 'object' && !Array.isArray(v);
			const walk = (v: unknown, at: unknown, path: string[]): void => {
				if (plainObject(v) && Object.keys(v).length > 0 && (path.length === 0 || plainObject(at)))
					for (const [k, x] of Object.entries(v))
						walk(x, plainObject(at) ? at[k] : undefined, [...path, k]);
				else if (path.length > 0) out.push({ path, value: v });
			};
			walk(sanitizeWireJson(data), current, []);
			return out;
		};
		/**
		 * The kind `kid` shows once it leaves `from` for a slot under `parent`
		 * — the island and container rules, one answer:
		 * - an island's child takes `parent`'s default child (it leaves the
		 *   island's kinds) — unless that renders no content while the child
		 *   does: a line then takes the document's default kind (a code line
		 *   shed into a columns layout is a paragraph, AW-05), any other child
		 *   keeps its kind, as `typeOf` shows one a peer adds meanwhile;
		 * - a container's item (its default child) takes `parent`'s default
		 *   child — an item never shows outside its list (YW-02) — unless it
		 *   stays inside an outer container of that kind (a nested list,
		 *   SW8-roles-4), or that kind renders no content (a column in a
		 *   columns layout: its text would vanish, DR-crdt-1);
		 * - then a plain block that does not fit `parent` (`fits`: a paragraph
		 *   shed into a list) becomes its item, when that item renders content
		 *   (ZW-01, `fitted`). A block that cannot (a paragraph in a columns
		 *   layout) keeps its kind: its text never vanishes; any other kind (an
		 *   image, a code block, a heading) keeps its kind (DR-crdt-1).
		 */
		/**
		 * The kind a child of `island` (now `kind`) takes where the default
		 * child is `to`: `to` — unless `to` renders no content while the child
		 * does (its text would vanish): a line then takes the document's
		 * default kind, any other child keeps its kind (AW-05, as `typeOf`).
		 */
		const leavingIsland = (island: BlockId, kind: string | undefined, to: string) => {
			if (rendersContentOf(to) || (kind !== undefined && !rendersContentOf(kind))) return to;
			return is(island, (type) => roles.line(type) !== undefined) ? defaultChild(null) : kind;
		};
		const settledKind = (
			from: BlockId | null,
			kid: BlockId,
			parent: BlockId | null
		): string | undefined => {
			let kind = blockTypeOf(kid);
			if (from !== null && isIsland(from)) kind = leavingIsland(from, kind, defaultChild(parent));
			else if (from !== null && isContainer(from) && kind === defaultChild(from)) {
				const within = parent === null ? [] : [parent, ...ancestorsOf(parent)];
				const to = defaultChild(parent);
				// An outer container of its kind keeps it an item (a nested list); a
				// column's default child is the document's: it holds no items of its own.
				const outer =
					kind !== defaultChild(null) &&
					within.some((a) => isContainer(a) && defaultChild(a) === kind);
				if (!outer && rendersContentOf(to)) kind = to;
			}
			return fitted(parent, kind);
		};
		/** The kind steps for the `kids` of `from` (`null`: the root) landing under `parent` (`settledKind`). */
		const settle = (
			from: BlockId | null,
			kids: readonly BlockId[],
			parent: BlockId | null
		): PlanStep[] =>
			kids.flatMap((kid) => {
				const kind = settledKind(from, kid, parent);
				return kind === undefined || kind === blockTypeOf(kid) ? [] : attr(kid, TYPE, kind);
			});
		/** `parent` and its display ancestors: where blocks landing under `parent` keep alive. */
		const landing = (parent: BlockId | null): Set<BlockId | null> =>
			new Set(parent === null ? [] : [parent, ...ancestorsOf(parent)]);
		/**
		 * `writes`, then every container one of `from` (the blocks' former
		 * parents) is left with no child but `leaving` removed
		 * (`del.range.empty-container`), and so on upward — never one of
		 * `kept`, and only an `emptiable` one (a container holding text of its
		 * own stays). The containers are found together, deepest first: a
		 * list that loses its last item along with a list nested in it goes
		 * too (SW9-containers-2). Then every layout the plan leaves with one
		 * item or none dissolves (`dissolving`); `removed`: blocks the plan
		 * deletes besides (a block delete's members), which only that counts.
		 */
		const emptyingAll = (
			from: readonly (BlockId | null)[],
			leaving: readonly BlockId[],
			writes: readonly PlanStep[],
			kept: ReadonlySet<BlockId | null> = new Set(),
			removed: readonly BlockId[] = []
		): PlanStep[] => {
			const gone = new Set<BlockId>(leaving);
			const tops: BlockId[] = [];
			const deepest = [...new Set(from)]
				.filter((c): c is BlockId => c !== null)
				.sort((a, b) => ancestorsOf(b).length - ancestorsOf(a).length);
			for (const start of deepest) {
				let top: BlockId | null = null;
				for (
					let c: BlockId | null = start;
					c !== null && !gone.has(c) && !kept.has(c) && emptiable(c);
					c = positionOf(c)!.parent
				) {
					if (!childrenIds(c).every((kid) => gone.has(kid))) break;
					gone.add((top = c));
				}
				if (top !== null) tops.push(top);
			}
			const roots = tops.filter((t) => !ancestorsOf(t).some((a) => tops.includes(a)));
			const steps = [...writes, ...roots.map((t) => remove(t, leaving))];
			for (const id of removed) gone.add(id);
			return [...steps, ...dissolving(gone, leaving, steps)];
		};
		/**
		 * `layout.dissolving`: the steps that delete each layout a plan leaves
		 * with one item or none — `gone` (blocks the plan removes) and
		 * `leaving` (blocks it moves) no longer count, an item `writes` move or
		 * insert into it does. With one left, the layout and that item are
		 * deleted and the item's children moved to the layout's slot at the
		 * rank `layout.single` reads (`promotedRank` of the layout's, then the
		 * item's), as the kind they show there (`settle`); with none, the
		 * layout is deleted. One plan with the write that caused it.
		 */
		const dissolving = (
			gone: ReadonlySet<BlockId>,
			leaving: readonly BlockId[],
			writes: readonly PlanStep[]
		): PlanStep[] => {
			const away = new Set([...gone, ...leaving]);
			const layouts = new Set<BlockId>();
			for (const id of away) {
				const parent = positionOf(id)?.parent;
				if (parent != null && isLayout(parent)) layouts.add(parent);
			}
			const { kids } = view();
			const out: PlanStep[] = [];
			for (const layout of layouts) {
				if ([layout, ...ancestorsOf(layout)].some((a) => gone.has(a))) continue;
				const item = itemKindOf(layout)!;
				const arriving = writes.reduce(
					(n, w) =>
						w.op === 'moveBlocks' && w.parent === layout
							? n + w.ids.filter((id) => blockTypeOf(id) === item).length
							: w.op === 'insertBlocks' && w.parent === layout
								? n + w.specs.filter((spec) => spec.type === item).length
								: n,
					0
				);
				const slots = kids.get(layout) ?? [];
				const items = slots.filter((k) => !away.has(k.id) && blockTypeOf(k.id) === item);
				if (items.length + arriving > 1) continue;
				const { parent, index } = positionOf(layout)!;
				const rank = kids.get(parent)![index]!.rank;
				const last = items[0];
				if (last === undefined) {
					out.push(deleting(layout, [layout]));
					continue;
				}
				const moved = (kids.get(last.id) ?? []).filter((k) => !away.has(k.id));
				const ids = moved.map((k) => k.id);
				const ranks = moved.map((k) => promotedRank(rank, promotedRank(last.rank, k.rank)));
				out.push(
					...moveTo(ids, parent, index + 1, ranks),
					...settle(last.id, ids, parent),
					deleting(layout, [layout, last.id])
				);
			}
			return out;
		};
		/** `writes`, then `container` removed when they leave it no child but `leaving` (`emptyingAll`). */
		const emptying = (
			container: BlockId,
			leaving: readonly BlockId[],
			writes: readonly PlanStep[],
			kept?: ReadonlySet<BlockId | null>
		): PlanStep[] => emptyingAll([container], leaving, writes, kept);
		/**
		 * Delete (R3): `removes` leave. Every one is marked with what it
		 * displays — an unmarked one would be promoted into the deleted slot
		 * (`displaySlotOf`).
		 */
		const deleting = (id: BlockId, removes: BlockId[]): PlanStep => {
			const marks = [...new Set(removes.flatMap((b) => view().displays(b)))];
			return { op: 'deleteBlock', id, marks, removes };
		};
		/** Delete `id` and its subtree, `kept` children aside. */
		const remove = (id: BlockId, kept: readonly BlockId[] = []): PlanStep => {
			const removes: BlockId[] = [];
			const skip = new Set(kept);
			const walk = (b: BlockId): void => {
				removes.push(b);
				for (const kid of childrenIds(b)) if (!skip.has(kid)) walk(kid);
			};
			walk(id);
			return deleting(id, removes);
		};
		const merge = (from: BlockId, into: BlockId): PlanStep => ({
			op: 'mergeBlocks',
			from,
			into,
			at: displayLength(into),
			length: displayLength(from)
		});
		/** `[at, end)` — `[offset, offset + length)` clamped to `id`'s display. */
		const clamp = (id: BlockId, offset: number, length: number): [number, number] => {
			const total = displayLength(id);
			const at = Math.max(0, Math.min(offset, total));
			return [at, Math.min(total, at + Math.max(0, length))];
		};
		/** `id`'s display items, each with its `[at, end)` display offsets. */
		const spans = (id: BlockId) => {
			let end = 0;
			return contentItems(id).map((item) => {
				const at = end;
				end += item.kind === 'text' ? item.text.length : 1;
				return { item, at, end };
			});
		};
		/** The live inline atom `atom` in `id`'s display, or undefined. */
		const atomOf = (id: BlockId, atom: string) =>
			live(id)
				? spans(id).find(({ item }) => item.kind === 'inline' && item.id === atom)
				: undefined;
		/** Text items overlapping `[at, end)` of `id` (inline atoms carry no marks). */
		const textIn = (id: BlockId, at: number, end: number) =>
			spans(id).flatMap((s) =>
				s.item.kind === 'text' && s.at < end && s.end > at ? [s.item] : []
			);

		/**
		 * Insert blocks (specs may carry children/content/data — ids are
		 * caller-assigned and must be fresh; the batch is all-or-nothing).
		 * Refused when the parent is not live, is `void` or is an island's
		 * line (it holds no children), or any id collides.
		 * Inserting INSIDE an island is allowed — island interiors are built
		 * this way. `ids`: the inserted roots.
		 */
		const insertBlocks = (dest: Destination, specs: readonly BlockSpec[]): Prepared => {
			const parent = ref(dest.parent);
			const clean = specs.map(sanitizeSpec);
			if (parent !== null && (isVoid(parent) || isLine(parent))) return REFUSED;
			if (clean.length === 0) return plan([], []);
			if ((parent !== null && !live(parent)) || M.collides(doc, clean)) return REFUSED;
			const ranks = ranksFor(parent, dest.index, clean.length, [], true);
			return plan(
				clean.map((s) => s.id),
				[{ op: 'insertBlocks', parent, index: dest.index, specs: clean, ranks }]
			);
		};

		/**
		 * Grouped move — one step, per-member conflict resolution; refused
		 * exactly when `canPlace` refuses the group. `ids`: the moved blocks,
		 * in request order.
		 */
		const moveBlocks = (ids: readonly BlockId[], dest: Destination): Prepared => {
			const moved = ids.map(ref);
			const parent = ref(dest.parent);
			if (moved.length === 0) return plan([], []);
			if (!canPlace(moved, parent)) return REFUSED;
			// A list the move leaves with no item goes (not one it moves or lands in).
			const into = new Set([...moved, ...landing(parent)]);
			return plan(moved, emptied(moved, move(moved, parent, dest.index), into));
		};
		/**
		 * Outdent (UW-23): move sibling blocks `ids` (document order) right
		 * after their parent, and hand the siblings that followed the last of
		 * them to it as its last children — every outliner's Shift+Tab. A last
		 * block that cannot adopt them (void, island, a container they do not
		 * fit) leaves them with the parent. The blocks take the kind they show
		 * in their new slot (`settledKind`: a list's item becomes a paragraph,
		 * a paragraph outdented into a list its item); refused where one would
		 * not fit (a paragraph out of a column into its columns layout, ZW-14).
		 * Items leaving a container never take the items after them (DR-crdt-3):
		 * the list splits around them, Notion's way — outdented first items go
		 * before it, last ones after it; from the middle, the list keeps the
		 * items after them and a new list of its kind takes the ones before
		 * them, so an item a peer appends meanwhile stays with the items it
		 * follows (ZW-03; `splitOut`, the split Turn into's `liftOut` makes). A
		 * container left with no child goes (YW-02). One plan; refused as the
		 * move is. `ids`: the moved blocks.
		 */
		const unNestBlocks = (ids: readonly BlockId[]): Prepared => {
			const moved = ids.map(ref);
			const last = moved.at(-1);
			const pos = last === undefined ? null : positionOf(last);
			const ppos = pos?.parent != null ? positionOf(pos.parent) : null;
			if (!ppos || moved.some((id) => positionOf(id)?.parent !== pos!.parent)) return REFUSED;
			const from = pos!.parent!;
			if (!canPlace(moved, ppos.parent, (id) => settledKind(from, id, ppos.parent))) return REFUSED;
			const after = childrenIds(from).slice(pos!.index + 1);
			const retype = settle(from, moved, ppos.parent);
			if (isContainer(from)) return splitOut(moved, [from], [], false, retype);
			const out = leaving(from, true, moved);
			const writes = [...moveTo(moved, ppos.parent, ppos.index + 1, out), ...retype];
			const adopts =
				after.length > 0 &&
				!isVoid(last!) &&
				!isIsland(last!) &&
				after.every((id) => fits(last!, blockTypeOf(id)));
			if (adopts) writes.push(...move(after, last!, Infinity));
			return plan(moved, writes);
		};
		/** Outdent one block (`unNestBlocks`). */
		const unNestBlock = (id: BlockId): Prepared => unNestBlocks([id]);

		/**
		 * Where a block of `kind` at `id`'s place lands: `id`'s parent, or the
		 * first one up that `kind` fits (`fits`: a list holds only its items),
		 * and the containers it leaves on the way, innermost first (`levels`).
		 * Its own kind keeps a block where it is (DR-behavior-3), as a reorder
		 * does (`canPlace`); a block inserted after it (`after`) has no place
		 * yet.
		 */
		const landingOf = (id: BlockId, kind: string, after = false) => {
			const levels: BlockId[] = [];
			let parent = positionOf(id)?.parent ?? null;
			const own = !after && blockTypeOf(id) === kind;
			for (; !own && parent !== null && !fits(parent, kind); parent = positionOf(parent)!.parent)
				levels.push(parent);
			return { parent, levels };
		};
		/**
		 * Lift sibling blocks `ids` (document order) out of `levels`, the
		 * containers around them, innermost first (ZW-03, AW-01): each level
		 * splits around them as an outdent splits one list — the blocks
		 * before them go to a new container of its kind, which the level above
		 * holds the same way, and the level keeps the ones after them, so an
		 * item a peer appends meanwhile stays with the items it follows; one
		 * left with no child goes. `specs` (new blocks) land right after them.
		 * With `keep`, `ids` stay before the split and only `specs` go out.
		 * `retype` (the caller's kind steps) joins the plan. The one split
		 * `unNestBlocks` and `liftOut` share. `ids`: the placed blocks.
		 */
		const splitOut = (
			ids: readonly BlockId[],
			levels: readonly BlockId[],
			specs: BlockSpec[],
			keep: boolean,
			retype: readonly PlanStep[] = []
		): Plan => {
			const moved = keep ? [] : [...ids];
			const placed = [...moved, ...specs.map((s) => s.id)];
			const insert = (at: BlockId | null, index: number, s: BlockSpec[], ranks: string[]) =>
				s.length ? [{ op: 'insertBlocks' as const, parent: at, index, specs: s, ranks }] : [];
			const last = ids.at(-1)!;
			const { parent, index } = positionOf(levels.at(-1) ?? last)!;
			if (levels.length === 0) {
				const ranks = ranksFor(parent, index + 1, specs.length, [], true);
				return plan(placed, [...insert(parent, index + 1, specs, ranks), ...retype]);
			}
			// Bottom up: what stays before the split at each level (the level
			// itself, or a new head holding it), and whether anything follows it.
			const heads: { spec: BlockSpec; kids: BlockId[]; inner?: BlockSpec }[] = [];
			let before: { id: BlockId; head?: BlockSpec } | null = null;
			let follows = false;
			// The block right after `last` (what the split ends at when `keep`).
			let next: BlockId | undefined;
			let child = last;
			for (const level of levels) {
				const kids = childrenIds(level);
				const at = kids.indexOf(child);
				const lead: BlockId[] = [
					...kids.slice(0, keep && child === last ? at + 1 : at).filter((k) => !moved.includes(k)),
					...(before && !before.head ? [before.id] : [])
				];
				if (!follows && at + 1 < kids.length) [follows, next] = [true, kids[at + 1]];
				if ((lead.length > 0 || before?.head) && follows) {
					const spec = sanitizeSpec({
						id: newId('b'),
						type: kindToCopy(level),
						data: blockDataOf(level) ?? {}
					});
					heads.push({ spec, kids: lead, inner: before?.head });
					before = { id: spec.id, head: spec };
				} else before = lead.length > 0 ? { id: level } : null;
				child = level;
			}
			// Ranked by where each comes from in the outermost level (CW-01): the
			// head right before the first block (with `keep`, right before it
			// leaves), the blocks, then `specs` after the last — with `keep`,
			// right before the block after it, so a peer's head that takes the
			// block they follow sorts before them.
			const outside = before !== null && !before.head;
			let gap = index + (outside ? 1 : 0);
			const ranks = exitRanks(levels.at(-1)!, outside, [
				...(before?.head ? [{ at: ids[0]!, part: [keep ? WITH : HEAD] }] : []),
				...moved.map((id) => ({ at: id, part: [SELF] })),
				...specs.map((_, i) =>
					keep && !outside ? { at: next!, part: [KEPT, i] } : { at: last, part: [AFTER, i] }
				)
			]);
			const writes: PlanStep[] = before?.head
				? insert(parent, gap++, [before.head], ranks.splice(0, 1))
				: [];
			for (const { spec, kids, inner } of heads.reverse()) {
				const inside = ranksFor(spec.id, 0, kids.length + (inner ? 1 : 0));
				writes.push(
					...moveTo(kids, spec.id, 0, inside.slice(0, kids.length)),
					...(inner ? insert(spec.id, kids.length, [inner], inside.slice(-1)) : [])
				);
			}
			const mine = ranks.splice(0, moved.length);
			writes.push(
				...moveTo(moved, parent, gap, mine),
				...insert(parent, gap + moved.length, specs, ranks),
				...retype
			);
			return plan(placed, emptying(levels[0]!, moved, writes, landing(parent)));
		};
		/**
		 * Place `id` where a block of `kind` fits, in one plan (AW-01, AW-03):
		 * out of every container around it that `kind` does not fit
		 * (`landingOf`: a list, and a list holding that list directly, for a
		 * heading or a divider), each split around it (`splitOut`). `after`
		 * (new blocks) lands right after it. With `keep`, `id` stays and only
		 * `after` goes out, the split right after `id` (a divider inserted
		 * after an item). Its own kind never moves it. The kinds are the
		 * caller's: it composes the retype (`setBlock`). Refused where `id`
		 * may not move there (`canPlace`). `ids`: the placed blocks.
		 */
		const liftOut = (
			id: BlockId,
			kind: string,
			{ keep = false, after = [] }: { keep?: boolean; after?: readonly BlockSpec[] } = {}
		): Prepared => {
			id = ref(id);
			kind = ref(kind);
			const specs = after.map(sanitizeSpec);
			const { parent, levels } = landingOf(id, kind, keep);
			if (!positionOf(id) || M.collides(doc, specs) || !canPlace([id], parent, () => kind))
				return REFUSED;
			return splitOut([id], levels, specs, keep);
		};

		/** The layout kind a new layout takes: `kind` when it is one, else the only one the roles declare. */
		const layoutKind = (kind?: string): string | undefined => {
			if (kind !== undefined) return roles.layout(kind) === undefined ? undefined : kind;
			const kinds = [...roles.layoutKinds()];
			return kinds.length === 1 ? kinds[0] : undefined;
		};
		/**
		 * The block a beside placement at `target` stands beside
		 * (`layout.place-beside`): a layout or an item for itself; a block whose
		 * parent shows only its children (a list item → its list, at any depth)
		 * or is an island of lines (a code line → its code block) for that
		 * parent; then the block itself when it sits directly in an item or at
		 * the root, or where a new layout of `kind` (else the only layout kind)
		 * fits beside it (a toggle's, a callout's or a nested block's child,
		 * outside any item and island, D2); else its outermost block below the
		 * root or an item.
		 */
		const besideAt = (target: BlockId, kind?: string): BlockId => {
			let at = ref(target);
			if (isLayout(at) || isLayoutItem(at)) return at;
			for (
				let parent = positionOf(at)?.parent ?? null;
				parent !== null && !isLayoutItem(parent) && (isContainer(parent) || isLines(parent));
				parent = positionOf(parent)?.parent ?? null
			)
				at = parent;
			const parent = positionOf(at)?.parent ?? null;
			if (parent === null || isLayoutItem(parent)) return at;
			const wrap = layoutKind(kind);
			if (
				wrap !== undefined &&
				fits(parent, wrap) &&
				!insideItem(parent) &&
				!isIsland(parent) &&
				!insideIsland(parent)
			)
				return at;
			for (
				let up: BlockId | null = parent;
				up !== null && !isLayoutItem(up);
				up = positionOf(up)!.parent
			)
				at = up;
			return at;
		};
		/**
		 * Place `ids` beside `target`, to its `side` (`layout.place-beside`: a
		 * block dragged to another block's left or right edge). The target
		 * resolves to its outermost block below the root or below a layout
		 * item (a list item → its list, a code line → its code block); an item
		 * stands for itself, a layout for its first or last slot. Beside a
		 * block in an item, a new item holding `ids` goes beside that item;
		 * otherwise the block and a new item holding `ids` are wrapped in a new
		 * layout of the layout `kind` (else the only one the roles declare) at
		 * its place. Refused when `ids` holds the target or an ancestor of it,
		 * an item, a layout or a block holding one (D2), a block that does not
		 * fit an item, a block or a layout inside an island, and, wrapping,
		 * when there is no layout kind. The sources are cleaned in the same
		 * plan (`emptying`, `dissolving`); plain ranks (a move). `ids`: the
		 * moved blocks.
		 */
		const placeBeside = (
			ids: readonly BlockId[],
			target: BlockId,
			side: 'left' | 'right',
			kind?: string
		): Prepared => {
			const moved = ids.map(ref);
			target = ref(target);
			const v = view();
			if ((side !== 'left' && side !== 'right') || !canPlace(moved) || !live(target))
				return REFUSED;
			if ([target, ...ancestorsOf(target, v)].some((a) => moved.includes(a))) return REFUSED;
			if (moved.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
			const right = side === 'right';
			// Where the new item goes: beside an item of a layout, or a new layout wrapping `at`.
			const at = besideAt(target, kind && ref(kind));
			let layout: BlockId | null = null;
			let index = 0;
			if (isLayout(at)) [layout, index] = [at, right ? childrenIds(at).length : 0];
			else {
				const item = isLayoutItem(at) ? at : positionOf(at)!.parent;
				if (item !== null) {
					const pos = positionOf(item)!;
					[layout, index] = [pos.parent!, pos.index + (right ? 1 : 0)];
				}
			}
			const wrap = layout === null ? layoutKind(kind && ref(kind)) : blockTypeOf(layout);
			const item = wrap === undefined ? undefined : roles.layout(wrap);
			if (wrap === undefined || item === undefined) return REFUSED;
			if (moved.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
			if (layout !== null && (isIsland(layout) || insideIsland(layout, v))) return REFUSED;
			const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
			const fresh = spec(item);
			const into = (parent: BlockId) => moveTo(moved, parent, 0, ranksFor(parent, 0, moved.length));
			let writes: PlanStep[];
			let kept: Set<BlockId | null>;
			if (layout !== null) {
				const ranks = ranksFor(layout, index, 1);
				writes = [
					{ op: 'insertBlocks', parent: layout, index, specs: [fresh], ranks },
					...into(fresh.id)
				];
				kept = new Set([fresh.id, ...landing(layout)]);
			} else {
				const pos = positionOf(at)!;
				const host = spec(item);
				const wrapper = { ...spec(wrap), children: right ? [host, fresh] : [fresh, host] };
				const ranks = ranksFor(pos.parent, pos.index, 1);
				writes = [
					{ op: 'insertBlocks', parent: pos.parent, index: pos.index, specs: [wrapper], ranks },
					...moveTo([at], host.id, 0, ranksFor(host.id, 0, 1)),
					...into(fresh.id)
				];
				kept = new Set([wrapper.id, host.id, fresh.id, ...landing(pos.parent)]);
			}
			return plan(moved, emptied(moved, writes, kept));
		};

		/**
		 * Wrap sibling blocks in a new layout of `columns` items (default: one
		 * per block), at the first one's place (`layout.wrap`: Turn into N
		 * columns, as Notion): the blocks fill the first items, one each, in
		 * document order; each item after them holds one empty block of the
		 * item's default child (one block turned into 3 columns: it, then two
		 * empty columns). The layout is of the layout `kind` (else the only one
		 * the roles declare). Refused for no block, fewer than two items or
		 * fewer items than blocks, blocks of different parents, an item, a
		 * layout or a block holding one (D2), where the layout does not fit
		 * (`fits`: in a list, a code block) or lands inside an item (D2) or an
		 * island, and for a block that does not fit an item. Plain ranks (a
		 * move). `ids`: the new layout.
		 */
		const wrapInLayout = (
			ids: readonly BlockId[],
			kind?: string,
			columns: number = ids.length
		): Prepared => {
			const blocks = ids.map(ref);
			const v = view();
			if (!Number.isInteger(columns) || columns < 2 || blocks.length < 1) return REFUSED;
			if (columns < blocks.length || !canPlace(blocks)) return REFUSED;
			const parent = positionOf(blocks[0]!)!.parent;
			if (blocks.some((id) => positionOf(id)!.parent !== parent)) return REFUSED;
			if (blocks.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
			const wrap = layoutKind(kind && ref(kind));
			const item = wrap === undefined ? undefined : roles.layout(wrap);
			if (wrap === undefined || item === undefined || !fits(parent, wrap)) return REFUSED;
			if (parent !== null && (insideItem(parent, v) || isIsland(parent) || insideIsland(parent, v)))
				return REFUSED;
			if (blocks.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
			const fill = roles.defaultChild(item);
			if (columns > blocks.length && !fitsIn(item, fill)) return REFUSED;
			const ordered = blocks.toSorted((a, b) => positionOf(a)!.index - positionOf(b)!.index);
			const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
			const items = Array.from({ length: columns }, (_, i) =>
				i < ordered.length ? spec(item) : { ...spec(item), children: [spec(fill)] }
			);
			const wrapper = { ...spec(wrap), children: items };
			const at = positionOf(ordered[0]!)!.index;
			const writes: PlanStep[] = [
				{
					op: 'insertBlocks',
					parent,
					index: at,
					specs: [wrapper],
					ranks: ranksFor(parent, at, 1)
				},
				...ordered.flatMap((id, i) => moveTo([id], items[i]!.id, 0, ranksFor(items[i]!.id, 0, 1)))
			];
			const kept = new Set<BlockId | null>([
				wrapper.id,
				...items.map((it) => it.id),
				...landing(parent)
			]);
			return plan([wrapper.id], emptied(ordered, writes, kept));
		};

		/**
		 * Split `id` at content `offset` into a new sibling `newId` (one boundary
		 * item and the claims that follow it, no text copied; children follow).
		 * `tail` decides the sibling's type/data once (default: the source's —
		 * the kind it displays, RW-01; an empty `tail.type` is the default too).
		 * Refused on `void` blocks and on blocks that render no content (a
		 * list, a code block: nothing to split, SW8-roles-3). `ids`: the new
		 * block.
		 */
		const splitBlock = (
			id: BlockId,
			offset: number,
			newId: BlockId,
			tail?: SplitTail
		): Prepared => {
			id = ref(id);
			const born = ref(newId);
			const pos = positionOf(id);
			const rec = view().blocks.get(id);
			if (pos === null || isVoid(id) || !rendersContent(id) || !rec?.claimsNode) return REFUSED;
			if (M.blockNodeOf(doc, born) !== null) return REFUSED;
			const [at] = clamp(id, offset, 0);
			// An empty tail type is the one a view reads mid-retype: copy the kind (YW-07).
			const type = tail?.type ? ref(tail.type) : kindToCopy(id);
			const t = tail
				? { type, data: tail.data && sanitizeWireJson(tail.data) }
				: { type, data: readData(rec.node) };
			const [rank] = pieceRanks(id, at, 1);
			const length = displayLength(id) - at;
			const split: PlanStep = {
				op: 'splitBlock',
				id,
				offset: at,
				length,
				newId: born,
				tail: t,
				parent: pos.parent,
				rank: rank!
			};
			return plan([born], [split, ...move(childrenIds(id), born, 0)]);
		};

		/**
		 * Engine merge primitive: `from`'s content is claimed by `into`, its
		 * children ADOPTED as `into`'s last children — an island's take
		 * `into`'s default child, like a baseline merge's — and `from` is
		 * hidden via the claim (undo restores it). The children stay under
		 * `from`, ranked after `into`'s children, and display under `into`
		 * through the claim (FW-12): a concurrent delete of `into` voids the
		 * claim and `from` comes back with its children, never below them.
		 * Role rules are `canMerge`'s; a merge that would close a display
		 * cycle is refused. `ids`: `into`.
		 */
		const mergeBlocks = (fromId: BlockId, intoId: BlockId): Prepared => {
			const from = ref(fromId);
			const into = ref(intoId);
			const v = view();
			if (!canMerge(from, into) || !contentTarget(into)) return REFUSED;
			if (M.isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
			const kids = childrenIds(from);
			const retype = settle(from, kids, into);
			const adopt = moveTo(kids, from, kids.length, ranksFor(into, Infinity, kids.length, kids));
			// A list its only item leaves goes, as with every sibling op (DR-crdt-5).
			return plan([into], emptied([from], [merge(from, into), ...adopt, ...retype], landing(into)));
		};

		/**
		 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
		 * `from`'s children unnest right after `from`'s vacated sibling slot —
		 * NOT adopted into `into` — and take the kind they show there
		 * (`settledKind`: an island's children its parent's default child, a
		 * paragraph in a list its item, ZW-01); then `from`'s content claims
		 * into `into`. Ranked after `from`, not at it: a concurrent delete of
		 * `into` revives `from` above its former children (UW-20).
		 */
		const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
			const pos = canMerge(from, into) ? positionOf(from) : null;
			if (pos === null || !contentTarget(into)) return REFUSED;
			const kids = childrenIds(from);
			const retype = settle(from, kids, pos.parent);
			const out = leaving(from, true, kids);
			return plan(
				[into],
				[...moveTo(kids, pos.parent, pos.index + 1, out), ...retype, merge(from, into)]
			);
		};

		/** Remove `container`, left empty, for the key at `id` (refused if it holds text). */
		const gone = (id: BlockId, container: BlockId): Prepared => {
			const writes = emptying(container, [], []);
			return writes.length > 0 ? plan([id], writes) : REFUSED;
		};

		/**
		 * Baseline `mergeBlockBackward`: merge `id` into the previous block in
		 * document order. No previous block → an empty block merges forward,
		 * else refused. The first item of a container (`isContainer`) outside
		 * any island lifts out of it instead (YW-02, Notion): it takes the
		 * container's slot, as its new parent's default child, with its
		 * children (a first cell stays: nothing leaves an island; a block that
		 * would land directly in a container it is no item of stays too,
		 * DR-crdt-1). The first block of a layout item merges across items
		 * instead, in reading order (`layout.merge`, D4, Notion): into the
		 * previous item's last line, or, in the first item, the line before
		 * the layout; an item it empties goes and the layout dissolves.
		 * `ids`: the surviving block.
		 */
		const mergeBackward = (id: BlockId): Prepared => {
			id = ref(id);
			const prev = previous(id);
			if (prev === null && childrenIds(id).length === 0 && displayLength(id) === 0) {
				return mergeForward(id);
			}
			// A container a concurrent edit left empty shows nothing: the key removes it.
			if (prev !== null && isContainer(prev) && childrenIds(prev).length === 0)
				return gone(id, prev);
			if (prev !== null && prev === positionOf(id)?.parent && isLayoutItem(prev)) {
				const layout = positionOf(prev)!.parent!;
				let into = previous(prev);
				if (into === layout) into = previous(layout);
				const merged = into === null ? REFUSED : mergeUnnesting(id, into);
				if (!('writes' in merged) || childrenIds(id).length > 0) return merged;
				return plan(merged.ids, emptying(prev, [id], merged.writes));
			}
			if (
				prev !== null &&
				prev === positionOf(id)?.parent &&
				isContainer(prev) &&
				!insideIsland(prev)
			) {
				// It lands only where it fits: never directly in a container it is no item of.
				const slot = positionOf(prev)!;
				if (!fits(slot.parent, settledKind(prev, id, slot.parent))) return REFUSED;
				const lift = [
					...moveTo([id], slot.parent, slot.index, leaving(prev, false, [id])),
					...settle(prev, [id], slot.parent)
				];
				return plan([id], emptying(prev, [id], lift, landing(slot.parent)));
			}
			return prev ? mergeUnnesting(id, prev) : REFUSED;
		};

		/**
		 * Baseline `mergeBlockForward`: pull the next block in document order
		 * into `id`. A container passes the merge to its first item (YW-02:
		 * Delete above a list pulls the item's text up and the list keeps the
		 * rest, or goes when that was its only item). A container left
		 * empty (by concurrent edits) is removed instead, by either key.
		 */
		const mergeForward = (id: BlockId): Prepared => {
			id = ref(id);
			let after = next(id);
			while (after !== null && isContainer(after)) {
				const first = childrenIds(after)[0];
				// A container a concurrent edit left empty shows nothing: the key removes it.
				if (first === undefined) return gone(id, after);
				after = first;
			}
			const out = after ? mergeUnnesting(after, id) : REFUSED;
			const parent = after && positionOf(after)?.parent;
			if (!('writes' in out) || !parent || childrenIds(after!).length > 0) return out;
			return plan(out.ids, emptying(parent, [after!], out.writes));
		};

		/** `writes`, then every container the `leaving` blocks leave with no child removed. */
		const emptied = (
			leaving: readonly BlockId[],
			writes: PlanStep[],
			kept?: ReadonlySet<BlockId | null>
		): PlanStep[] =>
			emptyingAll(
				leaving.map((id) => positionOf(id)!.parent),
				leaving,
				writes,
				kept
			);
		/**
		 * Delete a set of blocks (R3, `del.blocks.promote`): this writer's mark on
		 * every member and on what it displays through merge claims (wins over
		 * concurrent moves). Only the members leave: the unselected children of a
		 * deleted block take its slot, in order, with their subtrees, as the
		 * kind they show there (`settledKind`: a deleted island's children take
		 * the slot parent's default child, a deleted list's items leave its
		 * kind, a block promoted into a list is its item). A container the delete leaves with no child goes too
		 * (`del.range.empty-container`). `subtree` is the explicit whole-subtree
		 * delete. `filled`: a parent the same plan fills again (a flow placed in
		 * the deleted blocks' slot, `flow.slot`), which is never emptied, so its
		 * layout never dissolves (`layout.flow-slot`).
		 */
		const deleteBlocks = (
			ids: readonly BlockId[],
			subtree = false,
			filled?: BlockId | null
		): Prepared => {
			const set = new Set(ids.map(ref));
			if ([...set].some((id) => !live(id))) return REFUSED;
			// A layout goes with its items: their blocks take its slot (`layout.dissolving`).
			for (const id of [...set])
				if (isLayout(id)) for (const kid of childrenIds(id)) if (isLayoutItem(kid)) set.add(kid);
			if (subtree) {
				const roots = [...set].filter((id) => !ancestorsOf(id).some((a) => set.has(a)));
				return plan(
					roots,
					emptied(
						roots,
						roots.map((id) => remove(id))
					)
				);
			}
			const roots = [...set].filter((id) => !set.has(positionOf(id)!.parent!));
			const { kids } = view();
			const promoting = new Set<BlockId>();
			const members: BlockId[] = [];
			const writes = roots.flatMap((root) => {
				const pos = positionOf(root)!;
				const chunk: BlockId[] = [];
				const kept: { id: BlockId; from: BlockId; rank: string }[] = [];
				// Each kept child moves to the rank read-time promotion gives it
				// (`promotedRank`), so a block a peer puts under a member meanwhile
				// takes the slot in the member's order among them. Right after the
				// root: a flow placed in the root's slot precedes them.
				const walk = (b: BlockId, slotRank: string): void => {
					chunk.push(b);
					for (const kid of kids.get(b) ?? []) {
						const rank = promotedRank(slotRank, kid.rank);
						if (set.has(kid.id)) walk(kid.id, rank);
						else kept.push({ id: kid.id, from: b, rank });
					}
				};
				walk(root, kids.get(pos.parent)![pos.index]!.rank);
				members.push(...chunk);
				if (kept.length > 0) promoting.add(root);
				// A layout shows only its items: a deleted item's blocks land right
				// after it, where read-time promotion shows them (`layout.only-items`).
				const item = pos.parent === null ? undefined : itemKindOf(pos.parent);
				const at = (k: { id: BlockId }) => item !== undefined && blockTypeOf(k.id) !== item;
				const out = kept.filter(at);
				const inside = kept.filter((k) => !at(k));
				const lpos = out.length > 0 ? positionOf(pos.parent!)! : null;
				const lrank = lpos && kids.get(lpos.parent)![lpos.index]!.rank;
				return [
					...moveTo(
						inside.map((k) => k.id),
						pos.parent,
						pos.index + 1,
						inside.map((k) => k.rank)
					),
					...inside.flatMap((k) => settle(k.from, [k.id], pos.parent)),
					...(lpos === null
						? []
						: [
								...moveTo(
									out.map((k) => k.id),
									lpos.parent,
									lpos.index + 1,
									out.map((k) => promotedRank(lrank!, k.rank))
								),
								...out.flatMap((k) => settle(k.from, [k.id], lpos.parent))
							]),
					deleting(root, chunk)
				];
			});
			return plan(
				roots,
				emptyingAll(
					roots.filter((r) => !promoting.has(r)).map((id) => positionOf(id)!.parent),
					roots.filter((r) => !promoting.has(r)),
					writes,
					filled === undefined ? undefined : new Set([filled]),
					members
				)
			);
		};

		/** Delete `id` — its children take its slot (`keepChildren: false`: the whole subtree). */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): Prepared =>
			deleteBlocks([id], opts.keepChildren === false);

		/**
		 * The target role decides (UW-21): nothing renders a void's children,
		 * so a block retyped to a void kind hands them to the slot right after
		 * it, as the kind they show there (`settledKind`). Each moves to the
		 * rank the read-time
		 * shedding gives it (`promotedRank`, UW-21b), so a child a peer adds
		 * meanwhile keeps its place in the void's order among them. An island
		 * declared `lines` retyped to an ordinary kind keeps its lines, each
		 * retyped to the new kind's default child (the document's where that
		 * renders no content): no line kind outside its island. Any other
		 * island's children keep their kinds (a table's rows stay rows), as
		 * `typeOf` shows a child a peer adds meanwhile (DR-crdt-2).
		 */
		const retypeSteps = (id: BlockId, type: string): PlanStep[] => {
			const { kids } = view();
			const pos = positionOf(id);
			const steps = attr(id, TYPE, type);
			const moved = kids.get(id) ?? [];
			// A code block retyped to an ordinary kind keeps its lines as that kind's children
			// (`leavingIsland`: never a kind that hides their text, AW-05).
			const lined = is(id, (t) => roles.line(t) !== undefined);
			if (lined && !roles.island(type) && !roles.childless(type)) {
				const to = roles.defaultChild(type);
				return [
					...steps,
					...moved.flatMap((k) => {
						const kind = leavingIsland(id, blockTypeOf(k.id), to);
						return kind === undefined ? [] : attr(k.id, TYPE, kind);
					})
				];
			}
			if (!roles.childless(type) || moved.length === 0 || pos === null) return steps;
			const slotRank = kids.get(pos.parent)![pos.index]!.rank;
			const ids = moved.map((k) => k.id);
			return [
				...steps,
				...moveTo(
					ids,
					pos.parent,
					pos.index + 1,
					moved.map((k) => promotedRank(slotRank, k.rank))
				),
				...settle(id, ids, pos.parent)
			];
		};

		/** Set the block type (attr write — the block keeps its identity; see `retypeSteps`). */
		const setBlockType = (id: BlockId, type: string): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], retypeSteps(id, ref(type))) : REFUSED;
		};

		/**
		 * Patch the data of a block, one of its inline atoms or the document
		 * (`null`), in order (`crdt/data.ts`): each patch replaces the value at
		 * its path (`value` absent deletes it), `splice` and `order` edit the
		 * array there; a path addresses array items by index, resolved here
		 * to the items' ids. Only the leaves it changes are written, so a
		 * peer's edit of another key or item is kept. Refused for an absent
		 * target, a path that is no array of strings, a root value that is no
		 * object, or an op that fits no value at its path.
		 */
		const patchData = (target: DataTarget, patches: readonly DataPatch[]): Prepared => {
			const valid = (p: DataPatch) =>
				Array.isArray(p?.path) &&
				p.path.every((k) => typeof k === 'string') &&
				(p.path.length > 0 || p.value === undefined || isObject(p.value));
			if (!Array.isArray(patches) || !patches.every(valid)) return REFUSED;
			// Only the fields a patch has: an absent one is no non-JSON value to report.
			const clean = patches.map(({ path, value, splice, order }) =>
				sanitizeWireJson({
					path,
					...(value !== undefined && { value }),
					...(splice !== undefined && { splice }),
					...(order !== undefined && { order })
				})
			);
			const t: DataTarget =
				target === null
					? null
					: typeof target === 'string'
						? ref(target)
						: { block: ref(target.block), atom: ref(target.atom) };
			if (typeof t === 'string' ? !live(t) : t !== null && atomOf(t.block, t.atom) === undefined)
				return REFUSED;
			const steps = dataSteps(t, clean);
			return steps ? plan(t === null ? [] : [typeof t === 'string' ? t : t.block], steps) : REFUSED;
		};

		/**
		 * Baseline `setBlock`: `type` updates the block in place and `data`
		 * sets the leaves it names, removing none (`data.retype.keep`, H4: a
		 * retype keeps the block's properties, as Notion's Turn into does;
		 * `setBlockData` replaces them); `content`/`children` REPLACE
		 * wholesale — explicit replacement is a
		 * new-identity operation; a retype to a void kind without `children`
		 * unnests the current ones (`retypeSteps`). All-or-nothing (D-12): children
		 * for a block that is `void` after the write, or a replacement id that
		 * is already taken (a live or deleted
		 * block, the replaced children included, or a duplicate inside the
		 * replacement), refuses before any write — `id-collision` for the
		 * latter. A caller wanting a child back re-creates it with a fresh id.
		 */
		const setBlock = (
			id: BlockId,
			value: {
				type?: string;
				data?: Record<string, unknown>;
				content?: ContentItem[];
				children?: BlockSpec[];
			}
		): Prepared => {
			id = ref(id);
			const content = value.content?.map(sanitizeItem);
			const children = value.children?.map(sanitizeSpec);
			if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
			const type = value.type === undefined ? undefined : ref(value.type);
			const toVoid = type === undefined ? isVoid(id) : roles.childless(type);
			if (children?.length && toVoid) return REFUSED;
			if (children !== undefined && M.collides(doc, children)) return refused('id-collision');
			const data =
				value.data === undefined ? [] : dataSteps(id, leafSets(value.data, blockDataOf(id)));
			if (data === null) return REFUSED;
			const writes: PlanStep[] = [
				...(type === undefined
					? []
					: children === undefined
						? retypeSteps(id, type)
						: attr(id, TYPE, type)),
				...data
			];
			if (content !== undefined) {
				const length = displayLength(id);
				if (length > 0) writes.push({ op: 'deleteText', id, offset: 0, length });
				let at = 0;
				for (const item of content) {
					if (item.kind === 'inline')
						writes.push({ op: 'insertInline', id, offset: at++, atom: item });
					else if (item.text !== '') {
						writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
						at += item.text.length;
					}
				}
			}
			if (children !== undefined) {
				for (const kid of childrenIds(id)) writes.push(remove(kid));
				// Every current child is deleted, so the new ones rank from an empty list.
				const ranks = M.ranksAt([], 0, children.length, doc.clientID, randOf(doc));
				if (children.length > 0)
					writes.push({ op: 'insertBlocks', parent: id, index: 0, specs: children, ranks });
			}
			return plan([id], writes);
		};

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * serializes `id`, remaps every block and inline atom id through
		 * `freshId`, inserts the copy right after `id`. Text atoms get new
		 * identity too — duplication is a creation op, not a relocation. An
		 * inline id `freshId` does not answer (a block-only callback) is
		 * minted; a block id it does not answer refuses the copy. `ids`: the
		 * copy's root.
		 */
		const duplicateBlock = (
			id: BlockId,
			freshId: (oldId: string, kind: 'block' | 'inline') => string
		): Prepared => {
			id = ref(id);
			const pos = positionOf(id);
			if (pos === null) return REFUSED;
			const spec = (b: BlockId): BlockSpec | null => {
				const fresh = freshId(b, 'block');
				if (typeof fresh !== 'string') return null;
				const content = contentItems(b).map((item) => {
					if (item.kind !== 'inline') return item;
					const atom = freshId(item.id, 'inline');
					return { ...item, id: typeof atom === 'string' ? atom : newId('i') };
				});
				const children = childrenIds(b).map(spec);
				if (children.includes(null)) return null;
				const data = blockDataOf(b);
				return {
					id: fresh,
					type: kindToCopy(b),
					...(data !== undefined && { data }),
					content,
					children: children as BlockSpec[]
				};
			};
			const copy = spec(id);
			return copy ? insertBlocks({ parent: pos.parent, index: pos.index + 1 }, [copy]) : REFUSED;
		};

		// content ops (allowed inside voids — caption contract)

		const insertText = (
			id: BlockId,
			offset: number,
			text: string,
			marks?: Record<string, unknown>
		): Prepared => {
			id = ref(id);
			const clean = ref(text);
			if (!contentTarget(id)) return REFUSED;
			const [at] = clamp(id, offset, 0);
			const m = marks && sanitizeWireJson(marks);
			return plan(
				[id],
				clean === '' ? [] : [{ op: 'insertText', id, offset: at, text: clean, marks: m }]
			);
		};

		const deleteText = (id: BlockId, offset: number, length: number): Prepared => {
			id = ref(id);
			if (!contentTarget(id)) return REFUSED;
			const [at, end] = clamp(id, offset, length);
			return plan([id], end > at ? [{ op: 'deleteText', id, offset: at, length: end - at }] : []);
		};

		/**
		 * Multi-mark format over a range (values may be null = unset); planned
		 * only when some text atom in the range carries a different value.
		 */
		const formatRange = (
			id: BlockId,
			offset: number,
			length: number,
			marks: Record<string, unknown>
		): Prepared => {
			id = ref(id);
			const clean = sanitizeWireJson(marks);
			if (!contentTarget(id)) return REFUSED;
			const [at, end] = clamp(id, offset, length);
			// Planned only when some text atom carries another value (the same-value guard).
			const differs = textIn(id, at, end).some((item) =>
				Object.keys(clean).some((k) => !jsonEquals(item.marks?.[k] ?? null, clean[k] ?? null))
			);
			return plan(
				[id],
				differs ? [{ op: 'formatRange', id, offset: at, length: end - at, marks: clean }] : []
			);
		};

		/**
		 * Baseline `removeMarksFromText`: every mark present anywhere in the
		 * range is unset over the range. Names are discovered from the content.
		 */
		const clearMarks = (id: BlockId, offset: number, length: number): Prepared => {
			const clears: JsonObj = {};
			for (const item of textIn(ref(id), offset, offset + length)) {
				for (const k of Object.keys(item.marks ?? {})) clears[k] = null;
			}
			return formatRange(id, offset, length, clears);
		};

		const insertInline = (id: BlockId, offset: number, atom: InlineSpec): Prepared => {
			id = ref(id);
			const clean = sanitizeInline(atom);
			if (!contentTarget(id)) return REFUSED;
			return plan([id], [{ op: 'insertInline', id, offset: clamp(id, offset, 0)[0], atom: clean }]);
		};

		const removeInline = (id: BlockId, inlineId: string): Prepared => {
			id = ref(id);
			const atom = atomOf(id, ref(inlineId));
			if (atom === undefined) return REFUSED;
			return plan([id], [{ op: 'removeInline', id, offset: atom.at, inlineId: ref(inlineId) }]);
		};

		/** What range deletion and flow placement read, and the step writers they compose. */
		const context: FlowContext = {
			ref,
			refused: REFUSED,
			plan,
			order: () => view().order,
			positionOf,
			ancestorsOf: (id) => ancestorsOf(id),
			childrenIds,
			displayLength,
			contentTarget,
			rendersContent,
			canMerge,
			isIsland,
			isLines,
			defaultChild,
			fitted,
			move,
			retype: (id, type) => attr(id, TYPE, type),
			isContainer,
			emptiable,
			settle,
			remove,
			insertBlocks,
			sanitize: sanitizeSpec,
			collides: (specs) => M.collides(doc, specs),
			isVoid,
			roleOf: (kind) => ({
				void: roles.childless(kind),
				island: roles.island(kind),
				rendersContent: roles.rendersContent(kind),
				layout: roles.layout(kind)
			}),
			insideItem: (id) => insideItem(id),
			tailOf: (id) => ({ type: kindToCopy(id), data: blockDataOf(id) }),
			ranksFor,
			insertRanks: (parent, index, count) => ranksFor(parent, index, count, [], true),
			pieceRanks,
			redata: (id, data) => dataSteps(id, replaceData(data)) ?? [],
			deleteBlocks: (ids, filled) => deleteBlocks(ids, false, filled),
			dissolving: (gone, leaving, writes) => dissolving(new Set(gone), leaving, writes)
		};

		/** Every document op, prepared (R6) — `apply(prepare.op(…))` is the op. */
		const prepare = {
			insertBlocks,
			insertBlock: (dest: Destination, spec: BlockSpec) => insertBlocks(dest, [spec]),
			moveBlocks,
			/** Relocate `id` — identity preserved. */
			moveBlock: (id: BlockId, dest: Destination) => moveBlocks([id], dest),
			/**
			 * Move `id` to the last position under `parent` — under a container
			 * it is no item of, under its last item (`nestParent`: Tab after a list).
			 */
			nestBlock: (id: BlockId, parent: BlockId) => {
				const at = nestParent([ref(id)], ref(parent));
				return moveBlocks([id], { parent: at, index: childrenIds(at).length });
			},
			unNestBlock,
			unNestBlocks,
			liftOut,
			placeBeside,
			wrapInLayout,
			splitBlock,
			mergeBlocks,
			mergeBackward,
			mergeForward,
			deleteBlock,
			setBlock,
			setBlockType,
			patchData,
			/** Replace a block's `data`: a patch of its root. */
			setBlockData: (id: BlockId, data: Record<string, unknown>) =>
				patchData(id, [{ path: [], value: data }]),
			duplicateBlock,
			insertText,
			deleteText,
			formatRange,
			setMark: (id: BlockId, offset: number, length: number, name: string, value: unknown) =>
				formatRange(id, offset, length, { [name]: value }),
			unsetMark: (id: BlockId, offset: number, length: number, name: string) =>
				formatRange(id, offset, length, { [name]: null }),
			clearMarks,
			insertInline,
			removeInline,
			/** Replace an inline atom's `data`: a patch of its root. */
			setInlineData: (id: BlockId, inlineId: string, data: Record<string, unknown>) =>
				patchData({ block: id, atom: inlineId }, [{ path: [], value: data }]),
			/** Delete a block selection — one plan; only the members leave (`deleteBlocks` above). */
			deleteBlocks: (ids: readonly BlockId[]): Prepared => deleteBlocks(ids),
			...rangeDeleteOps(context),
			...flowOps(context)
		};

		/**
		 * Plans prepared at one version, as one plan (refused if any part is;
		 * stamped with the oldest part's version, so `apply` refuses a stale
		 * one). The caller guarantees the parts are independent: no step's
		 * coordinates depend on an earlier part's writes.
		 */
		const compose = (...parts: Prepared[]): Prepared => {
			const plans = parts as Plan[];
			const version = Math.min(...plans.map((p) => p.version));
			return (
				parts.find((p) => !('writes' in p)) ?? {
					...plan(
						plans.flatMap((p) => p.ids),
						plans.flatMap((p) => p.writes)
					),
					version
				}
			);
		};

		// ── JSON boundary ─────────────────────────────────────────────────

		/**
		 * Public JSON export — `{ children: JSONBlock[] }` matching
		 * `src/lib/utils/json.ts` (`data` always present, `content`/`children`
		 * omitted when empty): the one serializer, {@link blockJSON}, over the
		 * root's visible children.
		 */
		const toJSON = (): JSONDoc => {
			const data = docData();
			const children = childrenIds(null).map(blockJSON);
			return Object.keys(data).length > 0
				? { data: data as JSONDoc['data'], children }
				: { children };
		};

		// ── facade object ─────────────────────────────────────────────────

		/** A read taking an id first: the id normalizes at ingress (O1). */
		const byRef =
			<I extends BlockId | null, A extends unknown[], R>(f: (id: I, ...rest: A) => R) =>
			(id: I, ...rest: A): R =>
				f(ref(id), ...rest);

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
			/** Apply the deterministic seed of `value` and the document's `data` (R13) — the document's seed decision. */
			seed: (value: JSONBlock[], data?: JsonObj) =>
				write(() => seed(doc, value, defaultType, data)),
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
			// reads — every id argument normalizes at ingress (O1)
			project: () => M.project(doc),
			toJSON,
			blockJSON: byRef(blockJSON),
			childrenIds: byRef(childrenIds),
			/** Visible children of `parent` with their ranks, in `(rank, id)` order. */
			childSlots: (parent: BlockId | null) => view().kids.get(parent) ?? [],
			slotOf: byRef(slotOf),
			positionOf: byRef(positionOf),
			pathOf: byRef(pathOf),
			parentOf: byRef((id: BlockId) => positionOf(id)?.parent ?? null),
			ancestorsOf: byRef((id: BlockId) => ancestorsOf(id)),
			listBlockIds: () => M.listBlockIds(doc),
			blockText: byRef((id: BlockId) => M.blockText(doc, id)),
			blockTypeOf: byRef(blockTypeOf),
			blockDataOf: byRef(blockDataOf),
			docData,
			dataItemIds,
			/**
			 * U1 — compact per-block attribution (`{createdBy, contributors,
			 * lastChangedBy}`), or `undefined` for unauthored/system blocks.
			 * O(1) per call; live-replicated (remote values read the same).
			 */
			blockAttribution: byRef((id: BlockId): BlockAttribution | undefined =>
				blockAttributionOf(doc, id)
			),
			crdtId: byRef((id: BlockId) => M.crdtId(doc, id)),
			resolveBlock: byRef((id: BlockId) => M.resolveBlock(doc, id)),
			displayLength: byRef(displayLength),
			contentItems: byRef(contentItems),
			hasBlock: byRef(hasBlock),
			isVisibleBlock: byRef(live),
			order,
			compare: (a: BlockId, b: BlockId) => compare(ref(a), ref(b)),
			next: byRef(next),
			previous: byRef(previous),
			// caret anchors (U09) — backing-text-bound selection endpoints
			anchorAt: byRef(anchorAt),
			resolveAnchor,
			followUndo,
			// roles
			/** Re-read the roles after `roleOf` answers differently (roles adopted later). */
			rolesChanged: () => runsView.roles(roles),
			isVoid: byRef(isVoid),
			isIsland: byRef(isIsland),
			isLines: byRef(isLines),
			/** `id` is a layout: its kind's role says `layout` (`layout.*`). */
			isLayout: byRef(isLayout),
			/** `id` is a layout item: of its layout's item kind, directly in it (a column). */
			isLayoutItem: byRef(isLayoutItem),
			/** The block a beside placement at `id` stands beside (`placeBeside`'s resolution). */
			besideAt: (id: BlockId, kind?: string) => besideAt(id, kind),
			islandOf: byRef((id: BlockId) => islandOf(id)),
			insideIsland: byRef((id: BlockId) => insideIsland(id)),
			// structural capability (R5)
			canPlace: (ids: readonly BlockId[], parent?: BlockId | null) =>
				canPlace(ids.map(ref), parent == null ? parent : ref(parent)),
			canMerge: (from: BlockId, into: BlockId) => canMerge(ref(from), ref(into)),
			/** May a block of `kind` sit directly under `parent`? The container rule (`fits`). */
			fits: (parent: BlockId | null, kind: string) =>
				fits(parent == null ? null : ref(parent), ref(kind)),
			/** Where `ids` nest when nested into `parent` (Tab, a drop inside it): `nestParent`. */
			nestParent: (ids: readonly BlockId[], parent: BlockId) =>
				nestParent(ids.map(ref), ref(parent)),
			/** Where a block of `kind` at `id`'s place lands, and the containers it leaves (`liftOut`). */
			landingOf: (id: BlockId, kind: string, after?: boolean) =>
				landingOf(ref(id), ref(kind), after),
			defaultChild: byRef(defaultChild),
			// maintained runs (U05 surface, bound to this doc)
			runs: byRef(runsView.runs),
			contentJSON: byRef(runsView.contentJSON),
			// events
			onChange,
			// every op — each returns an {@link OpResult}; `apply(prepare.op(…))`
			...applied(prepare, apply),
			/** Every op prepared (R6): pure, a plan of named steps + its effect, or `refused`. */
			prepare,
			/** Write a prepared plan exactly (refusals pass through). */
			apply,
			compose,
			// transactions (composed ops already run in one; expose for callers
			// that batch several ops into one undo step / one event)
			transact: <R>(fn: () => R, origin?: unknown): R => write(() => doc.transact(fn, origin)),
			// escape hatch for U08/debugging — the bound engine layers.
			model: M,
			text: T,
			runsView,
			// ── model-state version + typed node surface (WU2) ──────────
			/**
			 * The index version — bumps on every fold that changed derived
			 * state, mid-transaction writes included. Read surfaces that
			 * memoize on it (the editor's projected-tree cache) always observe
			 * post-write state — this is the read-your-writes contract.
			 */
			get version() {
				return runsView.version();
			},
			/**
			 * The typed handle over one document block — the domain command
			 * surface (see `nodes.ts` for the contract: display offsets,
			 * transaction-aware reads, dead-safe). Handles are cached per
			 * id; a handle for an absent id reports `exists`/`live`/`visible`
			 * false and refuses ops.
			 */
			block: (id: BlockId): DocBlock => nodes().block(ref(id))
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
		restore,
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
