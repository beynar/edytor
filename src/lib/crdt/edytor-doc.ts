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
 * ── Deterministic bootstrap ────────────────────────────────────────────
 *
 * `init(doc)` stamps the version record and, iff the registry holds NO
 * entries at all, inserts the bootstrap block under the RESERVED id
 * {@link BOOTSTRAP_BLOCK_ID}. Concurrent initialization by N peers therefore
 * writes N registry attrs under the SAME key; the engine's map-attr LWW
 * keeps exactly one winner (and tombstones the losers' whole subtrees), so
 * replicas converge to one canonical empty root — never N fallback
 * paragraphs. Initial content may be supplied as spec blocks; concurrent
 * inits with identical ids dedupe the same way, different ids union.
 * Init is explicit: reads never create or normalize state.
 *
 * ── Identity discipline ────────────────────────────────────────────────
 *
 * Relocation (move/nest/unnest/split/merge/delete-with-children) preserves
 * block AND atom identity — the U03/U04 contract. New identity is created
 * ONLY by ops whose purpose is fresh identity: `insertBlock`/`insertSubtree`
 * (caller-assigned ids), `duplicateBlock` (explicit fresh ids for
 * paste/drag-clone), and `setBlock` content/children replacement (baseline
 * `setBlock` semantics — replacement is a new-identity operation).
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
import type { EngineApi, EngineDoc, EngineNode, YNode, YUndoManager } from './engine-api.js';
import {
	bindModel,
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
	isMergeClaim,
	isSliceRecord,
	type Anchor,
	type Ownership,
	type SliceEntry,
	type TextBlockRec
} from './text/model.js';
import { bindRuns, type ContentRun, type RunView } from './text/runs.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import {
	cloneJson,
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
		registry: 'blocks',
		/** Version/manifest record root (attrs: `v`, `schema`). */
		meta: 'meta'
	},
	/** Named node roles (YNode.name). */
	nodes: {
		block: 'block',
		content: 'content',
		slices: 'slices',
		at: 'at',
		inline: 'inline'
	},
	/** Attr keys on a block node. */
	blockAttrs: {
		id: 'id',
		type: 'type',
		data: 'data',
		/** Presence = explicitly deleted (deletion-wins flag). */
		del: 'del',
		content: 'content',
		slices: 'slices',
		at: 'at'
	},
	/** Attr keys on an inline-atom node. */
	inlineAttrs: { id: 'id', type: 'type', data: 'data' },
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

/**
 * Reserved block id for the deterministic bootstrap block. Caller-assigned
 * ids are arbitrary strings, so a namespaced constant removes any practical
 * collision; concurrent inits all write under this one key and the registry
 * LWW dedupes them to a single survivor.
 */
export const BOOTSTRAP_BLOCK_ID = 'edytor:bootstrap';

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
 */
export type SchemaProblem = {
	kind: 'unversioned' | 'unsupported';
	/** The observed `meta.v` (undefined for `unversioned`). */
	version?: number;
};

/**
 * Inspect the document's schema record. `null` = clean (versioned under the
 * supported schema, or completely untouched). Read-only, safe mid-transaction.
 */
export const checkSchema = (doc: EngineDoc): SchemaProblem | null => {
	const v = schemaVersion(doc);
	if (v === undefined) {
		return registryEmpty(doc) ? null : { kind: 'unversioned' };
	}
	if (v !== SCHEMA_VERSION) return { kind: 'unsupported', version: v };
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
				: `Document "${docName}" claims unsupported schema version ${problem.version} (this build speaks ${SCHEMA_VERSION}).`
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
	/** Parents (`null` = root) whose visible child list changed → new order. */
	order: Map<BlockId | null, BlockId[]>;
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
export type DocAnchor = { b: BlockId; a: Anchor };

// ── internals ───────────────────────────────────────────────────────────

type JsonObj = Record<string, unknown>;

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** Canonical key for a content item list — for change detection only. */
const contentKeyOf = (items: unknown): string => JSON.stringify(items ?? null);
const dataKeyOf = (v: unknown): string => JSON.stringify(v ?? null);

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
	/** parentKey (id or null for root) → ordered child ids. */
	order: Map<BlockId | null, BlockId[]>;
	/** Materialize the projected subtree rooted at `id` (for `added` entries). */
	nodeFor?: (id: BlockId) => ProjectedBlock;
};

/**
 * Bind the assembled model to a concrete engine surface. `Y` must be the
 * vendored v14 module — injected so this file type-checks structurally and
 * never imports vendor `.js` (see `engine-api.ts`).
 */
export const bindEdytorDoc = (Y: EngineApi) => {
	const M = bindModel(Y);
	const T = bindText(Y);
	const R = bindRuns(Y);

	// ── version record / bootstrap (doc-level, facade-free) ────────────
	// `schemaVersion`, `registryEmpty`, `isInitialized`, `checkSchema` and
	// `assertSchema` are module-level (see above) — pure doc reads shared by
	// providers and migration without re-binding.

	/**
	 * Deterministic bootstrap — see the module header. Idempotent: a second
	 * call (or a call on a synced non-empty doc) only ensures the version
	 * record. Never writes on read paths; callers invoke it explicitly
	 * (U08's `sync()`, seeders, tests).
	 *
	 * `content` — optional spec blocks for initial JSON load (ids
	 * caller-assigned; concurrent same-id inits dedupe). Absent → one
	 * canonical empty bootstrap block.
	 */
	const init = (
		doc: EngineDoc,
		opts: { content?: BlockSpec[]; defaultType?: string } = {}
	): void => {
		doc.transact(() => {
			const meta = doc.get(META_KEY);
			if (meta.getAttr(SCHEMA.metaAttrs.version) === undefined) {
				// Never downgrade a higher version written by a newer peer —
				// U07's gate decides compatibility; init only stamps absent.
				meta.setAttr(SCHEMA.metaAttrs.version, SCHEMA_VERSION);
				meta.setAttr(SCHEMA.metaAttrs.schema, SCHEMA_NAME);
			}
			if (!registryEmpty(doc)) return;
			const specs =
				opts.content && opts.content.length > 0
					? opts.content
					: [
							{
								id: BOOTSTRAP_BLOCK_ID,
								type: opts.defaultType ?? 'paragraph'
							} satisfies BlockSpec
						];
			for (const spec of specs) {
				M.insertBlock(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, spec);
			}
		});
	};

	// ── per-doc facade ──────────────────────────────────────────────────

	const create = (doc: EngineDoc, config: EdytorDocConfig = {}) => {
		// Document-boundary check — foreign (v13-engine) and legacy-schema docs
		// fail fast here rather than inside the runs view (see assertUsableDoc).
		assertUsableDoc(doc);
		const roleOf = config.roleOf ?? (() => undefined);
		const defaultType = config.defaultType ?? 'paragraph';
		const runsView: RunView = R.attach(doc);

		/** One consistent replicated-state view (blocks + ownership + placements). */
		const view = () => {
			const blocks = M.collectBlocks(doc);
			const own = T.computeOwnership(doc, blocks);
			return { blocks, own, placements: M.resolvePlacements(blocks, own.ownerOf) };
		};

		/**
		 * Lighter replicated-state view for anchor ops — placements are not
		 * needed to map positions ↔ backing atoms, so skip resolving them.
		 */
		const anchorView = () => {
			const blocks = M.collectBlocks(doc);
			return { blocks, own: T.computeOwnership(doc, blocks) };
		};

		// ── reads ────────────────────────────────────────────────────────

		const blockTypeOf = (id: BlockId): string | undefined => {
			const t = M.blockNodeOf(doc, id)?.getAttr(SCHEMA.blockAttrs.type);
			return typeof t === 'string' ? t : undefined;
		};

		const blockDataOf = (id: BlockId): Record<string, unknown> | undefined => {
			const d = M.blockNodeOf(doc, id)?.getAttr(SCHEMA.blockAttrs.data);
			return d !== undefined && d !== null ? (cloneJson(d) as JsonObj) : undefined;
		};

		type View = ReturnType<typeof view>;

		/**
		 * Ordered visible children of `parent` inside an already-collected
		 * view. Navigation helpers walk many levels; each public entry point
		 * collects ONE view and threads it through (U11: `view()` is ~1.2ms
		 * at 1,000 blocks — per-level collection made doc-order walks
		 * O(depth × n)).
		 */
		const childrenIdsIn = (v: View, parent: BlockId | null): BlockId[] =>
			M.childrenOf(v.blocks, v.placements, v.own, parent).map((k) => k.id);

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

		let version = 0;
		let listening = false;
		let prev: DocSnap | null = null;
		const subs = new Set<(change: DocChange) => void>();

		const takeSnap = (): DocSnap => {
			const { blocks, own, placements } = view();
			// ONE O(n) bucketing pass instead of walking `M.project()` — see
			// the DocSnap comment: materializing projected nodes per commit
			// was the dominant change-event cost (U11 measurement).
			const kids = M.childrenIndex(blocks, placements, own);
			const nodes: DocSnap['nodes'] = new Map();
			const order: DocSnap['order'] = new Map();
			for (const [parent, ks] of kids) {
				order.set(
					parent,
					ks.map((k) => k.id)
				);
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
			// Full projected subtree built on demand — only `added` roots pay
			// for it. Mirrors `project()`'s emit (including `malformed`).
			const nodeFor = (id: BlockId): ProjectedBlock => {
				const rec = blocks.get(id)!;
				const data = rec.data;
				const projected: ProjectedBlock = {
					id,
					type: rec.type,
					data:
						data === undefined || data === null
							? undefined
							: (cloneJson(data) as Record<string, unknown>),
					content: rec.content ? (T.contentItemsOf(id, blocks, own) as ContentItem[]) : [],
					children: []
				};
				if (!rec.content) projected.malformed = true;
				// childrenIndex buckets contain only visible entries — every
				// kid emits a node (no null-filter needed).
				for (const k of kids.get(id) ?? []) projected.children.push(nodeFor(k.id));
				return projected;
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
			const order = new Map<BlockId | null, BlockId[]>();
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
							n.data === undefined || n.data === null ? undefined : (cloneJson(n.data) as JsonObj)
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
				if (!after.order.has(parent)) order.set(parent, []);
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
			return { origin, local, version: ++version, added, removed, moved, meta, content, order };
		};

		const updateHandler = (_update: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown) => {
			const after = takeSnap();
			const change = diffSnaps(
				prev ?? { nodes: new Map(), order: new Map(), nodeFor: undefined },
				after,
				origin,
				(tr as { local?: boolean } | null)?.local === true
			);
			prev = after;
			if (change) for (const cb of subs) cb(change);
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
				doc.on('update', updateHandler);
				listening = true;
			}
			return () => {
				subs.delete(cb);
			};
		};

		const dispose = (): void => {
			if (listening) doc.off('update', updateHandler);
			listening = false;
			subs.clear();
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
			if (!isInitialized(doc)) init(doc);
			return new Y.UndoManager(M.registryOf(doc) as unknown as YNode, opts) as YUndoManager;
		};

		// ── structural ops ────────────────────────────────────────────────

		/**
		 * Insert a block (spec may carry children/content/data — ids are
		 * caller-assigned and must be fresh; the whole spec validates
		 * atomically). Rejected without mutation or update when the parent
		 * is unresolvable or `void` (voids cannot accept children). Inserting
		 * INSIDE an island is allowed — island interiors are built this way.
		 */
		const insertBlock = (dest: Destination, spec: BlockSpec): boolean => {
			if (dest.parent !== null && isVoid(dest.parent)) return false;
			return M.insertBlock(doc, dest, spec);
		};

		/**
		 * Named alias documenting intent: insert a fresh-identity subtree
		 * (paste/import). Identical to {@link insertBlock} — spec ids must be
		 * new; identity is created here, never relocated.
		 */
		const insertSubtree = insertBlock;

		/** Relocate `id` — identity preserved; island/void rules enforced. */
		const moveBlock = (id: BlockId, dest: Destination): boolean => {
			if (insideIsland(id)) return false; // island subtrees are sealed
			if (!canAcceptMove(dest.parent)) return false;
			return M.moveBlock(doc, id, dest);
		};

		/**
		 * Grouped move — ONE transaction (one undo step), per-member conflict
		 * resolution, all-or-nothing locally. Same island/void rules as
		 * `moveBlock`, evaluated for every member before any write.
		 */
		const moveBlocks = (ids: BlockId[], dest: Destination): boolean => {
			for (const id of ids) {
				if (insideIsland(id)) return false;
			}
			if (!canAcceptMove(dest.parent)) return false;
			return M.moveBlocks(doc, ids, dest);
		};

		/** Move `id` to the last position under `newParentId`. */
		const nestBlock = (id: BlockId, newParentId: BlockId): boolean => {
			if (insideIsland(id)) return false;
			if (!canAcceptMove(newParentId)) return false;
			return M.nestBlock(doc, id, newParentId);
		};

		/**
		 * Move `id` beside its parent (index = parent index + 1). Refused for
		 * blocks inside an island — unnesting across the boundary would
		 * escape the sealed subtree (baseline checked neither move nor
		 * unnest for this; the facade closes the hole).
		 */
		const unNestBlock = (id: BlockId): boolean => {
			if (insideIsland(id)) return false;
			const pos = M.positionOf(doc, id);
			if (!pos || pos.parent === null) return false;
			const ppos = M.positionOf(doc, pos.parent);
			if (!ppos) return false;
			if (!canAcceptMove(ppos.parent)) return false;
			return M.unNestBlock(doc, id);
		};

		/**
		 * Split `id` at content `offset` — the tail's slice records move to a
		 * new sibling `newId` (no atom copies), children follow the sibling.
		 * Refused on `void` blocks (no structural flow through voids).
		 */
		const splitBlock = (id: BlockId, offset: number, newId: BlockId): boolean => {
			if (isVoid(id)) return false;
			return M.splitBlock(doc, id, offset, newId);
		};

		/**
		 * Engine merge primitive: `from`'s content is claimed by `into`, its
		 * children ADOPTED into `into`'s child list, and `from` is hidden via
		 * the claim (undo restores it). Role rules: `void` blocks cannot
		 * merge either direction; a merge may not cross an island boundary
		 * (except a child merging into its own island — that stays inside).
		 */
		const mergeBlocks = (fromId: BlockId, intoId: BlockId): boolean => {
			if (fromId === intoId) return false;
			if (isVoid(fromId) || isVoid(intoId)) return false;
			const islandFrom = islandOf(fromId);
			const islandInto = islandOf(intoId);
			if (islandFrom !== islandInto && intoId !== islandFrom) return false;
			return M.mergeBlocks(doc, fromId, intoId);
		};

		/**
		 * Baseline-shaped merge (both `mergeBlockBackward` and
		 * `mergeBlockForward` share this form): `from`'s children are unnested
		 * to `from`'s vacated sibling slot — NOT adopted into `into` — and,
		 * when `from` is an island, reset to the default type; then `from`'s
		 * content claims into `into`. One transaction.
		 */
		const mergeUnnesting = (fromId: BlockId, intoId: BlockId): boolean => {
			if (fromId === intoId) return false;
			if (isVoid(fromId) || isVoid(intoId)) return false;
			const islandFrom = islandOf(fromId);
			if (islandFrom !== islandOf(intoId) && intoId !== islandFrom) return false;
			const pos = M.positionOf(doc, fromId);
			if (!pos) return false;
			return doc.transact(() => {
				const kids = childrenIds(fromId);
				const reset = isIsland(fromId);
				for (let i = 0; i < kids.length; i++) {
					M.moveBlock(doc, kids[i], { parent: pos.parent, index: pos.index + i });
					if (reset) M.blockNodeOf(doc, kids[i])?.setAttr(SCHEMA.blockAttrs.type, defaultType);
				}
				return M.mergeBlocks(doc, fromId, intoId);
			});
		};

		/**
		 * Baseline `mergeBlockBackward`: merge `id` into the previous block
		 * in document order (deepest last descendant of the previous sibling,
		 * or the parent for a first child). No previous block → merges
		 * forward when empty, else refuses — the baseline fallback.
		 */
		const mergeBackward = (id: BlockId): BlockId | null => {
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
		};

		/**
		 * Baseline `mergeBlockForward`: pull the next block in document order
		 * into `id` (its children unnest to its vacated slot).
		 */
		const mergeForward = (id: BlockId): BlockId | null => {
			if (isVoid(id)) return null;
			const next = nextInDocOrder(id);
			if (next === null) return null;
			return mergeUnnesting(next, id) ? id : null;
		};

		/**
		 * Delete `id` (explicit `del` flag — wins over concurrent moves).
		 * `keepChildren` reparents the children to `id`'s vacated slot with
		 * their identity PRESERVED — an intentional improvement over the
		 * baseline, which cloned children into fresh `Block`s.
		 */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): boolean => {
			if (!opts.keepChildren) return M.deleteBlock(doc, id);
			const pos = M.positionOf(doc, id);
			if (!pos) return false;
			const kids = childrenIds(id);
			return doc.transact(() => {
				for (let i = 0; i < kids.length; i++) {
					M.moveBlock(doc, kids[i], { parent: pos.parent, index: pos.index + i });
				}
				return M.deleteBlock(doc, id);
			});
		};

		// ── metadata / replacement ops ────────────────────────────────────

		/** Set the block type (attr write — the block keeps its identity). */
		const setBlockType = (id: BlockId, type: string): boolean => {
			const node = M.liveNodeOf(doc, id);
			if (!node) return false;
			return doc.transact(() => {
				node.setAttr(SCHEMA.blockAttrs.type, type);
				return true;
			});
		};

		/** Replace the block's `data` payload (whole-attr write). */
		const setBlockData = (id: BlockId, data: Record<string, unknown>): boolean => {
			const node = M.liveNodeOf(doc, id);
			if (!node) return false;
			return doc.transact(() => {
				node.setAttr(SCHEMA.blockAttrs.data, cloneJson(data));
				return true;
			});
		};

		/** Display length in atoms (chars + inline atoms) of `id`'s content. */
		const displayLength = (id: BlockId): number =>
			runsView
				.runs(id)
				.reduce((n, r) => n + (r.kind === 'text' ? (r as { text: string }).text.length : 1), 0);

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
				const owners = own.atomOwner.get(p.t);
				const claims = own.atomClaim.get(p.t);
				let n = 0;
				for (let i = range[0]; i < range[1]; i++) {
					if (owners?.[i] === B && claims?.[i] === entry) n++;
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
			const { blocks, own } = anchorView();
			const rec = blocks.get(blockId);
			if (!rec?.content) return null;
			const segs = T.flatten(blockId, blocks, own);
			if (segs.length === 0) {
				return { b: blockId, a: T.atomAnchorAt(doc, rec.content, 0, assoc) };
			}
			let acc = 0;
			for (const seg of segs) {
				const w = seg.i1 - seg.i0;
				const inside = assoc < 0 ? offset <= acc + w : offset < acc + w;
				if (inside) {
					const text = blocks.get(seg.t)?.content;
					if (!text) return null;
					const inner = Math.min(Math.max(offset - acc, 0), w);
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
			const { blocks, own } = anchorView();
			const t = anchor.b;
			const text = blocks.get(t)?.content;
			if (!text) return null;
			const i = T.resolveAnchor(doc, text, anchor.a);
			if (i === null) return null;
			const owners = own.atomOwner.get(t);
			const len = text.length;
			const ownedAt = (j: number): BlockId | undefined =>
				j >= 0 && j < len ? owners?.[j] : undefined;
			const preferLeft = anchor.a.a < 0;
			let hit: { j: number; after: boolean } | null = null;
			const adjacent: [number, boolean][] = preferLeft
				? [
						[i - 1, true],
						[i, false]
					]
				: [
						[i, false],
						[i - 1, true]
					];
			for (const [j, after] of adjacent) {
				if (ownedAt(j) !== undefined) {
					hit = { j, after };
					break;
				}
			}
			if (hit === null) {
				const dirs = preferLeft ? [-1, 1] : [1, -1];
				outer: for (const dir of dirs) {
					for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < len; j += dir) {
						if (ownedAt(j) !== undefined) {
							hit = { j, after: dir < 0 };
							break outer;
						}
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
		): boolean => {
			if (!M.liveNodeOf(doc, id)) return false;
			if (value.children !== undefined && isVoid(id)) return false;
			return doc.transact(() => {
				if (value.type !== undefined) setBlockType(id, value.type);
				if (value.data !== undefined) setBlockData(id, value.data);
				if (value.content !== undefined) {
					const len = displayLength(id);
					if (len > 0) M.deleteText(doc, id, 0, len);
					let off = 0;
					for (const item of value.content) {
						if (item.kind === 'text') {
							M.insertText(doc, id, off, item.text, item.marks);
							off += item.text.length;
						} else {
							M.insertInline(doc, id, off, item);
							off += 1;
						}
					}
				}
				if (value.children !== undefined) {
					for (const kid of childrenIds(id)) M.deleteBlock(doc, kid);
					for (const child of value.children) {
						M.insertBlock(doc, { parent: id, index: Number.MAX_SAFE_INTEGER }, child);
					}
				}
				return true;
			});
		};

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * projects `id`, remaps every block id through `freshId`, inserts the
		 * spec right after `id`. Returns the new root id, or null when `id`
		 * is unresolvable. Text atoms get new identity too — duplication is
		 * a creation op, not a relocation.
		 */
		const duplicateBlock = (id: BlockId, freshId: (oldId: BlockId) => BlockId): BlockId | null => {
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
			return insertBlock({ parent: pos.parent, index: pos.index + 1 }, newSpec) ? newSpec.id : null;
		};

		// ── content ops (allowed inside voids — caption contract) ─────────

		const insertText = (
			id: BlockId,
			offset: number,
			text: string,
			marks?: Record<string, unknown>
		): boolean => M.insertText(doc, id, offset, text, marks);

		const deleteText = (id: BlockId, offset: number, length: number): boolean =>
			M.deleteText(doc, id, offset, length);

		const setMark = (
			id: BlockId,
			offset: number,
			length: number,
			name: string,
			value: unknown
		): boolean => M.setMark(doc, id, offset, length, name, value);

		const unsetMark = (id: BlockId, offset: number, length: number, name: string): boolean =>
			M.unsetMark(doc, id, offset, length, name);

		/** Multi-mark format write over a range (values may be null = unset). */
		const formatRange = (
			id: BlockId,
			offset: number,
			length: number,
			marks: Record<string, unknown>
		): boolean => {
			if (!M.liveNodeOf(doc, id)) return false;
			return doc.transact(() => {
				const { blocks, own } = view();
				return T.formatRangeIn(doc, blocks, own, id, offset, length, marks);
			});
		};

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
			M.insertInline(doc, id, offset, atom);

		const removeInline = (id: BlockId, inlineId: string): boolean =>
			M.removeInline(doc, id, inlineId);

		const setInlineData = (id: BlockId, inlineId: string, data: Record<string, unknown>): boolean =>
			M.setInlineData(doc, id, inlineId, data);

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

		return {
			doc,
			// lifecycle
			init: (opts?: Parameters<typeof init>[1]) => init(doc, opts),
			isInitialized: () => isInitialized(doc),
			schemaVersion: () => schemaVersion(doc),
			/**
			 * The schema gate for this doc — throws {@link SchemaMismatchError}
			 * on unversioned-content or unsupported-version state. Consumers
			 * (U08 `Edytor.sync()`) call it before trusting a synced doc.
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
			crdtId: (id: BlockId) => M.crdtId(doc, id),
			resolveBlock: (id: BlockId) => M.resolveBlock(doc, id),
			displayLength,
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
			insertSubtree,
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
			transact: <R>(fn: () => R, origin?: unknown): R => doc.transact(fn, origin),
			// escape hatch for U08/debugging — the bound engine layers.
			model: M,
			text: T,
			runsView
		};
	};

	return {
		/** The schema manifest constants table. */
		SCHEMA,
		SCHEMA_VERSION,
		SCHEMA_NAME,
		META_KEY,
		BOOTSTRAP_BLOCK_ID,
		/** Doc-level API (no facade needed). */
		init,
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
