/**
 * `CrdtOps` — the operation-adapter contract between the replica harness and a
 * document model (U02).
 *
 * The harness (PeerSet + scenarios + random corpus) only ever talks to a
 * `CrdtOps` implementation. Today that is {@link RawNodeOps}, which maps the
 * contract directly onto vendored `Y.Node` primitives with *today's* semantics
 * (structure changes copy payloads — no identity-preserving move/split/merge).
 * U03/U04/U06 will plug the real model adapter behind the same interface so the
 * entire schedule/scenario/corpus suite runs unchanged against it.
 *
 * Design rules:
 *
 * - Adapters are STATELESS across peers: every method takes the `Peer` and
 *   resolves its own live objects from `peer.doc`. Scenario code never holds
 *   engine handles, only logical ids.
 * - Blocks are addressed by a caller-assigned logical `BlockId` (the `id`
 *   attribute). Whether the underlying engine identity survives an op is a
 *   separate, observable property — see {@link CrdtOps.crdtId}.
 * - `Destination` = `{ parent, index }`. `parent: null` is the document root.
 *   `index` counts the destination's CURRENT children after removing the
 *   moved block when it is a child of that parent (final-index semantics,
 *   matching the plan's proposed default; adapters document deviations).
 * - All mutating ops run inside `peer.transact` so they carry the peer's
 *   local transaction origin. Ops on unresolvable targets are no-ops that
 *   return `false`/`null` rather than throwing — the random corpus treats a
 *   no-op as "not applicable in this view", never as a failure. A thrown
 *   error means a genuine bug.
 * - The projection ({@link CrdtOps.project}) is the canonical comparison
 *   surface for convergence: a plain JSON tree of logical ids, types, marks
 *   and inline atoms. Engine-internal orderings that differ from the visible
 *   order must be normalized away by the adapter's projector.
 */
import type { Peer } from '../peer-set.js';

/** Logical block identifier — the model-level id stored on the block. */
export type BlockId = string;
/** Logical inline-atom identifier. */
export type InlineId = string;

/** Where a block goes: `parent` is a logical block id or `null` for root. */
export type Destination = { parent: BlockId | null; index: number };

/** One inline content element in a block spec / projection. */
export type ContentItem =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: InlineId; type: string; data?: Record<string, unknown> };

/** Declarative block description used for inserts (and by the seeder). */
export type BlockSpec = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content?: ContentItem[];
	children?: BlockSpec[];
};

/** Canonical projected block — the comparison surface for convergence. */
export type ProjectedBlock = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content: ContentItem[];
	children: ProjectedBlock[];
	/**
	 * Set when the underlying node could not be read completely (e.g. a
	 * tombstoned/GC'd node whose attrs no longer resolve under lossy reload
	 * schedules). Projected best-effort so convergence diffs stay readable;
	 * `checkStructurallyValid` reports it as a `malformed-node` violation —
	 * never an expected class.
	 */
	malformed?: true;
};

export type ProjectedDoc = { children: ProjectedBlock[] };

export type InlineSpec = { id: InlineId; type: string; data?: Record<string, unknown> };

export interface CrdtOps {
	/** Adapter label used in reports (e.g. 'raw-node'). */
	readonly name: string;
	/**
	 * True iff {@link moveBlock} preserves the engine identity of the block
	 * (and of any text it owns). RawNodeOps copies payloads, so this is false;
	 * scenarios that require retained identity check the flag and record the
	 * outcome as pending-scenario evidence instead of weakening assertions.
	 */
	readonly preservesIdentityOnMove: boolean;
	/** Same question for split/merge. */
	readonly preservesIdentityOnSplitMerge: boolean;

	// ── structure ────────────────────────────────────────────────────────

	/**
	 * Insert a new block (built from `spec`) at `dest`. Returns false without
	 * mutating when the destination or a spec id is unresolvable (the model
	 * validates the WHOLE spec tree's ids before writing — a nested-child id
	 * colliding with an existing block rejects the insert atomically).
	 */
	insertBlock(peer: Peer, dest: Destination, spec: BlockSpec): boolean;
	/** Delete a block and everything it owns. No-op when unknown. */
	deleteBlock(peer: Peer, id: BlockId): boolean;
	/**
	 * Relocate a block to `dest`. Implementations must reject moves into the
	 * block's own subtree without mutating. Whether the engine identity and
	 * payload survive is adapter-defined (`preservesIdentityOnMove`).
	 */
	moveBlock(peer: Peer, id: BlockId, dest: Destination): boolean;
	/**
	 * Grouped move: relocate `ids` (source-order snapshot) to consecutive
	 * positions starting at `dest.index` inside ONE transaction — one undo
	 * step, per-member conflict resolution (U03/MV07). Blocks inserted into
	 * the vacated range after the snapshot are NOT implicitly included.
	 * Locally all-or-nothing: any unresolvable member aborts the group.
	 */
	moveBlocks(peer: Peer, ids: BlockId[], dest: Destination): boolean;
	/** Convenience: move `id` to the last position under `newParentId`. */
	nestBlock(peer: Peer, id: BlockId, newParentId: BlockId): boolean;
	/** Convenience: move `id` beside its parent (index = parent index + 1). */
	unNestBlock(peer: Peer, id: BlockId): boolean;
	/**
	 * Split block `id` at content `offset`: a new sibling `newId` is created
	 * after `id` holding the trailing content (and, matching the current
	 * editor contract, the block's children). Returns false when unresolvable.
	 */
	splitBlock(peer: Peer, id: BlockId, offset: number, newId: BlockId): boolean;
	/**
	 * Merge `fromId` into `intoId`: `fromId`'s content is appended to
	 * `intoId`'s content, its children appended to `intoId`'s children, and
	 * `fromId` is deleted. Returns false when unresolvable.
	 */
	mergeBlocks(peer: Peer, fromId: BlockId, intoId: BlockId): boolean;

	// ── inline content ───────────────────────────────────────────────────

	/** Insert text at content `offset` (atoms count as one position). */
	insertText(
		peer: Peer,
		id: BlockId,
		offset: number,
		text: string,
		marks?: Record<string, unknown>
	): boolean;
	/** Delete `length` content positions starting at `offset`. */
	deleteText(peer: Peer, id: BlockId, offset: number, length: number): boolean;
	/** Set a mark on `length` content positions starting at `offset`. */
	setMark(
		peer: Peer,
		id: BlockId,
		offset: number,
		length: number,
		name: string,
		value: unknown
	): boolean;
	/** Remove a mark on a range (`value = null`). */
	unsetMark(peer: Peer, id: BlockId, offset: number, length: number, name: string): boolean;
	/** Insert an inline atom at content `offset`. */
	insertInline(peer: Peer, id: BlockId, offset: number, atom: InlineSpec): boolean;
	/** Remove an inline atom by its logical id. */
	removeInline(peer: Peer, id: BlockId, inlineId: InlineId): boolean;

	// ── queries (assertion surface) ──────────────────────────────────────

	/** Canonical projected document tree (see interface docs). */
	project(peer: Peer): ProjectedDoc;
	/** Live engine handle for a logical id, or null when absent. */
	resolveBlock(peer: Peer, id: BlockId): unknown | null;
	/**
	 * Stable engine identity of a block ('client:clock' on the raw adapter),
	 * or null when the block is absent. Identity-retention assertions compare
	 * this value across ops; it may legitimately change on adapters that copy.
	 */
	crdtId(peer: Peer, id: BlockId): string | null;
	/** Flat text of a block's content (atoms rendered as `obj`). */
	blockText(peer: Peer, id: BlockId): string | null;
	/** All logical block ids in projection (pre-order). */
	listBlockIds(peer: Peer): BlockId[];
	/** Parent of a block: `{ parent, index }`, or null when absent. */
	positionOf(peer: Peer, id: BlockId): Destination | null;

	/**
	 * Registry-completeness oracle (gate-1): the set of logical ids the
	 * adapter expects `project()` to emit — every live block that is not
	 * legitimately hidden (deleted, merged-away, or under a deleted
	 * ancestor). `checkStructurallyValid` diffs this against the projection:
	 * a live block that silently fell out of it is an `unreachable-block`
	 * violation, and a projected-but-should-be-hidden block is flagged the
	 * other way. Optional — adapters with no hidden-but-live state (raw
	 * nodes: projection IS the store) omit it and the check is skipped.
	 */
	expectedProjectedIds?(peer: Peer): Set<BlockId> | null;

	// ── strict lost-edit oracle (WU3) ────────────────────────────────────

	/**
	 * Locate the atoms a successful {@link insertText} just wrote, searching
	 * every backing text on `peer` for the unique tag. Returns the home text
	 * id plus the per-atom engine ids, or null when the tag is nowhere — an
	 * insert that reports success but writes no findable atoms is itself the
	 * real-loss signature the strict gate exists to catch. Optional: adapters
	 * without an ownership layer (raw nodes) omit it and the runner falls
	 * back to the legacy block-text check.
	 *
	 * `onlyNew` (U5): when supplied — the op's `diff.atomsNew` stamp keys —
	 * only an occurrence composed ENTIRELY of atoms the op just wrote
	 * qualifies; coincidental same-substring assemblies built from stale
	 * fragments of other inserts are skipped, and `null` is returned when
	 * the op's own atoms never spell the tag (the real-loss signature).
	 * Without it the first substring match wins (legacy semantics).
	 */
	locateTagAtoms?(
		peer: Peer,
		tag: string,
		onlyNew?: ReadonlySet<StampKey>
	): { textId: string; atoms: TagAtom[] } | null;

	/**
	 * Post-barrier per-atom fates for one tracked tag: where each atom ended
	 * up in the converged state. The runner aggregates these into the oracle
	 * verdicts — explicit deletion, movement to another owner, or actual
	 * loss — see {@link AtomFate}.
	 *
	 * `context` carries the schedule-side causal expectations the oracle
	 * cannot see from state alone (gate-F1 F3): without it, an atom under a
	 * foreign visible owner reports `moved` unconditionally. With it, an
	 * owner that no recorded split/merge produced — or that already owned
	 * the atoms at insert time — reports `stolen` instead.
	 */
	classifyTagAtoms?(
		peer: Peer,
		target: BlockId,
		atoms: TagAtom[],
		context?: TagClassifyContext
	): AtomFate[];

	/**
	 * Loss-correlation oracle (gate-F1 F4): for each tracked atom, the
	 * engine ids of the items its display DEPENDS on — the atom itself plus
	 * the claim stamps of every slice record covering it on this replica
	 * (any holder, live or dead). The runner intersects this set with the
	 * ids a lossy reload actually destroyed (or left stranded in pending
	 * state) to decide whether a hard fate is explained convergent-loss or
	 * a real defect. Optional — adapters without it fall back to checking
	 * the atom's own id only.
	 */
	tagAtomDeps?(peer: Peer, textId: BlockId, atoms: TagAtom[]): TagAtom[][];

	// ── operation-intent oracle (hardening U5) ─────────────────────────
	//
	// The strict oracle must check OPERATION INTENT, not just post-hoc
	// consistency (review §R6): a tombstone proves deletion occurred, not
	// that deletion was requested; a destination produced by an unrelated
	// split proves nothing about a particular atom's transfer. The runner
	// snapshots the mutation surface around EVERY scheduled doc op and
	// rejects effects the op was never allowed to produce — per-op causal
	// evidence replaces run-global `legitOwners`/deletion permissions.

	/**
	 * Snapshot everything a mutation can lawfully touch on `peer`'s
	 * current doc — see {@link OpState}. Called immediately before and
	 * after each executed doc op; the runner diffs the pair and rejects
	 * out-of-envelope effects. Optional: adapters without an ownership
	 * layer (raw nodes) omit it and the runner skips intent checking for
	 * them (the strict lanes both implement it).
	 */
	captureOpState?(peer: Peer): OpState;

	/**
	 * The addressable surface of an op targeting block `id`, resolved on
	 * THIS peer's current view — see {@link OpTarget}. `null` means `id`
	 * is unresolvable/invisible: the op must then produce an empty diff.
	 */
	opTarget?(peer: Peer, id: BlockId): OpTarget | null;

	/**
	 * Why a block is dead/hidden — per-holder explanation the runner
	 * evaluates for `dead-owner` fates: `del` = it carries a del flag,
	 * `ancestor` = hidden under a dead display ancestor (`root`),
	 * `claim` = its owner chain routes to a dead block (`end`) through
	 * merge-claim stamps `chain`, `absent` = not in the registry,
	 * `live` = nothing explains it (always suspicious in context).
	 */
	deadCause?(peer: Peer, id: BlockId): DeadCause;

	/**
	 * Attach per-peer history tracking (a registry-scoped UndoManager,
	 * `captureTimeout: 0`, tracking only the peer's local origin).
	 * Idempotent; called by the runner before schedules that contain
	 * undo/redo ops. History does not survive reload (a reloaded doc is a
	 * new writer — the manager re-derives on the new doc).
	 */
	trackHistory?(peer: Peer): void;
	/** Pop the peer's local undo stack. No-op when empty/unsupported. */
	undo?(peer: Peer): void;
	/** Pop the peer's local redo stack. No-op when empty/unsupported. */
	redo?(peer: Peer): void;

	// ── roles (an adapter configured with block roles) ──────────────────

	/** The role answer for void kinds (`wellFormed` `void-children`). */
	isVoid?(peer: Peer, id: BlockId): boolean;
	/** Island child kind → island kind (`wellFormed` `island-kind`, settled states). */
	readonly islandKinds?: ReadonlyMap<string, string>;
	/** The kind a view fed only the change reports holds for `id` (`wellFormed` `report-kind`). */
	reportedKind?(peer: Peer, id: BlockId): string | undefined;
	/**
	 * The container rules' side effects an op on `id` may have (ZW-11): the
	 * display ancestors of `id` that are containers (a structural op removes
	 * one it leaves with no child), and, for an outdent out of a container,
	 * the siblings that go to the new list it splits off (`split`).
	 */
	containerSlack?(
		peer: Peer,
		id: BlockId
	): { containers: BlockId[]; split: BlockId[]; layout?: { items: BlockId[]; moves: BlockId[] } };
	/** Layout kind → its item kind (`wellFormed` `layout-shape`). */
	readonly layouts?: ReadonlyMap<string, string>;
	/** `id` is a live block the layout rules hide (`layout.*`): its children show in its slot. */
	dissolved?(peer: Peer, id: BlockId): boolean;
	/**
	 * Place `ids` beside `target` (`layout.place-beside`): a new column beside
	 * the target's, or a new layout wrapping it. False when refused.
	 */
	placeBeside?(peer: Peer, ids: BlockId[], target: BlockId, side: 'left' | 'right'): boolean;
	/** Table kind → its row and cell kinds (`wellFormed` `table-shape`). */
	readonly tables?: ReadonlyMap<string, { row: string; cell: string }>;
	/** `id` is withdrawn by an undo and live (`hist.undo.withdraw`; `wellFormed` `table-shape`). */
	withdrawn?(peer: Peer, id: BlockId): boolean;
	/** The table `id` is, or holds `id` (its row or cell), with every block stored under it. */
	tableOf?(peer: Peer, id: BlockId): { table: BlockId; members: BlockId[]; cell: boolean } | null;
	/**
	 * One table operation on `table`, chosen by `pick` (`table.*`): a row or a
	 * column inserted, deleted or moved, or a padded cell filled. False when refused.
	 */
	tableOp?(peer: Peer, table: BlockId, pick: number): boolean;
}

/**
 * `StampKey` — `'client:clock'` string form of an engine item id, the
 * stable identity the intent oracle correlates across ops and replicas.
 */
export type StampKey = string;

/** One atom slot in a block's display (see {@link CrdtOps.opTarget}). */
export type OpTargetAtom = {
	/** Engine identity `client:clock` of the atom's item position. */
	key: StampKey;
	/** Present iff the atom is an inline node — its logical id. */
	inlineId?: InlineId;
};

/** Everything a positional op on `id` may lawfully touch. */
export type OpTarget = {
	/** Displayed atoms in order — deleteText/setMark ranges index this. */
	atoms: OpTargetAtom[];
	/**
	 * Backing texts the display draws from, PLUS `id` itself (its own
	 * backing text is always reachable — revive coverage/inserts write
	 * into it even when the display is empty).
	 */
	texts: ReadonlySet<BlockId>;
	/**
	 * Blocks whose `slices` lists may physically hold claims routing to
	 * `id` — `h` with `owner(h) === id` (`id` itself plus merged-away
	 * holders whose content routes here). Claim writes/removals during
	 * content ops on `id` are only legal on these lists.
	 */
	holders: ReadonlySet<BlockId>;
	/** Display children of `id` (split/merge reparent them). */
	children: ReadonlySet<BlockId>;
};

/** Per-block replicated-state surface captured for the op diff. */
export type OpStateBlock = {
	/** Any live per-writer delete mark. */
	deleted: boolean;
	/** Comma-joined stamps of the live delete-mark items (loss correlation). */
	delStamp: StampKey | null;
	/** Canonical fingerprint of the block's live placement candidates. */
	placements: string;
};

/**
 * The mutation surface an executed op may lawfully change — captured
 * twice per op (pre/post) and diffed by the runner:
 *
 * - `atoms`: every backing-text atom (live AND tombstoned) keyed by
 *   `client:clock`, with its home text and canonical fingerprints of its
 *   marks map / inline payload (`canonKey` strings — `''` when absent).
 * - `claims`: every `slices`-sequence item (live AND tombstoned) keyed by
 *   its stamp, classified as `slice` (target text `t`), `merge` (claimed
 *   block `m`) or `other` (unrecognized payload — still tracked so an op
 *   cannot touch it unnoticed).
 * - `blocks`: every registry entry with del flag, del-item stamp and a
 *   canonical fingerprint of its placement candidates.
 */
export type OpState = {
	atoms: Map<
		StampKey,
		{
			text: BlockId;
			live: boolean;
			marks: string;
			/** The shared mark map itself — kept for key-level diffs (read-only). */
			marksObj?: Record<string, unknown>;
			payload: string;
		}
	>;
	claims: Map<
		StampKey,
		{ holder: BlockId; kind: 'slice' | 'merge' | 'other'; t?: BlockId; m?: BlockId; live: boolean }
	>;
	blocks: Map<BlockId, OpStateBlock>;
};

/** Why a block is dead/hidden — see {@link CrdtOps.deadCause}. */
export type DeadCause =
	| { kind: 'del' }
	| { kind: 'ancestor'; root: BlockId }
	| { kind: 'claim'; chain: StampKey[]; end: BlockId }
	| { kind: 'absent' }
	| { kind: 'live' };

/** Engine identity of one atom: `{client, clock}` of its item position. */
export type TagAtom = { c: number; k: number };

/**
 * Fate of one tracked insert atom in the converged state — the strict
 * lost-edit oracle's vocabulary (docs/crdt-v14-harness.md):
 *
 * - `present` — displayed by the block the insert targeted.
 * - `moved` — displayed by a DIFFERENT visible block (`owner`): a legal
 *   owner-move through contested-range claims (concurrent split/merge won
 *   the seam). Evidence, not loss — the edit survived, relocated.
 * - `stolen` — displayed by a different visible block (`owner`) whose
 *   claim is NOT explained by the schedule's causal operations (gate-F1
 *   F3): either the owner already claimed the atoms at insert time (an
 *   ownership steal — the confirmed WU1 `alreadyCovered` defect shape) or
 *   the owner is not among the `legitOwners` the recorded split/merge ops
 *   produced. Hard failure — the strict lane reports it as `stolen-edit`.
 * - `tombstoned` — the item itself is deleted: an explicit `deleteText`/
 *   `removeInline` covered it. Legit deletion.
 * - `dead-owner` — the atom is live but every covering claim belongs to a
 *   deleted/legitimately-hidden holder (`holders`): the content died with
 *   its owner, same contract as deleting the block. Legit deletion.
 * - `unreachable` — displayed by a live block that should be projected but
 *   is not: the `unreachable-block` invariant, a hard failure on its own.
 * - `uncovered` — the atom is live and NO claim record covers it at all:
 *   a coverage hole. This is actual loss — hard failure.
 * - `gone` — the atom is absent from the store entirely (GC'd tombstone or
 *   a reload that dropped it). Legit only under observed environment loss.
 *
 * U5 detail fields: `via` = stamp (`client:clock`) of the winning slice
 * record covering the atom on this replica; `route` = merge-claim stamps
 * traversed from the record's holder to the displayed owner — the
 * physical ownership path the runner cross-checks against the claims the
 * schedule actually wrote. `marks`/`payload` = canonical fingerprints of
 * the atom's mark map / inline payload, compared against the atom's birth
 * snapshot (unrequested payload mutation is `mutated-edit`, hard).
 */
export type AtomFate =
	| {
			kind: 'present';
			via?: StampKey;
			route?: StampKey[];
			marks?: string;
			marksObj?: Record<string, unknown>;
			payload?: string;
	  }
	| {
			kind: 'moved';
			owner: BlockId;
			via?: StampKey;
			route?: StampKey[];
			marks?: string;
			marksObj?: Record<string, unknown>;
			payload?: string;
	  }
	| {
			kind: 'stolen';
			owner: BlockId;
			via?: StampKey;
			route?: StampKey[];
			marks?: string;
			marksObj?: Record<string, unknown>;
			payload?: string;
	  }
	| { kind: 'tombstoned' }
	| {
			kind: 'dead-owner';
			holders: BlockId[];
			marks?: string;
			marksObj?: Record<string, unknown>;
			payload?: string;
	  }
	| {
			kind: 'unreachable';
			owner: BlockId;
			via?: StampKey;
			route?: StampKey[];
			marks?: string;
			marksObj?: Record<string, unknown>;
			payload?: string;
	  }
	| { kind: 'uncovered' }
	| { kind: 'gone' }
	/** In a live block the table rules hide (`table.cell`: a cell of a deleted column), with it. */
	| { kind: 'hidden'; owner: BlockId };

/**
 * Schedule-side causal context for {@link CrdtOps.classifyTagAtoms}
 * (gate-F1 F3 + hardening U5) — the part of the `moved` vs `stolen`
 * distinction that engine state alone cannot express:
 *
 * - `legitOwners` — every block id a recorded split (`newId`) or merge
 *   (`intoId`) produced over the whole schedule, PLUS the atoms' home
 *   block (the backing text's natural owner — it reclaims them whenever
 *   a claim holding them dissolves, e.g. when the claiming block is
 *   concurrently deleted) and the insert target itself. Ownership
 *   transfers to these blocks are explainable by causal operations;
 *   anything else is not. **Pre-U5 semantics** — run-global: a
 *   destination produced anywhere in the run excuses ANY transfer into
 *   it (the R6 acceptance hole). Kept for context-free/direct callers;
 *   the runner no longer relies on it once `authorizedClaims` is set.
 * - `insertOwners` — owners that already claimed the tag's atoms on the
 *   INSERTING peer immediately after `insertText` returned. A correct
 *   insert always owns its atoms locally (the display position it typed
 *   into is target-owned); finding them under a foreign owner at birth is
 *   the ownership-steal signature — persisted under the same owner it is
 *   still a steal, not a move.
 * - `authorizedClaims` (U5) — the exact set of claim stamps
 *   (`client:clock` item ids) the executed schedule wrote: seed claims
 *   plus every claim write that passed the per-op intent envelope —
 *   NEVER the pseudo stamp `-1:-1`. When present it replaces
 *   `legitOwners` entirely: an atom is `stolen` iff its `via` record or
 *   any `route` merge-claim carries a real stamp outside this set. An
 *   injected move into a recorded split destination is caught because
 *   the claim that performed it was never written by the schedule —
 *   destination existence is no longer evidence.
 */
export type TagClassifyContext = {
	legitOwners?: ReadonlySet<BlockId>;
	insertOwners?: ReadonlySet<BlockId>;
	authorizedClaims?: ReadonlySet<StampKey>;
};
