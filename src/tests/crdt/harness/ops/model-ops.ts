/**
 * `ModelOps` — the `CrdtOps` adapter for the U03 placement model
 * (`src/lib/crdt/placement/model.ts` via `bindModel`).
 *
 * Unlike `RawNodeOps` this adapter preserves engine identity across every
 * structural op: moves, nests, splits and merges write placement candidates —
 * no payload is ever copied or rebuilt. `preservesIdentityOnMove` /
 * `preservesIdentityOnSplitMerge` are therefore true, which turns the copy
 * evidence classes (duplicate placement, resurrected delete, lost identity,
 * cycle) into hard failures under this adapter — exactly what U03 must prove.
 *
 * Adapter contract notes:
 *
 * - `Destination.index` uses final-index semantics (counts the destination's
 *   children after removing the moving block when it is already under that
 *   parent) — identical to the raw adapter and the plan's proposed default.
 * - Every mutating op runs inside `peer.transact` so it carries the peer's
 *   local origin (undo tracking). The model's own `doc.transact` calls then
 *   join that outer transaction.
 * - Ops on unresolvable targets return `false`/`null` without mutating;
 *   a local move into the block's own subtree is rejected the same way.
 * - Deletion is an explicit `del` flag that wins over any concurrent
 *   placement — a deleted block's subtree is hidden with it.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../../lib/crdt/index.js';
import { bindText } from '../../../../lib/crdt/text/model.js';
import type { Peer } from '../peer-set.js';
import type { CrdtOps } from './crdt-ops.js';

const M = bindModel(Y);
const T = bindText(Y);

/**
 * Registry-completeness oracle (gate-1 finding #3): the set of block ids the
 * projection MUST contain on this peer — every registry entry that is live
 * (`del` unset), self-owned (not merged away) and whose DISPLAY-parent chain
 * (`owner(placementParent)`, the relation `resolvePlacements` keeps acyclic)
 * reaches the root without passing through a deleted ancestor.
 *
 * A block on a cyclic display chain still counts as expected — a composed
 * cycle is the bug being guarded against, not a hiding policy — so a
 * regression that reintroduces it is flagged `unreachable-block` instead of
 * silently passing. `dead` chain ends are legitimate (deleted ancestor →
 * hidden-with-subtree, MV06b); a 'dead' verdict against a parent that is
 * NOT actually `del`-flagged is itself counted as expected so the
 * discrepancy surfaces rather than being absorbed.
 */
export const expectedProjectedIds = (peer: Peer): Set<string> => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	const expected = new Set<string>();
	for (const [id, rec] of blocks) {
		if (rec.deleted || own.hidden(id)) continue;
		let cur = id;
		const seen = new Set<string>([id]);
		let legitimatelyHidden = false;
		for (;;) {
			const pl = placements.get(cur);
			if (pl === undefined || pl.parent === null) break; // reached the root
			const dp = own.ownerOf(pl.parent);
			if (dp === 'dead') {
				// Deleted/unintegrated ancestor — legitimate hiding only when the
				// parent really is gone or `del`-flagged; a 'dead' verdict on a
				// live parent is an ownership bug, so keep the block expected.
				const prec = blocks.get(pl.parent);
				if (prec === undefined || prec.deleted) legitimatelyHidden = true;
				break;
			}
			if (seen.has(dp)) break; // composed display cycle → still expected
			seen.add(dp);
			cur = dp;
		}
		if (!legitimatelyHidden) expected.add(id);
	}
	return expected;
};

export const createModelOps = (): CrdtOps => ({
	name: 'placement-model',
	preservesIdentityOnMove: true,
	preservesIdentityOnSplitMerge: true,

	insertBlock: (peer, dest, spec) => peer.transact(() => M.insertBlock(peer.doc, dest, spec)),
	deleteBlock: (peer, id) => peer.transact(() => M.deleteBlock(peer.doc, id)),
	moveBlock: (peer, id, dest) => peer.transact(() => M.moveBlock(peer.doc, id, dest)),
	moveBlocks: (peer, ids, dest) => peer.transact(() => M.moveBlocks(peer.doc, ids, dest)),
	nestBlock: (peer, id, newParentId) => peer.transact(() => M.nestBlock(peer.doc, id, newParentId)),
	unNestBlock: (peer, id) => peer.transact(() => M.unNestBlock(peer.doc, id)),
	splitBlock: (peer, id, offset, newId) =>
		peer.transact(() => M.splitBlock(peer.doc, id, offset, newId)),
	mergeBlocks: (peer, fromId, intoId) =>
		peer.transact(() => M.mergeBlocks(peer.doc, fromId, intoId)),

	insertText: (peer, id, offset, text, marks) =>
		peer.transact(() => M.insertText(peer.doc, id, offset, text, marks)),
	deleteText: (peer, id, offset, length) =>
		peer.transact(() => M.deleteText(peer.doc, id, offset, length)),
	setMark: (peer, id, offset, length, name, value) =>
		peer.transact(() => M.setMark(peer.doc, id, offset, length, name, value)),
	unsetMark: (peer, id, offset, length, name) =>
		peer.transact(() => M.unsetMark(peer.doc, id, offset, length, name)),
	insertInline: (peer, id, offset, atom) =>
		peer.transact(() => M.insertInline(peer.doc, id, offset, atom)),
	removeInline: (peer, id, inlineId) => peer.transact(() => M.removeInline(peer.doc, id, inlineId)),

	project: (peer) => M.project(peer.doc),
	resolveBlock: (peer, id) => M.resolveBlock(peer.doc, id),
	crdtId: (peer, id) => M.crdtId(peer.doc, id),
	blockText: (peer, id) => M.blockText(peer.doc, id),
	listBlockIds: (peer) => M.listBlockIds(peer.doc),
	positionOf: (peer, id) => M.positionOf(peer.doc, id),
	expectedProjectedIds
});

/** The bound model itself, for tests that need internals (ranks, candidates). */
export const model = M;
