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
 *   allowed. Moving INTO an island subtree is rejected. `canPlace` and
 *   `canMerge` are the one answer, asked in advance or by the ops (R5).
 * - Island merge: when an island block itself is merged (backward or
 *   forward), its children are unnested to the vacated sibling slot and
 *   reset to the default child of that slot's parent (`defaultChild`).
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
	AT_NODE,
	BLOCK_NODE,
	CONTENT_NODE,
	DATA,
	DEL_PREFIX,
	ID,
	LAST_CHANGED_ATTR,
	TYPE,
	SCHEMA
} from './schema.js';
import {
	bindModel,
	displayParentOf,
	isLiveIn,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ProjectedBlock,
	type SplitTail
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
	type SliceEntry,
	type TextBlockRec
} from './text/model.js';
import { bindRuns, type ContentRun, type RunView } from './text/runs.js';
import { bindNodes, type DocBlock } from './nodes.js';
import {
	clockOf,
	deletedLen,
	walkIdSetStructs,
	type IdSetLike,
	type StoreStruct
} from './structs.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import type { AttributionActor } from './attribution/index.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import { randOf } from './rand.js';
import { rangeDeleteOps, type DocPosition } from './rangeDelete.js';
import { jsonEquals } from '../utils/json.js';
import {
	cloneJsonSafe,
	jsonBlockToSpec,
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
	| { op: 'insertBlocks'; parent: BlockId | null; specs: BlockSpec[]; ranks: string[] }
	| { op: 'moveBlocks'; ids: BlockId[]; parent: BlockId | null; ranks: string[] }
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
	| { op: 'setBlockData'; id: BlockId; data: Record<string, unknown> }
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
	  }
	| {
			op: 'setInlineData';
			id: BlockId;
			offset: number;
			inlineId: string;
			data: Record<string, unknown>;
	  };

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
		} else if (w.op === 'setBlockType' || w.op === 'setBlockData') e.meta.push(w.id);
		else if (w.op === 'insertText') text(w.id, w.offset, w.text.length);
		else if (w.op === 'deleteText' || w.op === 'formatRange') text(w.id, w.offset, w.length);
		else text(w.id, w.offset, 1);
	}
	return e;
};

/**
 * Ingress for an id reference (O1): it normalizes exactly like a stored id
 * (`sanitizeSpec`), so a write and a later lookup by the same string agree.
 */
const ref = <I extends string | null>(id: I): I => (id === null ? id : sanitizeWireString(id)) as I;

/** Replacement content for `setBlock`. */
type SetBlockContent = (
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> }
)[];

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
		contentNodeName: CONTENT_NODE
	});

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
		const defaultChildOf = config.defaultChildOf ?? (() => undefined);
		const rendersContentOf = config.rendersContent ?? (() => true);
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

		// ── the write funnel (R6, O10, O19) ─────────────────────────────
		//
		// Every document op is a prepared plan (R6, below) written by `apply`:
		// one transaction, and a result folded from what that transaction
		// actually did — `applied` iff this replica's clock advanced (an item
		// was written) or the transaction's delete set grew; otherwise `noop`.
		// The plan decides what to write (a same-value attr or format is never
		// planned); the result is observed, never predicted.
		//
		// Each apply opens a frame. When it closes, ONE pass over what the
		// frame wrote stamps attribution and commits lineage (U1): a block
		// created by a registry insert gets its `createdBy` record; a block whose content, claims, type or data
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
			clock: number;
			deleted: number;
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

		/** The frame's one attribution pass over what its transaction wrote. */
		const close = (f: Frame, tr: unknown): void => {
			const actor = actorOf();
			const now = clockOf(doc);
			const deletes = deletedLen(tr) > f.deleted;
			if (actor === undefined || (now === f.clock && !deletes)) return;
			const registry = M.registryOf(doc);
			const created = new Set<BlockId>();
			const changed = new Set<BlockId>();
			const gone = new Set<BlockId>(f.unions.map(([, from]) => from));
			const sort = (inserted: boolean) => (s: StoreStruct) => {
				let n = s.parent as EngineNode | null;
				let facet: string | null = null;
				if (n === registry) {
					if (inserted && typeof s.parentSub === 'string') created.add(s.parentSub);
					return;
				}
				while (n !== null && typeof n === 'object' && n.name !== BLOCK_NODE) {
					facet = n.name;
					n = (n._item?.parent ?? null) as EngineNode | null;
				}
				const id = n?.getAttr(ID);
				if (typeof id !== 'string') return;
				if (facet === null) {
					if (s.parentSub === TYPE || s.parentSub === DATA) changed.add(id);
					else if (s.parentSub?.startsWith(DEL_PREFIX)) gone.add(id);
				} else if (facet !== AT_NODE) changed.add(id);
			};
			const own = new Map([
				[doc.clientID, { getIds: () => [{ clock: f.clock, len: now - f.clock }] }]
			]);
			walkIdSetStructs(Y, doc, { clients: own, has: () => false }, sort(true));
			if (deletes)
				walkIdSetStructs(Y, doc, (tr as { deleteSet: IdSetLike }).deleteSet, sort(false));
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

		/** One planned step, written (the plan decided it; writers never refuse). */
		const writeStep = (w: PlanStep, f: Frame): void => {
			// Structural steps need no view: delete marks and placements write one node.
			if (w.op === 'deleteBlock')
				return w.marks.forEach((id) =>
					M.blockNodeOf(doc, id)!.setAttr(DEL_PREFIX + doc.clientID, true)
				);
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
				case 'setBlockData':
					return void node(w.id).setAttr(DATA, w.data);
				case 'insertText':
					return T.insertIntoText(doc, blocks, own, w.id, w.offset, w.text, w.marks);
				case 'insertInline':
					return T.insertIntoText(doc, blocks, own, w.id, w.offset, M.buildInline(w.atom));
				case 'deleteText':
				case 'removeInline':
					return T.deleteRange(doc, blocks, own, w.id, w.offset, 'length' in w ? w.length : 1);
				case 'formatRange':
					return T.formatRangeIn(doc, blocks, own, w.id, w.offset, w.length, w.marks);
				case 'setInlineData':
					for (const seg of T.flatten(w.id, blocks, own)) {
						let p = 0;
						for (const entry of blocks.get(seg.t)!.content!.toArray()) {
							if (
								isNodeLike(entry) &&
								entry.getAttr(ID) === w.inlineId &&
								p >= seg.i0 &&
								p < seg.i1
							)
								return void entry.setAttr(DATA, w.data);
							p += typeof entry === 'string' ? entry.length : 1;
						}
					}
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
			if (p.version !== stateVersion) {
				throw new Error('[edytor-doc] stale plan: prepared against another document version');
			}
			return write(() =>
				doc.transact((tr) => {
					const f: Frame = {
						clock: clockOf(doc),
						deleted: deletedLen(tr),
						lineage: new Map(),
						inherit: new Map(),
						unions: []
					};
					// Lineage captures every target's pre-write state before the
					// first write; destructive steps capture whoever owns `l`.
					for (const w of p.writes) {
						if (w.op === 'deleteBlock') capture(f, w.id, true);
						else if (w.op === 'mergeBlocks') {
							capture(f, w.from, true);
							capture(f, w.into);
						} else if ('id' in w) capture(f, w.id);
					}
					for (const w of p.writes) {
						invalidate();
						writeStep(w, f);
					}
					close(f, tr);
					return clockOf(doc) > f.clock || deletedLen(tr) > f.deleted
						? { status: 'applied', ids: p.ids }
						: NOOP;
				})
			);
		};

		/** The one serializer (L14): `id`'s subtree in the public `JSONBlock` shape. */
		const blockJSON = (id: BlockId): JSONBlock => {
			const block: JSONBlock = {
				type: blockTypeOf(id) ?? '',
				id,
				data: (blockDataOf(id) ?? {}) as JSONBlock['data']
			};
			const content = runsView.contentJSON(id) as JSONBlock['content'] & unknown[];
			if (content.length > 0) block.content = content;
			const children = childrenIds(id);
			if (children.length > 0) block.children = children.map(blockJSON);
			return block;
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
			const t = M.blockNodeOf(doc, id)?.getAttr(TYPE);
			return typeof t === 'string' ? t : undefined;
		};

		const blockDataOf = (id: BlockId): Record<string, unknown> | undefined => {
			const d = M.blockNodeOf(doc, id)?.getAttr(DATA);
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
				const pos = M.positionInView(v.placements, v.own, cur);
				if (!pos) return null;
				path.unshift(pos.index);
				cur = pos.parent;
			}
			return path;
		};

		/** Display ancestors of `id`, nearest first (`null` parent = root → stop). */
		const ancestorsOf = (id: BlockId, v: View = view()): BlockId[] => {
			const out: BlockId[] = [];
			for (let cur = id; isLiveIn(v, cur); ) {
				const parent = displayParentOf(v.own, v.placements.get(cur)!);
				if (parent === null || parent === DEAD) break;
				out.push((cur = parent));
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

		// ── structural capability (R5, O8): one answer in advance and at execution ──

		/**
		 * May `ids` be placed under `parent` (`null` = the root)? Every id is
		 * live, distinct and outside any island interior (island subtrees are
		 * sealed); the destination is live, neither void nor an island nor
		 * inside one, and not inside any moved block's own subtree. Without a
		 * `parent`: may these blocks move at all (the drag affordance). The
		 * move ops refuse exactly when this answers `false`. (`insertBlock` is
		 * looser — island interiors are built by inserting into them.)
		 */
		const canPlace = (ids: readonly BlockId[], parent?: BlockId | null): boolean => {
			const v = view();
			if (ids.length === 0 || new Set(ids).size !== ids.length) return false;
			if (ids.some((id) => !isLiveIn(v, id) || insideIsland(id, v))) return false;
			if (parent === undefined || parent === null) return true;
			if (!isLiveIn(v, parent) || isVoid(parent)) return false;
			return ![parent, ...ancestorsOf(parent, v)].some((a) => isIsland(a) || ids.includes(a));
		};

		/**
		 * May `fromId`'s content merge into `intoId`? Both live and distinct,
		 * neither void, and the merge stays on one side of an island boundary
		 * (a block may merge into its own island root — that stays inside).
		 */
		const canMerge = (fromId: BlockId, intoId: BlockId): boolean => {
			const v = view();
			if (fromId === intoId || !isLiveIn(v, fromId) || !isLiveIn(v, intoId)) return false;
			if (isVoid(fromId) || isVoid(intoId)) return false;
			const islandFrom = islandOf(fromId, v);
			return islandFrom === islandOf(intoId, v) || intoId === islandFrom;
		};

		/** The adopted default child type under `parent` (`null` = the root). */
		const defaultChild = (parent: BlockId | null): string => {
			const t = parent === null ? undefined : blockTypeOf(parent);
			return (t !== undefined ? defaultChildOf(t) : undefined) ?? defaultType;
		};

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
			const mustEscalate = (id: BlockId): boolean => !before.nodes.has(id) && isLiveIn(v, id); // live-but-untracked
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
							const pending = lineagePending(bid, true);
							if (pending !== undefined) BA.appendLineage(doc, bid, pending, lineageDepth);
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

		/**
		 * Display length in atoms (chars + inline atoms) of `id`'s content —
		 * computed from the LIVE view so mid-transaction callers read
		 * post-write state.
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

		/** Registry membership — the block exists (may be delete-marked or merged away). */
		const hasBlock = (id: BlockId): boolean => M.blockNodeOf(doc, id) !== null;

		/** The one liveness answer ({@link isLiveIn}): `id` renders in `project()`. O(depth). */
		const isVisibleBlock = (id: BlockId): boolean => M.isLive(doc, id);

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

		/** A replacement content item normalized at ingress. */
		const sanitizeItem = (item: SetBlockContent[number]): SetBlockContent[number] =>
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
		const plan = (ids: readonly BlockId[], writes: PlanStep[]): Plan => ({
			ids,
			writes,
			effect: effectOf(writes),
			version: stateVersion
		});
		const live = (id: BlockId): boolean => isLiveIn(view(), id);
		/** A live block that can hold content: its own backing text and slice list. */
		const contentTarget = (id: BlockId): boolean => {
			const rec = view().blocks.get(id);
			return live(id) && rec?.content !== undefined && rec.slicesNode !== undefined;
		};

		/** `count` ranks at `index` among `parent`'s children, the moving `exclude` left out. */
		const ranksFor = (
			parent: BlockId | null,
			index: number,
			count: number,
			exclude: readonly BlockId[] = []
		): string[] => {
			const sibs = (view().kids.get(parent) ?? []).filter((k) => !exclude.includes(k.id));
			const at = Math.max(0, Math.min(index, sibs.length));
			return M.ranksAt(sibs, at, count, doc.clientID, randOf(doc));
		};
		const move = (ids: BlockId[], parent: BlockId | null, index: number): PlanStep[] =>
			ids.length === 0
				? []
				: [{ op: 'moveBlocks', ids, parent, ranks: ranksFor(parent, index, ids.length, ids) }];
		/** A type/data step, planned only when the value differs (the one same-value guard). */
		const attr = (id: BlockId, key: typeof TYPE | typeof DATA, value: unknown): PlanStep[] => {
			if (jsonEquals(M.blockNodeOf(doc, id)!.getAttr(key), value)) return [];
			return [
				key === TYPE
					? { op: 'setBlockType', id, type: value as string }
					: { op: 'setBlockData', id, data: value as JsonObj }
			];
		};
		/** Delete (R3): marks on `id` and on what it displays; `id` and its subtree leave, `kept` children aside. */
		let displayed: { version: number; by: Map<BlockId, BlockId[]> } | undefined;
		const remove = (id: BlockId, kept: readonly BlockId[] = []): PlanStep => {
			const v = view();
			const removes: BlockId[] = [];
			const walk = (b: BlockId): void => {
				removes.push(b);
				for (const kid of childrenIds(b)) if (!kept.includes(kid)) walk(kid);
			};
			walk(id);
			// Who displays what, once per version (a block set deletes many).
			if (displayed?.version !== stateVersion) {
				const by = new Map<BlockId, BlockId[]>();
				for (const b of v.blocks.keys()) {
					const owner = v.own.ownerOf(b);
					if (typeof owner === 'string') by.set(owner, [...(by.get(owner) ?? []), b]);
				}
				displayed = { version: stateVersion, by };
			}
			return { op: 'deleteBlock', id, marks: displayed.by.get(id) ?? [], removes };
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
		 * Refused when the parent is not live or is `void`, or any id collides.
		 * Inserting INSIDE an island is allowed — island interiors are built
		 * this way. `ids`: the inserted roots.
		 */
		const insertBlocks = (dest: Destination, specs: readonly BlockSpec[]): Prepared => {
			const parent = ref(dest.parent);
			const clean = specs.map(sanitizeSpec);
			if (parent !== null && isVoid(parent)) return REFUSED;
			if (clean.length === 0) return plan([], []);
			if ((parent !== null && !live(parent)) || M.collides(doc, clean)) return REFUSED;
			const ranks = ranksFor(parent, dest.index, clean.length);
			return plan(
				clean.map((s) => s.id),
				[{ op: 'insertBlocks', parent, specs: clean, ranks }]
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
			return canPlace(moved, parent) ? plan(moved, move(moved, parent, dest.index)) : REFUSED;
		};
		/** Move `id` beside its parent (index = parent index + 1). */
		const unNestBlock = (id: BlockId): Prepared => {
			const pos = positionOf(ref(id));
			const ppos = pos?.parent != null ? positionOf(pos.parent) : null;
			return ppos ? moveBlocks([id], { parent: ppos.parent, index: ppos.index + 1 }) : REFUSED;
		};

		/**
		 * Split `id` at content `offset` into a new sibling `newId` (the tail's
		 * slice records move, no atom copies; children follow the sibling).
		 * `tail` decides the sibling's type/data once (default: the source's).
		 * Refused on `void` blocks. `ids`: the new block.
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
			if (pos === null || isVoid(id) || !rec?.slicesNode || M.blockNodeOf(doc, born) !== null) {
				return REFUSED;
			}
			const [at] = clamp(id, offset, 0);
			const t = tail
				? { type: ref(tail.type), data: tail.data && sanitizeWireJson(tail.data) }
				: { type: rec.node.getAttr(TYPE) as string, data: rec.node.getAttr(DATA) as JsonObj };
			const [rank] = ranksFor(pos.parent, pos.index + 1, 1);
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
		 * children ADOPTED into `into`'s child list, and `from` is hidden via
		 * the claim (undo restores it). Role rules are `canMerge`'s; a merge
		 * that would close a display cycle is refused. `ids`: `into`.
		 */
		const mergeBlocks = (fromId: BlockId, intoId: BlockId): Prepared => {
			const from = ref(fromId);
			const into = ref(intoId);
			const v = view();
			if (!canMerge(from, into) || !v.blocks.get(into)?.slicesNode) return REFUSED;
			if (M.isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
			return plan([into], [merge(from, into), ...move(childrenIds(from), into, Infinity)]);
		};

		/**
		 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
		 * `from`'s children unnest to `from`'s vacated sibling slot — NOT
		 * adopted into `into` — and, when `from` is an island, take the default
		 * child of that slot's parent; then `from`'s content claims into `into`.
		 */
		const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
			const pos = canMerge(from, into) ? positionOf(from) : null;
			if (pos === null || !view().blocks.get(into)?.slicesNode) return REFUSED;
			const kids = childrenIds(from);
			const reset = isIsland(from) ? defaultChild(pos.parent) : null;
			const retype = reset === null ? [] : kids.flatMap((kid) => attr(kid, TYPE, reset));
			return plan([into], [...move(kids, pos.parent, pos.index), ...retype, merge(from, into)]);
		};

		/**
		 * Baseline `mergeBlockBackward`: merge `id` into the previous block in
		 * document order. No previous block → an empty block merges forward,
		 * else refused. `ids`: the surviving block.
		 */
		const mergeBackward = (id: BlockId): Prepared => {
			id = ref(id);
			const prev = isVoid(id) ? undefined : previous(id);
			if (prev === null && childrenIds(id).length === 0 && displayLength(id) === 0) {
				return mergeForward(id);
			}
			return prev ? mergeUnnesting(id, prev) : REFUSED;
		};

		/** Baseline `mergeBlockForward`: pull the next block in document order into `id`. */
		const mergeForward = (id: BlockId): Prepared => {
			id = ref(id);
			const after = isVoid(id) ? null : next(id);
			return after ? mergeUnnesting(after, id) : REFUSED;
		};

		/**
		 * Delete `id` (R3: this writer's marks on `id` and on what it displays
		 * through merge claims — wins over concurrent moves). `keepChildren`
		 * first moves the children to `id`'s vacated slot, identity preserved.
		 */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): Prepared => {
			id = ref(id);
			const pos = positionOf(id);
			if (pos === null) return REFUSED;
			const kids = opts.keepChildren ? childrenIds(id) : [];
			return plan([id], [...move(kids, pos.parent, pos.index), remove(id, kids)]);
		};

		/** Set the block type (attr write — the block keeps its identity). */
		const setBlockType = (id: BlockId, type: string): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], attr(id, TYPE, ref(type))) : REFUSED;
		};

		/** Replace the block's `data` payload (whole-attr write). */
		const setBlockData = (id: BlockId, data: Record<string, unknown>): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], attr(id, DATA, sanitizeWireJson(data))) : REFUSED;
		};

		/**
		 * Baseline `setBlock`: `type`/`data` update the block in place;
		 * `content`/`children` REPLACE wholesale — explicit replacement is a
		 * new-identity operation. All-or-nothing (D-12): `children` on a `void`
		 * block, or a replacement id that is already taken (a live or deleted
		 * block, the replaced children included, or a duplicate inside the
		 * replacement), refuses before any write — `id-collision` for the
		 * latter. A caller wanting a child back re-creates it with a fresh id.
		 */
		const setBlock = (
			id: BlockId,
			value: {
				type?: string;
				data?: Record<string, unknown>;
				content?: SetBlockContent;
				children?: BlockSpec[];
			}
		): Prepared => {
			id = ref(id);
			const content = value.content?.map(sanitizeItem);
			const children = value.children?.map(sanitizeSpec);
			if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
			if (children !== undefined && isVoid(id)) return REFUSED;
			if (children !== undefined && M.collides(doc, children)) return refused('id-collision');
			const writes: PlanStep[] = [
				...(value.type === undefined ? [] : attr(id, TYPE, ref(value.type))),
				...(value.data === undefined ? [] : attr(id, DATA, sanitizeWireJson(value.data)))
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
					writes.push({ op: 'insertBlocks', parent: id, specs: children, ranks });
			}
			return plan([id], writes);
		};

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * serializes `id`, remaps every block id through `freshId`, inserts the
		 * copy right after `id`. Text atoms get new identity too — duplication
		 * is a creation op, not a relocation. `ids`: the copy's root.
		 */
		const duplicateBlock = (id: BlockId, freshId: (oldId: BlockId) => BlockId): Prepared => {
			id = ref(id);
			const pos = positionOf(id);
			if (pos === null) return REFUSED;
			const spec = (b: BlockId): BlockSpec => {
				const data = blockDataOf(b);
				return {
					id: freshId(b),
					type: blockTypeOf(b) ?? '',
					...(data !== undefined && { data }),
					content: contentItems(b),
					children: childrenIds(b).map(spec)
				};
			};
			return insertBlocks({ parent: pos.parent, index: pos.index + 1 }, [spec(id)]);
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

		const setInlineData = (
			id: BlockId,
			inlineId: string,
			data: Record<string, unknown>
		): Prepared => {
			id = ref(id);
			const clean = sanitizeWireJson(data);
			const atom = atomOf(id, ref(inlineId));
			if (atom === undefined) return REFUSED;
			if (jsonEquals((atom.item as InlineSpec).data, clean)) return plan([id], []);
			const step = {
				op: 'setInlineData',
				id,
				offset: atom.at,
				inlineId: ref(inlineId),
				data: clean
			};
			return plan([id], [step as PlanStep]);
		};

		/** Every document op, prepared (R6) — `apply(prepare.op(…))` is the op. */
		const prepare = {
			insertBlocks,
			insertBlock: (dest: Destination, spec: BlockSpec) => insertBlocks(dest, [spec]),
			moveBlocks,
			/** Relocate `id` — identity preserved. */
			moveBlock: (id: BlockId, dest: Destination) => moveBlocks([id], dest),
			/** Move `id` to the last position under `parent`. */
			nestBlock: (id: BlockId, parent: BlockId) =>
				moveBlocks([id], { parent, index: childrenIds(ref(parent)).length }),
			unNestBlock,
			splitBlock,
			mergeBlocks,
			mergeBackward,
			mergeForward,
			deleteBlock,
			setBlock,
			setBlockType,
			setBlockData,
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
			setInlineData,
			/** Delete a set of blocks (a block selection) — one plan; nested members ride their ancestor. */
			deleteBlocks: (ids: readonly BlockId[]): Prepared => {
				const set = new Set(ids.map(ref));
				if ([...set].some((id) => !live(id))) return REFUSED;
				const roots = [...set].filter((id) => !ancestorsOf(id).some((a) => set.has(a)));
				return plan(
					roots,
					roots.map((id) => remove(id))
				);
			},
			...rangeDeleteOps({
				ref,
				refused: REFUSED,
				plan,
				order: () => view().order,
				positionOf,
				ancestorsOf: (id) => ancestorsOf(id),
				childrenIds,
				displayLength,
				contentTarget,
				rendersContent: (id) => rendersContentOf(blockTypeOf(id) ?? ''),
				canMerge,
				isIsland,
				defaultChild,
				move,
				retype: (id, type) => attr(id, TYPE, type),
				remove,
				insertBlocks
			})
		};

		// ── JSON boundary ─────────────────────────────────────────────────

		/**
		 * Public JSON export — `{ children: JSONBlock[] }` matching
		 * `src/lib/utils/json.ts` (`data` always present, `content`/`children`
		 * omitted when empty): the one serializer, {@link blockJSON}, over the
		 * root's visible children.
		 */
		const toJSON = (): JSONDoc => ({ children: childrenIds(null).map(blockJSON) });

		// ── facade object ─────────────────────────────────────────────────

		/**
		 * The typed-node surface (`document.block(id)` handles — see
		 * `nodes.ts`). Created lazily on first use; `bindNodes` caches one
		 * handle per block id, so repeated `facade.block(id)` calls return
		 * the same instance.
		 */
		/** A read taking an id first: the id normalizes at ingress (O1). */
		const byRef =
			<I extends BlockId | null, A extends unknown[], R>(f: (id: I, ...rest: A) => R) =>
			(id: I, ...rest: A): R =>
				f(ref(id), ...rest);

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
			// reads — every id argument normalizes at ingress (O1)
			project: () => M.project(doc),
			toJSON,
			blockJSON: byRef(blockJSON),
			childrenIds: byRef(childrenIds),
			positionOf: byRef(positionOf),
			pathOf: byRef(pathOf),
			parentOf: byRef((id: BlockId) => positionOf(id)?.parent ?? null),
			ancestorsOf: byRef((id: BlockId) => ancestorsOf(id)),
			listBlockIds: () => M.listBlockIds(doc),
			blockText: byRef((id: BlockId) => M.blockText(doc, id)),
			blockTypeOf: byRef(blockTypeOf),
			blockDataOf: byRef(blockDataOf),
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
			isVisibleBlock: byRef(isVisibleBlock),
			order,
			compare: (a: BlockId, b: BlockId) => compare(ref(a), ref(b)),
			next: byRef(next),
			previous: byRef(previous),
			// caret anchors (U09) — backing-text-bound selection endpoints
			anchorAt: byRef(anchorAt),
			resolveAnchor,
			// roles
			isVoid: byRef(isVoid),
			isIsland: byRef(isIsland),
			islandOf: byRef((id: BlockId) => islandOf(id)),
			insideIsland: byRef((id: BlockId) => insideIsland(id)),
			// structural capability (R5)
			canPlace: (ids: readonly BlockId[], parent?: BlockId | null) =>
				canPlace(ids.map(ref), parent == null ? parent : ref(parent)),
			canMerge: (from: BlockId, into: BlockId) => canMerge(ref(from), ref(into)),
			defaultChild: byRef(defaultChild),
			// maintained runs (U05 surface, bound to this doc)
			runs: byRef(runsView.runs),
			snapshot: runsView.snapshot,
			contentJSON: byRef(runsView.contentJSON),
			blockVersion: byRef(runsView.blockVersion),
			subscribeBlock: byRef(runsView.subscribeBlock),
			// events
			onChange,
			// every op — each returns an {@link OpResult}; `apply(prepare.op(…))`
			...applied(prepare, apply),
			/** Every op prepared (R6): pure, a plan of named steps + its effect, or `refused`. */
			prepare,
			/** Write a prepared plan exactly (refusals pass through). */
			apply,
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
