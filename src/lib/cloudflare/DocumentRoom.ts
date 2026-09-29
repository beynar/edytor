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
 *   attachment, then our SyncStep1 (write sockets only) and every present
 *   peer.
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
 *   message it holds), sent after the write (store-before-ack). Presence
 *   is relayed through the instance-free codec, only for the socket's own
 *   replica. Only bytes that do not decode are refused `malformed`
 *   (1008); a storage or engine fault closes the socket 1011 (its
 *   provider redials), after rebuilding the document where it may hold
 *   what storage does not.
 * - every INTEGRATED update is appended to SQLite as one record split into
 *   rows ≤ `maxRowBytes` (2 MB row cap) in one `transactionSync`, then
 *   broadcast; after `compactAfter` update records the rows are merged
 *   (`mergeUpdates`) into one snapshot record, after the message is
 *   acknowledged — never inside the engine's `update` observer, where one
 *   throw would silence every later emit. Memory never runs ahead of
 *   storage: when an append fails, nothing is relayed or acknowledged, the
 *   live doc is rebuilt from the stored rows and the sender's socket is
 *   closed (1011) so its provider reconnects and resends.
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
 *   server; persisted and broadcast to every socket like a client's edit.
 *   `read()` returns the document as JSON (both RPC-callable wrappers are
 *   yours to define).
 */
import { DurableObject } from 'cloudflare:workers';
import * as encoding from 'lib0-v14/encoding';
import { Y } from '../crdt/engine.js';
import * as E from '../crdt/index.js';
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

/** Headers carrying the identity `routeDocumentSocket` verified — never the client's. */
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

type RowKind = 'generation' | 'update' | 'snapshot';
type Row = { kind: RowKind; record: number; part: number; parts: number; bytes: ArrayBuffer };

/** The dial of a replica another user owns: terminal for the provider (`4xxx`). */
const REPLICA_TAKEN_CLOSE = { code: 4409, reason: 'replica bound to another user' } as const;

/**
 * An upgrade accepted and closed at once, so the client reads `code`: a
 * browser sees an HTTP error at the upgrade only as `1006`, which a
 * provider cannot tell from a network failure.
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
/** A stored record missing some of its rows: the container is corrupt, not the read. */
class TornRecord extends Error {
	constructor() {
		super('torn record');
	}
}

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

const readIdentity = (headers: Headers): SocketIdentity | null => {
	const user = headers.get(IDENTITY_HEADERS.user);
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
		defaultChildOf: own(semantics.defaultChild),
		rendersContent: (type: string) => rendersContent(type) ?? true,
		defaultType: semantics.defaultType
	};
};

const encodeJSON = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** An awareness frame carrying `entries` — no `Awareness` instance involved. */
export const presenceFrame = (entries: AwarenessEntry[]): Uint8Array =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));

const isGenerationRecord = (found: unknown) => {
	const record = found as Partial<E.GenerationRecord> | null;
	return (
		record !== null &&
		typeof record === 'object' &&
		record.engine === E.GENERATION_RECORD.engine &&
		record.protocol === E.GENERATION_RECORD.protocol &&
		record.schema === E.GENERATION_RECORD.schema
	);
};

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
	seed: (children: JSONDoc['children']) => Uint8Array
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
			return { update: seed(found.children), replicas: [] };
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

/**
 * A decoded update without what it carries under `clients`: their structs,
 * and its deletes of their items (a forged transaction's rewrite of an
 * entry deletes the entry it replaces).
 */
const withoutClients = ({ structs, ds }: Decoded, clients: Set<number>): Uint8Array => {
	const kept = new Map<number, typeof structs>();
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
	const deletes = Y.createIdSet();
	for (const [client, ranges] of ds.clients) {
		if (!clients.has(client)) deletes.clients.set(client, ranges);
	}
	Y.writeIdSet(encoder, deletes);
	return encoder.toUint8Array();
};

/**
 * The deletes of `ds` that `doc` holds: their items integrated and deleted.
 * What a stripped frame's acknowledgement may carry — a relayer's delete
 * of an item the room holds deleted is stored, even when the delete itself
 * was stripped (a map entry is deleted by the entry that replaces it).
 */
const heldDeletes = (doc: YDoc, ds: Decoded['ds']): Decoded['ds'] => {
	const held = Y.createIdSet();
	for (const [client, ranges] of ds.clients) {
		const structs = doc.store.clients.get(client) ?? [];
		const last = structs.at(-1);
		const stored = last ? last.id.clock + last.length : 0;
		for (const { clock, len } of ranges.getIds()) {
			if (clock >= stored) continue;
			for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
				const struct = structs[i];
				if (struct.id.clock >= clock + len) break;
				if (!struct.deleted || struct instanceof Y.Skip) continue;
				const from = Math.max(clock, struct.id.clock);
				held.add(client, from, Math.min(clock + len, struct.id.clock + struct.length) - from);
			}
		}
	}
	return held;
};

/** A Step2 of what the room STORED: the engine's pending store (never stored) is left out. */
const storedStep2 = (doc: YDoc, sv: Uint8Array): Uint8Array => {
	const { store } = doc;
	const held = [store.pendingStructs, store.pendingDs] as const;
	store.pendingStructs = null;
	store.pendingDs = null;
	try {
		return E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, doc, sv));
	} finally {
		[store.pendingStructs, store.pendingDs] = held;
	}
};

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
	/** The live document; `null` when the stored container was refused. */
	doc: YDoc | null = null;
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
	/** The failure is the storage's (a failed read, `onLoad`'s store down): the next dial starts again. */
	private retryable = false;
	private readonly sql: SqlStorage;
	private _facade: EdytorDoc | null = null;
	private saveScheduled = false;
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
			noTimers(() => this.load());
			if (this.origin.kind === 'fresh' && this.doc !== null) await this.seed();
		} catch (error) {
			this.fail(error, true);
		}
	}

	private fail(error: unknown, retryable: boolean) {
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.retryable = retryable;
		this.unstored = null;
		this._facade?.dispose();
		this._facade = null;
		this.doc?.destroy();
		this.doc = null;
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

	/** The facade over the live document. */
	get facade(): EdytorDoc {
		return (this._facade ??= this.facadeOf(this.requireDoc()));
	}

	/**
	 * Manipulate: run `fn` on the facade in one transaction. The edit is
	 * stored, then broadcast to every socket. An empty room is first seeded
	 * with one empty block, as a client with no `value` would.
	 */
	transact<T>(fn: (facade: EdytorDoc) => T): T {
		return noTimers(() => {
			const doc = this.requireDoc();
			if (!crdt.doc.isInitialized(doc as never)) this.facade.seed([]);
			let result!: T;
			this.facade.transact(() => {
				result = fn(this.facade);
			}, ROOM_ORIGIN);
			if (this.unstored !== null) {
				const error = this.unstored;
				this.note({ reason: 'storage', detail: String(error) });
				this.rebuild();
				throw error;
			}
			this.compactIfDue();
			return result;
		});
	}

	/** The document as JSON. */
	read(): JSONDoc {
		return this.facade.toJSON();
	}

	/** Runs `onSave` — the object's alarm, `saveAfter` ms after the first unsaved change. */
	async alarm(): Promise<void> {
		this.saveScheduled = false;
		if (this.doc === null || !this.options.onSave) return;
		// One synchronous read: the registry matches the state it is saved with.
		const saved = {
			value: this.read(),
			update: Y.encodeStateAsUpdate(this.doc),
			replicas: this.sql
				.exec<ReplicaOwner>(`SELECT replica, user FROM ${this.replicasTable} ORDER BY replica`)
				.toArray()
		};
		await this.options.onSave(saved);
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
	 * registry, atomically.
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
				const loaded = loadedUpdate(found, (children) => {
					const scratch = crdt.createDoc();
					const facade = this.facadeOf(scratch);
					facade.seed(children);
					facade.dispose();
					const update = Y.encodeStateAsUpdate(scratch);
					scratch.destroy();
					return update;
				});
				doc = crdt.admission.admitUpdate(loaded.update, `room ${this.ctx.id} onLoad`);
				replicas = loaded.replicas;
			} catch (error) {
				return this.fail(error, false);
			}
			try {
				this.ctx.storage.transactionSync(() => {
					this.insert('snapshot', Y.encodeStateAsUpdate(doc));
					// Without a registry, every id with content is left claimable (user '').
					const owners =
						replicas ?? [...stateVector(doc).keys()].map((replica) => ({ replica, user: '' }));
					for (const { replica, user } of owners) {
						this.sql.exec(
							`INSERT ${replicas ? 'OR REPLACE' : 'OR IGNORE'} INTO ${this.replicasTable} (replica, user) VALUES (?, ?)`,
							replica,
							user
						);
					}
				});
			} catch (error) {
				return this.fail(error, true);
			}
			this.doc?.destroy();
			this.adopt(doc);
		});
	}

	private scheduleSave() {
		if (this.saveScheduled || !this.options.onSave) return;
		this.saveScheduled = true;
		void this.ctx.storage.setAlarm(Date.now() + this.saveAfter);
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
				this.adopt(crdt.createDoc());
				return;
			}
			const [generation, ...rest] = records;
			const found = JSON.parse(new TextDecoder().decode(generation.bytes));
			if (generation.kind !== 'generation' || !isGenerationRecord(found)) {
				throw new E.GenerationMismatchError(`room ${this.ctx.id}`, found);
			}
			const merged = Y.mergeUpdates(rest.map((record) => record.bytes));
			this.adopt(crdt.admission.admitUpdate(merged, `room ${this.ctx.id}`));
			this.origin = { kind: 'restored', records: rest.length };
			this.updates = rest.filter((record) => record.kind === 'update').length;
		} catch (error) {
			this.fail(error, false);
		}
	}

	/** Reassembled logical records in write order; a torn record throws. */
	records(): Array<{ kind: RowKind; bytes: Uint8Array<ArrayBuffer> }> {
		const byRecord = new Map<number, Row[]>();
		for (const row of this.sql.exec<Row>(
			`SELECT kind, record, part, parts, bytes FROM ${this.rowsTable} ORDER BY seq`
		)) {
			const parts = byRecord.get(row.record) ?? [];
			parts.push(row);
			byRecord.set(row.record, parts);
			this.nextRecord = Math.max(this.nextRecord, row.record + 1);
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
			return { kind: parts[0].kind, bytes };
		});
	}

	/**
	 * One logical record split into rows ≤ `maxRowBytes` (callers run it in
	 * a transaction). The first record of an empty container brings the
	 * generation record with it.
	 */
	private insert(kind: RowKind, bytes: Uint8Array) {
		if (this.nextRecord === 0 && kind !== 'generation') {
			this.insert('generation', encodeJSON(E.GENERATION_RECORD));
		}
		const record = this.nextRecord++;
		const parts = Math.max(1, Math.ceil(bytes.length / this.maxRowBytes));
		for (let part = 0; part < parts; part++) {
			this.sql.exec(
				`INSERT INTO ${this.rowsTable} (kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?)`,
				kind,
				record,
				part,
				parts,
				bytes.slice(part * this.maxRowBytes, (part + 1) * this.maxRowBytes)
			);
		}
	}

	/**
	 * Compaction: the rows become the generation record + one chunked
	 * snapshot, `mergeUpdates` of every stored record, atomically. The
	 * registry keeps the ids holding content and those bound to an open
	 * socket; the others (page loads that never wrote) are dropped, and
	 * re-register at their next dial or write. Runs by itself after
	 * `compactAfter` update records; callable over RPC (e.g. from the
	 * host's own alarm).
	 */
	compact(): { rows: number } {
		return noTimers(() => {
			const doc = this.requireDoc();
			const merged = Y.mergeUpdates(
				this.records()
					.slice(1)
					.map((record) => record.bytes)
			);
			// Memory never runs ahead of storage: the live state vector is the stored one.
			const kept = new Set(stateVector(doc).keys());
			for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
				const replica = (ws.deserializeAttachment() as Attachment | null)?.replica;
				if (replica != null) kept.add(replica);
			}
			const registered = this.sql
				.exec<{ replica: number }>(`SELECT replica FROM ${this.replicasTable}`)
				.toArray();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM ${this.rowsTable}`);
				this.insert('generation', encodeJSON(E.GENERATION_RECORD));
				this.insert('snapshot', merged);
				for (const { replica } of registered) {
					if (!kept.has(replica)) {
						this.sql.exec(`DELETE FROM ${this.replicasTable} WHERE replica = ?`, replica);
					}
				}
			});
			this.updates = 0;
			return {
				rows: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.rowsTable}`).one().n
			};
		});
	}

	/**
	 * After a failed append: the live doc is rebuilt from the stored rows
	 * alone (as a restart would), so nothing unstored is ever served or
	 * acknowledged, and the sender's socket is closed (1011) — its
	 * provider reconnects, the join rule finds what the room lacks, and
	 * the edit is resent and stored.
	 */
	private recover(ws: WebSocket) {
		this.note({ reason: 'storage', detail: String(this.unstored) });
		this.rebuild();
		this.depart(ws);
		this.close(ws, 1011, STORAGE_FAILURE);
	}

	/**
	 * A fault of the room while it handled `ws`'s frame — a registry write
	 * (`storage`), the engine or a send (`internal`): never the client's
	 * doing, so never a refusal. An engine fault may leave the live doc
	 * holding what storage does not: it is rebuilt from the stored rows.
	 * The socket is closed 1011; its provider redials and resends.
	 */
	private fault(ws: WebSocket, error: unknown) {
		if (this.unstored !== null) return this.recover(ws);
		const storage = error instanceof StorageFault;
		this.note({ reason: storage ? 'storage' : 'internal', detail: String(error) });
		if (!storage && this.doc !== null) this.rebuild();
		this.depart(ws);
		this.close(ws, 1011, storage ? STORAGE_FAILURE : 'internal error');
	}

	/**
	 * Automatic compaction, once the message that made it due is
	 * acknowledged. A failure is logged and retried after half the
	 * threshold; the edit is already stored and nobody is closed.
	 */
	private compactIfDue() {
		if (this.updates < this.compactAfter || this.doc === null) return;
		try {
			this.compact();
		} catch (error) {
			this.note({ reason: 'storage', detail: `compaction: ${String(error)}` });
			this.updates = Math.floor(this.compactAfter / 2);
		}
	}

	/**
	 * Drop the live doc for the stored rows (a failed append, an engine
	 * fault). A read that fails now is retryable: the next dial loads again.
	 */
	private rebuild() {
		const stale = this.doc;
		this.doc = null;
		this.unstored = null;
		this.load();
		stale?.destroy();
	}

	private requireDoc(): YDoc {
		if (this.doc === null) throw this.failure ?? new Error('room has no document');
		return this.doc;
	}

	private adopt(doc: YDoc) {
		this._facade?.dispose();
		this._facade = null;
		this.doc = doc;
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
				this.broadcast(
					E.frame(E.messageSync, (e) => sync.writeUpdate(e, update)),
					origin
				);
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
		// A read of the rows or `onLoad` failed (storage was down): start again before refusing.
		if (this.doc === null && this.retryable) {
			await this.ctx.blockConcurrencyWhile(async () => {
				if (this.doc === null && this.retryable) await this.start();
			});
		}
		return noTimers(() => {
			const doc = this.doc;
			if (doc !== null && identity.replica !== null) {
				let bound: boolean;
				try {
					bound = this.bind(identity.user, identity.replica, stateVector(doc), !identity.readOnly);
				} catch (error) {
					if (!(error instanceof StorageFault)) throw error;
					this.note({ reason: 'storage', detail: String(error) });
					return closedSocket(1011, STORAGE_FAILURE);
				}
				if (!bound) {
					this.note({ reason: 'replica', detail: identity.replica });
					return closedSocket(REPLICA_TAKEN_CLOSE.code, REPLICA_TAKEN_CLOSE.reason);
				}
			}
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server, [SOCKET_TAG]);
			server.serializeAttachment({ ...identity, clock: null } satisfies Attachment);
			if (doc === null) {
				this.refuseContainer(server);
			} else {
				// A read-only socket is never asked for its state: it has nothing to give.
				if (!identity.readOnly) {
					this.send(
						server,
						E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc))
					);
				}
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
			const doc = this.doc;
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
			if (!attachment.readOnly && sync.lacks(doc, sv)) {
				this.send(
					ws,
					E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc))
				);
			}
			return this.acknowledge(ws, doc);
		}
		if (syncType !== E.messageYjsSyncStep2 && syncType !== E.messageYjsUpdate) {
			return this.refuse(ws, { reason: 'malformed', detail: `sync type ${syncType}` });
		}
		const update = decode(() => E.readVarUint8Array(decoder));
		// 2 · Access: a read-only socket writes nothing (it stays, and is told).
		if (attachment.readOnly) {
			this.note({ reason: 'read-only', detail: attachment.user });
			return this.send(
				ws,
				E.frame(E.messageAuth, (e) => E.writePermissionDenied(e, 'read-only'))
			);
		}
		// 3 · Attribution: new structs only under client ids this user may
		// write under; another user's are stripped, the rest applied.
		const decoded = decode(() => Y.decodeUpdate(update));
		const sv = stateVector(doc);
		const stripped = this.attribute(attachment, newWriters(decoded, sv), sv);
		const admitted = stripped.size === 0 ? update : withoutClients(decoded, stripped);
		// 4 · Schema: the inbound refusal of a foreign stamp (the update's,
		// or a pending one it would release — discarded, the sender kept).
		// Integrating persists (the doc's update handler) before the ack.
		let failure: unknown = null;
		const { applied, problem, discarded } = sync.applyRemote(doc, admitted, ws, (error) => {
			failure = error;
		});
		if (this.unstored !== null) return this.recover(ws);
		if (problem !== null) return this.refuse(ws, { reason: 'schema', detail: problem });
		// The bytes decoded: an update the engine could not apply is its fault.
		if (!applied) return this.fault(ws, failure ?? new Error('update not applied'));
		if (discarded) this.note({ reason: 'schema', detail: { discarded } });
		this.acknowledge(ws, doc, stripped.size === 0 ? decoded.ds : heldDeletes(doc, decoded.ds));
		this.compactIfDue();
	}

	/**
	 * Store-before-ack: everything under the room's state vector is
	 * persisted, and so are the acknowledged deletes (`deletes`, the
	 * message's, less those the engine holds pending).
	 */
	private acknowledge(ws: WebSocket, doc: YDoc, deletes?: ReturnType<typeof Y.decodeUpdate>['ds']) {
		this.send(
			ws,
			E.frame(E.messageSaved, (e) => sync.writeSaved(e, doc, deletes))
		);
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
		this.close(ws, 1008, `refused: ${refusal.reason}`);
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
		this.close(ws, 1011, 'room unavailable');
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
	const ctx = (host as unknown as { ctx: DurableObjectState }).ctx;
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
