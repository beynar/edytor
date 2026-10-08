/**
 * The document facade's public types (`EdytorDoc`): the block roles and the
 * facade configuration, the change report, caret anchors, and the prepared
 * operation shapes — a plan's steps, its effect and an op's result.
 */
import type { MarkEdge } from '../text/marks.js';
import type { AttributionActor } from '../attribution/index.js';
import type {
	BlockId,
	BlockSpec,
	InlineSpec,
	ProjectedBlock,
	SplitTail
} from '../placement/model.js';
import type { Anchor } from '../text/model.js';
import type { ContentRun } from '../text/runs.js';
import type { DataPatch, LeafWrite } from '../data.js';
import type { DocPosition } from '../rangeDelete.js';

/** Structural role of a block type (plugin-side policy, resolved per op). */
export type BlockRole = {
	/** Not editable through normal structural flow; no children, no merges. */
	void?: boolean;
	/** Editable, but its subtree is structurally sealed from outside blocks. */
	island?: boolean;
	/**
	 * An island of lines (code): each direct child displays as its
	 * `defaultChild` kind and holds no children. Needs
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
	 * Data paths written as one leaf (`data.atomic`): a top-level key, or
	 * an array of keys for a nested one (`['link', ['media', 'source']]`). An
	 * assignment there, or anywhere under it, writes the whole value as one
	 * last-writer-wins leaf, so two concurrent assignments never merge into a
	 * value neither wrote: one wins whole.
	 */
	atomic?: readonly (string | readonly string[])[];
};

/** Island-sealing policy for a walk in document order (see `next`). */
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
	 * The adopted default child type per parent type — the island
	 * merge-out reset applies it against the children's actual new parent.
	 */
	defaultChildOf?: (parentType: string) => string | undefined;
	/** The adopted `rendersContent` per kind; undeclared kinds render theirs. */
	rendersContent?: (type: string) => boolean;
	/**
	 * The adopted edge of a mark (its record's `edge`): where a concurrent
	 * insert at each end of a mark operation lands. Undeclared marks are
	 * `inclusive`; a key `name:<id>` falls back to `name`'s.
	 */
	markEdge?: (mark: string) => MarkEdge | undefined;
	/**
	 * The kinds `roleOf` answers for — the display reads the line kinds of
	 * the `lines` islands from them, present in the document or not. Absent: only the kinds of the blocks the document holds.
	 */
	kinds?: () => Iterable<string>;
	/**
	 * The local actor getter for compact per-block attribution
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
	 * The document's `writable` guard — called at the write funnel;
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
	 *  (frozen — shared with the retained snapshot baseline). */
	order: Map<BlockId | null, readonly BlockId[]>;
	/** The document's own data (`docData()`), when this commit changed it. */
	data?: Record<string, unknown>;
};

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
 * A selection endpoint: `b` is the home block of the backing text the
 * position lives in (NOT necessarily the block that displays it — merges and
 * splits reroute display while the anchor stays on the same items), `a` an
 * engine relative position whose `a` carries the side (`< 0` left, `>= 0`
 * right). The containing stream and the side are two facts in two fields.
 * JSON-serializable — the presence and history wire shape.
 */
export type DocAnchor = { b: BlockId; a: Anchor };

/** A JSON object (a block's, an atom's or the document's data). */
export type JsonObj = Record<string, unknown>;

/**
 * The observed outcome of one document operation — the one result
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

/** A text range an op writes, in display offsets before the write. */
export type TextRange = { block: BlockId; offset: number; length: number };

/**
 * One planned write, named by the document operation that
 * performs it — the name a hook matches. Steps carry everything
 * their write needs (ranks, marks, offsets), decided at prepare time.
 */
export type PlanStep =
	/** `index`: the destination slot at prepare time, as hooks see it. */
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
 * What applying a plan does: blocks created, removed (they leave the
 * document), merged (`[from, into]`), moved (a placement written), retyped
 * or given new data (`meta`), and the text ranges written. Derived from the
 * plan's steps; the applied transaction changes exactly this.
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
 * A prepared operation: its steps, their effect, the ids the op
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
