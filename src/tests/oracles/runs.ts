/**
 * Test oracle: from-scratch run projection (arch-v2 L63 — moved out of
 * `src/lib/crdt/text/runs.ts`, where only tests and the runs bench called
 * it).
 *
 * `computeAllRuns` recomputes every visible block's runs with no caches —
 * the honest "full recomputation" comparator for benchmarks and the
 * fresh-projection oracle for the maintained run view's equivalence tests.
 * It reuses the production ownership + flatten primitives
 * (`computeOwnership`, `contentItemsOf`), so it is an oracle for the
 * MAINTENANCE layer (invalidation, caching, structural sharing), not for
 * ownership itself.
 */
import type { EngineApi, EngineDoc, EngineNode } from '../../lib/crdt/engine-api.js';
import type { BlockId, ContentItem } from '../../lib/crdt/placement/model.js';
import { REGISTRY_KEY } from '../../lib/crdt/placement/model.js';
import {
	bindText,
	canonKey,
	deepFreeze,
	protectItems,
	readSliceEntries,
	type TextBlockRec
} from '../../lib/crdt/text/model.js';
import type { ContentRun } from '../../lib/crdt/text/runs.js';
import { CONTENT, DEL, SLICES } from '../../lib/crdt/schema.js';
import { cloneJsonSafe } from '../../lib/utils/json.js';

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

const sameMarks = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): boolean => a === b || (a !== undefined && b !== undefined && canonKey(a) === canonKey(b));

/**
 * Canonicalize raw content items into runs: adjacent text items whose mark
 * sets are deep-equal merge into a single run (segment boundaries are not
 * observable at the run layer); inline atoms always stand alone.
 */
export const mergeRuns = (items: readonly (ContentItem | ContentRun)[]): ContentRun[] => {
	const out: ContentRun[] = [];
	for (const item of items) {
		if (item.kind === 'text') {
			const last = out[out.length - 1];
			if (last && last.kind === 'text' && sameMarks(last.marks, item.marks)) {
				(last as { text: string }).text += item.text;
			} else {
				// JSON-payload contract: absent marks, not `marks: undefined`.
				out.push({
					kind: 'text',
					text: item.text,
					...(item.marks === undefined ? {} : { marks: item.marks })
				});
			}
		} else {
			out.push(item as ContentRun);
		}
	}
	return out;
};

export const bindRunsOracle = (Y: EngineApi) => {
	const T = bindText(Y);

	/**
	 * From-scratch baseline: recompute every visible block's runs with no
	 * caches.
	 */
	const computeAllRuns = (doc: EngineDoc): Map<BlockId, readonly ContentRun[]> => {
		// Detached canonical payloads for the oracle — `contentItemsOf`
		// borrows live marks/data refs, so the baseline applies the same
		// R4 freeze a public read would (no shared interner here).
		const freezeClone = <V>(v: V): V => deepFreeze(cloneJsonSafe(v));
		const registry = doc.get(REGISTRY_KEY);
		const blocks = new Map<BlockId, TextBlockRec>();
		registry.forEachAttr((v: unknown, id: string) => {
			if (!isNodeLike(v)) return;
			const slices = v.getAttr(SLICES);
			const slicesNode = isNodeLike(slices) ? slices : undefined;
			const content = v.getAttr(CONTENT);
			blocks.set(id, {
				id,
				deleted: v.getAttr(DEL) !== undefined,
				content: isNodeLike(content) ? content : undefined,
				slicesNode,
				entries: slicesNode
					? readSliceEntries(slicesNode)
					: [
							{
								payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
								stamp: { c: -1, k: -1 },
								seqIndex: 0
							}
						]
			});
		});
		const own = T.computeOwnership(doc, blocks);
		const out = new Map<BlockId, readonly ContentRun[]>();
		for (const [id, rec] of blocks) {
			if (rec.deleted || own.hidden(id)) {
				out.set(id, Object.freeze([]));
				continue;
			}
			const items = T.contentItemsOf(id, blocks, own) as ContentItem[];
			out.set(id, Object.freeze(mergeRuns(protectItems(items, freezeClone))));
		}
		return out;
	};

	return { computeAllRuns };
};
