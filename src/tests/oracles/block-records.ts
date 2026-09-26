/**
 * Test oracle: enumerate every `b/<id>` block-attribution record on a doc
 * (arch-v2 L63 — moved out of `src/lib/crdt/attribution/block.ts`, where
 * only tests, the DOM test route and the collab DST runner called it).
 *
 * Records intentionally SURVIVE their block's deletion (a deleted block's
 * recovery ring stays readable), so this is the only way to compare deleted
 * blocks' attribution and lineage across replicas — live-tree walks
 * structurally cannot reach them. O(records).
 */
import type { EngineDoc, EngineNode } from '../../lib/crdt/engine-api.js';
import type { BlockId } from '../../lib/crdt/placement/model.js';
import {
	blockAttributionOf,
	type BlockAttribution,
	type LineageEntry
} from '../../lib/crdt/attribution/block.js';
import { BLOCK_ATTR_ROOT, REC_PREFIX } from '../../lib/crdt/schema.js';

/** Record node name and incarnation key — mirrors `attribution/block.ts`. */
const REC_NODE = 'brec';
const INCARNATION_KEY = 'i';

const isNodeLike = (v: unknown): v is EngineNode =>
	typeof v === 'object' && v !== null && 'getAttr' in (v as EngineNode);

/** One enumerated `b/<id>` record — including records whose block is deleted. */
export type BlockRecord = {
	id: BlockId;
	attribution: BlockAttribution | undefined;
	/** The RAW stored ring (`history()`'s source), not the capped read view. */
	lineage: LineageEntry[] | undefined;
	/** `client:clock` incarnation stamp — distinguishes recycled ids' records. */
	incarnation: string | null;
};

export const blockRecordsOf = (doc: EngineDoc): BlockRecord[] => {
	const root = doc.get(BLOCK_ATTR_ROOT);
	const out: BlockRecord[] = [];
	for (const key of root.attrKeys()) {
		if (!key.startsWith(REC_PREFIX)) continue;
		const rec = root.getAttr(key);
		if (!isNodeLike(rec) || rec.name !== REC_NODE) continue;
		const id = key.slice(REC_PREFIX.length) as BlockId;
		const i = rec.getAttr(INCARNATION_KEY);
		out.push({
			id,
			attribution: blockAttributionOf(doc, id),
			lineage: rec.toArray() as LineageEntry[],
			incarnation: typeof i === 'string' ? i : null
		});
	}
	return out;
};
