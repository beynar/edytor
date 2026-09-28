/**
 * `EdytorDocument` — the assembled document: one composition/lifecycle
 * owner binding the production engine once and composing the existing
 * domain facade, the default local history, one shared awareness, the
 * document-level semantic configuration (block roles + default type) and
 * the local actor identity (compact per-block attribution, U1+U2).
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
 * authority — U1 contract). The same rule applies to an injected
 * `awareness` (the `_ownsAwareness` convention already used by
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
 * ── Admission boundary (U8) ────────────────────────────────────────────
 *
 * Every content-entry path crosses the one document-level admission gate
 * (`src/lib/crdt/admission.ts` — shared vocabulary with the transport
 * layer's staged-update gate):
 *
 * - `createDocument` — the fresh doc is trivially admitted;
 * - `loadDocument` — the payload is decoded+integrated onto a SCRATCH
 *   doc first (`admitUpdate`) and the gate runs on the merged result; a
 *   refusal ({@link UndecodableUpdateError}, {@link UnsupportedDocError},
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
 * The adopted capability (rule R5) is document-level state that outlives
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
 * One registry-scoped `Y.UndoManager` per document (the facade's
 * supported seam). Capture is gated by TWO live checks, both consulted
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
 * excluded. Stacks are unbounded (the engine prunes nothing); prune
 * explicitly via {@link clearHistory} / `history.clear()`, and tune the
 * merge window via `history.captureTimeout`.
 */
import { Y } from './engine.js';
import type { EngineApi, EngineDoc, YDoc, YUndoManager } from './engine-api.js';
import {
	bindAttribution,
	type AttributionBinding,
	type AttributionController,
	type DocumentAttribution
} from './attribution/index.js';
import {
	bindEdytorDoc,
	isInitialized,
	lineageDepthOf,
	type BlockRole,
	type EdytorDoc,
	type EdytorDocBinding
} from './edytor-doc.js';
import { assertAdmission, assertSchema, bindAdmission, checkSchema } from './admission.js';
import { Awareness } from './protocols/awareness.js';
import type { EdytorSync, EdytorSyncCleanup, EdytorSyncPayload } from './providers/index.js';
import { TRANSACTION } from '../constants.js';
import type { JSONDoc } from '../utils/json.js';

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
	/** Structural role per block type (`{void?, island?}` — absent flags mean false). */
	roles?: Record<string, BlockRole>;
	/** Whether a kind renders its own content slot (undeclared kinds do). */
	rendersContent?: Record<string, boolean>;
	/** Default child type per parent type (undeclared parents take `defaultType`). */
	defaultChild?: Record<string, string>;
	/** Default block type — the root's default child and the bootstrap block. */
	defaultType?: string;
};

export type DocumentOptions = {
	/** Local actor — anonymous opaque id when absent. */
	actor?: DocumentActor;
	/** Up-front semantic configuration (views may also seed via `adoptSemantics`). */
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
	 * commit its own step. Stacks are unbounded regardless — see
	 * {@link EdytorDocument.clearHistory} for the pruning surface.
	 */
	history?: { captureTimeout?: number };
	/**
	 * Opt-in per-block lineage ring — `depth > 0` captures a subtree
	 * snapshot just before an edit displaces a block's current
	 * `lastChangedBy` owner (handoffs, deletes, undo/redo touches),
	 * ring-trimmed to this many entries per block. `0`/absent disables
	 * the feature: no captures, byte-identical writes. Read via
	 * {@link DocumentAttribution.history}. Must be a finite non-negative
	 * integer — `NaN`/`Infinity`/fractional/negative values raise
	 * `RangeError` at creation (an unbounded ring is worse than no ring).
	 */
	lineage?: { depth?: number };
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

/**
 * Raised when a view (or caller) tries to contribute document-level
 * semantics that contradict an already-adopted rule — views must never
 * silently impose incompatible structural rules on a shared document.
 */
export class SemanticConflictError extends Error {
	constructor(
		/** What conflicted (e.g. `block role "divider"`, `defaultType`). */
		public readonly subject: string,
		public readonly existing: unknown,
		public readonly incoming: unknown
	) {
		super(
			`EdytorDocument semantic conflict on ${subject}: ` +
				`${JSON.stringify(existing)} already adopted, refusing ${JSON.stringify(incoming)}.`
		);
		this.name = 'SemanticConflictError';
	}
}

/** Raised when a readiness-gated service is used on a pending document. */
export class DocumentNotReadyError extends Error {
	constructor(service: string) {
		super(
			`EdytorDocument.${service}: document is not ready — it is still pending ` +
				`(created without a value, provider hydration may be in flight). ` +
				`Wait for the sync callback / call document.sync() first.`
		);
		this.name = 'DocumentNotReadyError';
	}
}

/**
 * Raised when an operation runs against a torn-down document — every
 * attach reference has been released and the facade/history/awareness
 * teardown already ran. Distinct from {@link DocumentNotReadyError}:
 * destroyed is terminal, pending may still resolve.
 */
export class DocumentDestroyedError extends Error {
	constructor(service?: string) {
		super(`EdytorDocument${service ? `.${service}` : ''}: document is destroyed.`);
		this.name = 'DocumentDestroyedError';
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
 * state (unversioned/unsupported/foreign/legacy — e.g. via raw
 * `applyUpdate` bypass writes) refuses there with a typed error, stays
 * `pending`, and preserves the state — never silently becoming `local`.
 */
export type DocumentReadiness = 'pending' | 'local' | 'hydrated';

/**
 * How long (ms) an empty document waits for a provider that has not
 * settled before it decides without it (R13 settle-or-bound) — the bound a
 * provider that cannot report "settled" (an opaque websocket relay in an
 * empty room) gets. A factory sets its own with `sync.bound`.
 */
export const DEFAULT_READINESS_BOUND = 1000;

type NormalizedRole = { void: boolean; island: boolean };

const normalizeRole = (role: BlockRole | undefined): NormalizedRole => ({
	void: role?.void === true,
	island: role?.island === true
});

const anonymousActor = (): DocumentActor => ({
	id: `anon-${crypto.randomUUID()}`
});

/** Internal constructor bag — use {@link createDocument}/{@link loadDocument}/{@link attachDocument}. */
export type EdytorDocumentInit = {
	doc: YDoc;
	/** Whether `destroy()` may `doc.destroy()` — true only for document-allocated docs. */
	ownsDoc: boolean;
	/** The bound facade binding this document composes (injected by `bindDocument`). */
	binding: EdytorDocBinding;
	/** The bound attribution service (injected by `bindDocument`). */
	attribution: AttributionBinding;
	/** The engine this document's doc belongs to (for `encode`). */
	engine: EngineApi;
	/** The awareness class bound to this engine (same class for every engine). */
	awarenessCtor: typeof Awareness;
	actor?: DocumentActor;
	awareness?: Awareness;
	semantics?: DocumentSemanticsConfig;
	history?: { captureTimeout?: number };
	lineage?: { depth?: number };
};

/**
 * The assembled document — see the module header for the lifecycle,
 * readiness and semantic-config contracts.
 */
export class EdytorDocument {
	/** The underlying engine doc — raw reads/providers borrow it; they never own it. */
	readonly doc: YDoc;
	/**
	 * The shared domain facade (the ONLY structural read/write surface —
	 * one per document, shared by every view). Attaching it holds the
	 * document's lease on the maintained runs view.
	 */
	readonly facade: EdytorDoc;
	/** One shared awareness instance for every view/provider of this document. */
	readonly awareness: Awareness;
	/** The local actor identity (anonymous opaque id when none was supplied). */
	readonly actor: DocumentActor;
	/**
	 * The attribution surface — compact per-block records (U1), the
	 * replicated actor dictionary (`u/` profiles, `c/` replica bindings),
	 * and a `legacy()` read over any pre-existing `a/` per-edit records
	 * written by pre-U2 builds. Ordinary edits perform no attribution
	 * writes — authorship lands inside the owning op's transaction as the
	 * block-level `b/<id>` record/`l` stamp. See
	 * `src/lib/crdt/attribution/attribution.ts` for the full contract.
	 * Access after teardown throws {@link DocumentDestroyedError} — same
	 * lifecycle contract as {@link history}.
	 *
	 * Reads are pull-model: record arrivals emit no attribution-specific
	 * change event — every fresh `block()`/`actors`/`legacy()` call reads
	 * current replicated state.
	 */
	get attribution(): DocumentAttribution {
		if (this._destroyed) {
			throw new DocumentDestroyedError('attribution');
		}
		return this._attributionCtl.view;
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
	private readonly _trackedOrigins = new Set<unknown>([this.transaction, null]);

	private readonly _engine: EngineApi;
	private readonly _ownsDoc: boolean;
	private readonly _ownsAwareness: boolean;
	private _history: YUndoManager | undefined;
	private readonly _attributionCtl: AttributionController;
	/**
	 * `true` when the attached manager was destroyed by something other
	 * than this document — its `destroy()` is a public engine surface, so
	 * an external caller can kill it while the document lives. The getter
	 * reattaches a fresh manager rather than handing back the corpse.
	 */
	private _readiness: DocumentReadiness = 'pending';
	private _destroyed = false;
	/**
	 * Attach references — every `createDocument`/`loadDocument`/
	 * `attachDocument` grants ONE; each {@link retain} grants one more.
	 * `destroy()` and a `retain()` release each consume exactly ONE
	 * reference; the document tears down only when the last release
	 * lands (deduplicated `attachDocument` shares this instance across
	 * callers/views).
	 */
	private _refs = 1;
	/** The adopted capability tables (R5): per kind, the first declaration. */
	private readonly _capability = {
		roles: new Map<string, NormalizedRole>(),
		rendersContent: new Map<string, boolean>(),
		defaultChild: new Map<string, string>()
	};
	private _defaultType: string;
	private readonly _historyOptions: { captureTimeout?: number } | undefined;
	private readonly _lineageDepth: number | undefined;
	/** Attached providers keyed by transport target (O75): one per target. */
	private _providers = new Map<unknown, EdytorSyncCleanup | undefined>();
	private _pendingSyncs = 0;
	private _healOff: (() => void) | undefined;
	private _readyListeners = new Set<() => void>();

	/** @internal Construct through {@link createDocument}/{@link loadDocument}/{@link attachDocument}. */
	constructor(init: EdytorDocumentInit) {
		this._engine = init.engine;
		this.doc = init.doc;
		this._ownsDoc = init.ownsDoc;
		this._defaultType = init.semantics?.defaultType ?? 'paragraph';
		this.facade = init.binding.create(this.doc as unknown as EngineDoc, {
			roleOf: (type) => this._capability.roles.get(type),
			defaultType: this._defaultType,
			defaultChildOf: (type) => this._capability.defaultChild.get(type),
			rendersContent: (type) => this.rendersContent(type),
			// U1: the facade's block-attribution ops read the actor lazily —
			// `this.actor` is assigned below, after facade construction.
			actor: () => this.actor,
			lineageDepth: init.lineage?.depth,
			// The `writable` guard: a write on a read-only document refuses
			// with the `SchemaMismatchError` naming the stamp.
			assertWritable: () => assertSchema(this.doc as unknown as EngineDoc, 'document')
		});
		this.awareness = init.awareness ?? new init.awarenessCtor(this.doc);
		this._ownsAwareness = init.awareness === undefined;
		this._historyOptions = init.history;
		this._lineageDepth = init.lineage?.depth;
		this.actor = init.actor ?? anonymousActor();
		// Durable actor identity is separate from the presence profile: the
		// `actor` field carries the stable id (U5/U6 stub seam), `user`
		// carries the display profile remote carets already read.
		this.awareness.setLocalStateField('actor', this.actor);
		if (this.actor.name !== undefined || this.actor.color !== undefined) {
			this.awareness.setLocalStateField('user', {
				...(this.actor.name !== undefined ? { name: this.actor.name } : {}),
				...(this.actor.color !== undefined ? { color: this.actor.color } : {})
			});
		}
		// Attribution service — attaches after the facade (which gates
		// foreign docs) and after the actor is fixed. Publishes this
		// replica's actor dictionary entries (`c/`+`u/`) once; ordinary
		// edits perform no attribution work (U2) and per-block records are
		// written inside the owning op's transaction by the facade.
		this._attributionCtl = init.attribution.attach(this.doc as unknown as EngineDoc, {
			actor: this.actor
		});
		if (init.semantics) {
			this.adoptSemantics({ ...init.semantics, defaultType: undefined });
		}
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
		return this._readiness !== 'pending';
	}

	/**
	 * `pending` | `local` | `hydrated` — distinguishes a locally-seeded
	 * ready from a provider-hydrated/restored ready (the contract consumers
	 * need to tell "I decided this content" from "sync brought it").
	 */
	get readiness(): DocumentReadiness {
		return this._readiness;
	}

	get destroyed(): boolean {
		return this._destroyed;
	}

	/**
	 * `false` while the document carries a schema stamp this build cannot
	 * own (a foreign stamp got in despite the transport's inbound refusal):
	 * every write refuses with a `SchemaMismatchError`, and the providers
	 * neither persist nor broadcast it (O18, D-2).
	 */
	get writable(): boolean {
		return checkSchema(this.doc as unknown as EngineDoc) === null;
	}

	/**
	 * Subscribe to {@link writable} transitions — the visible signal that
	 * the document turned read-only (once per transition, not per refused
	 * edit). Returns the unsubscribe.
	 */
	onWritableChange = (listener: (writable: boolean) => void): (() => void) => {
		let last = this.writable;
		const watch = () => this.writable !== last && listener((last = !last));
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
		return this._historyOptions?.captureTimeout;
	}

	/**
	 * The lineage ring depth this document was configured with — read by
	 * the `attachDocument` dedupe compatibility check (a reattach naming
	 * a different depth is a conflict; capture behavior cannot be retuned
	 * on the live facade).
	 * @internal
	 */
	get lineageDepth(): number | undefined {
		return this._lineageDepth;
	}

	/**
	 * The document-level semantic configuration (snapshot). The maps are
	 * copies — mutation is not supported; contribute via {@link adoptSemantics}.
	 */
	get semantics() {
		const { roles, rendersContent, defaultChild } = this._capability;
		return {
			defaultType: this._defaultType,
			roles: new Map<string, BlockRole>(roles),
			rendersContent: new Map(rendersContent),
			defaultChild: new Map(defaultChild)
		};
	}

	/**
	 * The default child type under a parent of `parentType` (`null` = the
	 * root) — the one answer split, paragraph insert, merge-unnest, clear
	 * and root normalization apply against the new block's actual parent.
	 */
	defaultChild = (parentType: string | null): string =>
		(parentType !== null ? this._capability.defaultChild.get(parentType) : undefined) ??
		this._defaultType;

	/** Whether kind `type` renders its own content slot (undeclared kinds do). */
	rendersContent = (type: string): boolean => this._capability.rendersContent.get(type) ?? true;

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
	 * Atomic: everything validates before anything is adopted.
	 *
	 * Contributions are document-lifetime: they survive the contributing
	 * view's teardown, so sibling views keep the same structural rules.
	 */
	adoptSemantics = (config: DocumentSemanticsConfig): void => {
		if (this._destroyed) {
			throw new DocumentDestroyedError('adoptSemantics');
		}
		if (config.defaultType !== undefined && config.defaultType !== this._defaultType) {
			throw new SemanticConflictError('defaultType', this._defaultType, config.defaultType);
		}
		const incoming = [
			['roles', Object.entries(config.roles ?? {}).map(([t, r]) => [t, normalizeRole(r)] as const)],
			['rendersContent', Object.entries(config.rendersContent ?? {})],
			['defaultChild', Object.entries(config.defaultChild ?? {})]
		] as const;
		// Pass 1 — validate EVERYTHING before mutating: a conflicting entry
		// late in a table must not leave earlier entries half-adopted.
		for (const [table, entries] of incoming) {
			for (const [type, value] of entries) {
				const existing = this._capability[table].get(type);
				if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
					throw new SemanticConflictError(`${table} "${type}"`, existing, value);
				}
			}
		}
		// Pass 2 — apply: every incoming entry proved compatible.
		for (const [table, entries] of incoming) {
			const adopted = this._capability[table] as Map<string, unknown>;
			for (const [type, value] of entries) adopted.set(type, value);
		}
	};

	/**
	 * The readiness transition — decide the document's content state. This
	 * is the document-side admission re-check ({@link assertAdmission} —
	 * usable → schema → verdict, the same reads the transport layer's
	 * staging gate runs):
	 *
	 * - `'fresh'` verdict → the deterministic seed of `value` (R13, D-3:
	 *   one update from a writer hashed from the seed; an empty value seeds
	 *   one `defaultType` block; non-local, so never an undo step);
	 * - `'initialized'` verdict (provider-hydrated, or a loaded restore) →
	 *   the schema was just asserted; content is left alone;
	 * - a doc in a problem state (unversioned/unsupported/foreign schema
	 *   claim, legacy layout — possible via raw `applyUpdate` writes that
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
		if (this._destroyed) {
			throw new DocumentDestroyedError('sync');
		}
		if (this._readiness !== 'pending') {
			return;
		}
		const verdict = assertAdmission(this.doc as unknown as EngineDoc, 'document');
		if (verdict === 'initialized') {
			// Hydrated/loaded doc — asserted above; content is left alone.
			this._readiness = 'hydrated';
		} else {
			this.facade.seed(value.children);
			this._readiness = 'local';
		}
		this._attachHistory();
		// Readiness decided — wake waiters synchronously. The hydrated
		// branch writes nothing to the doc, so `update`-based observation
		// misses it; polling alone would leave sibling views stale for
		// ~50 ms. Isolated per the listener-isolation convention: one
		// throwing waiter must not starve the rest or break `sync()`.
		const listeners = Array.from(this._readyListeners);
		this._readyListeners.clear();
		for (const listener of listeners) {
			try {
				listener();
			} catch (err) {
				console.error('[edytor-document] ready listener failed; continuing', err);
			}
		}
	};

	/**
	 * The default local history (registry-scoped `Y.UndoManager` —
	 * `undo`/`redo`/`stopCapturing`/stacks). Lazy: attaches at `sync()`,
	 * or on first access once the document is decided — it NEVER seeds
	 * content itself (accessing it on a pending doc throws
	 * {@link DocumentNotReadyError} instead of silently seeding).
	 */
	get history(): YUndoManager {
		if (this._destroyed) {
			throw new DocumentDestroyedError('history');
		}
		let history = this._history;
		// A manager enrolls itself in its tracked origins and leaves them on
		// `destroy()` — an external teardown (misuse, or the engine's own
		// `doc.destroy` cascade) shows there.
		if (history !== undefined && !this._trackedOrigins.has(history)) {
			// The manager was destroyed externally — it no longer observes
			// transactions or emits stack events, so returning it would
			// silently disable capture. Reattach a fresh one (the dead
			// manager's stacks are unrecoverable by definition).
			this._history = undefined;
			history = undefined;
		}
		if (history === undefined) {
			if (this._readiness === 'pending') {
				throw new DocumentNotReadyError('history');
			}
			history = this._attachHistory();
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
		if (this._destroyed) {
			throw new DocumentDestroyedError('trackOrigin');
		}
		this._trackedOrigins.add(origin);
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
		this._trackedOrigins.delete(origin);
	};

	private _attachHistory = (): YUndoManager => {
		if (this._history !== undefined) {
			return this._history;
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
		this._history = this.facade.createUndoManager({
			trackedOrigins: this._trackedOrigins,
			captureTimeout: this._historyOptions?.captureTimeout,
			captureTransaction: (transaction: { local?: boolean }) => transaction.local !== false
		});
		return this._history;
	};

	/**
	 * Prune the undo/redo stacks — the document's retention surface. The
	 * engine keeps unbounded stacks: nothing is pruned implicitly (the
	 * `captureTimeout` merge window only fuses adjacent commits into one
	 * step). Call this to bound memory on long-lived documents, e.g. after
	 * a save checkpoint. No-op while history has not attached (there is
	 * nothing to clear — it does NOT force attach or throw on pending).
	 */
	clearHistory = (): void => {
		if (this._destroyed) {
			throw new DocumentDestroyedError('clearHistory');
		}
		this._history?.clear();
	};

	/** Local document transaction — headless edits, one undo step per call. */
	transact = <T>(cb: () => T): T => {
		if (this._destroyed) {
			throw new DocumentDestroyedError('transact');
		}
		return this.facade.transact(cb, this.transaction);
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
		this._readyListeners.add(listener);
		return () => {
			this._readyListeners.delete(listener);
		};
	};

	/**
	 * Whether an attached provider has neither settled nor reached its
	 * bound. An editable view decides a pending document only when none is.
	 */
	get syncPending(): boolean {
		return this._pendingSyncs > 0;
	}

	/**
	 * The readiness decision (R13, O17): a document with content is decided
	 * (`hydrated`) as soon as any provider settles; an EMPTY one only once
	 * every attached provider settled or reached its bound, and then it
	 * seeds `value`. A refused admission leaves it pending, read-only and
	 * quarantined; it decides again when it turns writable (the refusal
	 * propagates to the reporting provider only).
	 */
	private _decide = (value: JSONDoc | undefined, report = false): void => {
		if (this._destroyed || this.ready) return;
		if (this._pendingSyncs > 0 && !isInitialized(this.doc as unknown as EngineDoc)) return;
		try {
			this.sync(value);
		} catch (error) {
			this._healOff ??= this.onWritableChange((writable) => {
				if (!writable) return;
				this._healOff?.();
				this._healOff = undefined;
				this._decide(value);
			});
			if (report) throw error;
		}
	};

	/**
	 * Attach a provider sync factory to this document (headless `EdytorSync`
	 * path — the same contract views use). The provider stays pending until
	 * it reports `synced` or the terminal `failed` (D4), is torn down, or its
	 * bound elapses: `sync.bound` ms, {@link DEFAULT_READINESS_BOUND} for a
	 * provider that cannot report settled. Each settle runs the readiness
	 * decision ({@link _decide}). A factory that throws never attached: its
	 * error propagates and it decides nothing. A transport target
	 * (`sync.target`, else the factory) already attached is a no-op: the
	 * document keeps one provider per target. The returned cleanup is also
	 * tracked: {@link destroy} runs it; it frees the target. A sync attaches
	 * a companion (the websocket sync's local store) through the payload's
	 * `attach`: a provider of its own, under the same rules.
	 */
	attachSync = (sync: EdytorSync, opts: { value?: JSONDoc } = {}): EdytorSyncCleanup | void => {
		if (this._destroyed) {
			throw new DocumentDestroyedError('attachSync');
		}
		const target = sync.target ?? sync;
		if (this._providers.has(target)) return;
		this._pendingSyncs += 1;
		let pending = true;
		const settle = (): boolean => {
			if (!pending) return false;
			pending = false;
			clearTimeout(bound);
			this._pendingSyncs -= 1;
			return true;
		};
		const decide = () => settle() && this._decide(opts.value);
		const ms = sync.bound ?? DEFAULT_READINESS_BOUND;
		const bound = Number.isFinite(ms) ? setTimeout(decide, ms) : undefined;
		let cleanup: ReturnType<EdytorSync>;
		try {
			cleanup = sync({
				doc: this.doc,
				awareness: this.awareness,
				synced: () => {
					settle();
					this._decide(opts.value, true);
				},
				failed: decide,
				attach: (companion) => this.attachSync(companion, opts)
			});
		} catch (error) {
			settle();
			throw error;
		}
		if (typeof cleanup !== 'function') {
			this._providers.set(target, undefined);
			return cleanup;
		}
		// The returned cleanup runs once and frees the target; tearing down
		// an unsynced provider settles it like a failure.
		const release = (): ReturnType<EdytorSyncCleanup> => {
			if (this._providers.get(target) !== release) return;
			this._providers.delete(target);
			decide();
			return cleanup();
		};
		this._providers.set(target, release);
		return release;
	};

	/** Full replicated state as a v14 update — `loadDocument` restores it on a fresh replica. */
	encode = (): Uint8Array => this._engine.encodeStateAsUpdate(this.doc);

	/**
	 * Acquire one more attach reference and return its ONE-SHOT release
	 * capability (U6b/R3). A deduplicated `attachDocument` hands every
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
		if (this._destroyed) {
			throw new DocumentDestroyedError('retain');
		}
		this._refs += 1;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this._releaseReference();
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
		this._releaseReference();
	};

	/** Shared reference release — `destroy()` and `retain()` closures land here. */
	private _releaseReference = (): void => {
		if (this._destroyed) {
			return;
		}
		this._refs -= 1;
		if (this._refs > 0) {
			return;
		}
		this._refs = 0;
		this._destroyed = true;

		// Waiters parked on the readiness transition are dropped silently —
		// a destroyed document never decides, and their views check
		// `destroyed` before binding anyway.
		this._readyListeners.clear();
		this._healOff?.();

		// Provider/sync cleanups registered through `attachSync`.
		const rethrowAsyncCleanupError = (error: unknown) => {
			setTimeout(() => {
				throw error;
			});
		};
		for (const release of [...this._providers.values()]) {
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
		this._history?.destroy();

		// The attribution service controller — the view stays readable
		// after release (a borrowed raw doc can outlive the document).
		this._attributionCtl.destroy();

		// The facade's doc `update` subscriptions + this document's lease on
		// the doc-shared run view (the view itself survives while another
		// facade holds a lease, or until the doc dies).
		this.facade.dispose();

		// Awareness is document-shared — destroy it only when the document
		// created it (an injected instance belongs to its caller).
		if (this._ownsAwareness) {
			this.awareness.destroy();
		}

		// `doc.destroy()` only for document-allocated docs — a borrowed raw
		// doc outlives this document by contract.
		if (this._ownsDoc) {
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
	const binding = bindEdytorDoc(Y);
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

	const init = (
		initOpts: Omit<EdytorDocumentInit, 'binding' | 'attribution' | 'engine' | 'awarenessCtor'>
	): EdytorDocument => {
		lineageDepthOf(initOpts.lineage?.depth);
		return new EdytorDocument({
			...initOpts,
			binding,
			attribution,
			engine: Y,
			awarenessCtor: Awareness
		});
	};

	/**
	 * A reattach must not silently diverge from the live composition —
	 * compatible declarations merge (semantics adopt onto the document,
	 * conflicting ones throw from `adoptSemantics` itself); a DIFFERENT
	 * actor, awareness instance or merge window is a conflict.
	 */
	const assertAttachCompatible = (existing: EdytorDocument, options: DocumentOptions): void => {
		lineageDepthOf(options.lineage?.depth);
		if (options.awareness !== undefined && options.awareness !== existing.awareness) {
			// SemanticConflictError serializes its operands — the awareness
			// objects themselves are circular; describe them instead.
			throw new SemanticConflictError(
				'awareness instance',
				'the attached awareness',
				'a different injected awareness'
			);
		}
		if (options.actor !== undefined && options.actor.id !== existing.actor.id) {
			throw new SemanticConflictError('actor.id', existing.actor.id, options.actor.id);
		}
		if (
			options.history?.captureTimeout !== undefined &&
			options.history.captureTimeout !== existing.historyCaptureTimeout
		) {
			throw new SemanticConflictError(
				'history.captureTimeout',
				existing.historyCaptureTimeout,
				options.history.captureTimeout
			);
		}
		if (options.lineage?.depth !== undefined && options.lineage.depth !== existing.lineageDepth) {
			throw new SemanticConflictError(
				'lineage.depth',
				existing.lineageDepth,
				options.lineage.depth
			);
		}
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
			// Every entry path crosses the admission boundary (U8) — a fresh
			// doc is trivially `'fresh'`; the uniform call keeps the gate
			// structural rather than assumed.
			const doc = new Y.Doc();
			assertAdmission(doc as unknown as EngineDoc, 'created document');
			const document = init({
				doc,
				ownsDoc: true,
				actor: options.actor,
				awareness: options.awareness,
				semantics: options.semantics,
				history: options.history,
				lineage: options.lineage
			});
			attached.set(document.doc, document);
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
		 * state). Staged admission per the U8 contract: the payload is
		 * decoded+integrated onto a SCRATCH doc and the document admission
		 * gate runs on the merged result — a corrupt payload
		 * ({@link UndecodableUpdateError}), a v13-era layout
		 * ({@link UnsupportedDocError} `'legacy'` → migration path), or a
		 * schema claim this build cannot own ({@link SchemaMismatchError})
		 * refuses BEFORE the facade/history/awareness ever compose, and
		 * the caller's bytes are never touched. Only then does `sync()`
		 * complete readiness (history attaches after the restored schema
		 * is validated, never before).
		 */
		loadDocument: (update: Uint8Array, options: LoadDocumentOptions = {}): EdytorDocument => {
			const doc = admission.admitUpdate(update, 'loaded document');
			const document = init({
				doc,
				ownsDoc: true,
				actor: options.actor,
				awareness: options.awareness,
				semantics: options.semantics,
				history: options.history,
				lineage: options.lineage
			});
			attached.set(doc, document);
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
		 * Admission runs BEFORE any composition touches the doc (U8): a
		 * foreign engine object or applied-but-unmigrated v13 state
		 * refuses with {@link UnsupportedDocError}, an
		 * unversioned/unsupported/foreign schema claim with
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
			assertAdmission(doc as unknown as EngineDoc, 'attached document');
			const document = init({
				doc,
				ownsDoc: false,
				actor: options.actor,
				awareness: options.awareness,
				semantics: options.semantics,
				history: options.history,
				lineage: options.lineage
			});
			attached.set(doc, document);
			return document;
		}
	};
};

// ── production binding (module singleton — bound ONCE) ─────────────────
//
// All documents share ONE `bindEdytorDoc` binding, so the doc-shared
// `RunView` (its `WeakMap<doc>` lease table) is maintained exactly once
// per doc no matter how many documents/views compose it.
const productionBinding = bindDocument(Y);

/** See {@link DocumentBinding.createDocument}. */
export const createDocument = productionBinding.createDocument;
/** See {@link DocumentBinding.loadDocument}. */
export const loadDocument = productionBinding.loadDocument;
/** See {@link DocumentBinding.attachDocument}. */
export const attachDocument = productionBinding.attachDocument;
