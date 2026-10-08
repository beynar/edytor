/**
 * The write funnel: every facade write goes through `write` (disposal and the
 * document's writable guard), and every prepared plan through `apply` — one
 * transaction, its result read from what the transaction wrote, and the
 * frame's one attribution and lineage pass.
 */
import type { BlockId } from '../placement/model.js';
import type { BlockAttributionApi } from '../attribution/block.js';
import type { AttributionActor } from '../attribution/index.js';
import { ENTRY_FACET, type Folded } from '../text/runs.js';
import { AT, DEL_PREFIX, ID, LAST_CHANGED_ATTR, TYPE } from '../schema.js';
import { writeLeaves } from '../data.js';
import type { JSONBlock } from '../../utils/json.js';
import { NOOP } from './plan.js';
import type { EdytorDocConfig, OpResult, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';

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

/** What the write funnel writes with: the reads, the attribution writer and the facade's configuration. */
export type FunnelContext = DocBase &
	DocReads & { BA: BlockAttributionApi; config: EdytorDocConfig };

/** The write funnel of one facade. */
export const writeFunnel = (c: FunnelContext) => {
	const { doc, M, T, runsView, dataNode, blockJSON, view, is, order, BA, config } = c;

	/**
	 * Terminal flag — set by `dispose()`. Mutating ops funnel through
	 * `write`, so gating there covers every facade write + `transact` +
	 * `init` + `createUndoManager`; reads stay dead-safe on purpose
	 * (a stale handle remains inspectable while its doc outlives the
	 * facade — e.g. the document teardown order). D14.
	 */
	let disposed = false;

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
		if (w.op === 'splitBlock' || w.op === 'insertText' || w.op === 'insertInline') needStream(w.id);
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
				return T.claimInto(blocks, own, w.from, w.into);
			case 'setBlockType':
				return void node(w.id).setAttr(TYPE, w.type);
			case 'patchData':
				return writeLeaves(dataNode(w.id, w.inlineId)!, w.leaves);
			case 'insertText':
				return T.insertIntoText(doc, blocks, own, w.id, w.offset, w.text, w.marks);
			case 'insertInline':
				return T.insertIntoText(doc, blocks, own, w.id, w.offset, M.buildInline(w.atom));
			case 'deleteText':
			case 'removeInline':
				return T.deleteRange(doc, blocks, own, w.id, w.offset, 'length' in w ? w.length : 1);
			case 'formatRange':
				return T.formatRangeIn(doc, blocks, own, w.id, w.offset, w.length, w.marks);
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
				try {
					// Lineage captures every target's pre-write state before the
					// first write; destructive steps capture whoever owns `l`.
					for (const w of p.writes) {
						if (w.op === 'deleteBlock') capture(f, w.id, true);
						else if (w.op === 'mergeBlocks') {
							capture(f, w.from, true);
							capture(f, w.into);
						} else if ('id' in w && w.id !== undefined) capture(f, w.id);
					}
					for (const w of p.writes) writeStep(w, f);
				} catch (error) {
					// The frame would otherwise fold every later commit (DR-rest-3).
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
		actorOf,
		lineageDepth,
		lineagePending,
		/** Disposal is terminal for writes. */
		dispose: (): void => {
			disposed = true;
		},
		disposed: (): boolean => disposed
	};
};

export type WriteFunnel = ReturnType<typeof writeFunnel>;
