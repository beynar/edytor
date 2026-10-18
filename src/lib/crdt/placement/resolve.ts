/**
 * Placement reads over the sequences (fork patch YP22): which block a home
 * slot belongs to, each block's display edges (the sequences that can show
 * its slot: its live move records', strongest first, then its parent's), the
 * places of every sequence, and the cycle walk. Which edge a block takes is
 * the index's acceptance (`text/index/placement.ts` `settle`). Pure over
 * replicated state.
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import { isNodeLike, REGISTRY_KEY } from '../schema.js';
import { baseIdOf, incarnationId, incarnationsOf, LIVE_WRITERS } from '../incarnations.js';
import { attrItems, firstItem, itemOf, type StoreStruct } from '../structs.js';
import {
	cmpStamp,
	isBlockSlot,
	isRecord,
	itemAt,
	sameUnit,
	stampOf,
	unitsOf,
	type BlockSlot,
	type Entry,
	type SeqItem,
	type Stamp,
	type Unit
} from './slots.js';
import { DEAD, type Owner } from '../text/model.js';
import type { BlockId } from './model.js';

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
 * item of its displaying unit (the slot's, or the record).
 */
export type Edge = {
	parent: BlockId | null | undefined;
	via: SeqItem | null;
	stamp: Stamp;
	item: SeqItem;
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
 * The owner of the sequence block `home`'s slot shows in as the engine
 * stands — its mover's, else its home's (`undefined`: gone, not arrived, or
 * a node that is no block): the strongest edge's parent without building the
 * edges (`candidatesOf`).
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
 * engine keeps a unit's movers in that order; the first is its mover), then
 * its home slot. A block shows at the
 * first one that closes no cycle (the later move wins); when that is not the
 * first, it is back where it stood before the move a cycle dropped: the
 * record before it, else home. `[]` when the slot is gone or has not arrived.
 * `at`: the slot's item when the caller read it already (a rebuild's
 * collection: no store lookup).
 */
export const candidatesOf = (
	doc: EngineDoc,
	registry: EngineNode,
	kept: (item: unknown) => boolean,
	home: SlotRef,
	at?: SeqItem
): Edge[] => {
	const item = at ?? itemAt(doc, home);
	if (item === null || item.gone === true) return [];
	const out: Edge[] =
		(item.movers as SeqItem[] | null | undefined)
			?.filter((r) => !r.deleted)
			.map((r) => ({
				parent: ownerOfNode(registry, kept, r.parent as EngineNode),
				via: r,
				stamp: stampOf(r),
				item: r
			})) ?? [];
	out.push({ parent: home.parent, via: null, stamp: [HOME, home.c, home.k], item });
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

/** The block slots of every sequence: by the id they name (with each one's item), and each sequence's places in order. */
export type Slots = {
	slots: Map<BlockId, SlotRef[]>;
	items: Map<SlotRef, SeqItem>;
	places: Map<BlockId | null, Entry[]>;
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
 * read once: the slots by the id they name (a slot item's units, moved away
 * or not, none gone), and each sequence's places in order
 * (`positionsOfItem`).
 */
export const collectSlots = (
	doc: EngineDoc,
	owners: Iterable<{ id: BlockId; node: EngineNode }>
): Slots => {
	const slots = new Map<BlockId, SlotRef[]>();
	const items = new Map<SlotRef, SeqItem>();
	const places = new Map<BlockId | null, Entry[]>();
	const read = (owner: BlockId | null, node: EngineNode): void => {
		let list: Entry[] | undefined;
		for (let it = firstItem<SeqItem>(node); it !== null; it = it.right) {
			const here = positionsOfItem(doc, it);
			if (here.length === 0) continue;
			if (list === undefined) places.set(owner, (list = []));
			for (const e of here) {
				list.push(e);
				if (e.via !== null) continue;
				const ref: SlotRef = { parent: owner, c: e.unit.c, k: e.unit.k };
				const b = (e.value as BlockSlot).b;
				const named = slots.get(b);
				if (named === undefined) slots.set(b, [ref]);
				else named.push(ref);
				items.set(ref, it);
			}
		}
	};
	read(null, doc.get(REGISTRY_KEY));
	for (const { id, node } of owners) read(id, node);
	return { slots, items, places };
};

export { isRecord, type Stamp };
