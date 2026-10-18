/**
 * Placement resolution over the sequences (fork patch YP22): which block a
 * home slot belongs to, each block's display edges (the sequences that can
 * show its slot: its live move records', strongest first, then its parent's),
 * and every block's placement from scratch — the greedy acyclic acceptance:
 * the later move wins, and a block a cycle drops is back where it stood.
 * Pure over replicated state.
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import { isNodeLike, REGISTRY_KEY } from '../schema.js';
import { baseIdOf, incarnationId, incarnationsOf, LIVE_WRITERS } from '../incarnations.js';
import { attrItems, firstItem, itemOf, type StoreStruct } from '../structs.js';
import { denseKey, keyBetween } from './keys.js';
import {
	cmpStamp,
	isBlockSlot,
	isRecord,
	itemAt,
	sameUnit,
	stampOf,
	unitOf,
	unitsOf,
	type BlockSlot,
	type Entry,
	type SeqItem,
	type Stamp,
	type Unit
} from './slots.js';
import { DEAD, type Owner } from '../text/model.js';
import type { BlockId, BlockRec, ResolvedPlacement } from './model.js';

/** A block's home slot: the owner of the sequence holding it (`null`: the root) and its unit. */
export type SlotRef = Unit & { parent: BlockId | null };

/** The stamp of a home slot's edge: below every record's. */
const HOME = 0;
/** The stamp of a block with no slot: below every edge (it shows at the root's tail). */
export const NO_SLOT: Stamp = [-1, 0, 0];

/**
 * A block's display edge: the owner of the sequence that shows its slot
 * (`null`: the root; `undefined`: a node that is no block of the document),
 * the record it shows through (`null`: at home), the edge's stamp, and the
 * item and offset of its displaying unit (the slot's, or the record).
 */
export type Edge = {
	parent: BlockId | null | undefined;
	via: SeqItem | null;
	stamp: Stamp;
	item: SeqItem;
	offset: number;
};

/** The registry's current value item for `id` (`undefined`: none). */
type RegistryItem = StoreStruct & {
	id: { client: number; clock: number };
	deleted: boolean;
	parentSub: string | null;
	left: RegistryItem | null;
	right: RegistryItem | null;
	content: { type?: unknown };
};

/**
 * The block a home slot `{ b: id }` written by `client` belongs to: `id`
 * when its registry value is `client`'s, else the losing incarnation
 * `client` wrote (`id.same.concurrent`: each creation wrote its own slot),
 * else `id` (a lone slot).
 */
export const slotOwner = (
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	id: BlockId,
	client: number
): BlockId => {
	const current = attrItems<RegistryItem>(registry).get(id);
	if (current === undefined || current.id.client === client) return id;
	for (let it = current.left; it !== null && it.parentSub === id; it = it.left)
		if (it.id.client === client && it.id.client >= LIVE_WRITERS && kept(it))
			return incarnationId(id, it);
	return id;
};

/**
 * The block whose sequence `node` is (`null`: the registry root), or
 * `undefined` for a node that is no block of the document (an atom, a data
 * root, a seed's losing incarnation).
 */
export const ownerOfNode = (
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	node: EngineNode
): BlockId | null | undefined => {
	if (node === registry) return null;
	const it = itemOf<RegistryItem>(node);
	if (it === null || it.parent !== registry || typeof it.parentSub !== 'string') return undefined;
	if (!it.deleted) return it.parentSub;
	if (!kept(it) || it.id.client < LIVE_WRITERS) return undefined;
	return incarnationId(it.parentSub, it);
};

/**
 * The display edge of the block whose home slot is `home` (`null` when the
 * slot is gone or has not arrived): at home, or at the record that wins
 * its movers, in that record's sequence.
 */
export const edgeOf = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: SlotRef
): Edge | null => {
	const u = unitOf(doc, home);
	if (u === null || u.item.gone === true) return null;
	const r = u.item.mover ?? null;
	if (r === null || r.deleted)
		return {
			parent: home.parent,
			via: null,
			stamp: [HOME, home.c, home.k],
			item: u.item,
			offset: home.k - u.item.id.clock
		};
	return {
		parent: ownerOfNode(registry, kept, r.parent as EngineNode),
		via: r,
		stamp: stampOf(r),
		item: r,
		offset: 0
	};
};

/**
 * The owner of the sequence block `home`'s slot shows in as the engine
 * stands — its mover's, else its home's (`undefined`: gone, not arrived, or
 * a node that is no block): `edgeOf`'s parent without building the edge.
 */
export const edgeParentOf = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: SlotRef
): BlockId | null | undefined => {
	const item = itemAt(doc, home);
	if (item === null || item.gone === true) return undefined;
	const r = item.mover ?? null;
	return r === null || r.deleted
		? home.parent
		: ownerOfNode(registry, kept, r.parent as EngineNode);
};

/**
 * The display edges block `home`'s slot can take, the strongest first: one per
 * live move record naming it, by descending `(priority, client, clock)` (the
 * first is the engine's mover), then its home slot. A block shows at the
 * first one that closes no cycle (the later move wins); when that is not the
 * first, it is back where it stood before the move a cycle dropped: the
 * record before it, else home. `[]` when the slot is gone or has not arrived.
 */
export const candidatesOf = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: SlotRef,
	at: { item: SeqItem; offset: number } | null = null
): Edge[] => {
	let item: SeqItem;
	let offset: number;
	if (at !== null) [item, offset] = [at.item, at.offset];
	else {
		const u = unitOf(doc, home);
		if (u === null) return [];
		[item, offset] = [u.item, home.k - u.item.id.clock];
	}
	if (item.gone === true) return [];
	const homeEdge: Edge = {
		parent: home.parent,
		via: null,
		stamp: [HOME, home.c, home.k],
		item,
		offset
	};
	const movers = item.movers as readonly SeqItem[] | null | undefined;
	if (movers == null || movers.length === 0) return [homeEdge];
	const live = movers.filter((r) => !r.deleted).map((r) => ({ r, stamp: stampOf(r) }));
	live.sort((a, b) => cmpStamp(b.stamp, a.stamp));
	const out: Edge[] = live.map(({ r, stamp }) => ({
		parent: ownerOfNode(registry, kept, r.parent as EngineNode),
		via: r,
		stamp,
		item: r,
		offset: 0
	}));
	out.push(homeEdge);
	return out;
};

/**
 * The block slots that can show in one sequence, in its order, as the index
 * reads it: a slot item's units (moved away or not: a block a cycle sends back
 * home shows there), a live record's units in the order it names them (a
 * block a cycle sends back to an older record shows at it). Which block shows
 * at a position is the index's acceptance; these are the places.
 */
export const positionsOfItem = (doc: EngineDoc, it: SeqItem): Entry[] =>
	unitsOf(doc, it, (_, value) => isBlockSlot(value));

/**
 * The places before unit `home` shown at `edge`, nearest first: the units its
 * record names before it (or its slot item's earlier units), then each item to
 * the left, last place first. The index's order keys walk them to the nearest
 * block that shows where it was found.
 */
export function* slotsBefore(doc: EngineDoc, edge: Edge, home: Unit): Generator<Entry> {
	const own = positionsOfItem(doc, edge.item);
	let at = own.findIndex((e) => sameUnit(e.unit, home));
	if (at < 0) at = edge.via === null ? 0 : own.length;
	for (let j = at - 1; j >= 0; j--) yield own[j]!;
	for (let p = edge.item.left; p !== null; p = p.left) {
		const list = positionsOfItem(doc, p);
		for (let j = list.length - 1; j >= 0; j--) yield list[j]!;
	}
}

/** Where a cycle check walks: the display parent of `at` through the accepted edges. */
type Accepted = ReadonlyMap<BlockId, { parent: BlockId | null }>;

/**
 * The blocks on the cycle a display edge `block → parent` would close
 * through `accepted` edges and the claim owners (`ownerOf`: a live parent's
 * edge is its owner's, a deleted one is walked itself), or `null` when it
 * closes none. The members are `block` and every block whose edge the walk
 * followed.
 */
export const cycleThrough = (
	accepted: Accepted,
	ownerOf: (b: BlockId) => Owner,
	block: BlockId,
	parent: BlockId | null
): BlockId[] | null => {
	const members = [block];
	for (let cur = parent, steps = 0; cur !== null; steps++) {
		const o = ownerOf(cur);
		const at = o === DEAD ? cur : o;
		if (at === block) return members;
		const next = accepted.get(at);
		if (next === undefined || steps > accepted.size) return null;
		members.push(at);
		cur = next.parent;
	}
	return null;
};

/** The order of the blocks at the root's tail (rejected or slotless): by their edge's stamp, then id. */
export const byTail = (
	a: { id: BlockId; stamp: Stamp },
	b: { id: BlockId; stamp: Stamp }
): number => cmpStamp(a.stamp, b.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Everything the from-scratch resolution decides. */
export type Resolution = {
	placements: Map<BlockId, ResolvedPlacement>;
	/** Each block's edge (`null`: no slot): the accepted one, or the strongest when none is. */
	edges: Map<BlockId, Edge | null>;
	/** Each block's home slot ({@link homeOf}). */
	homes: Map<BlockId, SlotRef>;
	/** Every block slot by the id it names (`{ b }`), as the sequences hold them. */
	slots: Map<BlockId, SlotRef[]>;
	/** The blocks shown at an edge below their strongest: a cycle dropped a later move. */
	fallen: Set<BlockId>;
	/** The blocks at the root's tail: every edge closes a cycle, or no slot. */
	rejected: Set<BlockId>;
	/** Each parent's children in order, keyed as `placements` (the index's lists, built once). */
	order: Map<BlockId | null, { id: BlockId; rank: string }[]>;
};

/**
 * The home slot of block `id` among the slots naming its registry id
 * (`slots`: every `{ b }` slot by `b`): the one its writer wrote
 * (`slotOwner`) — the lowest `(client, clock)` when several do (a redo's
 * copy beside the original) — or `null`.
 */
export const homeOf = (
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	slots: ReadonlyMap<BlockId, readonly SlotRef[]>,
	id: BlockId
): SlotRef | null => {
	const base = baseIdOf(id);
	let best: SlotRef | null = null;
	for (const ref of slots.get(base) ?? []) {
		if (slotOwner(registry, kept, base, ref.c) !== id) continue;
		if (best === null || ref.c < best.c || (ref.c === best.c && ref.k < best.k)) best = ref;
	}
	return best;
};

/** A slot unit as the sequences hold it: its sequence's owner (`null`: the root), its item and offset. */
export type SlotAt = { owner: BlockId | null; item: SeqItem; offset: number };

/** One place of a sequence: its entry, and the slot unit it is when at home (`null`: a record's unit). */
export type Place = { e: Entry; at: SlotAt | null };

/** The block slots of every sequence: by the id they name, by unit, and each sequence's places in order. */
export type Slots = {
	slots: Map<BlockId, SlotRef[]>;
	units: Map<string, SlotAt>;
	places: Map<BlockId | null, Place[]>;
};

/** Every registry node and its kept incarnations, with the block id each stands for (the sequences' owners). */
export const registryOwners = (
	registry: EngineNode,
	kept: (item: unknown) => boolean
): { id: BlockId; node: EngineNode }[] => {
	const owners: { id: BlockId; node: EngineNode }[] = [];
	// The registry's live entries, read from its items (one pass, no attr lookups).
	for (const [id, item] of attrItems<RegistryItem>(registry)) {
		if (item.deleted) continue;
		const node = item.content.type;
		if (isNodeLike(node)) owners.push({ id, node });
		owners.push(...incarnationsOf(registry, id, kept));
	}
	return owners;
};

/**
 * Every block slot of every sequence (the root's, each block's), each item
 * read once: the slots by the id they name and by unit (a slot item's units,
 * moved away or not, none gone), and each sequence's places in order
 * (`positionsOfItem`).
 */
export const collectSlots = (
	doc: EngineDoc,
	owners: Iterable<{ id: BlockId; node: EngineNode }>,
	_kept: (item: unknown) => boolean
): Slots => {
	const slots = new Map<BlockId, SlotRef[]>();
	const units = new Map<string, SlotAt>();
	const places = new Map<BlockId | null, Place[]>();
	const read = (owner: BlockId | null, node: EngineNode): void => {
		let list: Place[] | undefined;
		for (let it = firstItem<SeqItem>(node); it !== null; it = it.right) {
			const here = positionsOfItem(doc, it);
			if (here.length === 0) continue;
			if (list === undefined) places.set(owner, (list = []));
			for (const e of here) {
				if (e.via !== null) {
					list.push({ e, at: null });
					continue;
				}
				const ref: SlotRef = { parent: owner, c: e.unit.c, k: e.unit.k };
				const b = (e.value as BlockSlot).b;
				const named = slots.get(b);
				if (named === undefined) slots.set(b, [ref]);
				else named.push(ref);
				const at: SlotAt = { owner, item: it, offset: ref.k - it.id.clock };
				units.set(`${ref.c}:${ref.k}`, at);
				list.push({ e, at });
			}
		}
	};
	read(null, doc.get(REGISTRY_KEY));
	for (const { id, node } of owners) read(id, node);
	return { slots, units, places };
};

/**
 * Every block's placement from scratch. Each sequence (the root's, each
 * block's) is read once (`collectSlots`, or the caller's reading). A block's
 * candidate edges are its live move records, the strongest first, then its
 * home slot (`candidatesOf`); the acceptance runs over every candidate in
 * descending `(priority, client, clock)` (home slots: priority 0) and gives
 * each block the first that closes no cycle through the edges accepted so
 * far: the later move wins, and the block a cycle drops is back where it
 * stood before that move. A block every edge of which closes a cycle (or
 * with no slot) shows at the root after the last top-level block, ordered
 * by its strongest edge's stamp. The children of each parent are keyed
 * densely in its sequence's places (`places`). `knownHomes`: the records'
 * `home` is current (the index keeps it), so it is not read again. Pure —
 * writes nothing.
 */
export const resolveAll = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean,
	collected: Slots = collectSlots(doc, blocks.values(), kept),
	knownHomes = false,
	out: {
		placements?: Map<BlockId, ResolvedPlacement>;
		edges?: Map<BlockId, Edge | null>;
	} = {}
): Resolution => {
	const { slots, units, places } = collected;
	const registry = doc.get(REGISTRY_KEY);
	const edges = out.edges ?? new Map<BlockId, Edge | null>();
	const homes = new Map<BlockId, SlotRef>();
	/** The block whose home each slot unit is. */
	const homeAt = new Map<SlotAt, BlockId>();
	/** Every candidate edge: its block, its stamp's parts (sorted on), its rank among the block's. */
	const all: { id: BlockId; edge: Edge; p: number; c: number; k: number; n: number }[] = [];
	for (const [id, rec] of blocks) {
		const home = knownHomes ? rec.home : homeOf(registry, kept, slots, id);
		if (home === null) continue;
		homes.set(id, home);
		const at = units.get(`${home.c}:${home.k}`);
		if (at !== undefined) homeAt.set(at, id);
		const cands = candidatesOf(doc, registry, kept, home, at ?? null);
		if (cands.length === 0) continue; // gone, or not arrived
		edges.set(id, cands[0]!);
		for (let n = 0; n < cands.length; n++) {
			const edge = cands[n]!;
			all.push({ id, edge, p: edge.stamp[0], c: edge.stamp[1], k: edge.stamp[2], n });
		}
	}
	// Greedy acceptance, the strongest candidate first.
	all.sort(
		(a, b) => b.p - a.p || b.c - a.c || b.k - a.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
	const accepted = out.placements ?? new Map<BlockId, ResolvedPlacement>();
	const fallen = new Set<BlockId>();
	for (const { id, edge, n } of all) {
		if (accepted.has(id)) continue;
		const parent = edge.parent;
		if (parent === undefined || (parent !== null && !blocks.has(parent))) continue;
		if (cycleThrough(accepted, ownerOf, id, parent) !== null) continue;
		accepted.set(id, { parent, rank: '', home: edge.via === null });
		edges.set(id, edge);
		if (n > 0) fallen.add(id);
	}
	const rejected = new Set<BlockId>();
	for (const id of blocks.keys()) if (!accepted.has(id)) rejected.add(id);
	// The keys: each parent's places in order, a block where its accepted edge shows it.
	const order = new Map<BlockId | null, { id: BlockId; rank: string }[]>();
	for (const [owner, list] of places) {
		let i = 0;
		let kids: { id: BlockId; rank: string }[] | undefined;
		for (const { e, at } of list) {
			// A slot at home is the home of the block found with it; a record's unit, its slot's block's.
			const b =
				at !== null
					? homeAt.get(at)
					: slotOwner(registry, kept, (e.value as BlockSlot).b, e.unit.c);
			if (b === undefined) continue;
			const pl = accepted.get(b);
			if (pl === undefined || pl.parent !== owner) continue;
			const edge = edges.get(b)!;
			const home = homes.get(b)!;
			if (edge.via !== e.via || !sameUnit(home, e.unit)) continue;
			pl.rank = denseKey(i++);
			if (kids === undefined) order.set(owner, (kids = []));
			kids.push({ id: b, rank: pl.rank });
		}
	}
	// The tail: after the last top-level key, by the strongest edge's stamp, then id.
	const root = order.get(null);
	let last = root?.[root.length - 1]?.rank;
	const tail = [...rejected]
		.map((id) => ({ id, stamp: edges.get(id)?.stamp ?? NO_SLOT }))
		.sort(byTail);
	for (const { id } of tail) {
		last = keyBetween(last, undefined);
		accepted.set(id, { parent: null, rank: last, home: false });
		let kids = order.get(null);
		if (kids === undefined) order.set(null, (kids = []));
		kids.push({ id, rank: last });
	}
	for (const id of blocks.keys()) if (!edges.has(id)) edges.set(id, null);
	return { placements: accepted, edges, homes, slots, fallen, rejected, order };
};

/** {@link resolveAll}'s placements: the oracle the index is checked against. */
export const resolvePlacements = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean
): Map<BlockId, ResolvedPlacement> => resolveAll(doc, blocks, ownerOf, kept).placements;

export { isRecord, type Stamp };
