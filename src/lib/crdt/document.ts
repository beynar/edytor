/**
 * `EdytorDocument` — the assembled document: one composition/lifecycle
 * owner binding the production engine once and composing the existing
 * domain facade, the default local history, one shared awareness, the
 * document-level semantic configuration (block roles + default type) and
 * the local actor identity (compact per-block attribution and the actor dictionary).
 *
 * Used headlessly or shared by any number of `Edytor` views:
 *
 * ```ts
 * const document = createDocument({ value, actor: { id: 'user-42', name: 'Ada' } });
 * document.facade.insertText(bootstrapId, 0, 'hello');
 * document.history.undo();
 * const saved = document.encode();
 * const restored = loadDocument(saved);
 * ```
 *
 * ```svelte
 * <Edytor {document} />
 * ```
 *
 * ── Owned vs borrowed ──────────────────────────────────────────────────
 *
 * `createDocument`/`loadDocument` allocate a FRESH engine doc — the
 * document owns it and `destroy()` releases everything exactly once
 * (undo manager, facade/run-view lease, awareness, doc, sync cleanups).
 * `attachDocument` composes the same services around a doc the CALLER
 * owns: `destroy()` releases the document-created services but never
 * `doc.destroy()`s the borrowed doc (borrowing grants no destruction
 * authority). The same rule applies to an injected
 * `awareness` (the `#ownsAwareness` convention already used by
 * `IndexeddbPersistence`).
 *
 * ── Readiness ──────────────────────────────────────────────────────────
 *
 * `createDocument({ value })` seeds synchronously (local-first) and is
 * `ready` on return. A document created WITHOUT a value stays `pending`:
 * no bootstrap is stamped, no version written, because a provider may
 * still hydrate it. `sync(value?)` is the single explicit readiness
 * transition — the same deferral `Edytor.sync()` had: assert-and-adopt
 * on an already-initialized (hydrated) doc, `init` on a still-fresh one,
 * then the history attaches (bootstrap-before-capture — `createUndoManager`
 * on the facade keeps that invariant internally too). `loadDocument`
 * validates the payload BEFORE the facade or any capture attaches, then
 * arrives ready.
 *
 * Per-state legality: `pending` — reads (`facade.project`/`toJSON`),
 * `attachSync`, `adoptSemantics`, `trackOrigin`, `sync()`, `destroy()`
 * are legal; `history` throws {@link DocumentNotReadyError}; nothing
 * bootstrap-shaped is written or broadcast, so writes made raw against a
 * pending doc produce unversioned state that `sync()` then refuses (see
 * below). `local`/`hydrated` — the full surface is legal; the only
 * difference is WHO decided the content. (One exception to "nothing
 * broadcast": the actor dictionary attach publishes this replica's
 * `c/<clientID>`/`u/<actorId>` records on ANY constructed document —
 * identity metadata, not content, and outside every admission gate.)
 *
 * ── Admission boundary ────────────────────────────────────────────
 *
 * Every content-entry path crosses the one document-level admission gate
 * (`src/lib/crdt/admission.ts` — shared vocabulary with the transport
 * layer's staged-update gate):
 *
 * - `createDocument` — the fresh doc is trivially admitted;
 * - `loadDocument` — the payload is decoded+integrated onto a SCRATCH
 *   doc first (`admitUpdate`) and the gate runs on the merged result; a
 *   refusal ({@link UndecodableUpdateError},
 *   {@link SchemaMismatchError}) leaves nothing composed and never
 *   touches the caller's bytes;
 * - `attachDocument` — the borrowed doc is gated BEFORE any composition
 *   touches it; a refusal leaves it byte-identical (and re-attachable
 *   once its state heals). It never auto-seeds: the doc always attaches
 *   `pending` and only `sync()`/migration decides content state;
 * - `sync()` — re-runs the gate at the readiness decision: provider or
 *   raw writes may have landed since attach. A doc that fails now
 *   refuses readiness with the typed error (stays `pending`, content
 *   preserved) rather than `init` stamping a schema over unversioned
 *   content; a `'fresh'` verdict seeds (`local`), an `'initialized'`
 *   verdict adopts (`hydrated`). Idempotent once ready.
 *
 * Refusal preserves data — the gate reads are write-free: refused docs
 * keep their content, refused updates keep their bytes, and provider-side
 * refusals keep their stored rows (`IndexeddbPersistence` compaction
 * stays blocked while a refused row set cannot be represented by a
 * compacted snapshot).
 *
 * ── Semantic configuration ─────────────────────────────────────────────
 *
 * The adopted capability is document-level state that outlives
 * any single view: structural roles (`void`/`island`), whether a kind
 * renders its own content (`rendersContent`), the default child type per
 * parent type (`defaultChild`) and `defaultType`. Views contribute what
 * their plugin block definitions declare via {@link adoptSemantics}: the
 * first declaration for a type is adopted, a later CONFLICTING one is an
 * error, and a refused contribution adopts nothing (views cannot silently
 * impose incompatible structural rules on a shared document). Snippets
 * and DOM hooks stay view-side.
 *
 * ── History ────────────────────────────────────────────────────────────
 *
 * One registry-scoped undo manager per document (`doc/history.ts`, the
 * facade's supported seam). Capture is gated by TWO live checks, both consulted
 * on every committing transaction:
 *
 * - `trackedOrigins` — a LIVE per-document set checked by identity: the
 *   document's own headless origin, `null` (untyped local transactions)
 *   and every view's `TRANSACTION` instance registered via
 *   {@link trackOrigin} — each `Edytor` keeps its own instance so the
 *   mirror can still tell its own commits from a sibling view's, while
 *   identity tracking keeps undo LOCAL unless the document is actually
 *   shared.
 * - `captureTransaction` — `transaction.local !== false`. The engine
 *   marks every update-integration transaction non-local: `applyUpdate`
 *   runs `transact(..., local=false)` AND forces `transaction.local =
 *   false` on the in-flight transaction, so even an apply nested inside
 *   a local `transact` marks the whole commit non-local. This is the
 *   remote-exclusion contract: NO provider path or raw
 *   `applyUpdate(doc, u)` — stamped or originless — can ever enter the
 *   local user undo stack, and the guarantee cannot be bypassed by a
 *   provider forgetting to stamp an origin. (Provider paths still stamp
 *   their instance as origin — required anyway so `doc.on('update')`
 *   echo suppression keeps working — see `protocols/sync.ts`
 *   `remoteApplyOrigin` for the residual no-origin default.)
 *
 * `null` therefore carries only LOCAL untyped transactions now — direct
 * `document.facade.<op>` calls outside `document.transact`, raw
 * `doc.transact(fn)` writes. Keeping it tracked preserves the headless
 * contract (`document.facade.insertText(...)` stays undoable); callers
 * wanting per-action undo grouping should prefer `document.transact`.
 * Bookkeeping writes that must never enter user history run under an
 * UNTRACKED origin (the undo-ownership repair's `UNDO_REPAIR_ORIGIN`
 * Symbol and the actor-dictionary's `ATTRIBUTION_ORIGIN` are the existing
 * examples) or inside a non-local transaction; either channel is
 * sufficient and both are free of the local undo stack.
 *
 * History is lazy: it attaches at `sync()`, or on first `history` access
 * once the doc is initialized — it NEVER initializes content itself, so
 * bootstrap/hydration writes all predate capture and are naturally
 * excluded. The undo stack keeps `history.limit` steps; drop them all
 * via {@link clearHistory} / `history.clear()`, and tune the merge window
 * via `history.captureTimeout`.
 */
import type { MarkEdge } from './text/marks.js';
import { DEV } from 'esm-env';
import { Y } from './engine.js';
import type { EngineApi, EngineDoc, YDoc, YUndoManager } from './engine-api.js';
import { asEngineDoc } from './structs.js';
import { DOCUMENT_OPERATIONS, type DocumentOperations } from './operations.js';
import { propsProxy } from './props.js';
import {
	bindAttribution,
	type AttributionBinding,
	type AttributionController,
	type DocumentAttribution
} from './attribution/index.js';
import { profileOf } from './attribution/attribution.js';
import {
	docFacade,
	DocumentDestroyedError,
	DEFAULT_HISTORY_LIMIT,
	isInitialized,
	type BlockRole,
	type DocFacade,
	type EdytorDocConfig
} from './edytor-doc.js';
import { assertAdmission, assertSchema, bindAdmission, checkSchema } from './admission.js';
import { Awareness } from './protocols/awareness.js';
import { callEach } from './protocols/observable.js';
import type { EdytorSync, EdytorSyncCleanup } from './providers/index.js';
import { SyncRefusedError } from './providers/room.js';
import { TRANSACTION } from '../constants.js';
import type { JSONDoc } from '../utils/json.js';
import {
	defaultSemantics,
	facadeConfigOf,
	mergeSemantics,
	normalizeRole,
	SemanticConflictError,
	semanticsDigest
} from './semantics.js';

export { SemanticConflictError };

/** Refuse `op` on a destroyed document. */
const alive = (document: EdytorDocument, op: string): void => {
	if (document.destroyed) throw new DocumentDestroyedError(op);
};

/** Local actor identity — durable across replicas, independent of presence profiles. */
export type DocumentActor = {
	/**
	 * Stable author identifier (used by awareness and, later, native
	 * attribution). Absent actors get an opaque anonymous id — account-free
	 * sessions stay valid, historic actor references stay resolvable.
	 */
	id: string;
	name?: string;
	color?: string;
};

/**
 * Document-level semantic configuration — the structural subset of what
 * plugin `BlockDefinition`s carry (roles, `rendersContent`, `defaultChild`)
 * plus the default block type. Snippets/DOM hooks are deliberately NOT
 * part of this: they are view-side rendering policy.
 */
export type DocumentSemanticsConfig = {
	/** Structural role per block type (`{void?, island?, lines?, layout?}` — absent flags mean false). */
	roles?: Record<string, BlockRole>;
	/** Whether a kind renders its own content slot (undeclared kinds do). */
	rendersContent?: Record<string, boolean>;
	/** Default child type per parent type (undeclared parents take `defaultType`). */
	defaultChild?: Record<string, string>;
	/** Default block type — the root's default child and the bootstrap block. */
	defaultType?: string;
	/**
	 * Per mark, its edge (its record's `edge`) — where a concurrent insert
	 * at each end of a mark lands. Undeclared marks are `inclusive`.
	 */
	marks?: Record<string, { edge?: MarkEdge }>;
};

export type DocumentOptions = {
	/** Local actor — anonymous opaque id when absent. */
	actor?: DocumentActor;
	/**
	 * Up-front semantic configuration (views may also seed via
	 * `adoptSemantics`). `createDocument` and `loadDocument` default to
	 * `defaultSemantics`, the bundled plugins' roles the room holds too;
	 * `{}` checks no roles. `attachDocument` (the doc a view composes)
	 * defaults to none: its views contribute their plugins' roles.
	 */
	semantics?: DocumentSemanticsConfig;
	/**
	 * Borrow an existing awareness instance instead of creating one —
	 * `destroy()` will NOT destroy it (same owned/borrowed rule as the doc).
	 * Borrowing still has the construction side effect of publishing this
	 * document's identity onto it: `setLocalStateField('actor', …)` (and
	 * `'user'` when name/color are supplied) runs on the injected instance,
	 * so a caller sharing one awareness across documents sees the LAST
	 * attached document's actor.
	 */
	awareness?: Awareness;
	/**
	 * History tuning — applied when the document's undo manager attaches.
	 * `captureTimeout` is the merge window in ms (engine default 500):
	 * commits closer than this fuse into one undo step; `0` makes every
	 * commit its own step. `limit` is the number of undo steps kept (default
	 * {@link DEFAULT_HISTORY_LIMIT}, 200; `Infinity` keeps every step): an
	 * older step is dropped and the deleted content it kept is collected.
	 * {@link EdytorDocument.clearHistory} drops both stacks.
	 */
	history?: { captureTimeout?: number; limit?: number };
	/**
	 * Decide an EMPTY document only from a provider that synced: the
	 * room answered, or a local store hydrated. A provider's bound or
	 * failure never seeds it, so a first visit offline writes nothing — no
	 * seed of `value` that a different seed in the room would later meet as
	 * duplicate blocks — and stays `pending` (a view keeps it read-only)
	 * until the document is fetched once. A document holding content is
	 * decided as before; an explicit {@link EdytorDocument.sync} still
	 * decides.
	 */
	requireHydration?: boolean;
};

export type CreateDocumentOptions = DocumentOptions & {
	/**
	 * Initial document content — when present the document is seeded
	 * synchronously (local-first) and arrives `ready`. When absent the
	 * document stays `pending` so a provider may hydrate it; call
	 * {@link EdytorDocument.sync} (or attach a sync via `attachSync`) to
	 * complete readiness.
	 */
	value?: JSONDoc;
};

export type LoadDocumentOptions = DocumentOptions;

export { DocumentDestroyedError };

/** Raised when a readiness-gated service is used on a pending document. */
export class DocumentNotReadyError extends Error {
	constructor(service: string) {
		super(`${service}: the document is not ready (call document.sync() first)`);
		this.name = 'DocumentNotReadyError';
	}
}

/**
 * How the document's content state was decided — the distinction the
 * readiness contract requires:
 * - `pending` — undecided (created without a value or attached before
 *   `sync()`; a provider may still hydrate — nothing bootstrapped,
 *   nothing broadcast). Reads/attaches/`sync()` legal, `history`
 *   refuses;
 * - `local` — seeded locally (`createDocument({value})`, or `sync()` on a
 *   still-fresh doc — seed-if-empty bootstrap included). Full surface
 *   legal;
 * - `hydrated` — the doc was already initialized when `sync()` ran:
 *   provider-applied remote state or a `loadDocument` restore (schema
 *   asserted, content untouched). Full surface legal.
 *
 * `sync()` is the only transition out of `pending`, and it is the
 * document-side admission re-check: a doc that arrived in a problem
 * state (unversioned/unsupported/foreign — e.g. via raw
 * `applyUpdate` bypass writes) refuses there with a typed error, stays
 * `pending`, and preserves the state — never silently becoming `local`.
 */
export type DocumentReadiness = 'pending' | 'local' | 'hydrated';

/**
 * How long (ms) an empty document waits for a provider that has not
 * settled before it decides without it (settle-or-bound) — the bound a
 * provider that cannot report "settled" gets, counted from its attach. A
 * factory sets its own with `sync.bound`, or arms it from transport state
 * (`bound: Infinity` + the payload's `armBound`, as the websocket sync
 * does: from the socket's open, so a slow dial never counts).
 */
export const DEFAULT_READINESS_BOUND = 1000;

const anonymousActor = (): DocumentActor => ({
	id: `anon-${crypto.randomUUID()}`
});

/**
 * DEV: publish the digest of a document's roles in its presence
 * (`semantics`, {@link semanticsDigest}), so a room reading other roles
 * logs the kinds they differ on (`semanticsMismatch`). Re-published at
 * each adoption; a production build advertises nothing.
 */
const advertise = (
	awareness: Awareness,
	config: ReturnType<typeof mergeSemantics>,
	defaultType: string
): void => awareness.setLocalStateField('semantics', semanticsDigest({ ...config, defaultType }));

/**
 * DEV: `layout` needs a default child (its item kind); `lines` needs an
 * island with a default child (its line kind), and
 * the line kind belongs to it — outside such an island a block of that
 * kind shows as its parent's default child, so a kind other blocks use
 * (the default type, another kind's default child) would be recast.
 */
const warnLines = (
	capability: {
		config: ReturnType<typeof mergeSemantics>;
		of: ReturnType<typeof facadeConfigOf>;
	},
	defaultType: string
): void => {
	const { roles, defaultChild } = capability.config;
	for (const [type, role] of Object.entries(roles)) {
		if (role.layout && !Object.hasOwn(defaultChild, type))
			console.warn(
				`[edytor] "${type}" declares \`layout\` without a \`defaultChild\` (its column kind): it is no layout.`
			);
		if (role.table && !Object.hasOwn(defaultChild, type))
			console.warn(
				`[edytor] "${type}" declares \`table\` without a \`defaultChild\` (its row kind): it is no table.`
			);
		if (!role.lines) continue;
		const line = capability.of.defaultChildOf(type);
		if (!role.island || line === undefined) {
			console.warn(
				`[edytor] "${type}" declares \`lines\` without \`island\` and a \`defaultChild\`: it holds no lines.`
			);
			continue;
		}
		const shared =
			line === defaultType ||
			Object.entries(defaultChild).some(
				([other, child]) => child === line && !capability.of.roleOf(other)?.lines
			);
		if (shared)
			console.warn(
				`[edytor] "${type}" holds lines of "${line}", a kind other blocks use: outside "${type}" they show as their parent's default child. Give its lines a kind of their own.`
			);
	}
};

/** Internal constructor bag — use {@link createDocument}/{@link loadDocument}/{@link attachDocument}. */
export type EdytorDocumentInit = {
	doc: YDoc;
	/** Whether `destroy()` may `doc.destroy()` — true only for document-allocated docs. */
	ownsDoc: boolean;
	/** The facade factory this document composes (injected by `bindDocument`). */
	facade: (doc: EngineDoc, config: EdytorDocConfig) => DocFacade;
	/** The bound attribution service (injected by `bindDocument`). */
	attribution: AttributionBinding;
	/** The engine this document's doc belongs to (for `encode`). */
	engine: EngineApi;
	/** The awareness class bound to this engine (same class for every engine). */
	awarenessCtor: typeof Awareness;
	actor?: DocumentActor;
	awareness?: Awareness;
	semantics?: DocumentSemanticsConfig;
	history?: { captureTimeout?: number; limit?: number };
	requireHydration?: boolean;
};

/**
 * The assembled document — see the module header for the lifecycle,
 * readiness and semantic-config contracts.
 */
/**
 * The document's operations and reads are its own members
 * (`document.insertBlocks(…)`, `document.toJSON()`): see `DocumentOperations`.
 * `transact` is the document's (its local origin by default).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export interface EdytorDocument extends Omit<DocumentOperations, 'transact'> {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class EdytorDocument {
	/** The underlying engine doc — raw reads/providers borrow it; they never own it. */
	readonly doc: YDoc;
	/**
	 * The bound facade (one per document, shared by every view): the
	 * operations below, the index and the engine hooks. Attaching it holds
	 * the document's lease on the maintained runs view.
	 * @internal
	 */
	readonly facade: DocFacade;
	/** One shared awareness instance for every view/provider of this document. */
	readonly awareness: Awareness;
	/** The local actor identity (anonymous opaque id when none was supplied). */
	readonly actor: DocumentActor;
	/**
	 * The attribution surface — compact per-block records and the
	 * replicated actor dictionary (`u/` profiles, `c/` replica bindings).
	 * Ordinary edits perform no attribution
	 * writes — authorship lands inside the owning op's transaction as the
	 * block-level `b/<id>` record/`l` stamp. See
	 * `src/lib/crdt/attribution/attribution.ts` for the full contract.
	 * Access after teardown throws {@link DocumentDestroyedError} — same
	 * lifecycle contract as {@link history}.
	 *
	 * Reads are pull-model: record arrivals emit no attribution-specific
	 * change event — every fresh `block()`/`actors` call reads
	 * current replicated state.
	 */
	get attribution(): DocumentAttribution {
		alive(this, 'attribution');
		return this.#attributionCtl.view;
	}
	/**
	 * The document's own local-edit transaction origin — headless edits via
	 * {@link transact} carry it so history capture attributes them. (Views
	 * keep their own `TRANSACTION` instances — the class-level tracking
	 * covers them all while preserving each view's local/remote mirror
	 * distinction.)
	 */
	readonly transaction = new TRANSACTION();

	/**
	 * The live `trackedOrigins` set handed to the undo manager — checked
	 * live by the engine on every transaction, so origins may be added any
	 * time before/after history attaches. Contents:
	 * - `this.transaction` — the document's own headless local-edit origin;
	 * - `null` — untyped LOCAL transactions (direct `document.facade.<op>`
	 *   calls outside `document.transact`, raw `doc.transact(fn)` writes).
	 *   `null` can no longer admit remote state: `captureTransaction`
	 *   rejects every non-local commit before origins are even consulted —
	 *   keeping it preserves the documented headless-edit contract while
	 *   remote exclusion is enforced by `transaction.local`, not by origin
	 *   hygiene;
	 * - each attached view's `TRANSACTION` instance (via {@link trackOrigin}).
	 *
	 * Origins are tracked by IDENTITY, not class: a view's edits are only
	 * undoable through the document(s) it registered on — every view bound
	 * to ONE document shares its history. Views release their origin via
	 * {@link untrackOrigin} at teardown: already-captured stack items stay
	 * (their commits remain undoable), only FUTURE commits from the dead
	 * origin stop capturing.
	 */
	readonly #trackedOrigins = new Set<unknown>([this.transaction, null]);

	readonly #engine: EngineApi;
	readonly #ownsDoc: boolean;
	readonly #ownsAwareness: boolean;
	#_history: YUndoManager | undefined;
	readonly #attributionCtl: AttributionController;
	/**
	 * `true` when the attached manager was destroyed by something other
	 * than this document — its `destroy()` is a public engine surface, so
	 * an external caller can kill it while the document lives. The getter
	 * reattaches a fresh manager rather than handing back the corpse.
	 */
	#_readiness: DocumentReadiness = 'pending';
	private _destroyed = false;
	/**
	 * Attach references — every `createDocument`/`loadDocument`/
	 * `attachDocument` grants ONE; each {@link retain} grants one more.
	 * `destroy()` and a `retain()` release each consume exactly ONE
	 * reference; the document tears down only when the last release
	 * lands (deduplicated `attachDocument` shares this instance across
	 * callers/views).
	 */
	#refs = 1;
	/**
	 * The adopted semantics (every contribution, merged: `mergeSemantics`)
	 * and their lookups (`facadeConfigOf`, as the room reads its own).
	 */
	readonly #capability = { config: mergeSemantics(), of: facadeConfigOf({}) };
	#defaultType: string;
	readonly #historyOptions: { captureTimeout?: number; limit?: number } | undefined;
	/** {@link DocumentOptions.requireHydration}: an empty document waits for a provider's `synced`. */
	readonly requireHydration: boolean;
	/** Attached providers keyed by transport target: one per target. */
	#providers = new Map<unknown, EdytorSyncCleanup | undefined>();
	#pendingSyncs = 0;
	#healOff: (() => void) | undefined;
	#readyListeners = new Set<() => void>();

	/** @internal Construct through {@link createDocument}/{@link loadDocument}/{@link attachDocument}. */
	constructor(init: EdytorDocumentInit) {
		this.#engine = init.engine;
		this.doc = init.doc;
		this.#ownsDoc = init.ownsDoc;
		this.#defaultType = init.semantics?.defaultType ?? 'paragraph';
		const of = () => this.#capability.of;
		this.facade = init.facade(asEngineDoc(this.doc), {
			roleOf: (type) => of().roleOf(type),
			kinds: () => of().kinds(),
			defaultType: this.#defaultType,
			defaultChildOf: (type) => of().defaultChildOf(type),
			rendersContent: (type) => of().rendersContent(type),
			markEdge: (mark) => of().markEdge(mark),
			// The facade's block-attribution ops read the actor lazily —
			// `this.actor` is assigned below, after facade construction.
			actor: () => this.actor,
			// The `writable` guard: a write on a read-only document refuses
			// with the `SchemaMismatchError` naming the stamp.
			assertWritable: () => assertSchema(asEngineDoc(this.doc), 'document')
		});
		// The document's own operations (`DocumentOperations`): the bound
		// facade's, read through so each call reaches the live binding.
		for (const name of DOCUMENT_OPERATIONS) {
			if (name === 'transact') continue;
			Object.defineProperty(this, name, { get: () => this.facade[name], configurable: true });
		}
		this.awareness = init.awareness ?? new init.awarenessCtor(this.doc);
		this.#ownsAwareness = init.awareness === undefined;
		this.#historyOptions = init.history;
		this.requireHydration = init.requireHydration === true;
		this.actor = init.actor ?? anonymousActor();
		// Durable actor identity is separate from the presence profile: the
		// `actor` field carries the stable id, `user`
		// carries the display profile remote carets already read.
		this.awareness.setLocalStateField('actor', this.actor);
		const user = profileOf(this.actor);
		if (Object.keys(user).length) this.awareness.setLocalStateField('user', user);
		// Attribution service — attaches after the facade (which gates
		// foreign docs) and after the actor is fixed. Publishes this
		// replica's actor dictionary entries (`c/`+`u/`) once; ordinary
		// edits perform no attribution work and per-block records are
		// written inside the owning op's transaction by the facade.
		this.#attributionCtl = init.attribution.attach(asEngineDoc(this.doc), {
			actor: this.actor
		});
		if (init.semantics) {
			this.adoptSemantics({ ...init.semantics, defaultType: undefined });
		} else if (DEV) advertise(this.awareness, this.#capability.config, this.#defaultType);
	}

	#data?: Record<string, any>;
	/**
	 * The document's properties as a live object (`crdt/props`): a read
	 * follows the document, and a write at any depth (`document.data.title
	 * = 'Notes'`, `document.data.tags.push('x')`, `delete …`) is the raw
	 * `patchData` operation at once, as `document.patchData(null, …)`. Not
	 * reactive by itself: a view's `edytor.data` is, and dispatches.
	 */
	get data(): Record<string, any> {
		return (this.#data ??= propsProxy(
			() => this.facade.docData(),
			(patches) => void this.facade.apply(this.facade.prepare.patchData(null, patches)),
			(path) => this.facade.dataItemIds(null, path)
		));
	}

	/** The replica id (`doc.clientID`) — identifies the replica, not the actor. */
	get clientID(): number {
		return this.doc.clientID;
	}

	/**
	 * `true` once the document's content state is decided — seeded locally
	 * or hydrated then synced. `false` while pending (a provider may still
	 * hydrate; nothing has been bootstrapped). See {@link readiness} for
	 * WHICH kind of ready.
	 */
	get ready(): boolean {
		return this.#_readiness !== 'pending';
	}

	/**
	 * `pending` | `local` | `hydrated` — distinguishes a locally-seeded
	 * ready from a provider-hydrated/restored ready (the contract consumers
	 * need to tell "I decided this content" from "sync brought it").
	 */
	get readiness(): DocumentReadiness {
		return this.#_readiness;
	}

	get destroyed(): boolean {
		return this._destroyed;
	}

	/**
	 * `false` while the document carries a schema stamp this build cannot
	 * own (a foreign stamp got in despite the transport's inbound refusal):
	 * every write refuses with a `SchemaMismatchError`, and the providers
	 * neither persist nor broadcast it.
	 */
	get writable(): boolean {
		return checkSchema(asEngineDoc(this.doc)) === null;
	}

	/**
	 * Subscribe to {@link writable} transitions — the visible signal that
	 * the document turned read-only (once per transition, not per refused
	 * edit). Returns the unsubscribe. A listener that throws is logged: it
	 * runs inside the engine's `update` emit, which an error must not
	 * escape.
	 */
	onWritableChange = (listener: (writable: boolean) => void): (() => void) => {
		let last = this.writable;
		const watch = () => {
			if (this.writable !== last)
				callEach('[edytor-document] writable', [listener], (last = !last));
		};
		this.doc.on('update', watch);
		return () => this.doc.off('update', watch);
	};

	/**
	 * The capture timeout this document's history was configured with —
	 * the `attachDocument` dedupe compatibility check reads it (a reattach
	 * naming a different merge window is a conflict; the live manager
	 * cannot be retuned).
	 * @internal
	 */
	get historyCaptureTimeout(): number | undefined {
		return this.#historyOptions?.captureTimeout;
	}

	/**
	 * The undo steps this document's history keeps: the configured
	 * `history.limit`, else {@link DEFAULT_HISTORY_LIMIT}. The `attachDocument`
	 * dedupe check reads it (a reattach naming another limit is a conflict).
	 */
	get historyLimit(): number {
		return this.#historyOptions?.limit ?? DEFAULT_HISTORY_LIMIT;
	}

	/**
	 * The document-level semantic configuration (snapshot). The maps are
	 * copies — mutation is not supported; contribute via {@link adoptSemantics}.
	 */
	get semantics() {
		const { roles, rendersContent, defaultChild, marks } = this.#capability.config;
		const entries = <T, U>(table: Record<string, T>, f: (value: T) => U) =>
			new Map(Object.entries(table).map(([key, value]) => [key, f(value)]));
		return {
			defaultType: this.#defaultType,
			roles: entries<BlockRole, BlockRole>(roles, normalizeRole),
			rendersContent: new Map(Object.entries(rendersContent)),
			defaultChild: new Map(Object.entries(defaultChild)),
			marks: entries(marks, (mark): MarkEdge => mark.edge ?? 'inclusive')
		};
	}

	/**
	 * The default child type under a parent of `parentType` (`null` = the
	 * root) — the one answer split, paragraph insert, merge-unnest, clear
	 * and root normalization apply against the new block's actual parent.
	 */
	defaultChild = (parentType: string | null): string =>
		(parentType !== null ? this.#capability.of.defaultChildOf(parentType) : undefined) ??
		this.#defaultType;

	/** Whether kind `type` renders its own content slot (undeclared kinds do). */
	rendersContent = (type: string): boolean => this.#capability.of.rendersContent(type);

	/**
	 * Contribute document-level semantics — the seam views use to seed the
	 * structural roles implied by their plugin block definitions.
	 *
	 * Merge rules:
	 * - a type with no adopted role yet ADOPTS the incoming role;
	 * - an already-adopted role must equal the incoming one — otherwise
	 *   {@link SemanticConflictError} (incompatible rules on one document);
	 * - `rendersContent` and `defaultChild` entries follow the same rule;
	 * - `defaultType` must match the document's when supplied.
	 *
	 * Atomic: everything validates before anything is adopted (the merge is
	 * `mergeSemantics`'s).
	 *
	 * Contributions are document-lifetime: they survive the contributing
	 * view's teardown, so sibling views keep the same structural rules.
	 */
	adoptSemantics = (config: DocumentSemanticsConfig): void => {
		alive(this, 'adoptSemantics');
		if (config.defaultType !== undefined && config.defaultType !== this.#defaultType) {
			throw new SemanticConflictError('defaultType', this.#defaultType, config.defaultType);
		}
		const merged = mergeSemantics(this.#capability.config, { ...config, defaultType: undefined });
		Object.assign(this.#capability, { config: merged, of: facadeConfigOf(merged) });
		if (DEV) {
			advertise(this.awareness, merged, this.#defaultType);
			warnLines(this.#capability, this.#defaultType);
		}
		// A newly void kind sheds its children at read time; a block
		// promoted out of a newly island kind displays as a default child; a
		// newly layout kind displays only its items (`layout.*`), a newly
		// table kind only its rows (`table.*`).
		if (
			Object.values(config.roles ?? {}).some(
				(role) => role?.void || role?.island || role?.layout || role?.table
			)
		)
			this.facade.rolesChanged();
	};

	/**
	 * The readiness transition — decide the document's content state. This
	 * is the document-side admission re-check ({@link assertAdmission} —
	 * usable → schema → verdict, the same reads the transport layer's
	 * staging gate runs):
	 *
	 * - `'fresh'` verdict → the deterministic seed of `value` (one update from a writer hashed from the seed; an empty value seeds
	 *   one `defaultType` block; non-local, so never an undo step);
	 * - `'initialized'` verdict (provider-hydrated, or a loaded restore) →
	 *   the schema was just asserted; content is left alone;
	 * - a doc in a problem state (unversioned/unsupported/foreign schema
	 *   claim — possible via raw `applyUpdate` writes that
	 *   bypass the transport gate) REFUSES readiness: the typed error
	 *   propagates, the document stays `pending`, and the doc's state is
	 *   preserved. Retrying after the state heals (e.g. a remote update
	 *   supplies the missing version stamp) is legal;
	 * - then the default local history attaches (capture starts AFTER the
	 *   bootstrap — the facade's `createUndoManager` preserves that
	 *   invariant internally as well).
	 *
	 * Idempotent: a second call (the provider `synced` callback racing a
	 * local seed, a second view's `sync()`) is a no-op. Remote updates do
	 * not bootstrap — only this call (or `createDocument({value})`) does.
	 */
	sync = (value: JSONDoc = { children: [] }): void => {
		alive(this, 'sync');
		if (this.#_readiness !== 'pending') {
			return;
		}
		const verdict = assertAdmission(asEngineDoc(this.doc), 'document');
		if (verdict === 'initialized') {
			// Hydrated/loaded doc — asserted above; content is left alone.
			this.#_readiness = 'hydrated';
		} else {
			this.facade.seed(value.children, value.data);
			this.#_readiness = 'local';
		}
		this.#attachHistory();
		// Readiness decided — wake waiters synchronously. The hydrated
		// branch writes nothing to the doc, so `update`-based observation
		// misses it; polling alone would leave sibling views stale for
		// ~50 ms. Isolated per the listener-isolation convention: one
		// throwing waiter must not starve the rest or break `sync()`.
		const listeners = Array.from(this.#readyListeners);
		this.#readyListeners.clear();
		callEach('[edytor-document] ready', listeners);
	};

	/**
	 * The default local history (the registry-scoped undo manager —
	 * `undo`/`redo`/`stopCapturing`/stacks). Lazy: attaches at `sync()`,
	 * or on first access once the document is decided — it NEVER seeds
	 * content itself (accessing it on a pending doc throws
	 * {@link DocumentNotReadyError} instead of silently seeding).
	 */
	get history(): YUndoManager {
		alive(this, 'history');
		let history = this.#_history;
		// A manager enrolls itself in its tracked origins and leaves them on
		// `destroy()` — an external teardown (misuse, or the engine's own
		// `doc.destroy` cascade) shows there.
		if (history !== undefined && !this.#trackedOrigins.has(history)) {
			// The manager was destroyed externally — it no longer observes
			// transactions or emits stack events, so returning it would
			// silently disable capture. Reattach a fresh one (the dead
			// manager's stacks are unrecoverable by definition).
			this.#_history = undefined;
			history = undefined;
		}
		if (history === undefined) {
			if (this.#_readiness === 'pending') {
				throw new DocumentNotReadyError('history');
			}
			history = this.#attachHistory();
		}
		return history;
	}

	/**
	 * Track a local-edit transaction origin for history capture — the seam
	 * views use to enroll their own `TRANSACTION` instance in this
	 * document's history. The set is consulted live by the undo manager, so
	 * registering works before or after history attaches; capturing is
	 * per-registered-instance — an origin registered on a DIFFERENT
	 * document is not captured here (undo stays local unless the document
	 * is actually shared). Origins are released via {@link untrackOrigin}
	 * on view teardown — already-captured ops stay undoable.
	 */
	trackOrigin = (origin: unknown): void => {
		alive(this, 'trackOrigin');
		this.#trackedOrigins.add(origin);
	};

	/**
	 * Release a previously-tracked origin — the view-teardown counterpart
	 * of {@link trackOrigin}. Safe because the undo manager consults the
	 * set live at commit time: already-captured stack items stay undoable,
	 * only FUTURE commits from the released origin stop capturing. Silent
	 * no-op once the document is destroyed (teardown ordering must never
	 * throw — a dead document has already dropped its manager anyway).
	 */
	untrackOrigin = (origin: unknown): void => {
		if (this._destroyed) {
			return;
		}
		this.#trackedOrigins.delete(origin);
	};

	#attachHistory = (): YUndoManager => {
		if (this.#_history !== undefined) {
			return this.#_history;
		}
		// Two-layer capture rule (see the module header):
		// - `trackedOrigins` — identity tracking: the document's headless
		//   origin, `null` for untyped local transactions, every enrolled
		//   view origin. Provider/remote origins stay untracked.
		// - `captureTransaction` — `transaction.local !== false`: the engine
		//   marks every update-integration non-local (applyUpdate runs
		//   `local=false` and forces the flag on the in-flight transaction,
		//   even nested inside a local transact), so no provider path or raw
		//   `applyUpdate` — stamped or originless — can enter the local undo
		//   stack. This is the actual remote-exclusion contract; untracked
		//   remote origins are belt-and-suspenders on top of it.
		this.#_history = this.facade.createUndoManager({
			trackedOrigins: this.#trackedOrigins,
			captureTimeout: this.#historyOptions?.captureTimeout,
			limit: this.historyLimit,
			captureTransaction: (transaction: { local?: boolean }) => transaction.local !== false
		});
		return this.#_history;
	};

	/**
	 * Drop the undo/redo stacks. The undo stack already keeps only its
	 * newest `history.limit` steps; call this where undo no longer makes
	 * sense, e.g. after a save checkpoint. No-op while history has not
	 * attached (there is nothing to clear — it does NOT force attach or throw
	 * on pending).
	 */
	clearHistory = (): void => {
		alive(this, 'clearHistory');
		this.#_history?.clear();
	};

	/**
	 * Local document transaction — headless edits, one undo step per call
	 * (`origin`: another origin, which the document's history tracks only
	 * when it is tracked).
	 */
	transact = <T>(cb: () => T, origin: unknown = this.transaction): T => {
		alive(this, 'transact');
		return this.facade.transact(cb, origin);
	};

	/**
	 * Subscribe to the readiness transition — fires once, synchronously,
	 * inside {@link sync} when `_readiness` leaves `'pending'` (every
	 * decision path goes through `sync()`: provider `synced`, local seed,
	 * explicit call). A listener registered on an already-ready document
	 * is never called — check {@link ready} first. Each listener is
	 * invoked in isolation: a throwing waiter cannot starve siblings or
	 * break the transition.
	 */
	onReady = (listener: () => void): (() => void) => {
		if (this._destroyed) {
			return () => {};
		}
		this.#readyListeners.add(listener);
		return () => {
			this.#readyListeners.delete(listener);
		};
	};

	/**
	 * Whether an attached provider has neither settled nor reached its
	 * bound. An editable view decides a pending document only when none is.
	 */
	get syncPending(): boolean {
		return this.#pendingSyncs > 0;
	}

	/** The standing refusal of each attached target that reported one, oldest first. */
	#refusals = new Map<unknown, SyncRefusedError>();
	#refusalListeners = new Set<(refusal: SyncRefusedError) => void>();

	/**
	 * The server's refusal of a provider (a `1008`/`4xxx` close — see
	 * `SyncRefusedError`), the latest still standing: that provider
	 * stopped. An empty document stays `pending` rather than seed content
	 * the room refused. A refusal belongs to the provider that reported
	 * it: releasing that provider, or its own later sync (a `connect()`
	 * after a refreshed token), lifts it.
	 */
	get syncRefusal(): SyncRefusedError | undefined {
		return Array.from(this.#refusals.values()).at(-1);
	}

	/**
	 * Subscribe to provider refusals ({@link syncRefusal}). A listener
	 * registered after one is not called for it. Returns the unsubscribe.
	 */
	onSyncRefused = (listener: (refusal: SyncRefusedError) => void): (() => void) => {
		if (this._destroyed) return () => {};
		this.#refusalListeners.add(listener);
		return () => this.#refusalListeners.delete(listener);
	};

	/**
	 * The readiness decision: a document with content is decided
	 * (`hydrated`) as soon as any provider settles; an EMPTY one only once
	 * every attached provider settled or reached its bound, and then it
	 * seeds `value` — never while a provider's {@link syncRefusal} stands. A
	 * refused admission leaves it pending, read-only and quarantined; it
	 * decides again when it turns writable (the refusal propagates to the
	 * reporting provider only).
	 */
	private _decide = (value: JSONDoc | undefined, report = false, synced = false): void => {
		if (this._destroyed || this.ready) return;
		// An empty document waits for a provider that synced.
		if (this.requireHydration && !synced && !isInitialized(asEngineDoc(this.doc))) return;
		const waiting = this.#pendingSyncs > 0 || this.#refusals.size > 0;
		if (waiting && !isInitialized(asEngineDoc(this.doc))) return;
		try {
			this.sync(value);
		} catch (error) {
			this.#healOff ??= this.onWritableChange((writable) => {
				if (!writable) return;
				this.#healOff?.();
				this.#healOff = undefined;
				this._decide(value);
			});
			if (report) throw error;
		}
	};

	/**
	 * Attach a provider sync factory to this document (headless `EdytorSync`
	 * path — the same contract views use). The provider stays pending until
	 * it reports `synced` or the terminal `failed`, is torn down, or its
	 * bound elapses: `sync.bound` ms from the attach,
	 * {@link DEFAULT_READINESS_BOUND} for a provider that cannot report
	 * settled, or {@link DEFAULT_READINESS_BOUND} from each `armBound()`
	 * (`holdBound()` stops it until the next arm).
	 * Each settle runs the readiness decision ({@link _decide}); a
	 * `SyncRefusedError` is recorded as the target's {@link syncRefusal}
	 * until its release or its next `synced`, and decides only a document
	 * that holds content (an empty one never seeds over it).
	 * Releasing a refused provider decides with the providers still
	 * attached; with none, the document stays pending.
	 * A factory that throws never attached: its error propagates and it
	 * decides nothing. A transport target
	 * (`sync.target`, else the factory) already attached is a no-op: the
	 * document keeps one provider per target. The returned cleanup is also
	 * tracked: {@link destroy} runs it; it frees the target. A sync attaches
	 * a companion (the websocket sync's local store) through the payload's
	 * `attach`: a provider of its own, under the same rules.
	 */
	attachSync = (sync: EdytorSync, opts: { value?: JSONDoc } = {}): EdytorSyncCleanup | void => {
		alive(this, 'attachSync');
		const target = sync.target ?? sync;
		if (this.#providers.has(target)) return;
		this.#pendingSyncs += 1;
		let pending = true;
		const settle = (): boolean => {
			if (!pending) return false;
			pending = false;
			clearTimeout(bound);
			this.#pendingSyncs -= 1;
			return true;
		};
		const decide = () => settle() && this._decide(opts.value);
		const ms = sync.bound ?? DEFAULT_READINESS_BOUND;
		let bound = Number.isFinite(ms) ? setTimeout(decide, ms) : undefined;
		const failed = (error: unknown) => {
			if (!(error instanceof SyncRefusedError)) return void decide();
			settle();
			if (this._destroyed) return;
			this.#refusals.delete(target);
			this.#refusals.set(target, error);
			callEach('[edytor-document] refusal', Array.from(this.#refusalListeners), error);
			// A document that already holds content is decided (hydrated); an
			// empty one stays pending while the refusal stands.
			this._decide(opts.value);
		};
		let cleanup: ReturnType<EdytorSync>;
		try {
			cleanup = sync({
				doc: this.doc,
				awareness: this.awareness,
				synced: () => {
					settle();
					this.#refusals.delete(target);
					this._decide(opts.value, true, true);
				},
				failed,
				armBound: () => {
					if (!pending) return;
					clearTimeout(bound);
					bound = setTimeout(decide, DEFAULT_READINESS_BOUND);
				},
				holdBound: () => clearTimeout(bound),
				attach: (companion) => this.attachSync(companion, opts)
			});
		} catch (error) {
			settle();
			throw error;
		}
		if (typeof cleanup !== 'function') {
			this.#providers.set(target, undefined);
			return cleanup;
		}
		// The returned cleanup runs once and frees the target; tearing down
		// an unsynced provider settles it like a failure. A released refusal
		// lifts its hold: the providers still attached decide (with none, the
		// next attach or `sync()` does). After the cleanup, which releases
		// the provider's own companions.
		const release = (): ReturnType<EdytorSyncCleanup> => {
			if (this.#providers.get(target) !== release) return;
			this.#providers.delete(target);
			const refused = this.#refusals.delete(target);
			decide();
			const result = cleanup();
			if (refused && this.#providers.size > 0) this._decide(opts.value);
			return result;
		};
		this.#providers.set(target, release);
		return release;
	};

	/** Full replicated state as a v14 update — `loadDocument` restores it on a fresh replica. */
	encode = (): Uint8Array => this.#engine.encodeStateAsUpdate(this.doc);

	/**
	 * Acquire one more attach reference and return its ONE-SHOT release
	 * capability. A deduplicated `attachDocument` hands every
	 * holder the SAME object, so `destroy()` calls cannot be
	 * authenticated per caller — a holder that destroys more times than
	 * references it acquired consumes ANOTHER holder's reference. The
	 * returned release cannot over-release: calling it twice is a
	 * no-op. Direct consumers sharing a document should pair
	 * `retain()`/release per holder instead of calling `destroy()` per
	 * share; view-driven releases stay on `destroy()` (one per view
	 * lifecycle).
	 */
	retain = (): (() => void) => {
		alive(this, 'retain');
		this.#refs += 1;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.#releaseReference();
		};
	};

	/**
	 * Release ONE attach reference. Every `createDocument`/`loadDocument`/
	 * `attachDocument` grants exactly ONE reference — release it by
	 * calling `destroy()` ONCE; the teardown runs only when the LAST
	 * reference releases (a deduplicated `attachDocument` keeps the
	 * document alive for every holder). The shared handle cannot tell
	 * callers apart: calling `destroy()` more times than references you
	 * acquired releases references held by other callers — acquire
	 * additional references through {@link retain} instead, whose
	 * one-shot release capability makes over-release impossible.
	 *
	 * Order mirrors the old `Edytor.destroy()` teardown: provider/sync
	 * cleanups (tracked `attachSync` registrations), the undo manager's doc
	 * observers, the facade's doc `update` subscription + run-view lease,
	 * the awareness instance (only when the document created it), and
	 * finally `doc.destroy()` (only when the document allocated the doc —
	 * `attachDocument`/`{doc}`-injection paths skip it: borrowing a raw doc
	 * grants no destruction authority). Post-teardown calls are a no-op.
	 */
	destroy = (): void => {
		this.#releaseReference();
	};

	/** Shared reference release — `destroy()` and `retain()` closures land here. */
	#releaseReference = (): void => {
		if (this._destroyed) {
			return;
		}
		this.#refs -= 1;
		if (this.#refs > 0) {
			return;
		}
		this.#refs = 0;
		this._destroyed = true;

		// Waiters parked on the readiness transition are dropped silently —
		// a destroyed document never decides, and their views check
		// `destroyed` before binding anyway.
		this.#readyListeners.clear();
		this.#healOff?.();

		// Provider/sync cleanups registered through `attachSync`.
		const rethrowAsyncCleanupError = (error: unknown) => {
			setTimeout(() => {
				throw error;
			});
		};
		for (const release of [...this.#providers.values()]) {
			try {
				const result = release?.();
				if (result && typeof result === 'object' && 'catch' in result) {
					void (result as Promise<void>).catch(rethrowAsyncCleanupError);
				}
			} catch (error) {
				rethrowAsyncCleanupError(error);
			}
		}

		// Doc observers held by the undo manager (absent before readiness).
		this.#_history?.destroy();

		// The attribution service controller — the view stays readable
		// after release (a borrowed raw doc can outlive the document).
		this.#attributionCtl.destroy();

		// The facade's doc `update` subscriptions + this document's lease on
		// the doc-shared run view (the view itself survives while another
		// facade holds a lease, or until the doc dies).
		this.facade.dispose();

		// Awareness is document-shared — destroy it only when the document
		// created it (an injected instance belongs to its caller).
		if (this.#ownsAwareness) {
			this.awareness.destroy();
		}

		// `doc.destroy()` only for document-allocated docs — a borrowed raw
		// doc outlives this document by contract.
		if (this.#ownsDoc) {
			this.doc.destroy();
		}
	};
}

export type DocumentBinding = ReturnType<typeof bindDocument>;

/**
 * Bind the document surface to a concrete engine — same injection pattern
 * as `bindCrdt`. The production path uses the module-level
 * {@link createDocument}/{@link loadDocument}/{@link attachDocument}
 * (bound once to the vendored engine); alternate engine instances bind
 * their own surface here.
 */
export const bindDocument = (Y: EngineApi) => {
	const facade = docFacade(Y, { model: undefined, text: undefined });
	const attribution = bindAttribution(Y);
	const admission = bindAdmission(Y);
	/**
	 * One `EdytorDocument` per raw doc — the dedupe table. A raw doc can
	 * only carry ONE maintained facade/history/awareness composition, so
	 * every factory registers here and `attachDocument` reuses the live
	 * entry (a dead entry is replaced by the next attach). Weak keys: the
	 * raw doc is the identity; entries never outlive the doc itself.
	 */
	const attached = new WeakMap<YDoc, EdytorDocument>();

	/** A document over `doc`, registered for `attachDocument`'s dedupe. */
	const init = (
		doc: YDoc,
		ownsDoc: boolean,
		options: DocumentOptions,
		semantics = options.semantics
	): EdytorDocument => {
		const document = new EdytorDocument({
			...options,
			doc,
			ownsDoc,
			semantics,
			facade,
			attribution,
			engine: Y,
			awarenessCtor: Awareness
		});
		attached.set(doc, document);
		return document;
	};

	/**
	 * A reattach must not silently diverge from the live composition —
	 * compatible declarations merge (semantics adopt onto the document,
	 * conflicting ones throw from `adoptSemantics` itself); a DIFFERENT
	 * actor, awareness instance or merge window is a conflict.
	 */
	const assertAttachCompatible = (existing: EdytorDocument, options: DocumentOptions): void => {
		if (options.awareness !== undefined && options.awareness !== existing.awareness) {
			// SemanticConflictError serializes its operands — the awareness
			// objects themselves are circular; describe them instead.
			throw new SemanticConflictError(
				'awareness instance',
				'the attached awareness',
				'a different injected awareness'
			);
		}
		const asked: [subject: string, live: unknown, wanted: unknown][] = [
			['actor.id', existing.actor.id, options.actor?.id],
			['history.captureTimeout', existing.historyCaptureTimeout, options.history?.captureTimeout],
			['history.limit', existing.historyLimit, options.history?.limit],
			['requireHydration', existing.requireHydration, options.requireHydration]
		];
		for (const [subject, live, wanted] of asked)
			if (wanted !== undefined && wanted !== live)
				throw new SemanticConflictError(subject, live, wanted);
		if (options.semantics !== undefined) {
			existing.adoptSemantics(options.semantics);
		}
	};

	return {
		/**
		 * Fresh document, fresh replica identity — always allocates a new
		 * raw doc (never deduplicated). `value` seeds synchronously
		 * (local-first → `ready`); without it the document stays `pending`
		 * until {@link EdytorDocument.sync} runs (view `sync` path or
		 * provider `synced` → seed-if-empty).
		 */
		createDocument: (options: CreateDocumentOptions = {}): EdytorDocument => {
			// Every entry path crosses the admission boundary — a fresh
			// doc is trivially `'fresh'`; the uniform call keeps the gate
			// structural rather than assumed.
			const doc = new Y.Doc();
			assertAdmission(asEngineDoc(doc), 'created document');
			const document = init(doc, true, options, options.semantics ?? defaultSemantics);
			if (options.value !== undefined) {
				try {
					document.sync(options.value);
				} catch (error) {
					document.destroy();
					throw error;
				}
			}
			return document;
		},

		/**
		 * Restore a saved update on a FRESH replica (fresh `clientID` — the
		 * local replica identity is never restored, only the replicated
		 * state). Staged admission: the payload is
		 * decoded+integrated onto a SCRATCH doc and the document admission
		 * gate runs on the merged result — a corrupt payload
		 * ({@link UndecodableUpdateError}, a v13 document's bytes among
		 * them), or a schema claim this build cannot own ({@link SchemaMismatchError})
		 * refuses BEFORE the facade/history/awareness ever compose, and
		 * the caller's bytes are never touched. Only then does `sync()`
		 * complete readiness (history attaches after the restored schema
		 * is validated, never before).
		 */
		loadDocument: (update: Uint8Array, options: LoadDocumentOptions = {}): EdytorDocument => {
			const doc = admission.admitUpdate(update, 'loaded document');
			const document = init(doc, true, options, options.semantics ?? defaultSemantics);
			try {
				document.sync();
			} catch (error) {
				document.destroy();
				throw error;
			}
			return document;
		},

		/**
		 * Compose document services around a doc the CALLER owns — the
		 * legacy `{doc}`/`{awareness}` injection path. The document creates
		 * the facade, history and (unless injected) awareness around it;
		 * `destroy()` releases those but never `doc.destroy()`s the
		 * borrowed doc. Content state stays `pending` — the caller (view or
		 * provider path) drives `sync()`.
		 *
		 * Admission runs BEFORE any composition touches the doc: an
		 * unversioned/unsupported/foreign schema claim refuses with
		 * {@link SchemaMismatchError} — the borrowed doc is left
		 * byte-identical (the gate reads are write-free) and can be
		 * attached once its state heals (e.g. a remote update supplies the
		 * missing version stamp, or migration rewrites it). A doc with
		 * foreign/unrelated ROOTS but no schema claim admits `pending`:
		 * `sync()` then seeds the schema next to them, or a valid remote
		 * update hydrates it.
		 *
		 * Deduplicated by raw doc: reattaching returns the SAME live
		 * document and retains one more reference (released by that
		 * holder's `destroy()`). Divergent reattach configuration —
		 * another actor, another awareness instance, another merge
		 * window, or conflicting semantics — raises
		 * {@link SemanticConflictError}: two `EdytorDocument`s on one raw
		 * doc are impossible through this API.
		 */
		attachDocument: (doc: YDoc, options: DocumentOptions = {}): EdytorDocument => {
			// A destroyed raw doc cannot carry a maintained composition —
			// its shared types and event handlers are already torn down.
			if ((doc as { isDestroyed?: boolean }).isDestroyed === true) {
				throw new DocumentDestroyedError('attachDocument');
			}
			const existing = attached.get(doc);
			if (existing !== undefined && !existing.destroyed) {
				assertAttachCompatible(existing, options);
				existing.retain();
				return existing;
			}
			// Doc-level admission before composition — a refusal is typed
			// and leaves the borrowed doc untouched (see the docstring).
			assertAdmission(asEngineDoc(doc), 'attached document');
			return init(doc, false, options);
		}
	};
};

// ── production binding (module singleton — bound ONCE) ─────────────────
//
// All documents share ONE `bindDocModel` binding, so the doc-shared
// `RunView` (its `WeakMap<doc>` lease table) is maintained exactly once
// per doc no matter how many documents/views compose it.
const productionBinding = bindDocument(Y);

/** See {@link DocumentBinding.createDocument}. */
export const createDocument = productionBinding.createDocument;
/** See {@link DocumentBinding.loadDocument}. */
export const loadDocument = productionBinding.loadDocument;
/** See {@link DocumentBinding.attachDocument}. */
export const attachDocument = productionBinding.attachDocument;
