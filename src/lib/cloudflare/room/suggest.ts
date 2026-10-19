/**
 * The suggest-only rule (`room.access.suggest`, `sugg.room.suggest`): what a
 * frame of a socket whose user may only suggest may write. Every struct must
 * be a suggestion's, under a client id of that user that is not the socket's
 * own replica (its writes are suggestion writers'):
 *
 * - a suggestion record (an attr of the root `suggest`), and what a record
 *   of its user holds (its attrs, its writer's id lists and operations);
 * - its own binding and profile (the attribution root: the trust rules
 *   check them);
 * - text in a block's backing text (an insertion; a split's boundary; a
 *   merge's claim of a block its user made; a mark next to its user's own
 *   text), and an atom's attrs of an atom its user made;
 * - a block its user made (its registry entry, attrs, children's slots) and
 *   a home slot naming such a block in any block's sequence;
 * - a hold record naming only its user's units (deleting its own text).
 *
 * Anything else strips the client from the frame, as a forged mark does, and
 * a delete of an item another user wrote is dropped. Residuals: a mark both of
 * whose ends touch its user's text covers what lies between them, and its user
 * may delete its own accepted text directly (the room reads no record's
 * decisions). Pure reads of the room document and the frame.
 */
import { Y } from '../../crdt/engine.js';
import {
	ATTRIBUTION_ROOT,
	BLOCK_NODE,
	CONTENT_NODE,
	INLINE_NODE,
	REGISTRY_KEY,
	SUGGEST_ROOT,
	TEXT_DELETES_ROOT
} from '../../crdt/schema.js';
import type { YDoc } from '../../crdt/index.js';
import type { Decoded, Struct } from './context.js';
import { isId } from './forged.js';
import { heldClock, runsOf, storedStruct, structAt } from './updates.js';

type Id = { client: number; clock: number };
type Content = {
	type?: { name?: string };
	key?: string;
	ids?: number[];
	priority?: number;
	getContent?: () => unknown[];
};

/** What a frame of a suggest-only socket may not write: the clients to strip, the deletes to drop. */
export const suggestOnly = (
	doc: YDoc,
	{ structs, ds }: Decoded,
	skip: Set<number>,
	owns: (client: number) => boolean,
	replica: number | null
): { strip: Set<number>; deletes: Decoded['ds'] } => {
	const frame = runsOf(structs);
	const strip = new Set<number>();
	/** The struct at `id`, the room's or the frame's. */
	const at = (id: Id) =>
		(storedStruct(doc, id.client, id.clock) ?? structAt(frame.get(id.client) ?? [], id.clock)) as
			| (Struct & { content: Content })
			| undefined;
	/**
	 * Where the item at `id` sits: its map key (`null` in a sequence) and its
	 * parent, read from the item or, for an encoded one that names neither,
	 * from an origin of it (left, else right: one sequence, or one key).
	 */
	const placeIn = (id: Id): { key: string | null; parent: unknown } | null => {
		const seen = new Set<unknown>();
		for (let next: Id | null = id; next !== null; ) {
			const held = storedStruct(doc, next.client, next.clock);
			if (held) return held instanceof Y.Item ? { key: held.parentSub, parent: held.parent } : null;
			const item = structAt(frame.get(next.client) ?? [], next.clock) as
				| (Struct & {
						origin: Id | null;
						rightOrigin: Id | null;
						parent: unknown;
						parentSub: string | null;
				  })
				| undefined;
			if (!(item instanceof Y.Item) || seen.has(item)) return null;
			seen.add(item);
			if (item.parent !== null || item.parentSub !== null)
				return { key: item.parentSub, parent: item.parent };
			next = item.origin ?? item.rightOrigin;
		}
		return null;
	};
	/** The node (and its item) a place's parent names: a root's name, or a nested node's. */
	const nodeOf = (parent: unknown): { root?: string; name?: string; item?: Id } => {
		if (typeof parent === 'string') return { root: parent };
		if (isId(parent)) {
			const item = at(parent);
			return { name: item?.content?.type?.name, item: item?.id };
		}
		const node = parent as { _item?: { id: Id } | null; name?: string } | null;
		if (!node) return {};
		if (!node._item) {
			const root = [...doc.share].find(([, type]) => type === (parent as unknown))?.[0];
			return { root };
		}
		return { name: node.name, item: node._item.id };
	};
	const registry = () =>
		(doc.share.get(REGISTRY_KEY) as { _map?: Map<string, Struct> } | undefined)?._map;
	/** A block `id` whose node a client of this user made (in the room or the frame). */
	const ownBlock = (id: unknown): boolean => {
		if (typeof id !== 'string') return false;
		const stored = registry()?.get(id);
		if (stored) return owns(stored.id.client);
		return structs.some(
			(s) =>
				s instanceof Y.Item &&
				owns(s.id.client) &&
				placeIn(s.id)?.key === id &&
				nodeOf(placeIn(s.id)?.parent).root === REGISTRY_KEY
		);
	};
	const allowed = (s: Struct & { content: Content }): boolean => {
		const place = placeIn(s.id);
		if (place === null) return false;
		const parent = nodeOf(place.parent);
		const value = s.content.getContent?.()[0] as { b?: unknown; m?: unknown } | undefined;
		if (parent.root === SUGGEST_ROOT || parent.root === ATTRIBUTION_ROOT) return true;
		if (parent.name === 'suggestion') return !!parent.item && owns(parent.item.client);
		if (parent.root === TEXT_DELETES_ROOT) {
			const ids = s.content.ids ?? [];
			return ids.every((v, i) => i % 3 !== 0 || owns(v));
		}
		if (parent.name === CONTENT_NODE) {
			// A mark (a format item: its key and value).
			if (s.content.key !== undefined) {
				const { origin, rightOrigin } = s as unknown as {
					origin: Id | null;
					rightOrigin: Id | null;
				};
				const near = [origin, rightOrigin];
				return near.some((id) => isId(id) && owns(id.client));
			}
			return value?.m === undefined || ownBlock(value.m);
		}
		if (parent.name === INLINE_NODE) return !!parent.item && owns(parent.item.client);
		if (parent.root === REGISTRY_KEY) {
			// A top-level home slot of its own block, or its own block's entry (never another's).
			if (place.key === null) return ownBlock(value?.b);
			const stored = registry()?.get(place.key);
			return !stored || owns(stored.id.client);
		}
		if (parent.name === BLOCK_NODE) {
			if (s.content.priority !== undefined) return false;
			if (place.key === null && value?.b !== undefined) return ownBlock(value.b);
			return !!parent.item && owns(parent.item.client);
		}
		return false;
	};
	for (const s of structs) {
		const { client, clock } = s.id;
		if (!(s instanceof Y.Item) || skip.has(client) || strip.has(client)) continue;
		if (storedStruct(doc, client, clock) !== null) continue;
		if (client === replica || !owns(client) || !allowed(s as Struct & { content: Content }))
			strip.add(client);
	}
	// Deletes of what another user wrote are dropped.
	const deletes = Y.createIdSet();
	for (const [client, ranges] of ds.clients)
		if (!owns(client))
			for (const { clock, len } of ranges.getIds())
				if (clock < heldClock(doc, client)) deletes.add(client, clock, len);
	return { strip, deletes };
};
