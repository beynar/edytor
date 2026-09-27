/**
 * `StreamOps` — the `CrdtOps` adapter for the D11 stream-boundary spike
 * (`src/lib/crdt/streams.next.ts`). Tests only: the switch that runs the
 * scenario corpus against the spike is `harness/ops/backend.ts`, never a
 * production flag. Removed with the spike at D12.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import { bindStreams } from '../../../../lib/crdt/streams.next.js';
import { DEAD } from '../../../../lib/crdt/text/model.js';
import type { Peer } from '../peer-set.js';
import type { CrdtOps } from './crdt-ops.js';

let bound: ReturnType<typeof bindStreams> | null = null;
/** The bound spike (lazily: a missing implementation fails per test, not per file). */
export const spike = (): ReturnType<typeof bindStreams> => (bound ??= bindStreams(Y));

/** Live, self-owned blocks whose display-parent chain reaches the root without a deleted ancestor. */
const expectedProjectedIds = (peer: Peer): Set<string> => {
	const v = spike().view(peer.doc);
	const out = new Set<string>();
	for (const [id, rec] of v.blocks) {
		if (rec.deleted || v.own.hidden(id)) continue;
		let cur = id;
		const seen = new Set([id]);
		let dead = false;
		for (;;) {
			const pl = v.placements.get(cur);
			if (pl === undefined || pl.parent === null) break;
			const dp = v.own.ownerOf(pl.parent);
			if (dp === DEAD) {
				const prec = v.blocks.get(pl.parent);
				dead = prec === undefined || prec.deleted;
				break;
			}
			if (seen.has(dp)) break;
			seen.add(dp);
			cur = dp;
		}
		if (!dead) out.add(id);
	}
	return out;
};

export const createStreamOps = (): CrdtOps & {
	runs: (peer: Peer, id: string) => unknown[];
	contentJSON: (peer: Peer, id: string) => unknown[];
	setInlineData: (peer: Peer, id: string, inlineId: string, data: unknown) => boolean;
} => {
	const S = () => spike();
	const tx =
		<A extends unknown[]>(f: (doc: Peer['doc'], ...a: A) => boolean) =>
		(peer: Peer, ...a: A) =>
			peer.transact(() => f(peer.doc, ...a));
	return {
		name: 'streams-spike',
		preservesIdentityOnMove: true,
		preservesIdentityOnSplitMerge: true,
		insertBlock: tx((d, dest, spec) => S().insertBlock(d, dest, spec)),
		deleteBlock: tx((d, id) => S().deleteBlock(d, id)),
		moveBlock: tx((d, id, dest) => S().moveBlock(d, id, dest)),
		moveBlocks: tx((d, ids, dest) => S().moveBlocks(d, ids, dest)),
		nestBlock: tx((d, id, p) => S().nestBlock(d, id, p)),
		unNestBlock: tx((d, id) => S().unNestBlock(d, id)),
		splitBlock: tx((d, id, o, n) => S().splitBlock(d, id, o, n)),
		mergeBlocks: tx((d, f, i) => S().mergeBlocks(d, f, i)),
		insertText: tx((d, id, o, t, m) => S().insertText(d, id, o, t, m)),
		deleteText: tx((d, id, o, l) => S().deleteText(d, id, o, l)),
		setMark: tx((d, id, o, l, n, v) => S().setMark(d, id, o, l, n, v)),
		unsetMark: tx((d, id, o, l, n) => S().unsetMark(d, id, o, l, n)),
		insertInline: tx((d, id, o, a) => S().insertInline(d, id, o, a)),
		removeInline: tx((d, id, i) => S().removeInline(d, id, i)),
		setInlineData: tx((d, id, i, data) => S().setInlineData(d, id, i, data)),
		project: (peer) => S().project(peer.doc),
		resolveBlock: (peer, id) => S().resolveBlock(peer.doc, id),
		crdtId: (peer, id) => S().crdtId(peer.doc, id),
		blockText: (peer, id) => S().blockText(peer.doc, id),
		listBlockIds: (peer) => S().listBlockIds(peer.doc),
		positionOf: (peer, id) => S().positionOf(peer.doc, id),
		expectedProjectedIds,
		runs: (peer, id) => S().items(peer.doc, id),
		contentJSON: (peer, id) =>
			S()
				.items(peer.doc, id)
				.map((r) =>
					r.kind === 'text'
						? { text: r.text, ...(r.marks && { marks: r.marks }) }
						: { id: r.id, type: r.type, data: r.data ?? {} }
				),
		trackHistory: (peer) => {
			if (peer.undoManager === null) {
				peer.enableUndo({ scope: S().registryOf(peer.doc), captureTimeout: 0 });
			}
		},
		undo: (peer) => void peer.undoManager?.undo(),
		redo: (peer) => void peer.undoManager?.redo()
	};
};
