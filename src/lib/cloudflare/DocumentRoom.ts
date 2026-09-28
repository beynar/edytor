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
 *   replica to its user (a replica another user owns is refused 403),
 *   `ctx.acceptWebSocket` with the identity in the attachment, then our
 *   SyncStep1 (write sockets only) and every present peer.
 * - `webSocketMessage`: ADMIT first — the generation word, then the
 *   identity: a read-only socket's Step2/Update is refused (permission
 *   denied, the socket stays), and an update writing new structs under a
 *   client id its user does not own is refused (1008) — no attribution
 *   spoofing. Then the inbound schema refusal (`sync.applyRemote`, which
 *   also judges what the engine holds pending: a pending forged stamp the
 *   update would release is discarded, never integrated). A refused frame
 *   is never applied, stored or relayed. Every sync message is answered
 *   with `messageSaved` (the room's state vector, and the deletes of the
 *   message it holds), sent after the write (store-before-ack). Presence
 *   is relayed through the instance-free codec, only for the socket's own
 *   replica.
 * - every INTEGRATED update is appended to SQLite as one record split into
 *   rows ≤ `maxRowBytes` (2 MB row cap) in one `transactionSync`, then
 *   broadcast; after `compactAfter` update records the rows are merged
 *   (`mergeUpdates`) into one snapshot record. Memory never runs ahead of
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
 *   container of another generation refuses every socket.
 *
 * No entry point schedules a timer: each runs under {@link noTimers}
 * (a Durable Object with a pending timer never hibernates).
 *
 * Extending (subclass it, export the subclass):
 *
 * - `onLoad()` — retrieve: seed a room that stores nothing yet from your
 *   own store (JSON, or a v14 update). Runs before any socket is served.
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
import { Y } from '../crdt/engine.js';
import * as E from '../crdt/index.js';
import type { AwarenessEntry, EdytorDoc, JSONDoc, YDoc } from '../crdt/index.js';

const crdt = E.bindCrdt(Y);
const sync = crdt.sync;

/** Under SQLite-backed Durable Objects' 2 MB row cap, with room for the other columns. */
export const DEFAULT_MAX_ROW_BYTES = 2_000_000 - 4096;
/** Update records before the rows are merged into one snapshot. */
export const DEFAULT_COMPACT_AFTER = 500;
/** ms between the first unsaved change and `onSave`. */
export const DEFAULT_SAVE_AFTER = 2000;

/** The document as `onSave` receives it. */
export type SavedDocument = {
	/** The document as JSON. */
	value: JSONDoc;
	/** The full v14 state (`onLoad` takes it back as is). */
	update: Uint8Array;
};

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
		| 'storage';
	detail: unknown;
};

type RowKind = 'generation' | 'update' | 'snapshot';
type Row = { kind: RowKind; record: number; part: number; parts: number; bytes: ArrayBuffer };

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

export class DocumentRoom<
	// Unconstrained: an all-optional constraint would reject an Env naming none of the knobs.
	Env = DocumentRoomEnv
> extends DurableObject<Env> {
	readonly maxRowBytes: number;
	readonly maxFrameBytes: number;
	readonly compactAfter: number;
	readonly saveAfter: number;
	/** The live document; `null` when the stored container was refused. */
	doc: YDoc | null = null;
	/** Why the stored container was refused (another generation, a torn record…). */
	failure: Error | null = null;
	/** Latest presence entry per replica, for join snapshots (memory: refills after a wake). */
	presence = new Map<number, AwarenessEntry>();
	/** Refusals since this instance started (diagnostics; memory only). */
	refusals: Refusal[] = [];
	/** How this instance came to be: a fresh container, or a restore of N stored records. */
	origin: { kind: 'fresh' } | { kind: 'restored'; records: number } = { kind: 'fresh' };
	private nextRecord = 0;
	private updates = 0;
	/** A failed append: the live doc holds what storage does not, until it is rebuilt. */
	private unstored: unknown = null;
	private readonly sql: SqlStorage;
	private _facade: EdytorDoc | null = null;
	private saveScheduled = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		const knobs = env as DocumentRoomEnv;
		this.maxRowBytes = knob(knobs.EDYTOR_MAX_ROW_BYTES, DEFAULT_MAX_ROW_BYTES);
		this.maxFrameBytes = knob(knobs.EDYTOR_MAX_FRAME_BYTES, E.MAX_FRAME_BYTES);
		this.compactAfter = knob(knobs.EDYTOR_COMPACT_AFTER, DEFAULT_COMPACT_AFTER, 1e9);
		this.saveAfter = knob(knobs.EDYTOR_SAVE_AFTER, DEFAULT_SAVE_AFTER, 1e9);
		void ctx.blockConcurrencyWhile(async () => {
			noTimers(() => this.load());
			if (this.origin.kind === 'fresh' && this.doc !== null) await this.seed();
		});
	}

	// ── Extension points ─────────────────────────────────────────────────

	/**
	 * Retrieve: the document for a room that stores nothing yet (asked again
	 * at each start until something is stored). Return JSON, a v14 update
	 * (`SavedDocument.update`), or nothing for an empty room. A throw
	 * refuses every socket until the next start.
	 */
	protected async onLoad(): Promise<JSONDoc | Uint8Array | null | undefined> {
		return undefined;
	}

	/** Save: mirror the document to your own store. Not overridden: no alarm is ever set. */
	protected async onSave(_document: SavedDocument): Promise<void> {}

	/** The facade over the live document (roles unknown: no plugin definitions on the server). */
	get facade(): EdytorDoc {
		return (this._facade ??= crdt.doc.create(this.requireDoc() as never) as EdytorDoc);
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
			if (this.unstored !== null) throw this.rebuild();
			return result;
		});
	}

	/** The document as JSON. */
	read(): JSONDoc {
		return this.facade.toJSON();
	}

	/** Runs `onSave` (the alarm `saveAfter` ms after the first unsaved change). Call `super.alarm()` if you override it. */
	async alarm(): Promise<void> {
		this.saveScheduled = false;
		if (this.doc === null) return;
		await this.onSave({ value: this.read(), update: Y.encodeStateAsUpdate(this.doc) });
	}

	private async seed() {
		let found: JSONDoc | Uint8Array | null | undefined;
		try {
			found = await this.onLoad();
		} catch (error) {
			this.failure = error as Error;
			this.doc?.destroy();
			this.doc = null;
			return;
		}
		if (found == null) return;
		noTimers(() => {
			if (found instanceof Uint8Array) {
				// Admitted like a stored container, then stored as one snapshot record.
				const doc = crdt.admission.admitUpdate(found, `room ${this.ctx.id} onLoad`);
				this.ctx.storage.transactionSync(() => this.insert('snapshot', Y.encodeStateAsUpdate(doc)));
				this.doc?.destroy();
				this.adopt(doc);
			} else {
				// Deterministic: a client seeding the same value writes the same update.
				this.facade.seed((found as JSONDoc).children);
			}
		});
	}

	private scheduleSave() {
		if (this.saveScheduled || this.onSave === DocumentRoom.prototype.onSave) return;
		this.saveScheduled = true;
		void this.ctx.storage.setAlarm(Date.now() + this.saveAfter);
	}

	// ── Storage ──────────────────────────────────────────────────────────

	private load() {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS rows (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				record INTEGER NOT NULL,
				part INTEGER NOT NULL,
				parts INTEGER NOT NULL,
				bytes BLOB NOT NULL
			)`
		);
		this.sql.exec(
			'CREATE TABLE IF NOT EXISTS replicas (replica INTEGER PRIMARY KEY, user TEXT NOT NULL)'
		);
		const records = this.records();
		if (records.length === 0) {
			// A fresh room: the generation record is the container's first row.
			this.ctx.storage.transactionSync(() =>
				this.insert('generation', encodeJSON(E.GENERATION_RECORD))
			);
			this.adopt(crdt.createDoc());
			return;
		}
		try {
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
			this.failure = error as Error;
		}
	}

	/** Reassembled logical records in write order; a torn record throws. */
	records(): Array<{ kind: RowKind; bytes: Uint8Array<ArrayBuffer> }> {
		const byRecord = new Map<number, Row[]>();
		for (const row of this.sql.exec<Row>(
			'SELECT kind, record, part, parts, bytes FROM rows ORDER BY seq'
		)) {
			const parts = byRecord.get(row.record) ?? [];
			parts.push(row);
			byRecord.set(row.record, parts);
			this.nextRecord = Math.max(this.nextRecord, row.record + 1);
		}
		return [...byRecord.values()].map((parts) => {
			if (parts.length !== parts[0].parts) throw new Error('torn record');
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

	/** One logical record split into rows ≤ `maxRowBytes` (callers run it in a transaction). */
	private insert(kind: RowKind, bytes: Uint8Array) {
		const record = this.nextRecord++;
		const parts = Math.max(1, Math.ceil(bytes.length / this.maxRowBytes));
		for (let part = 0; part < parts; part++) {
			this.sql.exec(
				'INSERT INTO rows (kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?)',
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
	 * snapshot, `mergeUpdates` of every stored record, atomically. Runs by
	 * itself after `compactAfter` update records; callable over RPC (e.g.
	 * from the host's own alarm).
	 */
	compact(): { rows: number } {
		return noTimers(() => {
			this.requireDoc();
			const merged = Y.mergeUpdates(
				this.records()
					.slice(1)
					.map((record) => record.bytes)
			);
			this.ctx.storage.transactionSync(() => {
				this.sql.exec('DELETE FROM rows');
				this.insert('generation', encodeJSON(E.GENERATION_RECORD));
				this.insert('snapshot', merged);
			});
			this.updates = 0;
			return { rows: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rows').one().n };
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
		this.rebuild();
		this.depart(ws);
		try {
			ws.close(1011, 'storage failure');
		} catch {
			// already closing
		}
	}

	/** Drop the live doc for the stored rows (a failed append); returns the append's error. */
	private rebuild(): unknown {
		const error = this.unstored;
		this.refusals.push({ reason: 'storage', detail: String(error) });
		const stale = this.doc;
		this.doc = null;
		this.unstored = null;
		this.load();
		stale?.destroy();
		return error;
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
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (this.unstored !== null) return;
			try {
				this.ctx.storage.transactionSync(() => this.insert('update', update));
			} catch (error) {
				this.unstored = error;
				return;
			}
			this.broadcast(
				E.frame(E.messageSync, (e) => sync.writeUpdate(e, update)),
				origin
			);
			this.scheduleSave();
			if (++this.updates >= this.compactAfter) this.compact();
		});
	}

	// ── Identity ─────────────────────────────────────────────────────────

	/**
	 * May `user` write new structs under `clients`? A client id is the
	 * user's once it is registered to them; an unregistered id with no
	 * content in the room is registered now (when `register`); anything
	 * else — another user's id, or unregistered history — is refused.
	 * Returns the first refused id, or `null`.
	 */
	private claim(
		user: string,
		clients: Iterable<number>,
		sv: Map<number, number>,
		register: boolean
	): number | null {
		const fresh: number[] = [];
		for (const client of clients) {
			const owner = this.sql
				.exec<{ user: string }>('SELECT user FROM replicas WHERE replica = ?', client)
				.toArray()[0]?.user;
			if (owner === user) continue;
			if (owner !== undefined || (sv.get(client) ?? 0) > 0) return client;
			fresh.push(client);
		}
		if (register && fresh.length > 0) {
			this.ctx.storage.transactionSync(() => {
				for (const client of fresh) {
					this.sql.exec('INSERT INTO replicas (replica, user) VALUES (?, ?)', client, user);
				}
			});
		}
		return null;
	}

	// ── Hibernation WebSocket API ────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a websocket upgrade', { status: 426 });
		}
		const identity = readIdentity(request.headers);
		if (identity === null) return new Response('verified identity required', { status: 401 });
		return noTimers(() => {
			const doc = this.doc;
			if (doc !== null && identity.replica !== null) {
				const sv = stateVector(doc);
				if (this.claim(identity.user, [identity.replica], sv, !identity.readOnly) !== null) {
					this.refusals.push({ reason: 'replica', detail: identity.replica });
					return new Response('replica bound to another user', { status: 403 });
				}
			}
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment({ ...identity, clock: null } satisfies Attachment);
			if (doc === null) {
				this.refusals.push({ reason: 'container', detail: this.failure?.message });
				server.close(1011, 'room container refused');
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

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		noTimers(() => {
			// A refused socket is closing: frames it had in flight are dropped unread.
			if (ws.readyState !== WebSocket.OPEN) return;
			if (typeof message === 'string') {
				return this.refuse(ws, { reason: 'malformed', detail: 'text frame' });
			}
			const doc = this.doc;
			if (doc === null) return this.refuse(ws, { reason: 'container', detail: null });
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (!attachment?.user) return this.refuse(ws, { reason: 'identity', detail: null });
			const bytes = new Uint8Array(message);
			const decoder = E.createDecoder(bytes);
			// 1 · Admission: the generation word, before anything is decoded.
			if (!E.readProtocolVersion(decoder)) {
				return this.refuse(ws, { reason: 'generation', detail: bytes[0] });
			}
			try {
				const type = E.readVarUint(decoder);
				if (type === E.messageSync) return this.onSync(ws, attachment, doc, decoder);
				if (type === E.messageAwareness) {
					return this.onPresence(ws, attachment, doc, E.readVarUint8Array(decoder));
				}
				if (type === E.messageQueryAwareness) {
					return this.send(ws, presenceFrame([...this.presence.values()]));
				}
				this.refuse(ws, { reason: 'malformed', detail: `message type ${type}` });
			} catch (error) {
				this.refuse(ws, { reason: 'malformed', detail: String(error) });
			}
		});
	}

	webSocketClose(ws: WebSocket, code: number, reason: string) {
		noTimers(() => this.depart(ws));
		// Complete the closing handshake (a no-op where the runtime already
		// auto-replies). 1005/1006 are not sendable codes.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	webSocketError(ws: WebSocket) {
		noTimers(() => this.depart(ws));
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
		const syncType = E.readVarUint(decoder);
		if (syncType === E.messageYjsSyncStep1) {
			const sv = E.readVarUint8Array(decoder);
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
		const update = E.readVarUint8Array(decoder);
		// 2 · Access: a read-only socket writes nothing (it stays, and is told).
		if (attachment.readOnly) {
			this.refusals.push({ reason: 'read-only', detail: attachment.user });
			return this.send(
				ws,
				E.frame(E.messageAuth, (e) => E.writePermissionDenied(e, 'read-only'))
			);
		}
		// 3 · Attribution: new structs only under client ids this user owns.
		const decoded = Y.decodeUpdate(update);
		const sv = stateVector(doc);
		const refused = this.claim(attachment.user, newWriters(decoded, sv), sv, true);
		if (refused !== null) return this.refuse(ws, { reason: 'replica', detail: refused });
		// 4 · Schema: the inbound refusal of a foreign stamp (the update's,
		// or a pending one it would release — discarded, the sender kept).
		// Integrating persists (the doc's update handler) before the ack.
		const { applied, problem, discarded } = sync.applyRemote(doc, update, ws);
		if (this.unstored !== null) return this.recover(ws);
		if (problem !== null) return this.refuse(ws, { reason: 'schema', detail: problem });
		if (!applied) return this.refuse(ws, { reason: 'malformed', detail: 'undecodable update' });
		if (discarded) this.refusals.push({ reason: 'schema', detail: { discarded } });
		this.acknowledge(ws, doc, decoded.ds);
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
	 * wins, the attachment records the clock, the accepted entry is relayed.
	 * Entries for other replicas (a client re-sending what it heard) are dropped.
	 */
	private onPresence(ws: WebSocket, attachment: Attachment, doc: YDoc, update: Uint8Array) {
		const entries = E.readAwarenessEntries(update);
		let replica = attachment.replica;
		if (replica === null && entries.length > 0) {
			replica = entries[0].clientID;
			if (this.claim(attachment.user, [replica], stateVector(doc), !attachment.readOnly) !== null) {
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
		this.broadcast(presenceFrame([entry]), ws);
	}

	/** A refused frame is dropped whole and its socket closed (1008 policy violation). */
	private refuse(ws: WebSocket, refusal: Refusal) {
		this.refusals.push(refusal);
		this.depart(ws);
		try {
			ws.close(1008, `refused: ${refusal.reason}`);
		} catch {
			// already closing
		}
	}

	/** Send one frame — as chunks when it exceeds `maxFrameBytes` (bounded catch-up). */
	private send(ws: WebSocket, bytes: Uint8Array) {
		for (const piece of E.chunkFrame(bytes, this.maxFrameBytes)) ws.send(piece);
	}

	private broadcast(bytes: Uint8Array, except: unknown) {
		const pieces = E.chunkFrame(bytes, this.maxFrameBytes);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
			try {
				for (const piece of pieces) ws.send(piece);
			} catch {
				// a socket that died mid-broadcast gets its close event
			}
		}
	}
}
