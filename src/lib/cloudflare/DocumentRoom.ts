/**
 * `DocumentRoom` — the Cloudflare Durable Object that coordinates ONE
 * edytor document (one object per document) over hibernatable
 * WebSockets. Clients are the shipped `WebsocketProvider` /
 * `createWebsocketSync`; the host Worker reaches the room only through
 * {@link routeDocumentSocket}, which authorizes the request and forwards
 * the verified identity in the `X-Edytor-*` headers (and nothing the
 * client sent).
 *
 * Built on the Worker-safe CRDT entry only (`crdt/index.ts` + the vendored
 * engine). Entry point by entry point:
 *
 * - `fetch` (upgrade): read the verified identity, bind the socket's
 *   replica to its user (a replica another user owns is accepted, then
 *   closed `4409`), `ctx.acceptWebSocket` with the identity in the
 *   attachment, then our SyncStep1 (a read-only socket gets the
 *   read-only notice instead) and every present peer.
 * - `webSocketMessage`: ADMIT first — the generation word, then the
 *   identity: a read-only socket's Step2/Update is refused (permission
 *   denied, the socket stays), and new structs under a client id its user
 *   does not own are stripped from the frame (a relay of an id the room
 *   holds nothing of is kept, unowned) — no attribution spoofing, and the
 *   sender's own edits still land. Then the inbound schema refusal
 *   (`sync.applyRemote`, which also judges what the engine holds pending:
 *   a pending forged stamp the update would release is discarded, never
 *   integrated). A refused frame
 *   is never applied, stored or relayed. Every sync message is answered
 *   with `messageSaved` (the room's state vector, and the deletes of the
 *   message it stored), sent after the write (store-before-ack). Presence
 *   is relayed through the instance-free codec, only for the socket's own
 *   replica. Only bytes that do not decode are refused `malformed`
 *   (1008); a storage or engine fault closes the socket 1011 (its
 *   provider redials), after rebuilding the document where it may hold
 *   what storage does not.
 * - every INTEGRATED update is appended to SQLite as one record split into
 *   rows ≤ `maxRowBytes` (2 MB row cap) in one `transactionSync`, then
 *   broadcast; after `compactAfter` update records the rows are replaced
 *   by one snapshot record of the live document's state (its healed
 *   state, deleted content collected: P2), after the message is
 *   acknowledged — never inside the engine's `update` observer, where one
 *   throw would silence every later emit. Memory never runs ahead of
 *   storage: when an append fails, nothing is relayed or acknowledged, the
 *   live doc is rebuilt from the stored rows and the sender's socket is
 *   closed (1011) so its provider reconnects and resends.
 * - a delete of an item the room lacks waits in the engine and is stored
 *   as a `pending` record (not the entries its frame's waiting rewrites
 *   replace: those deletes wait with them, in memory); compaction keeps
 *   the pending records apart, and rewrites them as the deletes still
 *   waiting; a frame that discards a forged stamp drops them. At most
 *   {@link MAX_WAITING_DELETES} ranges wait, stored or in memory: a frame
 *   that would pass it has its waiting deletes dropped (refusal `waiting`,
 *   left out of the ack), the rest applied. Compaction reclaims the
 *   waiting deletes of client ids no user registered and no socket holds;
 *   `dropWaitingDeletes()` every one.
 * - storage format (P5): the generation record says `storage: 'v2'` —
 *   snapshots in the v2 encoding, compressed in place after they are
 *   stored (`compressLater`), inflated at start (`inflate`); update and
 *   pending records stay v1. A container without `storage` (0.1.0-next.22)
 *   is all v1, and its next compaction rewrites it.
 * - a Step2 serves the STORED state: the engine's pending structs (waiting
 *   for a dependency, never stored) are not served.
 * - a frame larger than `maxFrameBytes` (32 MiB) goes out as chunks the
 *   client applies only when complete (`chunkFrame`).
 * - `webSocketClose`/`webSocketError`: the departure the client may not
 *   have announced, read from the attachment (survives hibernation).
 * - constructor: restore from SQLite alone under `blockConcurrencyWhile`
 *   (verify the generation record, merge, `admission.admitUpdate`); a
 *   container that cannot be restored (another generation, a torn record,
 *   a refused `onLoad` payload) refuses every socket (1008); a read of the
 *   rows that fails is the storage's fault, retried at the next dial
 *   (1011). It never throws out of the constructor (the platform would
 *   reset the object on every request).
 *
 * No entry point schedules a timer: each runs under {@link noTimers}
 * (a Durable Object with a pending timer never hibernates). Keepalive is
 * the runtime's: a text `ping` is answered `pong` without waking the
 * object (`ctx.setWebSocketAutoResponse`, installed unless the host set
 * its own pair; `webSocketMessage` answers it otherwise).
 *
 * Extending (subclass it, export the subclass):
 *
 * - `onLoad()` — retrieve: seed a room that stores nothing yet from your
 *   own store (JSON, a v14 update, or `{ update, replicas }` from
 *   `onSave`). Runs before any socket is served; nothing is stored until
 *   it settles.
 * - `onSave(document)` — save: mirror the document to your own store,
 *   `saveAfter` ms after the first unsaved change (a Durable Object alarm,
 *   so hibernation is unaffected; a throw is retried by the platform).
 *   SQLite stays the room's source of truth: acks never wait on `onSave`.
 * - `transact(fn)` — manipulate: edit through the document facade on the
 *   server; persisted and broadcast to every socket like a client's edit
 *   (one transaction, not a rollback: a throw from `fn` keeps its writes).
 *   `read()` returns the document as JSON (both RPC-callable wrappers are
 *   yours to define).
 */
import { DurableObject } from 'cloudflare:workers';
import * as encoding from 'lib0-v14/encoding';
import { Y } from '../crdt/engine.js';
import * as E from '../crdt/index.js';
import { READ_ONLY_DENIAL } from '../crdt/protocols/auth.js';
import {
	isGenerationRecord,
	STORED_GENERATION_RECORD,
	storageOf,
	type StorageFormat
} from '../crdt/protocols/envelope.js';
import { gunzip, isGzip, packed } from '../crdt/storage.js';
import { CLOSE } from '../crdt/providers/room.js';
import type {
	AwarenessEntry,
	DocumentSemanticsConfig,
	EdytorDoc,
	JSONDoc,
	YDoc
} from '../crdt/index.js';

const crdt = E.bindCrdt(Y);
const sync = crdt.sync;

/** Under SQLite-backed Durable Objects' 2 MB row cap, with room for the other columns. */
export const DEFAULT_MAX_ROW_BYTES = 2_000_000 - 4096;
/** Update records before the rows are merged into one snapshot. */
export const DEFAULT_COMPACT_AFTER = 500;
/** ms between the first unsaved change and `onSave`. */
export const DEFAULT_SAVE_AFTER = 2000;
/** Longest wait between the save alarms of a room that cannot read its rows. */
const MAX_SAVE_RETRY = 5 * 60_000;

/**
 * Delete ranges the room keeps waiting for items it does not hold (a
 * relayer's delete of an author's edit a restore lost). Every update the
 * engine applies re-reads them, so they are capped.
 */
export const MAX_WAITING_DELETES = 1024;

/** Refusals kept in `refusals` (the newest); `refusalCounts` counts every one. */
export const MAX_REFUSALS = 100;

/**
 * A client id and the user who owns it (the room's replica registry). An
 * empty `user` marks an id a restore without a registry left unowned: its
 * first authenticated writer claims it.
 */
export type ReplicaOwner = { replica: number; user: string };

/** The document as `onSave` receives it. */
export type SavedDocument = {
	/** The document as JSON. */
	value: JSONDoc;
	/** The full v14 state (`onLoad` takes it back). */
	update: Uint8Array;
	/**
	 * Who owns each client id, read with `update`. Store it beside `update`
	 * and return both from `onLoad`: without it, a restored room cannot
	 * tell which user wrote under which id.
	 */
	replicas: ReplicaOwner[];
};

/** What `onLoad` may return: JSON, a bare v14 update, or `{ update, replicas }` (a `SavedDocument`). */
export type LoadedDocument = JSONDoc | Uint8Array | Pick<SavedDocument, 'update' | 'replicas'>;

/** The transaction origin of the room's own edits (`transact`, `onLoad` seeds). */
export const ROOM_ORIGIN = Symbol('edytor-room');

/**
 * Headers carrying the identity `routeDocumentSocket` verified — never the
 * client's. The user id is percent-encoded (`encodeURIComponent`): a header
 * value is trimmed and cannot carry every character, and a user id is any
 * string.
 */
export const IDENTITY_HEADERS = {
	user: 'X-Edytor-User',
	replica: 'X-Edytor-Replica',
	access: 'X-Edytor-Access'
} as const;

/**
 * Optional knobs (strings, as `vars` arrive): row size, outgoing frame
 * limit and compaction threshold. The defaults are the platform limits.
 */
export type DocumentRoomEnv = {
	EDYTOR_MAX_ROW_BYTES?: string | number;
	EDYTOR_MAX_FRAME_BYTES?: string | number;
	EDYTOR_COMPACT_AFTER?: string | number;
	EDYTOR_SAVE_AFTER?: string | number;
};

/** What a socket is bound to: its verified user, its replica (Yjs client id), its access. */
export type SocketIdentity = {
	user: string;
	/** `null` until bound — by `authorize`, or by the socket's first presence entry. */
	replica: number | null;
	readOnly: boolean;
};

/** A socket's attachment (survives hibernation): its identity and its presence clock. */
export type Attachment = SocketIdentity & { clock: number | null };

export type Refusal = {
	reason:
		| 'generation'
		| 'schema'
		| 'malformed'
		| 'container'
		| 'identity'
		| 'replica'
		| 'read-only'
		// A frame's deletes of items the room lacks, dropped: they would pass
		// MAX_WAITING_DELETES ({ user, ranges }). The rest of the frame applies.
		| 'waiting'
		| 'storage'
		// A fault of the room itself (the engine, a send): the socket is closed 1011.
		| 'internal'
		// Not a refusal: an id a registry-less restore left unowned, claimed ({ replica, user }).
		| 'orphan'
		// Not a refusal: structs under an id the room held nothing of, delivered by
		// another replica ({ replica, user }) and stored unowned.
		| 'relayed';
	detail: unknown;
};

/** `pending`: deletes of items the room does not hold yet (they wait for them). */
type RowKind = 'generation' | 'update' | 'snapshot' | 'pending';
type Row = { kind: RowKind; record: number; part: number; parts: number; bytes: ArrayBuffer };

/**
 * An upgrade accepted and closed at once, so the client reads `code`: a
 * browser sees an HTTP error at the upgrade only as `1006`, which a
 * provider cannot tell from a network failure. Refuse a dial your Worker
 * turns away itself with it: the provider stops at `1008` or `4xxx`
 * (except `4401`, redialed), and redials after anything else (`CLOSE`,
 * `isRefusal` in `crdt/providers/room.ts`).
 */
export const closedSocket = (code: number, reason: string): Response => {
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	server.close(code, reason);
	return new Response(null, { status: 101, webSocket: client });
};

/** The client's bytes do not decode: the only `malformed` refusal. */
class MalformedFrame extends Error {}
/** A SQLite fault outside the append path (the replica registry). */
class StorageFault extends Error {}
/** A stored record missing some of its rows, or one that does not inflate: the container is corrupt, not the read. */
class TornRecord extends Error {
	constructor(detail = 'torn record') {
		super(detail);
	}
}

/** A compressed record this instance has not inflated (only `start` can): the next dial reads it again. */
class CompressedRecord extends Error {
	constructor() {
		super('compressed record not inflated');
	}
}

/** A stored record, reassembled: its kind, record number, bytes, and whether they are v2 (a v2 container's snapshot). */
export type StoredRecord = {
	kind: RowKind;
	record: number;
	bytes: Uint8Array<ArrayBuffer>;
	v2: boolean;
};

/** Decode the client's bytes: a throw is theirs (`malformed`), not the room's. */
const decode = <T>(read: () => T): T => {
	try {
		return read();
	} catch (error) {
		throw new MalformedFrame(String(error));
	}
};

/** Run an entry point with timers forbidden — a pending timer keeps a Durable Object from hibernating. */
export const noTimers = <T>(fn: () => T): T => {
	const g = globalThis as Record<string, unknown>;
	const saved = [g.setTimeout, g.setInterval];
	const forbidden = () => {
		throw new Error('room scheduled a timer (a Durable Object could not hibernate)');
	};
	g.setTimeout = forbidden;
	g.setInterval = forbidden;
	try {
		return fn();
	} finally {
		[g.setTimeout, g.setInterval] = saved;
	}
};

/** A Yjs client id (a non-negative safe integer), or `null`. */
export const parseReplica = (raw: unknown): number | null => {
	const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
	return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** The user id `routeDocumentSocket` encoded into its header, or `null`. */
const readUser = (raw: string | null): string | null => {
	try {
		return raw === null ? null : decodeURIComponent(raw);
	} catch {
		return null;
	}
};

const readIdentity = (headers: Headers): SocketIdentity | null => {
	const user = readUser(headers.get(IDENTITY_HEADERS.user));
	const rawReplica = headers.get(IDENTITY_HEADERS.replica);
	const replica = rawReplica ? parseReplica(rawReplica) : null;
	const access = headers.get(IDENTITY_HEADERS.access);
	if (!user || user.length > 256 || (rawReplica && replica === null)) return null;
	if (access !== 'read' && access !== 'write') return null;
	return { user, replica, readOnly: access === 'read' };
};

const knob = (value: unknown, fallback: number, max = fallback) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** A semantics config as the facade's lookups — own keys only: block types come off the wire. */
const lookups = (semantics: DocumentSemanticsConfig) => {
	const own =
		<T>(table: Record<string, T> = {}) =>
		(type: string): T | undefined =>
			Object.hasOwn(table, type) ? table[type] : undefined;
	const rendersContent = own(semantics.rendersContent);
	return {
		roleOf: own(semantics.roles),
		kinds: () => Object.keys(semantics.roles ?? {}),
		defaultChildOf: own(semantics.defaultChild),
		rendersContent: (type: string) => rendersContent(type) ?? true,
		defaultType: semantics.defaultType
	};
};

const encodeJSON = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** An awareness frame carrying `entries` — no `Awareness` instance involved. */
export const presenceFrame = (entries: AwarenessEntry[]): Uint8Array =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));

/**
 * The store-before-ack frame, sent only once what `doc` holds is stored:
 * its state vector, and the message's `deletes` the room stored (see
 * {@link AttachedDocument.storedDeletes}).
 */
const savedFrame = (doc: YDoc, deletes?: Decoded['ds']): Uint8Array =>
	E.frame(E.messageSaved, (e) => sync.writeSaved(e, doc, deletes, null));

const step1Frame = (doc: YDoc): Uint8Array =>
	E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc));

const updateFrame = (update: Uint8Array): Uint8Array =>
	E.frame(E.messageSync, (e) => sync.writeUpdate(e, update));

/** The read-only notice at the join: a state, not a refusal. */
const readOnlyFrame = (): Uint8Array => E.frame(E.messageAuth, (e) => E.writeReadOnly(e));

/** The denial of a read-only socket's write: it stays, and still syncs. */
const readOnlyDenialFrame = (): Uint8Array =>
	E.frame(E.messageAuth, (e) => E.writePermissionDenied(e, READ_ONLY_DENIAL));

const stateVector = (doc: YDoc): Map<number, number> =>
	Y.decodeStateVector(Y.encodeStateVector(doc));

/**
 * What `onLoad` returned, as one update and its registry (`null`: none
 * came with it). JSON is seeded into a scratch doc. Any other shape is
 * refused (TypeError) — it would otherwise seed an empty document that
 * `onSave` later writes over the real one.
 */
const loadedUpdate = (
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
const newWriters = (
	{ structs }: ReturnType<typeof Y.decodeUpdate>,
	sv: Map<number, number>
): Set<number> => {
	const writers = new Set<number>();
	for (const struct of structs) {
		if (struct instanceof Y.Skip) continue;
		const { client, clock } = struct.id;
		if (clock + struct.length > (sv.get(client) ?? 0)) writers.add(client);
	}
	return writers;
};

type Decoded = ReturnType<typeof Y.decodeUpdate>;

/** The next clock of `client` in `doc` (0: it holds none). */
const heldClock = (doc: YDoc, client: number): number => {
	const last = doc.store.clients.get(client)?.at(-1);
	return last ? last.id.clock + last.length : 0;
};

/**
 * The struct `doc` integrated at `client`/`clock`, or `null` — also where
 * it holds a Skip: the engine integrates a client's later structs past one
 * still waiting and leaves a Skip in its place.
 */
const storedStruct = (doc: YDoc, client: number, clock: number) => {
	if (clock >= heldClock(doc, client)) return null;
	const structs = doc.store.clients.get(client)!;
	const struct = structs[Y.findIndexSS(structs, clock)];
	return struct instanceof Y.Skip ? null : struct;
};

type Struct = Decoded['structs'][number];
type Item = InstanceType<typeof Y.Item>;

/** The struct of `run` (one client's, in clock order) at `clock`, or `undefined`. */
const structAt = (run: Struct[], clock: number): Struct | undefined => {
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
const replacedEntries = (doc: YDoc, structs: Struct[], pick: (item: Item) => boolean) => {
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
 * room or not ({@link replacedEntries}). Their other deletes are kept —
 * whoever may write may delete —, of items the room lacks too: those wait
 * for the items (see {@link pendingDeletes}). Less `dropped` deletes.
 */
const withoutClients = (
	{ structs, ds }: Decoded,
	clients: Set<number>,
	doc: YDoc,
	dropped: Decoded['ds'] = Y.createIdSet()
): Uint8Array => {
	const kept = new Map<number, typeof structs>();
	const replaced = replacedEntries(doc, structs, (item) => clients.has(item.id.client));
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
		for (const struct of run) struct.write(encoder, 0, 0);
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
const unheldDeletes = (
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

/** How many ranges `ids` holds. */
const rangeCount = (ids: Decoded['ds']): number => {
	let count = 0;
	for (const ranges of ids.clients.values()) count += ranges.getIds().length;
	return count;
};

/**
 * Whether applying `structs` (less `stripped` clients') took the state
 * vector from `before` to `after` past what they carry: waiting structs
 * they released.
 */
const releasedWaiting = (
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
const pendingDeletes = (doc: YDoc): Decoded['ds'] =>
	doc.store.pendingDs ? Y.decodeUpdateV2(doc.store.pendingDs).ds : Y.createIdSet();

/** `into` with the ranges of `from` added — of the clients `keep` selects. */
const addIds = (
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

/** Rows grouped into their records, in write order; a record missing rows throws. */
const reassemble = (
	rows: Row[]
): Array<{ kind: RowKind; record: number; bytes: Uint8Array<ArrayBuffer> }> => {
	const byRecord = new Map<number, Row[]>();
	for (const row of rows) {
		const parts = byRecord.get(row.record) ?? [];
		parts.push(row);
		byRecord.set(row.record, parts);
	}
	return [...byRecord.values()].map((parts) => {
		if (parts.length !== parts[0].parts) throw new TornRecord();
		parts.sort((a, b) => a.part - b.part);
		const bytes = new Uint8Array(parts.reduce((n, p) => n + p.bytes.byteLength, 0));
		let at = 0;
		for (const part of parts) {
			bytes.set(new Uint8Array(part.bytes), at);
			at += part.bytes.byteLength;
		}
		return { kind: parts[0].kind, record: parts[0].record, bytes };
	});
};

/** The deletes of the `pending` records among `records`. */
const storedPending = (
	records: Array<{ kind: RowKind; bytes: Uint8Array<ArrayBuffer> }>
): Decoded['ds'] => {
	const pending = records.filter((record) => record.kind === 'pending');
	return pending.length === 0
		? Y.createIdSet()
		: Y.decodeUpdate(Y.mergeUpdates(pending.map((record) => record.bytes))).ds;
};

/** A V1 update carrying only `deletes`. */
const deletesUpdate = (deletes: Decoded['ds']): Uint8Array => {
	const encoder = new Y.UpdateEncoderV1();
	encoding.writeVarUint(encoder.restEncoder, 0); // no structs
	Y.writeIdSet(encoder, deletes);
	return encoder.toUint8Array();
};

/** The engine forgets `ids` of its waiting deletes: it re-reads the others, which wait again. */
const forgetWaiting = (doc: YDoc, ids: Decoded['ds']) => {
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
const heldDeletes = (doc: YDoc, ds: Decoded['ds']): Decoded['ds'] => heldIds(doc, ds, true);

/**
 * `read` with the engine's pending store set aside: what waits for a
 * dependency (structs, deletes of items it lacks) is never part of the
 * stored state — waiting deletes are stored apart, as `pending` records.
 */
const withoutPending = <T>(doc: YDoc, read: () => T): T => {
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

/** A Step2 of what the room STORED: the engine's pending store (never stored) is left out. */
const storedStep2 = (doc: YDoc, sv: Uint8Array): Uint8Array =>
	withoutPending(doc, () => E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, doc, sv)));

/**
 * The live document as one update (P2): its healed state — the engine
 * merged what each keystroke wrote and collected deleted content, sparing
 * the text a replica may copy again (`keepCopies`, P11) —, without what
 * waits (`withoutPending`). Memory never runs ahead of storage, so it
 * holds exactly what the stored records hold, collected.
 */
const liveState = (doc: YDoc): Uint8Array =>
	withoutPending(doc, () => Y.encodeStateAsUpdateV2(doc));

/** A fresh room document: it keeps what an editing replica keeps (P11). */
const roomDoc = (): YDoc => {
	const doc = crdt.createDoc();
	crdt.doc.keepCopies(doc as never);
	return doc;
};

/** Admit stored or loaded updates into a room document (`roomDoc`'s collection rules). */
const admit = (updates: Uint8Array | Array<Uint8Array | { v2: Uint8Array }>, name: string): YDoc =>
	crdt.admission.admitUpdate(updates, name, {
		prepare: (doc) => crdt.doc.keepCopies(doc as never)
	});

/** What {@link attachDocument} (and `DocumentRoom`) takes. */
export type AttachDocumentOptions = {
	/**
	 * Retrieve: the document for a room that stores nothing yet. Return
	 * JSON, `{ update, replicas }` from `onSave` (a bare `update` restores
	 * the content, but not who owns which client id), or nothing for an
	 * empty room. Nothing is stored until it settles, so it is asked again
	 * at each start (and after a throw, at the next dial) until something
	 * is stored. A payload the room refuses (another generation or schema,
	 * undecodable bytes, another shape) refuses every socket (1008).
	 */
	onLoad?: () => Promise<LoadedDocument | null | undefined> | LoadedDocument | null | undefined;
	/**
	 * Save: mirror the document to your own store, `saveAfter` ms after the
	 * first unsaved change, on the object's alarm (a throw is retried by the
	 * platform). Without it no alarm is ever set.
	 */
	onSave?: (document: SavedDocument) => Promise<void> | void;
	/** ms between the first unsaved change and `onSave` (default {@link DEFAULT_SAVE_AFTER}). */
	saveAfter?: number;
	/** Update records before the rows are merged into one snapshot (default {@link DEFAULT_COMPACT_AFTER}). */
	compactAfter?: number;
	/** Largest stored row; can only be lowered (default {@link DEFAULT_MAX_ROW_BYTES}). */
	maxRowBytes?: number;
	/** Largest frame sent whole; can only be lowered (default 32 MiB). */
	maxFrameBytes?: number;
	/** Prefix of the document's SQL tables, beside your own (default `'edytor_'`). */
	tablePrefix?: string;
	/**
	 * The block roles `transact` edits obey — the document semantics your
	 * clients' plugins declare (`defaultType` also names the block an empty
	 * room is seeded with). Default
	 * {@link E.defaultSemantics} (the bundled rich-text, code and image kinds).
	 */
	semantics?: DocumentSemanticsConfig;
};

/** The tag of the document's sockets: other sockets of the object are left to you. */
export const SOCKET_TAG = 'edytor';

/** The 1011 close of a storage fault: the provider redials and resends. */
const STORAGE_FAILURE = 'storage failure';

/** The provider's keepalive text frame, and the room's answer. */
const PING = 'ping';
const PONG = 'pong';

/**
 * One edytor document living in a Durable Object's storage: the room
 * logic, independent of the class that hosts it. Create it with
 * {@link attachDocument} (any Durable Object) or extend `DocumentRoom`.
 * The socket handlers ignore sockets without {@link SOCKET_TAG} and
 * return `false` for them.
 */
export class AttachedDocument {
	readonly ctx: DurableObjectState;
	readonly maxRowBytes: number;
	readonly maxFrameBytes: number;
	readonly compactAfter: number;
	readonly saveAfter: number;
	private live: YDoc | null = null;
	/** Why the stored container was refused (another generation, a torn record, `onLoad`…). */
	failure: Error | null = null;
	/** Latest presence entry per replica, for join snapshots (memory: refills after a wake). */
	presence = new Map<number, AwarenessEntry>();
	/** The newest {@link MAX_REFUSALS} refusals since this instance started (diagnostics; memory only). */
	refusals: Refusal[] = [];
	/** Every refusal since this instance started, by reason. */
	refusalCounts: Partial<Record<Refusal['reason'], number>> = {};
	/** How this instance came to be: a fresh container, or a restore of N stored records. */
	origin: { kind: 'fresh' } | { kind: 'restored'; records: number } = { kind: 'fresh' };
	private nextRecord = 0;
	private updates = 0;
	/** A failed append: the live doc holds what storage does not, until it is rebuilt. */
	private unstored: unknown = null;
	/** Inside `transact`, its commit included (a nested call is refused but while `fn` runs). */
	private transacting = false;
	/** Inside `transact`'s `fn`: a nested call joins the enclosing transaction. */
	private running = false;
	/** Inside a client frame's apply, its events included: the frame's handler settles it. */
	private handling = false;
	/** How the container stores its snapshots (its generation record says; a fresh one: this build's). */
	private format: StorageFormat = 'v2';
	/** The snapshot compression in flight (`compressed()`). */
	private compressing: Promise<unknown> = Promise.resolve();
	/** The raw bytes of the compressed snapshot record (`records` reads it; only `start` can inflate). */
	private inflated: { record: number; bytes: Uint8Array<ArrayBuffer> } | null = null;
	/** The waiting deletes stored as `pending` records (the engine may hold more, in memory). */
	private storedWaiting: Decoded['ds'] = Y.createIdSet();
	/** The failure is the storage's (a failed read, `onLoad`'s store down): the next dial starts again. */
	private retryable = false;
	private readonly sql: SqlStorage;
	private _facade: EdytorDoc | null = null;
	private saveScheduled = false;
	/** Alarms in a row that found the rows unreadable: each re-arms later. */
	private saveRetries = 0;
	private readonly options: AttachDocumentOptions;
	private readonly rowsTable: string;
	private readonly replicasTable: string;
	private _lookups: ReturnType<typeof lookups> | null = null;

	constructor(ctx: DurableObjectState, options: AttachDocumentOptions = {}) {
		this.ctx = ctx;
		this.options = options;
		this.sql = ctx.storage.sql;
		this.maxRowBytes = knob(options.maxRowBytes, DEFAULT_MAX_ROW_BYTES);
		this.maxFrameBytes = knob(options.maxFrameBytes, E.MAX_FRAME_BYTES);
		this.compactAfter = knob(options.compactAfter, DEFAULT_COMPACT_AFTER, 1e9);
		this.saveAfter = knob(options.saveAfter, DEFAULT_SAVE_AFTER, 1e9);
		const prefix = options.tablePrefix ?? 'edytor_';
		if (!/^\w*$/.test(prefix)) throw new Error(`invalid table prefix ${prefix}`);
		this.rowsTable = `${prefix}rows`;
		this.replicasTable = `${prefix}replicas`;
		// The provider pings a silent socket: answer without waking the object.
		if (ctx.setWebSocketAutoResponse && !ctx.getWebSocketAutoResponse?.()) {
			ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		}
		void ctx.blockConcurrencyWhile(() => this.start());
	}

	/**
	 * Restore from storage, or seed from `onLoad`. Never throws: a throw
	 * out of `blockConcurrencyWhile` resets the object on every request.
	 */
	private async start() {
		try {
			// A wake keeps a pending save: re-arming it would push `onSave` back at every wake.
			if (this.options.onSave) this.saveScheduled = (await this.ctx.storage.getAlarm()) !== null;
			await this.inflate();
			noTimers(() => this.load());
			if (this.origin.kind === 'fresh' && this.live !== null) await this.seed();
		} catch (error) {
			this.fail(error, !(error instanceof TornRecord));
		}
	}

	/**
	 * Inflate a compressed snapshot record (P5) for `records`, which reads
	 * synchronously (a rebuild does): decompression is asynchronous, so
	 * only `start` can. One that does not inflate is a corrupt container.
	 */
	private async inflate() {
		this.inflated = null;
		let rows: Row[];
		try {
			rows = this.sql
				.exec<Row>(
					`SELECT kind, record, part, parts, bytes FROM ${this.rowsTable} WHERE kind = 'snapshot' ORDER BY seq`
				)
				.toArray();
		} catch {
			return; // no table yet, or a failed read: `load` reports it
		}
		for (const { record, bytes } of reassemble(rows)) {
			if (!isGzip(bytes)) continue;
			try {
				this.inflated = { record, bytes: (await gunzip(bytes)) as Uint8Array<ArrayBuffer> };
			} catch (error) {
				throw new TornRecord(`snapshot does not inflate: ${String(error)}`);
			}
		}
	}

	/** A read of the rows or `onLoad` failed (storage was down): start again. */
	private async retryStart() {
		if (this.live !== null || !this.retryable) return;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.live === null && this.retryable) await this.start();
		});
	}

	private fail(error: unknown, retryable: boolean) {
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.retryable = retryable;
		this.unstored = null;
		this._facade?.dispose();
		this._facade = null;
		this.live?.destroy();
		this.live = null;
	}

	// ── Server-side access ───────────────────────────────────────────────

	/** The room's block roles, read at first use (a subclass's fields exist by then). */
	private get lookups(): ReturnType<typeof lookups> {
		return (this._lookups ??= lookups(this.options.semantics ?? E.defaultSemantics));
	}

	/** A facade over `doc` obeying the room's block roles (`semantics`). */
	private facadeOf(doc: YDoc): EdytorDoc {
		return crdt.doc.create(doc as never, this.lookups) as EdytorDoc;
	}

	/**
	 * The live document; `null` when the stored container was refused.
	 * Like {@link facade}, reading it first drops a direct write whose
	 * append failed (`heal`, only while the room is idle), so the next
	 * write through it is stored (HX-12).
	 */
	get doc(): YDoc | null {
		noTimers(() => this.heal());
		return this.live;
	}

	/**
	 * The facade over the live document. Read while the room is idle, it
	 * first drops a direct write whose append failed (`heal`), so the next
	 * write through it is stored (GX-09).
	 */
	get facade(): EdytorDoc {
		noTimers(() => this.heal());
		return (this._facade ??= this.facadeOf(this.requireDoc()));
	}

	/**
	 * Inside a room `transact` (its commit included), a client frame's apply
	 * or any transaction's events: a write now could not be stored before
	 * it returns, and a failed append belongs to what is being handled.
	 */
	private get busy(): boolean {
		return this.transacting || this.handling || (this.live?._transactionCleanups.length ?? 0) > 0;
	}

	/**
	 * Manipulate: run `fn` on the facade in one transaction. The edit is
	 * stored, then broadcast to every socket. It is not a rollback, like
	 * every client-side `transact`: when `fn` throws, what it wrote before
	 * the throw is kept (stored and broadcast) and its error is rethrown —
	 * validate before writing, or apply one `facade.prepare.*` plan. When
	 * the append fails, the storage error is thrown instead and nothing is
	 * kept (the live doc is rebuilt from the stored rows). A call inside
	 * `fn` joins the enclosing one. An empty room is first seeded with one
	 * empty block, as a client with no `value` would. Called anywhere else
	 * inside a transaction or its events — a `facade.onChange` subscriber
	 * (of a client's frame or of the room's own `transact`), a
	 * `doc.on('afterAllTransactions')` listener during a frame — it throws
	 * without writing: the engine would queue the write until that one
	 * ends, so it could not be stored before returning (DR-rest-1, HX-04).
	 */
	transact<T>(fn: (facade: EdytorDoc) => T): T {
		if (this.running) return fn(this.facade);
		return noTimers(() => {
			if (this.busy) {
				throw new Error(
					'room transact inside another transaction or its change events: its write could not be stored before it returns; defer it (queueMicrotask)'
				);
			}
			this.heal();
			const doc = this.requireDoc();
			if (!crdt.doc.isInitialized(doc as never)) this.facade.seed([]);
			let result!: T;
			let thrown = null as { error: unknown } | null;
			this.transacting = true;
			try {
				this.facade.transact(() => {
					this.running = true;
					try {
						result = fn(this.facade);
					} finally {
						this.running = false;
					}
				}, ROOM_ORIGIN);
			} catch (error) {
				thrown = { error };
			} finally {
				this.transacting = false;
			}
			// A failed append outranks fn's error: only the stored rows are kept.
			if (this.unstored !== null) {
				const error = this.unstored;
				this.heal();
				throw error;
			}
			this.compactIfDue();
			if (thrown !== null) throw thrown.error;
			return result;
		});
	}

	/** The document as JSON. */
	read(): JSONDoc {
		noTimers(() => this.heal());
		return this.facade.toJSON();
	}

	/**
	 * Runs `onSave` — the object's alarm, `saveAfter` ms after the first
	 * unsaved change. While the rows cannot be read (a retryable failure),
	 * it starts the room again; if that fails too, the save stays due: the
	 * alarm is set again, later at each failure (up to 5 minutes), so the
	 * mirror never silently lags what the room stored.
	 */
	async alarm(): Promise<void> {
		if (!this.options.onSave) return;
		await this.retryStart();
		noTimers(() => this.heal());
		// Set after `start()`, which reads the alarm this handler is running.
		this.saveScheduled = false;
		if (this.live === null) {
			if (!this.retryable) return;
			this.saveScheduled = true;
			const wait = Math.min(this.saveAfter * 2 ** ++this.saveRetries, MAX_SAVE_RETRY);
			return this.ctx.storage.setAlarm(Date.now() + wait);
		}
		this.saveRetries = 0;
		// One synchronous read: the registry matches the state it is saved with.
		const saved = {
			value: this.read(),
			update: Y.encodeStateAsUpdate(this.live),
			replicas: this.sql
				.exec<ReplicaOwner>(`SELECT replica, user FROM ${this.replicasTable} ORDER BY replica`)
				.toArray()
		};
		await this.options.onSave(saved);
	}

	/** The first unsaved change arms the save alarm; a wake keeps one already armed (`start`). */
	private scheduleSave() {
		if (this.saveScheduled || !this.options.onSave) return;
		this.saveScheduled = true;
		void this.ctx.storage.setAlarm(Date.now() + this.saveAfter);
	}

	/**
	 * Generation cutover: drop the stored document (both tables) of a room
	 * whose storage belongs to another edytor generation, and start again
	 * from `onLoad` — reseed it from JSON. Refused for any other room.
	 */
	async reset(): Promise<void> {
		if (!(this.failure instanceof E.GenerationMismatchError)) {
			throw new Error('reset() only replaces a container of another generation');
		}
		await this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM ${this.rowsTable}`);
				this.sql.exec(`DELETE FROM ${this.replicasTable}`);
			});
			this.presence.clear();
			await this.start();
		});
	}

	/**
	 * Seed a fresh room from `onLoad`. Nothing is stored before it settles:
	 * a throw or nothing leaves the room fresh, asked again at the next
	 * start (after a throw, also at the next dial). The payload is admitted
	 * like a stored container, then stored as one snapshot record with its
	 * registry, atomically. The deletes it carries of items it lacks (an
	 * `onSave` mirror holds the waiting ones) are stored apart, as one
	 * `pending` record, as a frame's are: acknowledged by id, reclaimed by
	 * compaction.
	 */
	private async seed() {
		let found: LoadedDocument | null | undefined;
		try {
			found = await this.options.onLoad?.();
		} catch (error) {
			return this.fail(error, true);
		}
		if (found == null) return;
		noTimers(() => {
			let doc: YDoc;
			let replicas: ReplicaOwner[] | null;
			try {
				// JSON is seeded deterministically: a client seeding the same value writes the same update.
				const loaded = loadedUpdate(found, ({ children, data }) => {
					const scratch = crdt.createDoc();
					const facade = this.facadeOf(scratch);
					facade.seed(children, data);
					facade.dispose();
					const update = Y.encodeStateAsUpdate(scratch);
					scratch.destroy();
					return update;
				});
				doc = admit(loaded.update, `room ${this.ctx.id} onLoad`);
				replicas = loaded.replicas;
			} catch (error) {
				return this.fail(error, false);
			}
			const waiting = pendingDeletes(doc);
			const snapshot = liveState(doc);
			let record = -1;
			try {
				this.ctx.storage.transactionSync(() => {
					record = this.insert('snapshot', snapshot);
					if (!waiting.isEmpty()) this.insert('pending', deletesUpdate(waiting));
					// Without a registry, every id with content is left claimable (user
					// ''). As in `register`, an unowned row never replaces an owner a
					// dial registered while the room stayed fresh.
					const owners =
						replicas ?? [...stateVector(doc).keys()].map((replica) => ({ replica, user: '' }));
					for (const { replica, user } of owners) {
						this.sql.exec(
							`INSERT ${user ? 'OR REPLACE' : 'OR IGNORE'} INTO ${this.replicasTable} (replica, user) VALUES (?, ?)`,
							replica,
							user
						);
					}
				});
			} catch (error) {
				return this.fail(error, true);
			}
			this.live?.destroy();
			this.format = STORED_GENERATION_RECORD.storage!;
			this.adopt(doc);
			this.storedWaiting = waiting;
			this.compressLater(record, snapshot);
		});
	}

	// ── Storage ──────────────────────────────────────────────────────────

	/**
	 * Restore the live doc from the stored rows. A read of the rows that
	 * fails is the storage's fault: retryable, the next dial loads again
	 * (at cold start, at a retry, after a rebuild). A container that reads
	 * but cannot be restored (a torn record, another generation, bytes the
	 * engine refuses) is refused for good.
	 */
	private load() {
		this.failure = null;
		this.retryable = false;
		let records: ReturnType<AttachedDocument['records']>;
		try {
			this.sql.exec(
				`CREATE TABLE IF NOT EXISTS ${this.rowsTable} (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					kind TEXT NOT NULL,
					record INTEGER NOT NULL,
					part INTEGER NOT NULL,
					parts INTEGER NOT NULL,
					bytes BLOB NOT NULL
				)`
			);
			this.sql.exec(
				`CREATE TABLE IF NOT EXISTS ${this.replicasTable} (replica INTEGER PRIMARY KEY, user TEXT NOT NULL)`
			);
			this.nextRecord = 0;
			records = this.records();
		} catch (error) {
			return this.fail(error, !(error instanceof TornRecord));
		}
		try {
			if (records.length === 0) {
				// A fresh room: the generation record is written with the first stored record.
				this.origin = { kind: 'fresh' };
				this.format = STORED_GENERATION_RECORD.storage!;
				this.storedWaiting = Y.createIdSet();
				this.adopt(roomDoc());
				return;
			}
			const [generation, ...rest] = records;
			const found = JSON.parse(new TextDecoder().decode(generation.bytes));
			if (generation.kind !== 'generation' || !isGenerationRecord(found)) {
				throw new E.GenerationMismatchError(`room ${this.ctx.id}`, found);
			}
			// Applied in one transaction, never merged first: a merge of the
			// records keeps every keystroke's struct and the deleted content.
			const doc = admit(
				rest.map((record) => (record.v2 ? { v2: record.bytes } : record.bytes)),
				`room ${this.ctx.id}`
			);
			this.format = storageOf(found);
			this.adopt(doc);
			// Every delete the engine holds waiting came from the rows.
			this.storedWaiting = pendingDeletes(doc);
			this.origin = { kind: 'restored', records: rest.length };
			this.updates = rest.filter((record) => record.kind !== 'snapshot').length;
		} catch (error) {
			this.fail(error, false);
		}
	}

	/**
	 * Reassembled logical records in write order (of one kind, with
	 * `only`); a torn record throws. A v2 container's snapshot is v2
	 * (`v2`), inflated when it is stored compressed (P5).
	 */
	records(only?: RowKind): StoredRecord[] {
		const rows = this.sql
			.exec<Row>(
				`SELECT kind, record, part, parts, bytes FROM ${this.rowsTable}${only ? ' WHERE kind = ?' : ''} ORDER BY seq`,
				...(only ? [only] : [])
			)
			.toArray();
		for (const row of rows) this.nextRecord = Math.max(this.nextRecord, row.record + 1);
		const records = reassemble(rows);
		// The container's storage format, from its generation record.
		let format: StorageFormat = 'v1';
		if (records[0]?.kind === 'generation') {
			try {
				const found = JSON.parse(new TextDecoder().decode(records[0].bytes));
				if (isGenerationRecord(found)) format = storageOf(found);
			} catch {
				// `load` refuses it
			}
		}
		return records.map((record) => {
			const v2 = format === 'v2' && record.kind === 'snapshot';
			if (!v2 || !isGzip(record.bytes)) return { ...record, v2 };
			if (this.inflated?.record !== record.record) throw new CompressedRecord();
			return { ...record, bytes: this.inflated.bytes, v2 };
		});
	}

	/**
	 * One logical record split into rows ≤ `maxRowBytes` (callers run it in
	 * a transaction). The first record of an empty container brings the
	 * generation record with it.
	 */
	private insert(kind: RowKind, bytes: Uint8Array): number {
		if (this.nextRecord === 0 && kind !== 'generation') {
			this.insert('generation', encodeJSON(STORED_GENERATION_RECORD));
		}
		const record = this.nextRecord++;
		this.writeRecord(kind, record, bytes);
		return record;
	}

	/** Record `record`'s rows (at the row positions `seqs`, when given). */
	private writeRecord(kind: RowKind, record: number, bytes: Uint8Array, seqs?: number[]) {
		const parts = Math.max(1, Math.ceil(bytes.length / this.maxRowBytes));
		for (let part = 0; part < parts; part++) {
			const row = bytes.slice(part * this.maxRowBytes, (part + 1) * this.maxRowBytes);
			if (seqs) {
				this.sql.exec(
					`INSERT INTO ${this.rowsTable} (seq, kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?, ?)`,
					seqs[part],
					kind,
					record,
					part,
					parts,
					row
				);
			} else {
				this.sql.exec(
					`INSERT INTO ${this.rowsTable} (kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?)`,
					kind,
					record,
					part,
					parts,
					row
				);
			}
		}
	}

	/**
	 * Compress snapshot `record` in place once it is stored (P5): gzip is
	 * asynchronous, and the store-before-ack path is not. Its rows are
	 * rewritten (at their positions) only while it is still the stored
	 * snapshot and only when that shrinks it; the raw bytes stay in memory
	 * (`inflated`) for a rebuild's synchronous read. A platform without
	 * `CompressionStream` keeps it raw.
	 */
	private compressLater(record: number, raw: Uint8Array) {
		const job = packed(raw)
			.then((bytes) =>
				noTimers(() => {
					if (bytes === raw) return;
					const rows = this.sql
						.exec<{
							seq: number;
						}>(
							`SELECT seq FROM ${this.rowsTable} WHERE record = ? AND kind = 'snapshot' ORDER BY part`,
							record
						)
						.toArray();
					// Replaced since (a compaction, a reset): nothing to do.
					if (rows.length !== Math.max(1, Math.ceil(raw.length / this.maxRowBytes))) return;
					this.ctx.storage.transactionSync(() => {
						this.sql.exec(`DELETE FROM ${this.rowsTable} WHERE record = ?`, record);
						this.writeRecord(
							'snapshot',
							record,
							bytes,
							rows.map((row) => row.seq)
						);
					});
					this.inflated = { record, bytes: raw.slice() };
				})
			)
			.catch((error) => this.note({ reason: 'storage', detail: `compression: ${String(error)}` }));
		this.compressing = job;
		this.ctx.waitUntil?.(job);
	}

	/**
	 * Resolves once the snapshot compression in flight, if any, is stored
	 * (P5): a compaction stores its snapshot raw, then compresses it in
	 * place. Wait for it before reading the rows' sizes.
	 */
	async compressed(): Promise<void> {
		await this.compressing;
	}

	/**
	 * Compaction: the rows become the generation record + one chunked
	 * snapshot of the live document's state (P2: the healed state, deleted
	 * content collected but the text a replica may copy again, P11 —
	 * never a merge of the records, which keeps every keystroke's struct
	 * and every deleted character), atomically, + one
	 * `pending` record of the stored deletes still waiting. A waiting delete
	 * of a client id no user registered and no socket holds is reclaimed,
	 * in memory too: nothing can deliver its item (a made-up id) — the
	 * registrations of ids with waiting deletes are kept. The registry
	 * keeps the ids holding content and those bound to an open socket; the
	 * others (page loads that never wrote) are dropped, and re-register at
	 * their next dial or write. Runs by itself after `compactAfter` update
	 * records; callable over RPC (e.g. from the host's own alarm).
	 */
	compact(): { rows: number } {
		return noTimers(() => {
			this.heal();
			const doc = this.requireDoc();
			// Only the waiting deletes are read back: the snapshot is the live doc.
			const pending = this.records('pending');
			// The live state, never a merge of the records (P2): memory never
			// runs ahead of storage, so it is what they hold, collected.
			const snapshot = liveState(doc);
			const sockets = new Set<number>();
			for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
				const replica = (ws.deserializeAttachment() as Attachment | null)?.replica;
				if (replica != null) sockets.add(replica);
			}
			const registered = this.sql
				.exec<{ replica: number }>(`SELECT replica FROM ${this.replicasTable}`)
				.toArray()
				.map(({ replica }) => replica);
			const known = new Set([...registered, ...sockets]);
			// Waiting deletes stay apart (a discarded forgery drops them,
			// `settleDeletes`): the stored ones the engine still holds waiting.
			const all = pendingDeletes(doc);
			const stored = storedPending(pending);
			const waiting = Y.diffIdSet(stored, Y.diffIdSet(stored, all));
			const still = addIds(Y.createIdSet(), waiting, (client) => known.has(client));
			// Memory never runs ahead of storage: the live state vector is the stored one.
			const kept = new Set([...stateVector(doc).keys(), ...sockets, ...still.clients.keys()]);
			let record = -1;
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM ${this.rowsTable}`);
				// The container is now this build's format (a v1 one migrates here).
				this.insert('generation', encodeJSON(STORED_GENERATION_RECORD));
				record = this.insert('snapshot', snapshot);
				if (!still.isEmpty()) this.insert('pending', deletesUpdate(still));
				for (const replica of registered) {
					if (!kept.has(replica)) {
						this.sql.exec(`DELETE FROM ${this.replicasTable} WHERE replica = ?`, replica);
					}
				}
			});
			this.updates = 0;
			this.format = STORED_GENERATION_RECORD.storage!;
			this.storedWaiting = still;
			this.compressLater(record, snapshot);
			// Unknown ids' deletes go, the ones waiting in memory with a rewrite too.
			forgetWaiting(
				doc,
				addIds(Y.createIdSet(), all, (client) => !known.has(client))
			);
			return {
				rows: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.rowsTable}`).one().n
			};
		});
	}

	/**
	 * Drop every waiting delete, stored or in memory (callable over RPC):
	 * the way out when a writer filled {@link MAX_WAITING_DELETES} with
	 * deletes of registered ids' items, which compaction keeps. A dropped
	 * delete's item shows if it ever arrives — but for an entry a waiting
	 * rewrite replaces, which that rewrite deletes should it integrate.
	 * Returns how many ranges were dropped.
	 */
	dropWaitingDeletes(): { ranges: number } {
		return noTimers(() => {
			this.heal();
			const doc = this.requireDoc();
			const dropped = pendingDeletes(doc);
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM ${this.rowsTable} WHERE kind = 'pending'`);
			});
			this.storedWaiting = Y.createIdSet();
			forgetWaiting(doc, dropped);
			this.scheduleSave();
			return { ranges: rangeCount(dropped) };
		});
	}

	/**
	 * A fault of the room while it handled `ws`'s frame, never the client's
	 * doing (so never a refusal): a failed append (`unstored`) or registry
	 * write (`storage`), the engine or a send (`internal`). After a failed
	 * append or an engine fault the live doc may hold what storage does
	 * not: it is rebuilt from the stored rows alone (as a restart would),
	 * so nothing unstored is ever served or acknowledged. The socket is
	 * closed 1011: its provider redials, the join rule finds what the room
	 * lacks, and the edit is resent and stored.
	 */
	private fault(ws: WebSocket, error: unknown) {
		// A failed append outranks whatever surfaced it.
		const append = this.unstored !== null;
		const registry = !append && error instanceof StorageFault;
		const storage = append || registry;
		this.note({
			reason: storage ? 'storage' : 'internal',
			detail: String(append ? this.unstored : error)
		});
		// Only a registry fault leaves the live doc as stored.
		if (!registry && this.live !== null) this.rebuild();
		this.depart(ws);
		this.close(ws, CLOSE.fault, storage ? STORAGE_FAILURE : 'internal error');
	}

	/**
	 * Automatic compaction, once the message that made it due is
	 * acknowledged. A failure is logged and retried after half the
	 * threshold; the edit is already stored and nobody is closed.
	 */
	private compactIfDue() {
		if (this.updates < this.compactAfter || this.live === null) return;
		try {
			this.compact();
		} catch (error) {
			this.note({ reason: 'storage', detail: `compaction: ${String(error)}` });
			this.updates = Math.floor(this.compactAfter / 2);
		}
	}

	/**
	 * Drop the live doc for the stored rows (a failed append, an engine
	 * fault): `doc` and `facade` are replaced, and subscriptions on the old
	 * ones end. A read that fails now is retryable: the next dial loads
	 * again. The room's own writes (`waiting`) change nothing the engine
	 * holds waiting (updates missing a dependency, deletes kept in memory):
	 * that is carried over, not lost as at a restart.
	 */
	private rebuild(waiting = false) {
		const stale = this.live;
		this.live = null;
		this.unstored = null;
		this.load();
		const doc = this.live as YDoc | null;
		if (waiting && stale !== null && doc !== null) {
			doc.store.pendingStructs = stale.store.pendingStructs;
			doc.store.pendingDs = stale.store.pendingDs;
		}
		stale?.destroy();
	}

	/**
	 * A room-side write outside `transact` (straight through `facade`)
	 * whose append failed left the live doc ahead of storage: rebuild it
	 * before anything is served, read or acknowledged. Only while the room
	 * is idle (not `busy`): from inside a transaction, a frame's apply or
	 * their events (a `facade.onChange` subscriber, a
	 * `doc.on('afterAllTransactions')` listener), the failure stays for
	 * the handler — a frame's faults its sender, `transact` throws it
	 * (SW16-room-1, HX-03).
	 */
	private heal() {
		if (this.unstored === null || this.live === null || this.busy) return;
		this.note({ reason: 'storage', detail: String(this.unstored) });
		this.rebuild(true);
	}

	/** Run a frame's apply: nothing its listeners do heals it (HX-03). */
	private handle<T>(fn: () => T): T {
		this.handling = true;
		try {
			return fn();
		} finally {
			this.handling = false;
		}
	}

	private requireDoc(): YDoc {
		if (this.live === null) throw this.failure ?? new Error('room has no document');
		return this.live;
	}

	private adopt(doc: YDoc) {
		this._facade?.dispose();
		this._facade = null;
		this.live = doc;
		// Every INTEGRATED update is persisted first, then relayed to
		// everyone but its sender (the socket is the transaction origin).
		// A failed append relays nothing; the sender's handler rebuilds.
		// Nothing may throw out of here: the engine would never emit
		// `update` again (compaction runs later, in `compactIfDue`).
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (this.unstored !== null) return;
			try {
				this.ctx.storage.transactionSync(() => this.insert('update', update));
				this.updates++;
				this.broadcast(updateFrame(update), origin);
				this.scheduleSave();
			} catch (error) {
				this.unstored = error;
			}
		});
	}

	// ── Identity ─────────────────────────────────────────────────────────

	/** A registry read or write, its SQLite fault tagged (the socket closes 1011, never 1008). */
	private registry<T>(fn: () => T): T {
		try {
			return fn();
		} catch (error) {
			throw new StorageFault(String(error));
		}
	}

	/** Who owns `client`: a user, `''` (unowned: its dial claims it), or `undefined` (unregistered). */
	private ownerOf(client: number): string | undefined {
		return this.registry(
			() =>
				this.sql
					.exec<{
						user: string;
					}>(`SELECT user FROM ${this.replicasTable} WHERE replica = ?`, client)
					.toArray()[0]?.user
		);
	}

	/** Register `owners` in one transaction; an unowned (`''`) row never replaces an owner. */
	private register(owners: ReplicaOwner[]) {
		if (owners.length === 0) return;
		this.registry(() =>
			this.ctx.storage.transactionSync(() => {
				for (const { replica, user } of owners) {
					this.sql.exec(
						`INSERT ${user ? 'OR REPLACE' : 'OR IGNORE'} INTO ${this.replicasTable} (replica, user) VALUES (?, ?)`,
						replica,
						user
					);
				}
			})
		);
	}

	/**
	 * May `user` bind `replica` to a socket (its dial, or its first presence
	 * entry)? Its own id; an unregistered id with no content in the room,
	 * registered now whatever the socket's access (so a viewer's id cannot be
	 * taken before it is granted edit); an unowned id (`''`), which a
	 * `writer` claims (logged `orphan`). Not another user's id, nor
	 * unregistered history.
	 */
	private bind(user: string, replica: number, sv: Map<number, number>, writer: boolean): boolean {
		const owner = this.ownerOf(replica);
		if (owner === user) return true;
		if (owner === '') {
			if (!writer) return true;
			this.register([{ replica, user }]);
			this.note({ reason: 'orphan', detail: { replica, user } });
			return true;
		}
		if (owner !== undefined || (sv.get(replica) ?? 0) > 0) return false;
		this.register([{ replica, user }]);
		return true;
	}

	/**
	 * Which new writers of an update a socket may deliver; returns those
	 * stripped from its frame (the rest of the frame is applied: never
	 * refused whole). Written: its user's ids, and its own replica (the
	 * dialed or bound one), which claims an unowned id or a fresh one, as
	 * `bind` would. A socket with no replica claims fresh ids it writes.
	 * Any other id is relayed — another replica's structs, which a restore
	 * from a lagging snapshot may have lost: kept, and left unowned (`''`,
	 * claimable only by its own dial), when the room holds none of that id's
	 * clocks and no user owns it; stripped otherwise (logged `replica`).
	 * Ownership never moves to a relayer.
	 */
	private attribute(
		{ user, replica }: Attachment,
		writers: Set<number>,
		sv: Map<number, number>
	): Set<number> {
		const claimed: ReplicaOwner[] = [];
		const orphans: number[] = [];
		const relayed: number[] = [];
		const stripped = new Set<number>();
		for (const client of writers) {
			const owner = this.ownerOf(client);
			if (owner === user) continue;
			const held = (sv.get(client) ?? 0) > 0;
			const fresh = owner === undefined && !held;
			if (client === replica ? fresh || owner === '' : replica === null && fresh) {
				claimed.push({ replica: client, user });
				if (owner === '') orphans.push(client);
			} else if ((fresh || owner === '') && !held) {
				relayed.push(client);
			} else {
				stripped.add(client);
			}
		}
		this.register([...claimed, ...relayed.map((client) => ({ replica: client, user: '' }))]);
		for (const client of orphans)
			this.note({ reason: 'orphan', detail: { replica: client, user } });
		for (const client of relayed)
			this.note({ reason: 'relayed', detail: { replica: client, user } });
		for (const client of stripped) this.note({ reason: 'replica', detail: client });
		return stripped;
	}

	// ── Hibernation WebSocket API ────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a websocket upgrade', { status: 426 });
		}
		const identity = readIdentity(request.headers);
		if (identity === null) return new Response('verified identity required', { status: 401 });
		await this.retryStart();
		return noTimers(() => {
			this.heal();
			const doc = this.live;
			if (doc !== null && identity.replica !== null) {
				let bound: boolean;
				try {
					bound = this.bind(identity.user, identity.replica, stateVector(doc), !identity.readOnly);
				} catch (error) {
					if (!(error instanceof StorageFault)) throw error;
					this.note({ reason: 'storage', detail: String(error) });
					return closedSocket(CLOSE.fault, STORAGE_FAILURE);
				}
				if (!bound) {
					this.note({ reason: 'replica', detail: identity.replica });
					return closedSocket(CLOSE.replicaTaken, 'replica bound to another user');
				}
			}
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server, [SOCKET_TAG]);
			server.serializeAttachment({ ...identity, clock: null } satisfies Attachment);
			if (doc === null) {
				this.refuseContainer(server);
			} else {
				// A read-only socket is never asked for its state: it has nothing
				// to give. It gets the read-only notice instead (not a refusal),
				// so its provider tracks nothing.
				this.send(server, identity.readOnly ? readOnlyFrame() : step1Frame(doc));
				if (this.presence.size > 0) this.send(server, presenceFrame([...this.presence.values()]));
			}
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	/** Is `ws` one of this document's sockets? */
	owns(ws: WebSocket): boolean {
		return this.ctx.getTags(ws).includes(SOCKET_TAG);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): boolean {
		if (!this.owns(ws)) return false;
		noTimers(() => {
			// A refused socket is closing: frames it had in flight are dropped unread.
			if (ws.readyState !== WebSocket.OPEN) return;
			if (message === PING) return ws.send(PONG);
			if (typeof message === 'string') {
				return this.refuse(ws, { reason: 'malformed', detail: 'text frame' });
			}
			this.heal();
			const doc = this.live;
			if (doc === null) return this.refuseContainer(ws);
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (!attachment?.user) return this.refuse(ws, { reason: 'identity', detail: null });
			const bytes = new Uint8Array(message);
			const decoder = E.createDecoder(bytes);
			// 1 · Admission: the generation word, before anything is decoded.
			if (!E.readProtocolVersion(decoder)) {
				return this.refuse(ws, { reason: 'generation', detail: bytes[0] });
			}
			try {
				const type = decode(() => E.readVarUint(decoder));
				if (type === E.messageSync) return this.onSync(ws, attachment, doc, decoder);
				if (type === E.messageAwareness) {
					const entries = decode(() => E.readAwarenessEntries(E.readVarUint8Array(decoder)));
					return this.onPresence(ws, attachment, doc, entries);
				}
				if (type === E.messageQueryAwareness) {
					return this.send(ws, presenceFrame([...this.presence.values()]));
				}
				this.refuse(ws, { reason: 'malformed', detail: `message type ${type}` });
			} catch (error) {
				// Only the client's bytes are its fault: the room's own faults close 1011.
				if (error instanceof MalformedFrame) {
					this.refuse(ws, { reason: 'malformed', detail: error.message });
				} else {
					this.fault(ws, error);
				}
			}
		});
		return true;
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): boolean {
		if (!this.owns(ws)) return false;
		noTimers(() => this.depart(ws));
		// Complete the closing handshake (a no-op where the runtime already
		// auto-replies). 1005/1006 are not sendable codes.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
		return true;
	}

	webSocketError(ws: WebSocket): boolean {
		if (!this.owns(ws)) return false;
		noTimers(() => this.depart(ws));
		return true;
	}

	/** The departure the client may not have announced — from the attachment, so it works after a wake. */
	private depart(ws: WebSocket) {
		const attachment = ws.deserializeAttachment() as Attachment | null;
		if (attachment?.replica == null || attachment.clock === null) return;
		// Announce once: a later close/error event on this socket is a no-op.
		ws.serializeAttachment({ ...attachment, clock: null } satisfies Attachment);
		this.presence.delete(attachment.replica);
		this.broadcast(
			presenceFrame([{ clientID: attachment.replica, clock: attachment.clock + 1, state: null }]),
			ws
		);
	}

	private onSync(ws: WebSocket, attachment: Attachment, doc: YDoc, decoder: E.Decoder) {
		const syncType = decode(() => E.readVarUint(decoder));
		if (syncType === E.messageYjsSyncStep1) {
			const sv = decode(() => {
				const sv = E.readVarUint8Array(decoder);
				Y.decodeStateVector(sv);
				return sv;
			});
			this.send(ws, storedStep2(doc, sv));
			if (!attachment.readOnly && sync.lacks(doc, sv)) this.send(ws, step1Frame(doc));
			return this.send(ws, savedFrame(doc));
		}
		if (syncType !== E.messageYjsSyncStep2 && syncType !== E.messageYjsUpdate) {
			return this.refuse(ws, { reason: 'malformed', detail: `sync type ${syncType}` });
		}
		const update = decode(() => E.readVarUint8Array(decoder));
		// 2 · Access: a read-only socket writes nothing (it stays, and is told).
		if (attachment.readOnly) {
			this.note({ reason: 'read-only', detail: attachment.user });
			return this.send(ws, readOnlyDenialFrame());
		}
		// 3 · Attribution: new structs only under client ids this user may
		// write under; another user's are stripped, the rest applied.
		const decoded = decode(() => Y.decodeUpdate(update));
		const sv = stateVector(doc);
		const stripped = this.attribute(attachment, newWriters(decoded, sv), sv);
		// Waiting deletes are capped: a frame that would pass the cap has them dropped.
		const waiting = pendingDeletes(doc);
		const unheld = decoded.ds.isEmpty() ? null : unheldDeletes(decoded, stripped, doc);
		const dropped =
			unheld && rangeCount(waiting) + rangeCount(unheld) > MAX_WAITING_DELETES ? unheld : null;
		if (dropped !== null) {
			this.note({
				reason: 'waiting',
				detail: { user: attachment.user, ranges: rangeCount(dropped) }
			});
		}
		const admitted =
			stripped.size === 0 && dropped === null
				? update
				: withoutClients(decoded, stripped, doc, dropped ?? undefined);
		// 4 · Schema: the inbound refusal of a foreign stamp (the update's,
		// or a pending one it would release — discarded, the sender kept).
		// Integrating persists (the doc's update handler) before the ack.
		let failure: unknown = null;
		const { applied, problem, discarded } = this.handle(() =>
			sync.applyRemote(doc, admitted, ws, (error) => {
				failure = error;
			})
		);
		if (this.unstored !== null) return this.fault(ws, this.unstored);
		if (problem !== null) return this.refuse(ws, { reason: 'schema', detail: problem });
		// The bytes decoded: an update the engine could not apply is its fault.
		if (!applied) return this.fault(ws, failure ?? new Error('update not applied'));
		// The entries the frame's own still-waiting rewrites replace.
		const stay =
			doc.store.pendingStructs === null
				? Y.createIdSet()
				: replacedEntries(
						doc,
						decoded.structs,
						({ id }) => !stripped.has(id.client) && storedStruct(doc, id.client, id.clock) === null
					);
		const released = this.handle(() =>
			this.settleDeletes(ws, attachment.user, doc, waiting, stay, discarded !== undefined)
		);
		if (this.unstored !== null) return this.fault(ws, this.unstored);
		if (discarded) this.note({ reason: 'schema', detail: { discarded } });
		// A dropped delete is not acknowledged: its sender stays unsaved.
		this.send(ws, savedFrame(doc, addIds(this.storedDeletes(doc, decoded.ds), released)));
		// Waiting writes the frame released are other sockets' (a relayer's
		// edit that built on an author's lost one): they are stored now, with
		// the deletes that waited with them.
		if (releasedWaiting(decoded.structs, stripped, sv, stateVector(doc))) {
			this.broadcast(savedFrame(doc, released), ws);
		}
		this.compactIfDue();
	}

	/**
	 * A delete of items the room does not hold (a relayer's delete of an
	 * author's edit a restore lost) waits in the engine for them: it is
	 * stored as it arrives, so it survives eviction and compaction and
	 * applies when the author's edit returns. Except the entries the frame's
	 * own still-waiting rewrites replace (`stay`): those deletes wait with
	 * the rewrites in memory, as the rewrites may never integrate. A frame
	 * that released a pending forged stamp discarded every waiting delete
	 * (`applyRemote`): the stored ones go too. The deletes the frame applied
	 * from the waiting ones go back to its sender, whom the relay of the
	 * update skips; they are returned. The cap holds here too: deletes of
	 * the frame's own structs that wait for an origin (stored, or kept in
	 * memory with its rewrites) pass the check before applying; when the
	 * frame's new waiting deletes take the room past
	 * {@link MAX_WAITING_DELETES}, they are all dropped (refusal `waiting`,
	 * the sender's), unstored and unacknowledged. A replaced entry is
	 * deleted by its rewrite anyway, should that integrate.
	 */
	private settleDeletes(
		ws: WebSocket,
		user: string,
		doc: YDoc,
		waiting: Decoded['ds'],
		stay: Decoded['ds'],
		discarded: boolean
	): Decoded['ds'] {
		let now = pendingDeletes(doc);
		const fresh = discarded ? now : Y.diffIdSet(now, waiting);
		if (!fresh.isEmpty() && rangeCount(now) > MAX_WAITING_DELETES) {
			this.note({ reason: 'waiting', detail: { user, ranges: rangeCount(fresh) } });
			forgetWaiting(doc, fresh);
			now = pendingDeletes(doc);
		}
		const added = Y.diffIdSet(discarded ? now : Y.diffIdSet(now, waiting), stay);
		const released = heldDeletes(doc, Y.diffIdSet(waiting, now));
		if (discarded || !added.isEmpty()) {
			try {
				this.ctx.storage.transactionSync(() => {
					if (discarded) this.sql.exec(`DELETE FROM ${this.rowsTable} WHERE kind = 'pending'`);
					if (!added.isEmpty()) this.insert('pending', deletesUpdate(added));
				});
				this.updates++;
			} catch (error) {
				this.unstored = error;
				return released;
			}
			this.scheduleSave();
			this.storedWaiting = addIds(discarded ? Y.createIdSet() : this.storedWaiting, added);
		}
		if (!released.isEmpty()) this.send(ws, updateFrame(deletesUpdate(released)));
		return released;
	}

	/**
	 * Of `deletes`, those the room stored — applied, or waiting in a
	 * `pending` record — and so acknowledges by id: never one it dropped
	 * (the waiting cap, a stripped rewrite's replaced entry) or keeps
	 * waiting in memory only.
	 */
	private storedDeletes(doc: YDoc, deletes: Decoded['ds']): Decoded['ds'] {
		const unheld = Y.diffIdSet(deletes, heldDeletes(doc, deletes));
		return Y.diffIdSet(deletes, Y.diffIdSet(unheld, this.storedWaiting));
	}

	/**
	 * Presence through the instance-free codec, for the socket's own replica
	 * only (bound by `authorize`, else by its first entry): the newest clock
	 * wins, the attachment records the clock, the accepted entry is relayed
	 * — to its sender too (a no-op for it), so a lone socket hears from the
	 * room at every renewal and is never torn down as silent.
	 * Entries for other replicas (a client re-sending what it heard) are dropped.
	 */
	private onPresence(ws: WebSocket, attachment: Attachment, doc: YDoc, entries: AwarenessEntry[]) {
		let replica = attachment.replica;
		if (replica === null && entries.length > 0) {
			replica = entries[0].clientID;
			if (!this.bind(attachment.user, replica, stateVector(doc), !attachment.readOnly)) {
				return this.refuse(ws, { reason: 'replica', detail: replica });
			}
		}
		const entry = entries.find((candidate) => candidate.clientID === replica);
		if (entry === undefined || replica === null) return;
		const known = this.presence.get(replica);
		if (known && known.clock > entry.clock) return;
		if (entry.state === null) this.presence.delete(replica);
		else this.presence.set(replica, entry);
		ws.serializeAttachment({
			...attachment,
			replica,
			clock: entry.state === null ? null : entry.clock
		} satisfies Attachment);
		this.broadcast(presenceFrame([entry]), entry.state === null ? ws : null);
	}

	/** Log a refusal: the newest {@link MAX_REFUSALS} are kept, every reason is counted. */
	private note(refusal: Refusal) {
		this.refusals.push(refusal);
		if (this.refusals.length > MAX_REFUSALS) this.refusals.shift();
		this.refusalCounts[refusal.reason] = (this.refusalCounts[refusal.reason] ?? 0) + 1;
	}

	/** A refused frame is dropped whole and its socket closed (1008 policy violation). */
	private refuse(ws: WebSocket, refusal: Refusal) {
		this.note(refusal);
		this.depart(ws);
		this.close(ws, CLOSE.refused, `refused: ${refusal.reason}`);
	}

	private close(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code, reason);
		} catch {
			// already closing
		}
	}

	/**
	 * No document to serve: a container that cannot be restored is
	 * refused for good (1008, the provider stops dialing); a failed read of
	 * the rows or an `onLoad` that threw is retried at the next dial (1011,
	 * the provider redials).
	 */
	private refuseContainer(ws: WebSocket) {
		if (!this.retryable)
			return this.refuse(ws, { reason: 'container', detail: this.failure?.message });
		this.note({ reason: 'container', detail: this.failure?.message });
		this.close(ws, CLOSE.fault, 'room unavailable');
	}

	/** Send one frame — as chunks when it exceeds `maxFrameBytes` (bounded catch-up). */
	private send(ws: WebSocket, bytes: Uint8Array) {
		for (const piece of E.chunkFrame(bytes, this.maxFrameBytes)) ws.send(piece);
	}

	private broadcast(bytes: Uint8Array, except: unknown) {
		const pieces = E.chunkFrame(bytes, this.maxFrameBytes);
		for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
			try {
				for (const piece of pieces) ws.send(piece);
			} catch {
				// a socket that died mid-broadcast gets its close event
			}
		}
	}
}

type Handler = 'fetch' | 'webSocketMessage' | 'webSocketClose' | 'webSocketError' | 'alarm';

/**
 * Attach an edytor document to any Durable Object (`attachDocument(this,
 * opts)`, in the constructor or a field). Its tables (`edytor_rows`,
 * `edytor_replicas`) live beside yours and its sockets carry
 * {@link SOCKET_TAG}. Each handler your class does not define —
 * `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, and
 * `alarm` when `onSave` is set — is installed on the object; a class that
 * defines one delegates to the returned document's method (which returns
 * `false` for a socket that is not the document's).
 */
export const attachDocument = (
	host: DurableObject<any>,
	options: AttachDocumentOptions = {}
): AttachedDocument => {
	const ctx = (host as unknown as { ctx?: DurableObjectState } | null)?.ctx;
	if (!ctx?.storage) {
		throw new TypeError(
			'attachDocument(this): `this` must be a Durable Object (a class extending DurableObject, after super())'
		);
	}
	const document = new AttachedDocument(ctx, options);
	const target = host as unknown as Record<Handler, unknown>;
	const handlers: Handler[] = ['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError'];
	if (options.onSave) handlers.push('alarm');
	for (const name of handlers) {
		if (typeof target[name] === 'function') continue;
		target[name] = (...args: never[]) => (document[name] as (...a: never[]) => unknown)(...args);
	}
	return document;
};

/**
 * The ready-made room: a Durable Object hosting one document, configured
 * by `vars` ({@link DocumentRoomEnv}). Subclass it to override `onLoad` and
 * `onSave`, and add your own RPC methods over `transact`/`read`. Its tables
 * are `rows` and `replicas` (no prefix).
 */
export class DocumentRoom<
	// Unconstrained: an all-optional constraint would reject an Env naming none of the knobs.
	Env = DocumentRoomEnv
> extends DurableObject<Env> {
	readonly room: AttachedDocument;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const knobs = env as DocumentRoomEnv;
		const saves = this.onSave !== DocumentRoom.prototype.onSave;
		const semantics = () => this.semantics();
		this.room = new AttachedDocument(ctx, {
			maxRowBytes: Number(knobs.EDYTOR_MAX_ROW_BYTES),
			maxFrameBytes: Number(knobs.EDYTOR_MAX_FRAME_BYTES),
			compactAfter: Number(knobs.EDYTOR_COMPACT_AFTER),
			saveAfter: Number(knobs.EDYTOR_SAVE_AFTER),
			tablePrefix: '',
			// A getter: a subclass's fields do not exist yet in this constructor.
			get semantics() {
				return semantics();
			},
			onLoad: () => this.onLoad(),
			onSave: saves ? (document) => this.onSave(document) : undefined
		});
	}

	/** Retrieve — see {@link AttachDocumentOptions.onLoad}. */
	protected async onLoad(): Promise<LoadedDocument | null | undefined> {
		return undefined;
	}

	/** Save — see {@link AttachDocumentOptions.onSave}. Not overridden: no alarm is ever set. */
	protected async onSave(_document: SavedDocument): Promise<void> {}

	/**
	 * Block roles — see {@link AttachDocumentOptions.semantics}. Read once,
	 * at first use (after construction: it may return a subclass field).
	 */
	protected semantics(): DocumentSemanticsConfig {
		return E.defaultSemantics;
	}

	fetch(request: Request): Promise<Response> {
		return this.room.fetch(request);
	}
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		this.room.webSocketMessage(ws, message);
	}
	webSocketClose(ws: WebSocket, code: number, reason: string) {
		this.room.webSocketClose(ws, code, reason);
	}
	webSocketError(ws: WebSocket) {
		this.room.webSocketError(ws);
	}
	/** Runs `onSave`. Call `super.alarm()` if you override it. */
	alarm(): Promise<void> {
		return this.room.alarm();
	}

	/** Compaction, also over RPC. */
	compact(): { rows: number } {
		return this.room.compact();
	}
	/** The snapshot compression in flight, also over RPC — see {@link AttachedDocument.compressed}. */
	compressed(): Promise<void> {
		return this.room.compressed();
	}
	/** Drop the stored waiting deletes, also over RPC — see {@link AttachedDocument.dropWaitingDeletes}. */
	dropWaitingDeletes(): { ranges: number } {
		return this.room.dropWaitingDeletes();
	}
	/** Generation cutover, also over RPC — see {@link AttachedDocument.reset}. */
	reset(): Promise<void> {
		return this.room.reset();
	}
	/** Server-side edit — see {@link AttachedDocument.transact}. */
	transact<T>(fn: (facade: EdytorDoc) => T): T {
		return this.room.transact(fn);
	}
	/** The document as JSON. */
	read(): JSONDoc {
		return this.room.read();
	}
	get facade(): EdytorDoc {
		return this.room.facade;
	}
	get doc(): YDoc | null {
		return this.room.doc;
	}
	get failure(): Error | null {
		return this.room.failure;
	}
	get refusals(): Refusal[] {
		return this.room.refusals;
	}
	get refusalCounts(): AttachedDocument['refusalCounts'] {
		return this.room.refusalCounts;
	}
	get presence(): Map<number, AwarenessEntry> {
		return this.room.presence;
	}
	get origin(): AttachedDocument['origin'] {
		return this.room.origin;
	}
	records(): ReturnType<AttachedDocument['records']> {
		return this.room.records();
	}
}
