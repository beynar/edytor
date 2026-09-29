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
import { DEV } from 'esm-env';
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode, YUndoManager } from './engine-api.js';
import { hash32, setDocRand } from './rand.js';
import {
	AT,
	BLOCK_NODE,
	CONTENT_NODE,
	DATA,
	DEL_PREFIX,
	ID,
	INLINE_NODE,
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
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ModelView,
	type ProjectedBlock,
	type SplitTail
} from './placement/model.js';
import { bindText, DEAD, displayOf, locate, ownedLength, type Anchor } from './text/model.js';
import { bindDeletes } from './text/deletes.js';
import {
	bindRuns,
	CONTENT_ATTR,
	ENTRY_FACET,
	type ContentRun,
	type Folded,
	type IndexReport,
	type RunView
} from './text/runs.js';
import { bindNodes, type DocBlock } from './nodes.js';
import { followRedone, holdsPending, walkIdSetStructs, type IdSetLike } from './structs.js';
import { ownTextIds } from './text/model.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import type { AttributionActor } from './attribution/index.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import { randOf } from './rand.js';
import { rangeDeleteOps, type DocPosition } from './rangeDelete.js';
import { flowOps, type FlowContext } from './flow.js';
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
	// Text written into a block the plan creates is part of its creation.
	e.textRanges = e.textRanges.filter((r) => !e.creates.includes(r.block));
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
		// The writer lives in a low band, [1, 2^26): a registry race is won by
		// the larger client id and live replicas draw uint53 ids, so a seed
		// sharing a block id with live content loses to it (UW-03) but for a
		// live id below the band (~2^-27). Two different seeds collide on one
		// writer at ~2^-26. The band moved from the full 32 bits: an id-less
		// template seeded late into a document seeded by an older build
		// mints new ids and shows twice, once.
		const writer =
			hash32(`yjs-v14/${SCHEMA_NAME}@${SCHEMA_VERSION}:${JSON.stringify(blocks)}`) >>> 6 || 1;
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
		// UW-21b: a void kind displays no children — the index sheds them
		// into its slot at read time, so a child a peer nests or splits under
		// a block another peer retypes to a void shows on every replica.
		const voidKind = (type: string): boolean => roleOf(type)?.void === true;
		if (config.roleOf) runsView.childless(voidKind);

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
					return void T.findAtom(own, w.id, w.inlineId)?.node.setAttr(DATA, w.data);
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
					// Lineage captures every target's pre-write state before the
					// first write; destructive steps capture whoever owns `l`.
					for (const w of p.writes) {
						if (w.op === 'deleteBlock') capture(f, w.id, true);
						else if (w.op === 'mergeBlocks') {
							capture(f, w.from, true);
							capture(f, w.into);
						} else if ('id' in w) capture(f, w.id);
					}
					for (const w of p.writes) writeStep(w, f);
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
			for (let p = displayParentOf(v.own, v.placements.get(id)!, v.placements); p !== null; ) {
				out.push(p as BlockId);
				p = displayParentOf(v.own, v.placements.get(p as BlockId)!, v.placements);
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
			const slot = displaySlotOf(v.own, v.placements, pl);
			return slot.parent === DEAD ? pl : (slot as { parent: BlockId | null; rank: string });
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
		const subs = new Set<(change: DocChange) => void>();
		let unsubscribe: (() => void) | null = null;
		/** One `DocChange` per commit, from the index's change report (the fold). */
		const publish = (report: IndexReport, origin: unknown, local: boolean): void => {
			const change: DocChange = { origin, local, version: ++changeVersion, ...report };
			// R5 listener isolation (callAll convention): a throwing subscriber
			// must not starve later subscribers — invoke all, then rethrow the
			// first error to the committer.
			let firstErr: unknown;
			let threw = false;
			for (const cb of [...subs]) {
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
			unsubscribe ??= runsView.onReport(publish);
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
				if (key === null || !REPAIRED[node?.name]?.includes(key)) return;
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
			opts: ConstructorParameters<EngineApi['UndoManager']>[1] = {}
		): YUndoManager => {
			if (disposed) {
				throw new EdytorDocDisposedError('createUndoManager');
			}
			write(() => {
				if (!isInitialized(doc)) init(doc);
			});
			// Text delete marks (P11): the marks are in scope (an undo removes the
			// undoer's own), and the history restores text only as the marks allow.
			// An undone creation withdraws the block instead of deleting it (P12).
			const marks = D.history(doc, () => um);
			const um: YUndoManager = new Y.UndoManager(
				[M.registryOf(doc), D.scope(doc)] as unknown as YNode[],
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
								let n = s.parent as EngineNode | null;
								while (n !== null && typeof n?.getAttr === 'function') {
									const bid = n.name === BLOCK_NODE ? n.getAttr(ID) : undefined;
									if (typeof bid === 'string') return void touched.add(bid);
									n = (n._item?.parent ?? null) as EngineNode | null;
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
		const contentItems = (id: BlockId): ContentItem[] => {
			// The maintained view's canonical item read — interned payloads,
			// transaction-aware via the same `modelCtx` view() consults.
			return runsView.contentItems(id);
		};

		/** Registry membership — the block exists (may be delete-marked or merged away). */
		const hasBlock = (id: BlockId): boolean => M.blockNodeOf(doc, id) !== null;

		/** The one liveness answer ({@link isLiveIn}): `id` renders in `project()`. O(depth). */
		const isVisibleBlock = (id: BlockId): boolean => M.isLive(doc, id);

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
			const s = own.streamsIn(anchor.b).find((x) => x.start <= i && i <= x.end);
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
			version: runsView.version()
		});
		const live = (id: BlockId): boolean => isLiveIn(view(), id);
		/** A live block that can hold content: it has a claims list (a streamless block gets its own text on first write). */
		const contentTarget = (id: BlockId): boolean => {
			const rec = view().blocks.get(id);
			return live(id) && rec?.claimsNode !== undefined;
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
				: [
						{
							op: 'moveBlocks',
							ids,
							parent,
							index,
							ranks: ranksFor(parent, index, ids.length, ids)
						}
					];
		/** A type/data step, planned only when the value differs (the one same-value guard). */
		const attr = (id: BlockId, key: typeof TYPE | typeof DATA, value: unknown): PlanStep[] => {
			if (jsonEquals(M.blockNodeOf(doc, id)!.getAttr(key), value)) return [];
			return [
				key === TYPE
					? { op: 'setBlockType', id, type: value as string }
					: { op: 'setBlockData', id, data: value as JsonObj }
			];
		};
		/**
		 * Delete (R3): `id` and its subtree leave, `kept` children aside. Every
		 * member is marked with what it displays — an unmarked one would be
		 * promoted into the deleted slot (`displaySlotOf`).
		 */
		const remove = (id: BlockId, kept: readonly BlockId[] = []): PlanStep => {
			const removes: BlockId[] = [];
			const walk = (b: BlockId): void => {
				removes.push(b);
				for (const kid of childrenIds(b)) if (!kept.includes(kid)) walk(kid);
			};
			walk(id);
			const marks = [...new Set(removes.flatMap((b) => view().displays(b)))];
			return { op: 'deleteBlock', id, marks, removes };
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
			return canPlace(moved, parent) ? plan(moved, move(moved, parent, dest.index)) : REFUSED;
		};
		/**
		 * Outdent (UW-23): move sibling blocks `ids` (document order) right
		 * after their parent, and hand the siblings that followed the last of
		 * them to it as its last children — every outliner's Shift+Tab. A last
		 * block that cannot adopt (void, island) leaves them with the parent.
		 * One plan; refused as the move is. `ids`: the moved blocks.
		 */
		const unNestBlocks = (ids: readonly BlockId[]): Prepared => {
			const moved = ids.map(ref);
			const last = moved.at(-1);
			const pos = last === undefined ? null : positionOf(last);
			const ppos = pos?.parent != null ? positionOf(pos.parent) : null;
			if (!ppos || moved.some((id) => positionOf(id)?.parent !== pos!.parent)) return REFUSED;
			const out = moveBlocks(moved, { parent: ppos.parent, index: ppos.index + 1 });
			const after = childrenIds(pos!.parent).slice(pos!.index + 1);
			if (!('writes' in out) || after.length === 0 || isVoid(last!) || isIsland(last!)) return out;
			return plan(moved, [...out.writes, ...move(after, last!, Infinity)]);
		};
		/** Outdent one block (`unNestBlocks`). */
		const unNestBlock = (id: BlockId): Prepared => unNestBlocks([id]);

		/**
		 * Split `id` at content `offset` into a new sibling `newId` (one boundary
		 * item and the claims that follow it, no text copied; children follow).
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
			if (pos === null || isVoid(id) || !rec?.claimsNode || M.blockNodeOf(doc, born) !== null) {
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
			if (!canMerge(from, into) || !v.blocks.get(into)?.claimsNode) return REFUSED;
			if (M.isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
			return plan([into], [merge(from, into), ...move(childrenIds(from), into, Infinity)]);
		};

		/**
		 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
		 * `from`'s children unnest right after `from`'s vacated sibling slot —
		 * NOT adopted into `into` — and, when `from` is an island, take the
		 * default child of that slot's parent; then `from`'s content claims
		 * into `into`. Ranked after `from`, not at it: a concurrent delete of
		 * `into` revives `from` above its former children (UW-20).
		 */
		const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
			const pos = canMerge(from, into) ? positionOf(from) : null;
			if (pos === null || !view().blocks.get(into)?.claimsNode) return REFUSED;
			const kids = childrenIds(from);
			const reset = isIsland(from) ? defaultChild(pos.parent) : null;
			const retype = reset === null ? [] : kids.flatMap((kid) => attr(kid, TYPE, reset));
			return plan([into], [...move(kids, pos.parent, pos.index + 1), ...retype, merge(from, into)]);
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
		 * Delete a set of blocks (R3, `del.blocks.promote`): this writer's mark on
		 * every member and on what it displays through merge claims (wins over
		 * concurrent moves). Only the members leave: the unselected children of a
		 * deleted block take its slot, in order, with their subtrees (a deleted
		 * island's children take the slot parent's default child type, like an
		 * island merge). `subtree` is the explicit whole-subtree delete.
		 */
		const deleteBlocks = (ids: readonly BlockId[], subtree = false): Prepared => {
			const set = new Set(ids.map(ref));
			if ([...set].some((id) => !live(id))) return REFUSED;
			if (subtree) {
				const roots = [...set].filter((id) => !ancestorsOf(id).some((a) => set.has(a)));
				return plan(
					roots,
					roots.map((id) => remove(id))
				);
			}
			const roots = [...set].filter((id) => !set.has(positionOf(id)!.parent!));
			const slots = view().kids;
			const writes = roots.flatMap((root) => {
				const pos = positionOf(root)!;
				const chunk: BlockId[] = [];
				const kids: { id: BlockId; from: BlockId; rank: string }[] = [];
				// Each kept child moves to the rank read-time promotion gives it
				// (`promotedRank`), so a block a peer puts under a member meanwhile
				// takes the slot in the member's order among them. Right after the
				// root: a flow placed in the root's slot precedes them.
				const walk = (b: BlockId, slot: string): void => {
					chunk.push(b);
					for (const kid of slots.get(b) ?? []) {
						const rank = promotedRank(slot, kid.rank);
						if (set.has(kid.id)) walk(kid.id, rank);
						else kids.push({ id: kid.id, from: b, rank });
					}
				};
				walk(root, slots.get(pos.parent)![pos.index]!.rank);
				const reset = defaultChild(pos.parent);
				const retype = kids.flatMap((k) => (isIsland(k.from) ? attr(k.id, TYPE, reset) : []));
				const marks = [...new Set(chunk.flatMap((b) => view().displays(b)))];
				const moved: PlanStep[] =
					kids.length === 0
						? []
						: [
								{
									op: 'moveBlocks',
									ids: kids.map((k) => k.id),
									parent: pos.parent,
									index: pos.index + 1,
									ranks: kids.map((k) => k.rank)
								}
							];
				return [
					...moved,
					...retype,
					{ op: 'deleteBlock', id: root, marks, removes: chunk } as PlanStep
				];
			});
			return plan(roots, writes);
		};

		/** Delete `id` — its children take its slot (`keepChildren: false`: the whole subtree). */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): Prepared =>
			deleteBlocks([id], opts.keepChildren === false);

		/**
		 * The target role decides (UW-21): nothing renders a void's children,
		 * so a block retyped to a void kind hands them to the slot right after
		 * it — the island-merge rule (an island's children take the slot
		 * parent's default child type). Each moves to the rank the read-time
		 * shedding gives it (`promotedRank`, UW-21b), so a child a peer adds
		 * meanwhile keeps its place in the void's order among them.
		 */
		const retypeSteps = (id: BlockId, type: string): PlanStep[] => {
			const { kids } = view();
			const pos = positionOf(id);
			const steps = attr(id, TYPE, type);
			const moved = kids.get(id) ?? [];
			if (roleOf(type)?.void !== true || moved.length === 0 || pos === null) return steps;
			const slot = kids.get(pos.parent)![pos.index]!.rank;
			const ids = moved.map((k) => k.id);
			const reset = isIsland(id) ? defaultChild(pos.parent) : null;
			return [
				...steps,
				{
					op: 'moveBlocks',
					ids,
					parent: pos.parent,
					index: pos.index + 1,
					ranks: moved.map((k) => promotedRank(slot, k.rank))
				},
				...(reset === null ? [] : ids.flatMap((kid) => attr(kid, TYPE, reset)))
			];
		};

		/** Set the block type (attr write — the block keeps its identity; see `retypeSteps`). */
		const setBlockType = (id: BlockId, type: string): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], retypeSteps(id, ref(type))) : REFUSED;
		};

		/** Replace the block's `data` payload (whole-attr write). */
		const setBlockData = (id: BlockId, data: Record<string, unknown>): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], attr(id, DATA, sanitizeWireJson(data))) : REFUSED;
		};

		/**
		 * Baseline `setBlock`: `type`/`data` update the block in place;
		 * `content`/`children` REPLACE wholesale — explicit replacement is a
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
				content?: SetBlockContent;
				children?: BlockSpec[];
			}
		): Prepared => {
			id = ref(id);
			const content = value.content?.map(sanitizeItem);
			const children = value.children?.map(sanitizeSpec);
			if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
			const type = value.type === undefined ? undefined : ref(value.type);
			const toVoid = type === undefined ? isVoid(id) : roleOf(type)?.void === true;
			if (children?.length && toVoid) return REFUSED;
			if (children !== undefined && M.collides(doc, children)) return refused('id-collision');
			const writes: PlanStep[] = [
				...(type === undefined
					? []
					: children === undefined
						? retypeSteps(id, type)
						: attr(id, TYPE, type)),
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
					writes.push({ op: 'insertBlocks', parent: id, index: 0, specs: children, ranks });
			}
			return plan([id], writes);
		};

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * serializes `id`, remaps every block and inline atom id through
		 * `freshId`, inserts the copy right after `id`. Text atoms get new
		 * identity too — duplication is a creation op, not a relocation. `ids`:
		 * the copy's root.
		 */
		const duplicateBlock = (
			id: BlockId,
			freshId: (oldId: string, kind: 'block' | 'inline') => string
		): Prepared => {
			id = ref(id);
			const pos = positionOf(id);
			if (pos === null) return REFUSED;
			const spec = (b: BlockId): BlockSpec => {
				const data = blockDataOf(b);
				return {
					id: freshId(b, 'block'),
					type: blockTypeOf(b) ?? '',
					...(data !== undefined && { data }),
					content: contentItems(b).map((item) =>
						item.kind === 'inline' ? { ...item, id: freshId(item.id, 'inline') } : item
					),
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
			rendersContent: (id) => rendersContentOf(blockTypeOf(id) ?? ''),
			canMerge,
			isIsland,
			defaultChild,
			move,
			retype: (id, type) => attr(id, TYPE, type),
			remove,
			insertBlocks,
			sanitize: sanitizeSpec,
			collides: (specs) => M.collides(doc, specs),
			isVoid,
			tailOf: (id) => ({ type: blockTypeOf(id)!, data: blockDataOf(id) }),
			ranksFor,
			redata: (id, data) => attr(id, DATA, data),
			deleteBlocks: (ids) => prepare.deleteBlocks(ids)
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
			unNestBlocks,
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
			followUndo,
			// roles
			/** Re-read the roles after `roleOf` answers differently (roles adopted later). */
			rolesChanged: () => runsView.childless(voidKind),
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
