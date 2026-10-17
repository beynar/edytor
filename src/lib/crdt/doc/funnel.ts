/**
 * The write funnel: every facade write goes through `write` (disposal and the
 * document's writable guard), and every prepared plan through `apply` — one
 * transaction, its result read from what the transaction wrote, and the
 * frame's one attribution pass.
 */
import type { Unit } from '../placement/slots.js';
import {
	blockNodeOf,
	buildInline,
	insertSpecsAt,
	moveBlocksTo,
	ownText,
	view as modelView,
	writeSplit,
	type BlockId
} from '../placement/model.js';
import type { BlockAttributionApi } from '../attribution/block.js';
import type { AttributionActor } from '../attribution/index.js';
import { ENTRY_FACET, SEQ_FACET, type Folded } from '../text/runs.js';
import { DEL_PREFIX, ID, LAST_CHANGED_ATTR, TYPE } from '../schema.js';
import { writeData } from '../data.js';
import { NOOP } from './plan.js';
import type { EdytorDocConfig, OpResult, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';
import { claimInto, deleteRange, formatRangeIn, insertIntoText } from '../text/model.js';

/**
 * Raised when an operation runs against a torn-down document: every attach
 * reference released, or its facade disposed (terminal for writes; reads
 * stay dead-safe: a stale handle may still be inspected). Distinct from
 * `DocumentNotReadyError`: destroyed is terminal, pending may still resolve.
 * Kept in this module because a bare `bindEdytorDoc` facade has no document
 * layer above it.
 */
export class DocumentDestroyedError extends Error {
	constructor(service?: string) {
		super(`${service ?? 'document'}: the document is destroyed`);
		this.name = 'DocumentDestroyedError';
	}
}

/** What the write funnel writes with: the reads, the attribution writer and the facade's configuration. */
export type FunnelContext = DocBase &
	DocReads & { BA: BlockAttributionApi; config: EdytorDocConfig };

/** The write funnel of one facade. */
export const writeFunnel = (c: FunnelContext) => {
	const { doc, runsView, dataNode, BA, config } = c;

	/**
	 * Terminal flag — set by `dispose()`. Mutating ops funnel through
	 * `write`, so gating there covers every facade write + `transact` +
	 * `init` + `createUndoManager`; reads stay dead-safe on purpose
	 * (a stale handle remains inspectable while its doc outlives the
	 * facade — e.g. the document teardown order).
	 */
	let disposed = false;

	/** Mutation boundary — every facade write funnels through `write`. */
	const write = <R>(fn: () => R): R => {
		if (disposed) {
			throw new DocumentDestroyedError();
		}
		config.assertWritable?.();
		return fn();
	};

	// ── the write funnel ─────────────────────────────
	//
	// Every document op is a prepared plan (below) written by `apply`:
	// one transaction, and a result read from the index's fold of what the
	// frame wrote — `applied` iff the transaction wrote anything (its
	// insert or delete set grew); otherwise `noop`. The plan decides what
	// to write (a same-value attr or format is never planned); the result
	// is observed, never predicted.
	//
	// Each apply opens a frame that tracks the index's folds. When it
	// closes, ONE pass over the facets the fold saw stamps attribution: a
	// block whose registry entry was created gets its `createdBy` record; a block whose content, claims, type or data
	// changed gets a contributor stamp; moves (a record or a slot in a
	// block's sequence) and delete marks stamp nothing. Two intents the effects cannot name are recorded by their
	// steps: a split-born block inherits its source's contributors, and a
	// merge survivor unions the absorbed block's. With no configured
	// `actor` the funnel writes no attribution at all.

	const actorOf = (): AttributionActor | undefined => config.actor?.();
	type Frame = {
		inherit: Map<BlockId, BlockId>;
		/** Each split-born block's boundary (the key of the slots a paste adds at its split). */
		bounds: Map<BlockId, Unit>;
		unions: [into: BlockId, from: BlockId][];
		/** A write whose facets are not the frame's (`RunView.track`'s `quiet`). */
		quiet: (write: () => void) => void;
	};

	/** The frame's one attribution pass over the facets the fold saw it write. */
	const close = (f: Frame, folded: Folded): void => {
		const actor = actorOf();
		if (actor === undefined || !folded.wrote) return;
		const created = new Set<BlockId>();
		const changed = new Set<BlockId>();
		for (const [id, facets] of folded.touched) {
			if (facets.has(ENTRY_FACET) && blockNodeOf(doc, id) !== null) created.add(id);
			else
				for (const facet of facets)
					if (
						!facet.startsWith(DEL_PREFIX) &&
						![ENTRY_FACET, SEQ_FACET, ID, LAST_CHANGED_ATTR].includes(facet)
					)
						changed.add(id);
		}
		// A merge changed its survivor (its claim item, written quietly, is no edit of the text holding it).
		for (const [into] of f.unions) changed.add(into);
		for (const id of created) {
			const node = blockNodeOf(doc, id);
			if (node !== null) BA.stampCreated(doc, node, id, actor.id, f.inherit.get(id));
		}
		for (const id of changed) {
			const node = created.has(id) ? null : blockNodeOf(doc, id);
			if (node !== null) BA.stampChange(doc, node, id, actor.id);
		}
		for (const [into, from] of f.unions) BA.unionContributors(doc, into, from);
	};

	/**
	 * A streamless block gets its own text before the first write that
	 * needs a stream (`ownText`: a writer derived from its dead
	 * incarnation); its attribution record follows the re-minted nonce. A
	 * claim item needs the block's own stream (`claim`); text, any piece of
	 * its display.
	 */
	const needStream = (id: BlockId, claim = false): void => {
		const { own } = modelView(doc);
		if (claim ? own.streamOf(id) !== undefined : (own.display(id) ?? []).length > 0) return;
		const { from, to } = ownText(doc, id);
		BA.retarget(doc, id, from, to);
	};

	/** One planned step, written (the plan decided it; writers never refuse). */
	const writeStep = (w: PlanStep, f: Frame): void => {
		// Delete marks need no view: they write one node.
		if (w.op === 'deleteBlock')
			return w.marks.forEach((id) =>
				blockNodeOf(doc, id)!.setAttr(DEL_PREFIX + doc.clientID, true)
			);
		if (w.op === 'splitBlock' || w.op === 'insertText' || w.op === 'insertInline') needStream(w.id);
		// A claim item goes at the end of the stream of the block merged into.
		if (w.op === 'mergeBlocks') needStream(w.into, true);
		const v = modelView(doc);
		const { blocks, own } = v;
		const node = (id: BlockId) => blockNodeOf(doc, id)!;
		switch (w.op) {
			case 'insertBlocks':
				return insertSpecsAt(
					doc,
					v,
					w.parent,
					w.index,
					w.specs,
					w.split === undefined ? null : (f.bounds.get(w.split) ?? null)
				);
			case 'moveBlocks':
				return moveBlocksTo(
					doc,
					v,
					w.ids,
					w.parent,
					w.index,
					w.side ?? 0,
					w.part ?? 0,
					w.at ?? null
				);
			case 'splitBlock':
				f.inherit.set(w.newId, w.id);
				f.bounds.set(w.newId, writeSplit(doc, w.id, w.offset, w.newId, w.tail, w.parent, w.index));
				return;
			case 'mergeBlocks':
				f.unions.push([w.into, w.from]);
				return f.quiet(() => claimInto(own, w.from, w.into));
			case 'setBlockType':
				return void node(w.id).setAttr(TYPE, w.type);
			case 'patchData':
				return writeData(dataNode(w.id, w.inlineId)!, w.writes);
			case 'insertText':
				return insertIntoText(doc, blocks, own, w.id, w.offset, w.text, w.marks);
			case 'insertInline':
				return insertIntoText(doc, blocks, own, w.id, w.offset, buildInline(w.atom));
			case 'deleteText':
			case 'removeInline':
				return deleteRange(doc, blocks, own, w.id, w.offset, 'length' in w ? w.length : 1);
			case 'formatRange':
				return formatRangeIn(doc, blocks, own, w.id, w.offset, w.length, w.marks);
		}
	};

	/**
	 * Apply a prepared plan: write exactly its steps in one transaction
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
				const f: Frame = { inherit: new Map(), bounds: new Map(), unions: [], quiet: frame.quiet };
				try {
					for (const w of p.writes) writeStep(w, f);
				} catch (error) {
					// The frame would otherwise fold every later commit.
					frame.end();
					throw error;
				}
				const folded = frame.end();
				close(f, folded);
				return folded.wrote ? { status: 'applied', ids: p.ids } : NOOP;
			})
		);
	};

	return {
		write,
		apply,
		/** Disposal is terminal for writes. */
		dispose: (): void => {
			disposed = true;
		},
		disposed: (): boolean => disposed
	};
};

export type WriteFunnel = ReturnType<typeof writeFunnel>;
