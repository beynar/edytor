/**
 * The placements from scratch, the greedy way (fork patch YP22) — the oracle
 * the index's placements are checked against (`index-checks.ts`,
 * `fresh-view.ts`, the model oracles). Every candidate edge of every block
 * (its live move records, the strongest first, then its home slot,
 * `candidatesOf`) is accepted in descending `(priority, client, clock)`
 * (home slots: priority 0), each block at the first that closes no cycle
 * through the edges accepted so far: the later move wins, and a block a
 * cycle drops is back where it stood before that move. A block every edge of
 * which closes a cycle (or with no slot) shows at the root after the last
 * top-level block, by its strongest edge's stamp, then id. The children of
 * each parent are keyed densely in their sequence's order.
 *
 * Production decides the same placements another way: the index settles
 * one block at a time (`text/index/placement.ts` `settle`, a cycle dropping
 * its oldest edge, `retryFallen`), whose fixpoint is this acceptance's
 * unique result whatever the order. This rebuild shares production's reads
 * of the engine (the slots, the candidates, the homes), never its acceptance.
 */
import type { EngineDoc, EngineNode } from '../../lib/crdt/engine-api.js';
import { REGISTRY_KEY } from '../../lib/crdt/schema.js';
import { denseKey, keyBetween } from '../../lib/crdt/placement/keys.js';
import {
	candidatesOf,
	collectSlots,
	homeOf,
	slotOwner,
	type Edge,
	type SlotRef
} from '../../lib/crdt/placement/resolve.js';
import { cmpStamp, sameUnit, type BlockSlot, type Stamp } from '../../lib/crdt/placement/slots.js';
import type { BlockId, BlockRec, ResolvedPlacement } from '../../lib/crdt/placement/model.js';
import { DEAD, type Owner } from '../../lib/crdt/text/model.js';

/** Everything the greedy resolution decides. */
export type Resolution = {
	placements: Map<BlockId, ResolvedPlacement>;
	/** Each block's edge (`null`: no slot): the accepted one, or the strongest when none is. */
	edges: Map<BlockId, Edge | null>;
	/** Each block's home slot. */
	homes: Map<BlockId, SlotRef>;
	/** Every block slot by the id it names (`{ b }`), as the sequences hold them. */
	slots: Map<BlockId, SlotRef[]>;
	/** The blocks shown at an edge below their strongest. */
	fallen: Set<BlockId>;
	/** The blocks at the root's tail: every edge closes a cycle, or no slot. */
	rejected: Set<BlockId>;
};

/** Whether the edge `block → parent` closes a cycle through `accepted` and the claim owners. */
const closes = (
	accepted: ReadonlyMap<BlockId, { parent: BlockId | null }>,
	ownerOf: (b: BlockId) => Owner,
	block: BlockId,
	parent: BlockId | null
): boolean => {
	for (let cur = parent, steps = 0; cur !== null && steps <= accepted.size; steps++) {
		const o = ownerOf(cur);
		const at = o === DEAD ? cur : o;
		if (at === block) return true;
		const next = accepted.get(at);
		if (next === undefined) return false;
		cur = next.parent;
	}
	return false;
};

const NO_SLOT: Stamp = [-1, 0, 0];

/** Every block's placement from scratch (see the module comment). Pure — writes nothing. */
export const resolveAll = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean
): Resolution => {
	const { slots, places } = collectSlots(doc, blocks.values());
	const registry = doc.get(REGISTRY_KEY);
	const edges = new Map<BlockId, Edge | null>();
	const homes = new Map<BlockId, SlotRef>();
	const all: { id: BlockId; edge: Edge; n: number }[] = [];
	for (const id of blocks.keys()) {
		const home = homeOf(registry, kept, slots, id);
		if (home === null) continue;
		homes.set(id, home);
		const cands = candidatesOf(doc, registry, kept, home);
		if (cands.length === 0) continue; // gone, or not arrived
		edges.set(id, cands[0]!);
		cands.forEach((edge, n) => all.push({ id, edge, n }));
	}
	// Greedy acceptance, the strongest candidate first.
	all.sort(
		(a, b) => cmpStamp(b.edge.stamp, a.edge.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
	const placements = new Map<BlockId, ResolvedPlacement>();
	const fallen = new Set<BlockId>();
	for (const { id, edge, n } of all) {
		if (placements.has(id)) continue;
		const parent = edge.parent;
		if (parent === undefined || (parent !== null && !blocks.has(parent))) continue;
		if (closes(placements, ownerOf, id, parent)) continue;
		placements.set(id, { parent, rank: '', home: edge.via === null });
		edges.set(id, edge);
		if (n > 0) fallen.add(id);
	}
	const rejected = new Set([...blocks.keys()].filter((id) => !placements.has(id)));
	// The keys: each parent's places in order, a block where its accepted edge shows it.
	let last: string | undefined;
	for (const [owner, list] of places) {
		let i = 0;
		for (const e of list) {
			const b = slotOwner(registry, kept, (e.value as BlockSlot).b, e.unit.c);
			const pl = placements.get(b);
			const home = homes.get(b);
			if (pl === undefined || pl.parent !== owner || rejected.has(b)) continue;
			if (edges.get(b)!.via !== e.via || home === undefined || !sameUnit(home, e.unit)) continue;
			pl.rank = denseKey(i++);
			if (owner === null) last = pl.rank;
		}
	}
	// The tail: after the last top-level key, by the strongest edge's stamp, then id.
	const tail = [...rejected]
		.map((id) => ({ id, stamp: edges.get(id)?.stamp ?? NO_SLOT }))
		.sort((a, b) => cmpStamp(a.stamp, b.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const { id } of tail) {
		last = keyBetween(last, undefined);
		placements.set(id, { parent: null, rank: last, home: false });
	}
	for (const id of blocks.keys()) if (!edges.has(id)) edges.set(id, null);
	return { placements, edges, homes, slots, fallen, rejected };
};

/** {@link resolveAll}'s placements. */
export const resolvePlacements = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean
): Map<BlockId, ResolvedPlacement> => resolveAll(doc, blocks, ownerOf, kept).placements;

/**
 * The display edge of the block whose home slot is `home` as the engine
 * stands (`null` when the slot is gone or has not arrived): its strongest
 * candidate — the record that wins its movers, else home.
 */
export const edgeOf = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: SlotRef
): Edge | null => candidatesOf(doc, registry, kept, home)[0] ?? null;
