/**
 * Caret anchors on the facade: a display offset bound to the backing text
 * (`anchorAt`), followed through this replica's undo (`followUndo`), and
 * resolved to the block that displays it now (`resolveAnchor`).
 */
import { isLiveIn, type BlockId } from '../placement/model.js';
import { DEAD, displayOf, locate, ownedLength } from '../text/model.js';
import { followRedone } from '../structs.js';
import type { AnchorAffinity, DocAnchor } from './types.js';
import type { DocBase, DocReads } from './reads.js';

/** The anchors of one facade. */
export const docAnchors = (c: DocBase & DocReads) => {
	const { Y, doc, T, view } = c;

	// ── anchors (R4) ─────────────────────────────────────────────────
	// An anchor is the home text id plus a relative position; the stream
	// containing the position says which block displays it. Both reads use
	// the index folded up to the last write, so they hold mid-transaction.

	/**
	 * Display offset in `blockId` → anchor. `'left'` binds the unit before
	 * the position (a caret, a range end: an insert there lands right of
	 * it; at a split-born block's start that unit is the block's boundary),
	 * `'right'` the unit at it (a range start). A streamless block with no
	 * claim binds its own future text's start. `null` for an unknown id.
	 */
	const anchorAt = (
		blockId: BlockId,
		offset: number,
		affinity: AnchorAffinity = 'left'
	): DocAnchor | null => {
		const { blocks, own } = view();
		if (!blocks.has(blockId)) return null;
		// A merged-away or deleted block's items still bind: the anchor
		// follows them to whichever block displays them (or to the seam).
		const segs = displayOf(blockId, blocks, own, undefined, true)!;
		const assoc = affinity === 'left' ? -1 : 0;
		const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))), affinity);
		if (hit === null) return { b: blockId, a: { i: null, a: assoc } };
		return { b: hit.seg.t, a: T.anchorAt(hit.seg.text, hit.idx, assoc) };
	};

	/**
	 * `anchor` rebound to the copy this replica's last undo/redo
	 * re-created of its item (the local `redone` chain): history restores
	 * a selection recorded before a delete through it, so the anchor
	 * binds the restored content instead of its tombstone.
	 */
	const followUndo = (anchor: DocAnchor): DocAnchor => {
		const i = anchor.a.i;
		if (i === null) return anchor;
		const to = followRedone(Y, doc, { client: i.c, clock: i.k });
		return to.client === i.c && to.clock === i.k
			? anchor
			: { ...anchor, a: { ...anchor.a, i: { c: to.client, k: to.clock } } };
	};

	/**
	 * Anchor → `{blockId, offset}` in the block that displays it now: the
	 * position's stream (the one whose delimiting boundary precedes it) and
	 * its display owner. `null` when the item is not integrated yet or the
	 * stream is not displayed (its block deleted or hidden) — the caller
	 * falls back to the seam.
	 */
	const resolveAnchor = (anchor: DocAnchor): { blockId: BlockId; offset: number } | null => {
		const { blocks, own } = view();
		const text = blocks.get(anchor.b)?.content;
		if (text === undefined) {
			// A streamless block's own text does not exist yet: its start.
			return anchor.a.i === null && own.display(anchor.b)?.length === 0
				? { blockId: anchor.b, offset: 0 }
				: null;
		}
		const i = T.resolveAnchor(doc, text, anchor.a);
		if (i === null) return null;
		const s = own.streamAt(anchor.b, i);
		const owner = s === undefined ? DEAD : own.ownerOf(s.block);
		if (typeof owner !== 'string' || !isLiveIn(view(), owner)) return null;
		let offset = 0;
		for (const seg of own.display(owner) ?? []) {
			if (seg.block === s!.block && seg.i0 <= i && i <= seg.i1)
				return { blockId: owner, offset: offset + i - seg.i0 };
			offset += seg.i1 - seg.i0;
		}
		return null;
	};

	return { anchorAt, followUndo, resolveAnchor };
};
