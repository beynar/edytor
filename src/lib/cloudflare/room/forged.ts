/**
 * Forged writes: what a frame writes or deletes that its sender may not —
 * another writer's per-writer block mark (`room.marks.writer`), the purge
 * horizon (the room's alone), another replica's binding or another user's
 * profile in the attribution root (`room.attribution.trust`). Pure reads of
 * the room document and the frame; `Admission` strips or drops what they
 * find.
 */
import { Y } from '../../crdt/engine.js';
import {
	ATTRIBUTION_ROOT,
	DEL_PREFIX,
	HORIZON_ROOT,
	REGISTRY_KEY,
	WITHDRAW_PREFIX
} from '../../crdt/schema.js';
import type { YDoc } from '../../crdt/index.js';
import type { Decoded, Item, Struct } from './context.js';
import { heldClock, storedStruct, structAt } from './updates.js';

// ── Per-writer marks (H2) ──────────────────────────────────────────

/** The writer `n` of a per-writer block mark key (`del.<n>`, `wd.<n>`), or `null`. */
const markWriter = (key: string | null | undefined): number | null => {
	if (typeof key !== 'string') return null;
	const prefix = key.startsWith(DEL_PREFIX)
		? DEL_PREFIX
		: key.startsWith(WITHDRAW_PREFIX)
			? WITHDRAW_PREFIX
			: null;
	const digits = prefix === null ? '' : key.slice(prefix.length);
	return /^\d{1,16}$/.test(digits) ? Number(digits) : null;
};

/** A frame's structs by client, each run in clock order. */
const runsOf = (structs: Struct[]): Map<number, Struct[]> => {
	const runs = new Map<number, Struct[]>();
	for (const struct of structs) {
		const run = runs.get(struct.id.client) ?? [];
		run.push(struct);
		runs.set(struct.id.client, run);
	}
	return runs;
};

type Id = { client: number; clock: number };
/** Where an item sits: its map key (`null` in a sequence) and its parent (a room type, a root name, or a parent id). */
type Place = { key: string | null; parent: unknown };

const isId = (value: unknown): value is Id =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Id).client === 'number' &&
	typeof (value as Id).clock === 'number' &&
	!('_item' in value);

/**
 * Where the item at `id` sits, held by the room or carried by the frame
 * (`frame`): an encoded map entry with a left origin names neither key nor
 * parent, so it is followed origin to origin to the one that does.
 */
const placeOf = (doc: YDoc, frame: Map<number, Struct[]>, id: Id): Place | null => {
	const seen = new Set<Struct>();
	for (let at: Id | null = id; at !== null; ) {
		const held = storedStruct(doc, at.client, at.clock);
		if (held) return held instanceof Y.Item ? { key: held.parentSub, parent: held.parent } : null;
		const struct = structAt(frame.get(at.client) ?? [], at.clock);
		if (!(struct instanceof Y.Item) || seen.has(struct)) return null;
		seen.add(struct);
		if (struct.parent !== null || struct.parentSub !== null) {
			return { key: struct.parentSub, parent: struct.parent };
		}
		if (struct.rightOrigin !== null || struct.origin === null) return null;
		at = struct.origin;
	}
	return null;
};

/** Is `parent` (a {@link Place}'s) a block node: an entry of the block registry? */
const isBlockNode = (doc: YDoc, frame: Map<number, Struct[]>, parent: unknown): boolean => {
	const registry = doc.share.get(REGISTRY_KEY);
	if (isId(parent)) {
		const node = placeOf(doc, frame, parent);
		return (
			node !== null &&
			node.key !== null &&
			(node.parent === registry || node.parent === REGISTRY_KEY)
		);
	}
	const item = (parent as { _item?: { parent?: unknown } | null } | null)?._item;
	return item?.parent === registry && registry !== undefined;
};

/** Is `parent` (a {@link Place}'s) the purge horizon's root, which only the room writes (H7)? */
const isHorizon = (doc: YDoc, parent: unknown): boolean =>
	parent === HORIZON_ROOT ||
	(parent != null && parent === (doc.share.get(HORIZON_ROOT) as unknown));

/**
 * The clients of a frame (but `skip`) that write a per-writer block mark
 * of another writer: a struct whose key is `del.<n>` or `wd.<n>` on a
 * block node, from a client other than `n` (H2). Only `n` writes its mark.
 * A struct in the purge horizon's root forges the room's (H7).
 */
export const forgedWriters = (doc: YDoc, structs: Struct[], skip: Set<number>): Set<number> => {
	const frame = runsOf(structs);
	const forged = new Set<number>();
	for (const struct of structs) {
		const { client, clock } = struct.id;
		if (!(struct instanceof Y.Item) || skip.has(client) || forged.has(client)) continue;
		if (storedStruct(doc, client, clock) !== null) continue;
		const place = placeOf(doc, frame, struct.id);
		const writer = markWriter(place?.key);
		if (
			(place !== null && isHorizon(doc, place.parent)) ||
			(writer !== null && writer !== client && isBlockNode(doc, frame, place!.parent))
		) {
			forged.add(client);
		}
	}
	return forged;
};

/**
 * Of a frame's deletes, those of live per-writer block marks whose writer
 * the sender may not delete for (`mayDelete`): only `n`'s replicas delete
 * `del.<n>`/`wd.<n>` (H2). A mark deleted with its block node (deleted, or
 * deleted by the same frame) is not one.
 */
export const forgedDeletes = (
	doc: YDoc,
	ds: Decoded['ds'],
	mayDelete: (writer: number) => boolean
): Decoded['ds'] => {
	const forged = Y.createIdSet();
	const registry = doc.share.get(REGISTRY_KEY);
	if (registry === undefined) return forged;
	for (const [client, ranges] of ds.clients) {
		const structs = doc.store.clients.get(client) ?? [];
		const held = heldClock(doc, client);
		for (const { clock, len } of ranges.getIds()) {
			if (clock >= held) continue;
			for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
				const struct = structs[i];
				if (struct.id.clock >= clock + len) break;
				if (!(struct instanceof Y.Item) || struct.deleted) continue;
				// The purge horizon is the room's alone (H7).
				if (!isHorizon(doc, struct.parent)) {
					const writer = markWriter(struct.parentSub);
					if (writer === null || mayDelete(writer)) continue;
					const node = (struct.parent as { _item?: Item | null } | null)?._item;
					if (!node || node.parent !== registry) continue;
					if (node.deleted || ds.has(node.id.client, node.id.clock)) continue;
				}
				const from = Math.max(clock, struct.id.clock);
				forged.add(client, from, Math.min(clock + len, struct.id.clock + struct.length) - from);
			}
		}
	}
	return forged;
};

// ── Attribution trust (`room.attribution.trust`) ────────────────────────

/** A replica's binding to its actor (`c/<client>`) and an actor's profile (`u/<id>`). */
export const BINDING_PREFIX = 'c/';
const PROFILE_PREFIX = 'u/';

/** Is `parent` (a {@link Place}'s, or a held item's) the attribution root? */
const isAttribution = (doc: YDoc, parent: unknown): boolean =>
	parent === ATTRIBUTION_ROOT ||
	(parent != null && parent === (doc.share.get(ATTRIBUTION_ROOT) as unknown));

/** The replica `n` a binding key (`c/<n>`) names, or `null`. */
const boundReplica = (key: string): number | null => {
	const digits = key.slice(BINDING_PREFIX.length);
	return key.startsWith(BINDING_PREFIX) && /^\d{1,16}$/.test(digits) ? Number(digits) : null;
};

/** What a frame writes to the attribution root that the sender may not. */
export type AttributionWrites = {
	/** Entries collected from the frame: another replica's binding, another user's profile. */
	collected: Set<Struct>;
	/** Their keys, for the log. */
	keys: string[];
	/** Bindings of the sender's own replicas to another actor: the room rebinds them. */
	rebind: Set<string>;
};

/**
 * The attribution entries of a frame's new structs (but `skip` clients')
 * that `user` may not write (`room.attribution.trust`): a binding
 * `c/<n>` written under another client id than `n`, or naming another
 * actor for a replica the user does not own (`owns`), and a profile
 * `u/<id>` of another user. A binding that names `n`'s registered owner
 * (`ownerOf`) is kept whoever wrote it: it says what the room holds (a
 * room's own rebinding, relayed to a room that lacks it). A binding of the
 * user's own replica to another actor is applied, and rebound to the user
 * by the room. A relayed id's binding to another actor is collected too
 * (the room cannot tell its author): the author's claim of the id binds
 * it again (`bindOrphan`).
 */
export const attributionWrites = (
	doc: YDoc,
	structs: Struct[],
	skip: Set<number>,
	user: string,
	owns: (client: number) => boolean,
	ownerOf: (client: number) => string | undefined
): AttributionWrites => {
	const writes: AttributionWrites = { collected: new Set(), keys: [], rebind: new Set() };
	const frame = runsOf(structs);
	for (const struct of structs) {
		const { client, clock } = struct.id;
		if (!(struct instanceof Y.Item) || skip.has(client)) continue;
		if (storedStruct(doc, client, clock) !== null) continue;
		const place = placeOf(doc, frame, struct.id);
		if (place === null || place.key === null || !isAttribution(doc, place.parent)) continue;
		const { key } = place;
		let forged = false;
		if (key.startsWith(BINDING_PREFIX)) {
			const content = struct.content.getContent();
			const value = content[content.length - 1];
			const replica = boundReplica(key);
			if (
				replica !== null &&
				typeof value === 'string' &&
				value !== '' &&
				value === ownerOf(replica)
			)
				continue;
			if (replica !== client) forged = true;
			else if (value === user) continue;
			else if (owns(client)) writes.rebind.add(key);
			else forged = true;
		} else if (key.startsWith(PROFILE_PREFIX)) {
			forged = key.slice(PROFILE_PREFIX.length) !== user;
		}
		if (forged) {
			writes.collected.add(struct);
			writes.keys.push(key);
		}
	}
	return writes;
};

/**
 * Of a frame's deletes, those of live attribution entries `user` may not
 * delete, with their keys: a binding of a replica the user does not own
 * (`owns`), a profile of another user (`room.attribution.trust`).
 */
export const forgedAttributionDeletes = (
	doc: YDoc,
	ds: Decoded['ds'],
	user: string,
	owns: (client: number) => boolean
): { ids: Decoded['ds']; keys: string[] } => {
	const ids = Y.createIdSet();
	const keys: string[] = [];
	const root = doc.share.get(ATTRIBUTION_ROOT);
	if (root === undefined) return { ids, keys };
	for (const [client, ranges] of ds.clients) {
		const structs = doc.store.clients.get(client) ?? [];
		const held = heldClock(doc, client);
		for (const { clock, len } of ranges.getIds()) {
			if (clock >= held) continue;
			for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
				const struct = structs[i];
				if (struct.id.clock >= clock + len) break;
				if (!(struct instanceof Y.Item) || struct.deleted) continue;
				if ((struct.parent as unknown) !== root || struct.parentSub === null) continue;
				const key = struct.parentSub;
				const replica = boundReplica(key);
				const allowed = key.startsWith(PROFILE_PREFIX)
					? key.slice(PROFILE_PREFIX.length) === user
					: replica === null || owns(replica);
				if (allowed) continue;
				const from = Math.max(clock, struct.id.clock);
				ids.add(client, from, Math.min(clock + len, struct.id.clock + struct.length) - from);
				keys.push(key);
			}
		}
	}
	return { ids, keys };
};
