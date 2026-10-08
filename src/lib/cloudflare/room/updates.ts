/**
 * Updates and id sets as the room reads them: what a frame writes, what
 * the room holds, what waits for a dependency — pure functions over a
 * room document and a decoded update (no storage, no sockets).
 */
import * as encoding from 'lib0-v14/encoding';
import { Y } from '../../crdt/engine.js';
import type { JSONBlock, JSONDoc, YDoc } from '../../crdt/index.js';
import { ROOM_ORIGIN, type LoadedDocument, type ReplicaOwner } from '../DocumentRoom.js';
import { parseReplica } from './access.js';
import { crdt, type Decoded, type Item, type Struct } from './context.js';

export const stateVector = (doc: YDoc): Map<number, number> =>
	Y.decodeStateVector(Y.encodeStateVector(doc));

/**
 * What `onLoad` returned, as one update and its registry (`null`: none
 * came with it). JSON is seeded into a scratch doc. Any other shape is
 * refused (TypeError) — it would otherwise seed an empty document that
 * `onSave` later writes over the real one.
 */
export const loadedUpdate = (
	found: LoadedDocument,
	seed: (value: JSONDoc) => Uint8Array
): { update: Uint8Array; replicas: ReplicaOwner[] | null } => {
	if (found instanceof Uint8Array) return { update: found, replicas: null };
	if (typeof found === 'object' && found !== null) {
		if ('update' in found && found.update instanceof Uint8Array) {
			const replicas = found.replicas;
			const valid = (owner: ReplicaOwner) =>
				parseReplica(owner?.replica) !== null &&
				typeof owner.user === 'string' &&
				owner.user.length <= 256;
			if (Array.isArray(replicas) && replicas.every(valid))
				return { update: found.update, replicas };
		} else if ('children' in found && Array.isArray(found.children)) {
			return { update: seed(found as JSONDoc), replicas: [] };
		}
	}
	throw new TypeError('onLoad returned neither a JSONDoc, a v14 update nor { update, replicas }');
};

/** The client ids a decoded update writes structs under that `sv` does not hold yet. */
export const newWriters = ({ structs }: Decoded, sv: Map<number, number>): Set<number> => {
	const writers = new Set<number>();
	for (const struct of structs) {
		if (struct instanceof Y.Skip) continue;
		const { client, clock } = struct.id;
		if (clock + struct.length > (sv.get(client) ?? 0)) writers.add(client);
	}
	return writers;
};

/** The next clock of `client` in `doc` (0: it holds none). */
export const heldClock = (doc: YDoc, client: number): number => {
	const last = doc.store.clients.get(client)?.at(-1);
	return last ? last.id.clock + last.length : 0;
};

/**
 * The struct `doc` integrated at `client`/`clock`, or `null` — also where
 * it holds a Skip: the engine integrates a client's later structs past one
 * still waiting and leaves a Skip in its place.
 */
export const storedStruct = (doc: YDoc, client: number, clock: number) => {
	if (clock >= heldClock(doc, client)) return null;
	const structs = doc.store.clients.get(client)!;
	const struct = structs[Y.findIndexSS(structs, clock)];
	return struct instanceof Y.Skip ? null : struct;
};

/** The struct of `run` (one client's, in clock order) at `clock`, or `undefined`. */
export const structAt = (run: Struct[], clock: number): Struct | undefined => {
	for (let lo = 0, hi = run.length - 1; lo <= hi; ) {
		const mid = (lo + hi) >> 1;
		const { id, length } = run[mid];
		if (clock < id.clock) hi = mid - 1;
		else if (clock >= id.clock + length) lo = mid + 1;
		else return run[mid];
	}
	return undefined;
};

/**
 * The map entries that the rewrites among `structs` which `pick` selects
 * replace (a rewrite deletes the entry it replaces: storing that delete
 * without the rewrite would empty the key). A rewrite is an item with a
 * left origin alone, and replaces its origin when that is an entry. The
 * room's record of the origin says; else the frame's — an encoded item
 * names its key only without origins, so one with a left origin alone is
 * of its origin's kind, followed origin to origin. What neither holds,
 * or the frame holds collected, may be an entry.
 */
export const replacedEntries = (doc: YDoc, structs: Struct[], pick: (item: Item) => boolean) => {
	const frame = new Map<number, Struct[]>();
	for (const struct of structs) {
		const run = frame.get(struct.id.client) ?? [];
		run.push(struct);
		frame.set(struct.id.client, run);
	}
	const known = new Map<Struct, boolean>();
	const isEntry = (id: { client: number; clock: number }): boolean => {
		const chain = new Set<Struct>();
		let entry = true;
		for (let at: typeof id | null = id; at !== null; ) {
			const held = storedStruct(doc, at.client, at.clock);
			if (held) {
				entry = held instanceof Y.Item && held.parentSub !== null;
				break;
			}
			const struct = structAt(frame.get(at.client) ?? [], at.clock);
			if (!(struct instanceof Y.Item) || chain.has(struct)) break;
			if (known.has(struct)) {
				entry = known.get(struct)!;
				break;
			}
			chain.add(struct);
			if (struct.parentSub !== null) break;
			if (struct.rightOrigin !== null || struct.origin === null) {
				entry = false;
				break;
			}
			at = struct.origin;
		}
		for (const struct of chain) known.set(struct, entry);
		return entry;
	};
	const replaced = Y.createIdSet();
	for (const struct of structs) {
		if (!(struct instanceof Y.Item) || !pick(struct)) continue;
		const { origin, rightOrigin } = struct;
		if (origin !== null && rightOrigin === null && isEntry(origin)) {
			replaced.add(origin.client, origin.clock, 1);
		}
	}
	return replaced;
};

/**
 * A decoded update without what it carries under `clients`: their structs,
 * and the deletes of the map entries their structs replace, held by the
 * room or not ({@link replacedEntries}); `collected` structs are kept as GC
 * (their clocks stay: the client's later structs apply), less the deletes
 * of the entries they replace. Their other deletes are kept —
 * whoever may write may delete —, of items the room lacks too: those wait
 * for the items (see {@link pendingDeletes}). Less `dropped` deletes.
 */
export const withoutClients = (
	{ structs, ds }: Decoded,
	clients: Set<number>,
	doc: YDoc,
	dropped: Decoded['ds'] = Y.createIdSet(),
	collected: ReadonlySet<Struct> = new Set()
): Uint8Array => {
	const kept = new Map<number, typeof structs>();
	const replaced = replacedEntries(
		doc,
		structs,
		(item) => clients.has(item.id.client) || collected.has(item)
	);
	for (const struct of structs) {
		const { client } = struct.id;
		if (clients.has(client)) continue;
		const run = kept.get(client) ?? [];
		run.push(struct);
		kept.set(client, run);
	}
	// The v1 layout: #clients, then per client #structs, client, first clock, structs.
	const encoder = new Y.UpdateEncoderV1();
	encoding.writeVarUint(encoder.restEncoder, kept.size);
	for (const [client, run] of kept) {
		encoding.writeVarUint(encoder.restEncoder, run.length);
		encoder.writeClient(client);
		encoding.writeVarUint(encoder.restEncoder, run[0].id.clock);
		for (const struct of run) {
			if (collected.has(struct)) {
				// A collected struct keeps its clock as a GC (its info byte, 0, and length).
				encoder.writeInfo(0);
				encoder.writeLen(struct.length);
			} else {
				struct.write(encoder, 0, 0);
			}
		}
	}
	Y.writeIdSet(encoder, Y.diffIdSet(Y.diffIdSet(ds, replaced), dropped));
	return encoder.toUint8Array();
};

/** The next clock per client of `structs`, less `stripped` clients'. */
const carriedClocks = (structs: Struct[], stripped: Set<number>): Map<number, number> => {
	const carried = new Map<number, number>();
	for (const { id, length } of structs) {
		if (stripped.has(id.client)) continue;
		carried.set(id.client, Math.max(carried.get(id.client) ?? 0, id.clock + length));
	}
	return carried;
};

/**
 * Of `ds`, the deletes of items neither the room (integrated: a client's
 * structs past a Skip count) nor the frame's own structs (less `stripped`
 * clients') hold: they would wait.
 */
export const unheldDeletes = (
	{ structs, ds }: Decoded,
	stripped: Set<number>,
	doc: YDoc
): Decoded['ds'] => {
	const carried = carriedClocks(structs, stripped);
	const unheld = Y.createIdSet();
	for (const [client, ranges] of Y.diffIdSet(ds, heldIds(doc, ds)).clients) {
		const held = carried.get(client) ?? 0;
		for (const { clock, len } of ranges.getIds()) {
			const from = Math.max(clock, held);
			if (from < clock + len) unheld.add(client, from, clock + len - from);
		}
	}
	return unheld;
};

/** The content `ds` deletes of what `doc` holds live (an item's length: characters, atoms). */
export const freedBy = (doc: YDoc, ds: Decoded['ds']): number => {
	let freed = 0;
	for (const [client, ranges] of ds.clients) {
		const structs = doc.store.clients.get(client) ?? [];
		const stored = heldClock(doc, client);
		for (const { clock, len } of ranges.getIds()) {
			if (clock >= stored) continue;
			for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
				const struct = structs[i];
				if (struct.id.clock >= clock + len) break;
				if (struct.deleted || struct instanceof Y.Skip) continue;
				freed +=
					Math.min(clock + len, struct.id.clock + struct.length) - Math.max(clock, struct.id.clock);
			}
		}
	}
	return freed;
};

/** How many ranges `ids` holds. */
export const rangeCount = (ids: Decoded['ds']): number => {
	let count = 0;
	for (const ranges of ids.clients.values()) count += ranges.getIds().length;
	return count;
};

/**
 * Whether applying `structs` (less `stripped` clients') took the state
 * vector from `before` to `after` past what they carry: waiting structs
 * they released.
 */
export const releasedWaiting = (
	structs: Struct[],
	stripped: Set<number>,
	before: Map<number, number>,
	after: Map<number, number>
): boolean => {
	const carried = carriedClocks(structs, stripped);
	for (const [client, clock] of after) {
		if (clock > Math.max(before.get(client) ?? 0, carried.get(client) ?? 0)) return true;
	}
	return false;
};

/** The deletes `doc`'s engine holds pending: of items it does not hold yet. */
export const pendingDeletes = (doc: YDoc): Decoded['ds'] =>
	doc.store.pendingDs ? Y.decodeUpdateV2(doc.store.pendingDs).ds : Y.createIdSet();

/** `into` with the ranges of `from` added — of the clients `keep` selects. */
export const addIds = (
	into: Decoded['ds'],
	from: Decoded['ds'],
	keep: (client: number) => boolean = () => true
): Decoded['ds'] => {
	for (const [client, ranges] of from.clients) {
		if (!keep(client)) continue;
		for (const { clock, len } of ranges.getIds()) into.add(client, clock, len);
	}
	return into;
};

/** Whether two byte strings are equal. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A V1 update carrying only `deletes`. */
export const deletesUpdate = (deletes: Decoded['ds']): Uint8Array => {
	const encoder = new Y.UpdateEncoderV1();
	encoding.writeVarUint(encoder.restEncoder, 0); // no structs
	Y.writeIdSet(encoder, deletes);
	return encoder.toUint8Array();
};

/** The engine forgets `ids` of its waiting deletes: it re-reads the others, which wait again. */
export const forgetWaiting = (doc: YDoc, ids: Decoded['ds']) => {
	if (ids.isEmpty()) return;
	const left = Y.diffIdSet(pendingDeletes(doc), ids);
	doc.store.pendingDs = null;
	if (!left.isEmpty()) Y.applyUpdate(doc, deletesUpdate(left), ROOM_ORIGIN);
};

/**
 * The ids of `ds` whose items `doc` integrated (not a Skip) — deleted ones
 * only, with `deleted`.
 */
const heldIds = (doc: YDoc, ds: Decoded['ds'], deleted = false): Decoded['ds'] => {
	const held = Y.createIdSet();
	for (const [client, ranges] of ds.clients) {
		const structs = doc.store.clients.get(client) ?? [];
		const stored = heldClock(doc, client);
		for (const { clock, len } of ranges.getIds()) {
			if (clock >= stored) continue;
			for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
				const struct = structs[i];
				if (struct.id.clock >= clock + len) break;
				if ((deleted && !struct.deleted) || struct instanceof Y.Skip) continue;
				const from = Math.max(clock, struct.id.clock);
				held.add(client, from, Math.min(clock + len, struct.id.clock + struct.length) - from);
			}
		}
	}
	return held;
};

/**
 * The deletes of `ds` that `doc` holds: their items integrated and deleted.
 * A relayer's delete of an item the room holds deleted is stored, even
 * when the delete itself was stripped (a map entry is deleted by the entry
 * that replaces it).
 */
export const heldDeletes = (doc: YDoc, ds: Decoded['ds']): Decoded['ds'] => heldIds(doc, ds, true);

/**
 * `read` with the engine's pending store set aside: what waits for a
 * dependency (structs, deletes of items it lacks) is never part of the
 * stored state — waiting deletes are stored apart, as `pending` records.
 */
export const withoutPending = <T>(doc: YDoc, read: () => T): T => {
	const { store } = doc;
	const held = [store.pendingStructs, store.pendingDs] as const;
	store.pendingStructs = null;
	store.pendingDs = null;
	try {
		return read();
	} finally {
		[store.pendingStructs, store.pendingDs] = held;
	}
};

/**
 * The live document as one update (P2): its healed state — the engine
 * merged what each keystroke wrote and collected deleted content, sparing
 * the text a replica may copy again (`keepCopies`, P11) —, without what
 * waits (`withoutPending`). Memory never runs ahead of storage, so it
 * holds exactly what the stored records hold, collected.
 */
export const liveState = (doc: YDoc): Uint8Array =>
	withoutPending(doc, () => Y.encodeStateAsUpdateV2(doc));

/**
 * A room document's collection rules, before any update applies: it keeps
 * what an editing replica keeps (P11), and the content the last restore
 * deleted while its undo stands (`keep`, `room.history.undo`).
 */
const prepareRoomDoc = (doc: YDoc, keep: () => Decoded['ds'] | null): void => {
	crdt.doc.keepCopies(doc as never);
	const d = doc as unknown as { gcFilter: (it: Item) => boolean };
	const gc = d.gcFilter;
	d.gcFilter = (it) =>
		gc(it) && !(keep()?.intersects(it.id.client, it.id.clock, it.length) ?? false);
};

/** A fresh room document (`prepareRoomDoc`'s collection rules). */
export const roomDoc = (keep: () => Decoded['ds'] | null): YDoc => {
	const doc = crdt.createDoc();
	prepareRoomDoc(doc, keep);
	return doc;
};

/** How many blocks `children` holds, nested ones included. */
export const countBlocks = (children: readonly JSONBlock[]): number =>
	children.reduce((n, block) => n + 1 + countBlocks(block.children ?? []), 0);

/** Admit stored or loaded updates into a room document (`prepareRoomDoc`'s collection rules). */
export const admit = (
	updates: Uint8Array | Array<Uint8Array | { v2: Uint8Array }>,
	name: string,
	keep: () => Decoded['ds'] | null
): YDoc =>
	crdt.admission.admitUpdate(updates, name, { prepare: (doc) => prepareRoomDoc(doc, keep) });
