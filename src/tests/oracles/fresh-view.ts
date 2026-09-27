/**
 * Test oracle: a FRESH replicated-state view (arch-v2 D9, L10 — moved out of
 * `src/lib/crdt/placement/model.ts`). Production derives every fact from the
 * doc's one index (`text/runs.ts`), folded once per transaction; this is the
 * from-scratch collect it replaced — every registry entry read into a record,
 * ownership computed over all of them, placements resolved, children
 * bucketed — so tests can compare the maintained index against a rebuild.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import {
	candidatesOf,
	childrenIndex,
	displayIndex,
	documentOrder,
	resolvePlacements,
	type BlockId,
	type BlockRec,
	type ModelView
} from '../../lib/crdt/placement/model.js';
import { bindText, deepFreeze, readSliceEntries } from '../../lib/crdt/text/model.js';
import { CONTENT, DATA, hasDeleteMark, REGISTRY_KEY, SLICES, TYPE } from '../../lib/crdt/schema.js';
import { cloneJsonSafe } from '../../lib/utils/json.js';
import type { EngineApi, EngineDoc } from '../../lib/crdt/engine-api.js';

const isNodeLike = (v: unknown) =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** Read every registry entry into a record map. */
export const collectBlocks = (doc: EngineDoc): Map<BlockId, BlockRec> => {
	const blocks = new Map<BlockId, BlockRec>();
	doc.get(REGISTRY_KEY).forEachAttr((v: unknown, id: string) => {
		if (!isNodeLike(v)) return;
		const content = v.getAttr(CONTENT);
		const slices = v.getAttr(SLICES);
		const type = v.getAttr(TYPE);
		const slicesNode = isNodeLike(slices) ? slices : undefined;
		blocks.set(id, {
			id,
			node: v,
			type: typeof type === 'string' ? type : 'unknown',
			data: v.getAttr(DATA),
			deleted: hasDeleteMark(v),
			content: isNodeLike(content) ? content : undefined,
			slicesNode,
			// Legacy rows without a `slices` node are one whole self-slice.
			entries: slicesNode
				? readSliceEntries(slicesNode)
				: [
						{
							payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
							stamp: { c: -1, k: -1 },
							seqIndex: 0
						}
					],
			cands: candidatesOf(v)
		});
	});
	return blocks;
};

/** The whole view rebuilt from scratch (records, ownership, placements, children, order). */
export const freshView = (Y: EngineApi, doc: EngineDoc): ModelView => {
	const blocks = collectBlocks(doc);
	const own = bindText(Y).computeOwnership(doc, blocks);
	const placements = resolvePlacements(blocks, own.ownerOf);
	const kids = childrenIndex(placements, own);
	const by = displayIndex(blocks, own.ownerOf);
	return {
		blocks,
		own,
		placements,
		kids,
		order: documentOrder(kids),
		intern: (v) => deepFreeze(cloneJsonSafe(v)),
		displays: (owner) => by.get(owner) ?? []
	};
};
