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
}
