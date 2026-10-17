/**
 * Placement resolution over the sequences (fork patch YP22): which block a
 * home slot belongs to, each block's display edge (the sequence that shows
 * its slot: its parent's, or its mover record's), and every block's placement
 * from scratch — the greedy acyclic acceptance with the parentless fallback.
 * Pure over replicated state.
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import { Y } from '../engine.js';
import { isNodeLike, REGISTRY_KEY } from '../schema.js';
import { baseIdOf, incarnationId, incarnationsOf, LIVE_WRITERS } from '../incarnations.js';
import { attrItems, engineOps, itemOf, type StoreStruct } from '../structs.js';
import { denseKey, keyBetween } from './keys.js';
import {
	cmpStamp,
	displayedUnits,
	entriesOf,
	isBlockSlot,
	isRecord,
	leftOf,
	stampOf,
	unitOf,
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

/** The entry (a block slot) right before `edge`'s displaying unit in its sequence, with its block. */
export const blockBefore = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: Unit,
	edge: Edge
): { entry: Entry; block: BlockId } | null => {
	const isBlock = (e: Entry) => isBlockSlot(e.value);
	let e: Entry | null;
	if (edge.via !== null) {
		const shown = displayedUnits(doc, edge.via);
		const at = shown.findIndex((x) => x.unit.c === home.c && x.unit.k === home.k);
		const earlier = shown.slice(0, Math.max(at, 0)).filter(isBlock);
		e = earlier.length > 0 ? earlier[earlier.length - 1]! : leftOf(doc, edge.via, 0, isBlock);
	} else e = leftOf(doc, edge.item, edge.offset, isBlock);
	if (e === null) return null;
	const { b } = e.value as { b: BlockId };
	return { entry: e, block: slotOwner(registry, kept, b, e.unit.c) };
};

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
	/** Each block's edge (`null`: no slot), as placed or rejected. */
	edges: Map<BlockId, Edge | null>;
	/** Each block's home slot ({@link homeOf}). */
	homes: Map<BlockId, SlotRef>;
	/** Every block slot by the id it names (`{ b }`), as the sequences hold them. */
	slots: Map<BlockId, SlotRef[]>;
	/** The blocks at the root's tail: their edge rejected (a cycle), or no slot. */
	rejected: Set<BlockId>;
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

/** The block slots of every sequence: by the id they name, and each unit's displayed entry. */
export type Slots = {
	slots: Map<BlockId, SlotRef[]>;
	shown: Map<string, { owner: BlockId | null; e: Entry; i: number }>;
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

/** A unit as the engine's sort hands it: its item and its clock in it. */
type UnitRef = { item: SeqItem; clock: number };

/**
 * The order of two units of different sequences, for the engine's sort of
 * two move records at one origin (fork patch YP22, `_unitOrder`): each
 * unit's chain of slots from the root sequence down — the home slot of the
 * block owning its sequence, that block's parent's, … — compared level by
 * level: in one sequence by position (`sequenceOrder`; in one item by
 * clock), a block's own slot before what stands inside it. Two peers that
 * lift blocks out of nested lists into one gap at once keep the document's
 * order there whatever their client ids (`del.merge.container`). `0` when a
 * chain cannot be
 * read (a sequence no block owns, a block without a slot): the engine falls
 * back to client id. Read from the engine alone (the slots are scanned, never
 * the index), so every replica with the same structs answers alike.
 */
export const unitOrder =
	(doc: EngineDoc) =>
	(a: UnitRef, b: UnitRef): number => {
		const registry = doc.get(REGISTRY_KEY);
		const kept = engineOps(Y).isKeptReplaced;
		let slots: Slots | null = null;
		const chain = (u: UnitRef): UnitRef[] | null => {
			const out = [u];
			for (let node = u.item.parent as EngineNode; node !== registry; ) {
				const owner = ownerOfNode(registry, kept, node);
				if (owner == null) return null;
				slots ??= collectSlots(doc, registryOwners(registry, kept), kept);
				const home = homeOf(registry, kept, slots.slots, owner);
				const at = home === null ? null : unitOf(doc, home);
				if (at === null) return null;
				out.unshift({ item: at.item, clock: home!.k });
				node = at.item.parent as EngineNode;
			}
			return out;
		};
		const x = chain(a);
		const y = chain(b);
		if (x === null || y === null) return 0;
		for (let i = 0; ; i++) {
			const p = x[i];
			const q = y[i];
			if (p === undefined || q === undefined)
				return (p === undefined ? 0 : 1) - (q === undefined ? 0 : 1);
			if (p.item === q.item) {
				if (p.clock !== q.clock) return p.clock - q.clock;
				continue;
			}
			const d = Y.sequenceOrder(p.item, q.item);
			return Number.isNaN(d) ? 0 : d;
		}
	};

/** `doc` sorting two move records of one origin by {@link unitOrder} when their units stand in different sequences (set before anything integrates). */
export const orderingUnits = <D extends object>(doc: D): D => {
	const d = doc as { _unitOrder?: unknown };
	d._unitOrder ??= unitOrder(doc as EngineDoc);
	return doc;
};

/**
 * Every block slot of every sequence (the root's, each block's), each read
 * once: by the id it names (with the sequence its unit stands in), and the
 * entry that shows it, keyed by unit.
 */
export const collectSlots = (
	doc: EngineDoc,
	owners: Iterable<{ id: BlockId; node: EngineNode }>,
	kept: (item: unknown) => boolean
): Slots => {
	const registry = doc.get(REGISTRY_KEY);
	const slots = new Map<BlockId, SlotRef[]>();
	const shown = new Map<string, { owner: BlockId | null; e: Entry; i: number }>();
	const read = (owner: BlockId | null, node: EngineNode): void => {
		let i = 0;
		for (const e of entriesOf(doc, node)) {
			if (!isBlockSlot(e.value)) continue;
			const u = unitOf(doc, e.unit)!;
			const homeNode = e.via === null ? node : (u.item.parent as EngineNode);
			const ref: SlotRef = {
				parent: e.via === null ? owner : (ownerOfNode(registry, kept, homeNode) ?? null),
				c: e.unit.c,
				k: e.unit.k
			};
			const list = slots.get(e.value.b);
			if (list === undefined) slots.set(e.value.b, [ref]);
			else list.push(ref);
			shown.set(`${e.unit.c}:${e.unit.k}`, { owner, e, i: i++ });
		}
	};
	read(null, registry);
	for (const { id, node } of owners) read(id, node);
	return { slots, shown };
};

/**
 * Every block's placement from scratch. Each sequence (the root's, each
 * block's) is read once (`collectSlots`, or the caller's reading): a block
 * slot at home or shown by a record is the block's display edge, keyed
 * densely in sequence order. The edges form a functional graph; its
 * acceptance runs in descending `(priority, client, clock)` (home slots:
 * priority 0) and rejects exactly the oldest edge of each cycle, whose
 * block then shows at the root after the last top-level block (the
 * parentless fallback), the rejected and slotless ones ordered by their
 * stamp. Pure — writes nothing.
 */
export const resolveAll = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean,
	{ slots, shown }: Slots = collectSlots(doc, blocks.values(), kept)
): Resolution => {
	const registry = doc.get(REGISTRY_KEY);
	const edges = new Map<BlockId, Edge | null>();
	const homes = new Map<BlockId, SlotRef>();
	const keys = new Map<BlockId, string>();
	// Each block's home: its writer's slot (the lowest when several), and its edge where that slot shows.
	for (const id of blocks.keys()) {
		const home = homeOf(registry, kept, slots, id);
		if (home === null) continue;
		homes.set(id, home);
		const at = shown.get(`${home.c}:${home.k}`);
		if (at === undefined) continue; // gone, or shown nowhere
		const u = unitOf(doc, home)!;
		edges.set(
			id,
			at.e.via === null
				? {
						parent: at.owner,
						via: null,
						stamp: [HOME, home.c, home.k],
						item: u.item,
						offset: home.k - u.item.id.clock
					}
				: { parent: at.owner, via: at.e.via, stamp: stampOf(at.e.via), item: at.e.via, offset: 0 }
		);
		keys.set(id, denseKey(at.i));
	}
	// Greedy acceptance, the highest stamp first.
	const ordered = [...blocks.keys()]
		.filter((id) => edges.get(id)?.parent !== undefined && edges.get(id) !== null)
		.sort((a, b) => -cmpStamp(edges.get(a)!.stamp, edges.get(b)!.stamp) || (a < b ? -1 : 1));
	const accepted = new Map<BlockId, ResolvedPlacement>();
	const rejected = new Set<BlockId>();
	for (const id of ordered) {
		const edge = edges.get(id)!;
		const parent = edge.parent as BlockId | null;
		if (parent !== null && !blocks.has(parent)) {
			rejected.add(id);
			continue;
		}
		if (cycleThrough(accepted, ownerOf, id, parent) !== null) {
			rejected.add(id);
			continue;
		}
		accepted.set(id, { parent, rank: keys.get(id)!, home: edge.via === null });
	}
	for (const id of blocks.keys()) if (!accepted.has(id) && !rejected.has(id)) rejected.add(id);
	// The tail: after the last top-level key, by stamp then id.
	let last: string | undefined;
	for (const [, pl] of accepted)
		if (pl.parent === null && (last === undefined || pl.rank > last)) last = pl.rank;
	const tail = [...rejected]
		.map((id) => ({ id, stamp: edges.get(id)?.stamp ?? NO_SLOT }))
		.sort(byTail);
	for (const { id } of tail) {
		last = keyBetween(last, undefined);
		accepted.set(id, { parent: null, rank: last, home: false });
	}
	for (const id of blocks.keys()) if (!edges.has(id)) edges.set(id, null);
	return { placements: accepted, edges, homes, slots, rejected };
};

/** {@link resolveAll}'s placements: the oracle the index is checked against. */
export const resolvePlacements = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, BlockRec>,
	ownerOf: (b: BlockId) => Owner,
	kept: (item: unknown) => boolean
): Map<BlockId, ResolvedPlacement> => resolveAll(doc, blocks, ownerOf, kept).placements;

export { isRecord, type Stamp };
