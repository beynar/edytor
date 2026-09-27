/**
 * Typed node surface (WU2) — `document.block(id)` handles over the semantic
 * model. Each handle is a thin dead-safe wrapper: ops delegate to the
 * facade's ownership-aware operations and return its {@link OpResult}
 * (`refused` on absent/merged ids).
 *
 * Handles are transaction-aware: `childIds()` etc. reflect mutations made
 * earlier in the same transaction.
 * What is COMMIT-BOUND is PUBLICATION (R5): the change report and
 * `onChange` fire once per completed transaction with the final coherent
 * state — a mid-transaction read never publishes a partial snapshot, and
 * a change-then-revert transaction publishes nothing.
 *
 * Snapshot isolation (R4): item `marks`/`data` payloads on `items`,
 * `project()`, `runs` and `DocChange` content are canonical deep-frozen
 * objects — mutating a returned snapshot throws (strict mode) or lands on
 * a frozen shared instance, never on live engine state.
 *
 * The read half is deliberately narrow — the consumed set: identity
 * (`id`, `document`), the U1 attribution record, the two content views
 * (transaction-aware `items`, commit-synced `runs`), `length` and
 * `childIds`. Richer structure reads (positions, paths, roles, anchors)
 * live on the facade (`positionOf`/`pathOf`/`isVoid`/`anchorAt`/…).
 */
import type { BlockId, BlockSpec, ContentItem, InlineSpec, SplitTail } from './placement/model.js';
import type { ContentRun } from './text/runs.js';
import type { EdytorDoc, OpResult } from './edytor-doc.js';
import type { BlockAttribution } from './attribution/block.js';

/** A node argument: another block handle, a raw block id, or `null` for the root list. */
export type NodeRef = DocBlock | BlockId | null;

const idOf = (ref: NodeRef | undefined): BlockId | null =>
	ref == null ? null : typeof ref === 'string' ? ref : ref.id;

/**
 * Typed handle over one document block. Handles are dead-safe: constructing
 * one for an absent/merged id is legal — ops are `refused` (the underlying
 * facade ops guard the same way).
 *
 * Read members are getters — every access re-derives from current doc state,
 * so a handle obtained before a mutation sees the mutation afterwards
 * (including within the same transaction).
 */
export type DocBlock = {
	/** Stable caller-assigned block id. */
	readonly id: BlockId;
	/** The owning document — cross-node and document-level ops live here. */
	readonly document: EdytorDoc;

	/**
	 * U1 — compact per-block attribution (`{createdBy, contributors,
	 * lastChangedBy}` as durable actor ids), or `undefined` for
	 * system/foreign blocks carrying no record. Read live per access.
	 */
	readonly attribution: BlockAttribution | undefined;

	// ── content reads — resolved DISPLAYED content (transaction-aware) ──

	/**
	 * Resolved content items of this block's display ({kind:'text'} runs and
	 * {kind:'inline'} atoms in display order, unmerged across streams).
	 * Reflects writes made earlier in the same transaction.
	 */
	readonly items: readonly ContentItem[];
	/** Display length in atoms (UTF-16 text units + 1 per inline atom). */
	readonly length: number;

	// ── maintained view (commit-synced render/notification surface) ────

	/**
	 * The maintained run view for this block — frozen, structurally shared
	 * run arrays refreshed at transaction commit. Rendering and `DocChange`
	 * payloads consume this; command code should use {@link items} (the
	 * transaction-aware view) when reading mid-transaction.
	 */
	readonly runs: readonly ContentRun[];

	// ── structure reads (transaction-aware) ─────────────────────────────

	/** Ordered visible child ids. */
	childIds(): BlockId[];

	// ── ops — display offsets, ownership-mapped; each returns the
	//    document's {@link OpResult} (the facade op with this block's id) ──

	insertText(offset: number, text: string, marks?: Record<string, unknown>): OpResult;
	deleteText(offset: number, length: number): OpResult;
	/** Multi-mark format over `[offset, offset+length)`; `null` values unset. */
	format(offset: number, length: number, marks: Record<string, unknown>): OpResult;
	setMark(offset: number, length: number, name: string, value: unknown): OpResult;
	unsetMark(offset: number, length: number, name: string): OpResult;
	/** Remove every mark present anywhere in the range. */
	clearMarks(offset: number, length: number): OpResult;
	insertInline(offset: number, spec: InlineSpec): OpResult;
	removeInline(inlineId: string): OpResult;
	setInlineData(inlineId: string, data: Record<string, unknown>): OpResult;
	/** Insert a fresh-identity child spec; `ids`: the new block. */
	insertChild(index: number, spec: BlockSpec): OpResult;
	/** Relocate this block — identity preserved; island/void rules apply. */
	moveTo(dest: { parent: NodeRef; index: number }): OpResult;
	/** Move to the last position under `parent`. */
	nestUnder(parent: DocBlock | BlockId): OpResult;
	/** Move beside the parent (index = parent index + 1). */
	unNest(): OpResult;
	/** Split content at display `offset` into a new sibling `newId`; `ids`: the new block. */
	split(offset: number, newId: BlockId, tail?: SplitTail): OpResult;
	/** Baseline merge into the previous block in document order; `ids`: the survivor. */
	mergeBackward(): OpResult;
	/** Baseline merge pulling the next block in document order into this. */
	mergeForward(): OpResult;
	/** Engine merge primitive — `other`'s content+children claim into this. */
	mergeFrom(other: DocBlock | BlockId): OpResult;
	/** Delete (per-writer marks on this block and what it displays; R3); `keepChildren` reparents. */
	delete(opts?: { keepChildren?: boolean }): OpResult;
	setType(type: string): OpResult;
	setData(data: Record<string, unknown>): OpResult;
	/** Baseline `setBlock` — type/data update in place; content/children replace (all-or-nothing). */
	set(value: Parameters<EdytorDoc['setBlock']>[1]): OpResult;
	/** Fresh-identity copy of this subtree right after it; `ids`: the copy. */
	duplicate(freshId: (oldId: BlockId) => BlockId): OpResult;
};

/**
 * Build the `document.block(id)` node surface over an existing facade —
 * one cached handle per id (the facade normalized it at ingress), all
 * delegating to the facade's semantic ops.
 */
export const bindNodes = (doc: EdytorDoc) => {
	const cache = new Map<BlockId, DocBlock>();

	const block = (id: BlockId): DocBlock => {
		const cached = cache.get(id);
		if (cached) return cached;
		const handle: DocBlock = {
			id,
			document: doc,

			get attribution() {
				return doc.blockAttribution(id);
			},

			get items() {
				return doc.contentItems(id);
			},
			get length() {
				return doc.displayLength(id);
			},

			get runs() {
				return doc.runs(id);
			},

			childIds: () => doc.childrenIds(id),

			insertText: (offset, text, marks) => doc.insertText(id, offset, text, marks),
			deleteText: (offset, length) => doc.deleteText(id, offset, length),
			format: (offset, length, marks) => doc.formatRange(id, offset, length, marks),
			setMark: (offset, length, name, value) => doc.setMark(id, offset, length, name, value),
			unsetMark: (offset, length, name) => doc.unsetMark(id, offset, length, name),
			clearMarks: (offset, length) => doc.clearMarks(id, offset, length),
			insertInline: (offset, spec) => doc.insertInline(id, offset, spec),
			removeInline: (inlineId) => doc.removeInline(id, inlineId),
			setInlineData: (inlineId, data) => doc.setInlineData(id, inlineId, data),
			insertChild: (index, spec) => doc.insertBlock({ parent: id, index }, spec),
			moveTo: (dest) => doc.moveBlock(id, { parent: idOf(dest.parent), index: dest.index }),
			nestUnder: (parent) => doc.nestBlock(id, idOf(parent)!),
			unNest: () => doc.unNestBlock(id),
			split: (offset, newId, tail) => doc.splitBlock(id, offset, newId, tail),
			mergeBackward: () => doc.mergeBackward(id),
			mergeForward: () => doc.mergeForward(id),
			mergeFrom: (other) => doc.mergeBlocks(idOf(other)!, id),
			delete: (opts) => doc.deleteBlock(id, opts),
			setType: (type) => doc.setBlockType(id, type),
			setData: (data) => doc.setBlockData(id, data),
			set: (value) => doc.setBlock(id, value),
			duplicate: (freshId) => doc.duplicateBlock(id, freshId)
		};
		cache.set(id, handle);
		return handle;
	};

	return { block };
};
