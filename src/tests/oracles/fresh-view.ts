/**
 * Test oracle: a FRESH replicated-state view (arch-v2 D9, L10 — moved out of
 * `src/lib/crdt/placement/model.ts`). Production derives every fact from the
 * doc's one index (`text/runs.ts`), folded once per transaction; this is the
 * from-scratch collect it replaced — every registry entry read into a record,
 * the claim graph and stream table computed over all of them, placements
 * resolved, children bucketed — so tests can compare the maintained index against a rebuild.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import {
	childrenIndex,
	documentOrder,
	type BlockId,
	type BlockRec,
	type ModelView
} from '../../lib/crdt/placement/model.js';
import type { Edge } from '../../lib/crdt/placement/resolve.js';
import { resolveAll } from './placements.js';
import { displayIndex } from './index-checks.js';
import {
	bindText,
	claimsIn,
	DEAD,
	deepFreeze,
	delimiters,
	placeText,
	scanText
} from '../../lib/crdt/text/model.js';
import { CONTENT, hasDeleteMark, NONCE, REGISTRY_KEY, TYPE } from '../../lib/crdt/schema.js';
import { cloneJsonSafe } from '../../lib/utils/json.js';
import { readData } from '../../lib/crdt/data.js';
import { engineOps } from '../../lib/crdt/structs.js';
import { Y } from '../../lib/crdt/engine.js';
import type { EngineApi, EngineDoc } from '../../lib/crdt/engine-api.js';

const kept = engineOps(Y).isKeptReplaced;

const isNodeLike = (v: unknown) =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** Read every registry entry into a record map (its claims: the claim items of its stream). */
export const collectBlocks = (doc: EngineDoc): Map<BlockId, BlockRec> => {
	const blocks = new Map<BlockId, BlockRec>();
	doc.get(REGISTRY_KEY).forEachAttr((v: unknown, id: string) => {
		if (!isNodeLike(v)) return;
		const content = v.getAttr(CONTENT);
		const type = v.getAttr(TYPE);
		blocks.set(id, {
			id,
			node: v,
			type: typeof type === 'string' ? type : 'unknown',
			data: readData(v),
			n: v.getAttr(NONCE),
			deleted: hasDeleteMark(v),
			content: isNodeLike(content) ? content : undefined,
			claims: [],
			home: null
		});
	});
	const rows = [...blocks.values()].flatMap((r) => (r.content ? [scanText(r.id, r.content)] : []));
	const delim = delimiters(blocks, rows);
	for (const row of rows)
		for (const st of placeText(row, delim)) blocks.get(st.block)!.claims = claimsIn(row, st);
	// The homes and edges read from the sequences (the cycles need no owners for these).
	const { homes, edges } = resolveAll(doc, blocks, () => DEAD, kept);
	for (const [id, home] of homes) blocks.get(id)!.home = home;
	settleWithdrawn(blocks, edges);
	return blocks;
};

/**
 * `hist.undo.withdraw`, from scratch: a block with a `wd.` mark and no delete
 * mark is deleted unless it holds a live unit in its stream or a child (a
 * block whose display edge names it) that is not deleted — the least
 * fixpoint: every withdrawn block starts deleted and is revived until
 * nothing changes.
 */
const settleWithdrawn = (
	blocks: Map<BlockId, BlockRec>,
	edges: ReadonlyMap<BlockId, Edge | null>
): void => {
	const withdrawn = [...blocks.values()].filter(
		(r) => !r.deleted && [...r.node.attrKeys()].some((k: string) => k.startsWith('wd.'))
	);
	if (withdrawn.length === 0) return;
	const rows = [...blocks.values()].flatMap((r) => (r.content ? [scanText(r.id, r.content)] : []));
	const delim = delimiters(blocks, rows);
	const units = new Map<BlockId, number>();
	for (const row of rows)
		for (const st of placeText(row, delim))
			units.set(st.block, st.end - st.start - st.inert.length);
	for (const r of withdrawn) r.deleted = true;
	for (let changed = true; changed; ) {
		changed = false;
		for (const r of withdrawn) {
			if (!r.deleted) continue;
			const child = [...blocks.values()].some(
				(c) => edges.get(c.id)?.parent === r.id && !c.deleted
			);
			if ((units.get(r.id) ?? 0) > 0 || child) {
				r.deleted = false;
				changed = true;
			}
		}
	}
};

/** The whole view rebuilt from scratch (records, ownership, placements, children, order). */
export const freshView = (Y: EngineApi, doc: EngineDoc): ModelView => {
	const blocks = collectBlocks(doc);
	const base = bindText(Y).computeOwnership(doc, blocks);
	const resolved = resolveAll(doc, blocks, base.ownerOf, kept);
	const placements = resolved.placements;
	// D-18 (`order.split.text`): pieces of one text read in its order by their slots' split keys.
	const own = base;
	const kids = childrenIndex(placements, own);
	const by = displayIndex(blocks, own.ownerOf);
	return {
		blocks,
		own,
		placements,
		kids,
		order: documentOrder(kids),
		intern: (v) => deepFreeze(cloneJsonSafe(v)),
		displays: (owner) => by.get(owner) ?? [],
		accepted: (id) => (resolved.rejected.has(id) ? null : (resolved.edges.get(id) ?? null))
	};
};
