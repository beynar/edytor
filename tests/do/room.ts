/**
 * TEST FIXTURE — a real Cloudflare Durable Object coordinating one edytor
 * document over hibernatable WebSockets. It is the runtime port of the
 * proof coordinator in `src/tests/crdt/arch-v2/do-coordinator.test.ts`;
 * the product export (`edytor/cloudflare`) is a later track and is NOT this
 * file.
 *
 * It imports ONLY the public CRDT entry (`src/lib/crdt/index.ts` =
 * `edytor/crdt/edytor`) and the vendored engine
 * (`src/lib/crdt/vendor/yjs/src/index.js` = `edytor/crdt`).
 *
 * The contract, entry point by entry point:
 *
 * - `fetch` (WebSocket upgrade): `ctx.acceptWebSocket(server)` — the
 *   hibernation API — an empty attachment, then our SyncStep1 and every
 *   present peer (the join rule from the server side).
 * - `webSocketMessage`: ADMIT first — the generation word before anything
 *   is decoded, then the inbound refusal of an update writing a foreign
 *   schema stamp (`sync.applyRemote`). A refused frame is never applied,
 *   stored or relayed; its socket is closed 1008 and its presence announced
 *   gone. Step1 is answered with Step2 (+ our Step1 when the asker holds
 *   something we lack); Step2/Update integrate; awareness is relayed
 *   verbatim through the instance-free codec (no `Awareness` instance — its
 *   sweep interval would keep the object from hibernating).
 * - every INTEGRATED update (never the raw inbound payload) is appended to
 *   SQLite as one logical record split into rows of at most
 *   `maxRowBytes` (DO SQLite caps a row at 2 MB), in one `transactionSync`,
 *   then broadcast to every other socket.
 * - `webSocketClose`/`webSocketError`: the departure the client may not have
 *   announced, read from the socket's attachment (client ids + clocks) — so
 *   it also works after a hibernation wake, when memory is gone.
 * - constructor: restore from SQLite alone under `blockConcurrencyWhile`:
 *   verify the container generation record, merge the records and stage
 *   them through `crdt.admission.admitUpdate`. A container of another
 *   generation never rebuilds: the room refuses every socket instead.
 * - `compact()` (RPC): the rows become the generation record + one chunked
 *   snapshot, atomically.
 *
 * No entry point schedules a timer: each runs under {@link noTimers}, which
 * throws if the engine, the sync protocol or admission tries (a Durable
 * Object with a pending timer never hibernates).
 */
import { DurableObject } from 'cloudflare:workers';
import * as E from '../../src/lib/crdt/index.js';
import type { AwarenessEntry, EngineApi, YDoc } from '../../src/lib/crdt/index.js';
// The vendored engine is plain JS (its typings are the ones `EngineApi` names).
// @ts-ignore -- untyped JS module; typed through `EngineApi` below
import * as RawY from '../../src/lib/crdt/vendor/yjs/src/index.js';

const Y = RawY as unknown as EngineApi;
const crdt = E.bindCrdt(Y);
const sync = crdt.sync;

/** Under SQLite-backed Durable Objects' 2 MB row cap, with room for the other columns. */
export const DEFAULT_MAX_ROW_BYTES = 2_000_000 - 4096;

export type RoomEnv = {
	/** Test knob: a smaller row size forces multi-row records with small updates. */
	EDYTOR_MAX_ROW_BYTES?: string | number;
};

export type Refusal = {
	reason: 'generation' | 'schema' | 'malformed' | 'container';
	detail: unknown;
};

/** What a socket's attachment holds: the awareness clients it speaks for, with their last clock. */
export type Attachment = { clients: Array<[clientID: number, clock: number]> };

type RowKind = 'generation' | 'update' | 'snapshot';

/**
 * Run an entry point with timers forbidden — a Durable Object with a
 * pending `setTimeout`/`setInterval` cannot hibernate. Entry points are
 * synchronous, so nothing else in the isolate observes the swap.
 */
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

const toBytes = (data: ArrayBuffer | ArrayBufferView): Uint8Array =>
	data instanceof Uint8Array
		? data
		: ArrayBuffer.isView(data)
			? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			: new Uint8Array(data);

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

export class Room extends DurableObject<RoomEnv> {
	readonly maxRowBytes: number;
	/** The live document; `null` when the container was refused at restore. */
	doc: YDoc | null = null;
	/** Why the stored container was refused (another generation, a torn record…). */
	failure: Error | null = null;
	/** Latest awareness entry per client id, for join snapshots (in memory: lost on hibernation). */
	presence = new Map<number, AwarenessEntry>();
	/** Refused frames since this instance started (in memory; tests read it via `runInDurableObject`). */
	refusals: Refusal[] = [];
	/** How this instance came to be: a fresh container, or a restore of N stored records. */
	origin: { kind: 'fresh' } | { kind: 'restored'; records: number } = { kind: 'fresh' };
	private nextRecord = 0;
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: RoomEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		const configured = Number(env.EDYTOR_MAX_ROW_BYTES);
		this.maxRowBytes =
			Number.isInteger(configured) && configured > 0
				? Math.min(configured, DEFAULT_MAX_ROW_BYTES)
				: DEFAULT_MAX_ROW_BYTES;
		void ctx.blockConcurrencyWhile(async () => {
			noTimers(() => this.load());
		});
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
		const records = this.records();
		if (records.length === 0) {
			// A fresh room: the generation record is the container's first row.
			this.append('generation', encodeJSON(E.GENERATION_RECORD));
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
		} catch (error) {
			this.failure = error as Error;
		}
	}

	/** Reassembled logical records in write order; a torn record throws. */
	records(): Array<{ kind: RowKind; bytes: Uint8Array<ArrayBuffer> }> {
		const byRecord = new Map<
			number,
			Array<{ kind: RowKind; part: number; parts: number; bytes: Uint8Array<ArrayBuffer> }>
		>();
		for (const row of this.sql.exec<{
			kind: RowKind;
			record: number;
			part: number;
			parts: number;
			bytes: ArrayBuffer;
		}>('SELECT kind, record, part, parts, bytes FROM rows ORDER BY seq')) {
			const parts = byRecord.get(row.record) ?? [];
			parts.push({ ...row, bytes: new Uint8Array(row.bytes) });
			byRecord.set(row.record, parts);
			this.nextRecord = Math.max(this.nextRecord, row.record + 1);
		}
		return [...byRecord.values()].map((parts) => {
			if (parts.length !== parts[0].parts) throw new Error('torn record');
			parts.sort((a, b) => a.part - b.part);
			const bytes = new Uint8Array(parts.reduce((n, p) => n + p.bytes.length, 0));
			let at = 0;
			for (const part of parts) {
				bytes.set(part.bytes, at);
				at += part.bytes.length;
			}
			return { kind: parts[0].kind, bytes };
		});
	}

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

	/** One logical record, split into rows ≤ `maxRowBytes`, written atomically. */
	private append(kind: RowKind, bytes: Uint8Array) {
		this.ctx.storage.transactionSync(() => this.insert(kind, bytes));
	}

	/** Compaction — the rows become the generation record + one chunked snapshot. */
	compact(): { rows: number } {
		return noTimers(() => {
			const doc = this.requireDoc();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec('DELETE FROM rows');
				this.insert('generation', encodeJSON(E.GENERATION_RECORD));
				this.insert('snapshot', Y.encodeStateAsUpdate(doc));
			});
			return { rows: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rows').one().n };
		});
	}

	private requireDoc(): YDoc {
		if (this.doc === null) throw this.failure ?? new Error('room has no document');
		return this.doc;
	}

	private adopt(doc: YDoc) {
		this.doc = doc;
		// Every INTEGRATED update is persisted first, then relayed to
		// everyone but its sender (the socket is the transaction origin).
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			this.append('update', update);
			this.broadcast(
				E.frame(E.messageSync, (e) => sync.writeUpdate(e, update)),
				origin
			);
		});
	}

	// ── Hibernation WebSocket API ────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a websocket upgrade', { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		noTimers(() => {
			server.serializeAttachment({ clients: [] } satisfies Attachment);
			if (this.doc === null) {
				this.refusals.push({ reason: 'container', detail: this.failure?.message });
				server.close(1011, 'room container refused');
				return;
			}
			const doc = this.doc;
			server.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc)));
			if (this.presence.size > 0) server.send(presenceFrame([...this.presence.values()]));
		});
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		noTimers(() => {
			if (typeof message === 'string') {
				return this.refuse(ws, { reason: 'malformed', detail: 'text frame' });
			}
			const doc = this.doc;
			if (doc === null) return this.refuse(ws, { reason: 'container', detail: null });
			const bytes = toBytes(message);
			const decoder = E.createDecoder(bytes);
			// 1 · Admission: the generation word, before anything is decoded.
			if (!E.readProtocolVersion(decoder)) {
				return this.refuse(ws, { reason: 'generation', detail: bytes[0] });
			}
			try {
				const type = E.readVarUint(decoder);
				if (type === E.messageSync) return this.onSync(ws, doc, decoder);
				if (type === E.messageAwareness) {
					this.onPresence(ws, E.readVarUint8Array(decoder));
					return this.broadcast(bytes, ws); // relayed verbatim
				}
				if (type === E.messageQueryAwareness) {
					return ws.send(presenceFrame([...this.presence.values()]));
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
		// auto-replies to a client close). 1005/1006 are not sendable codes.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	webSocketError(ws: WebSocket) {
		noTimers(() => this.depart(ws));
	}

	/**
	 * The departure announcement the client may not have sent — read from
	 * the socket's attachment, so it works after a hibernation wake too.
	 */
	private depart(ws: WebSocket) {
		const attachment = ws.deserializeAttachment() as Attachment | null;
		const clients = attachment?.clients ?? [];
		// Announce once: a later close/error event on this socket is a no-op.
		ws.serializeAttachment({ clients: [] } satisfies Attachment);
		if (clients.length === 0) return;
		const gone = clients.map(([clientID, clock]) => {
			this.presence.delete(clientID);
			return { clientID, clock: clock + 1, state: null };
		});
		this.broadcast(presenceFrame(gone), ws);
	}

	private onSync(ws: WebSocket, doc: YDoc, decoder: E.Decoder) {
		const syncType = E.readVarUint(decoder);
		if (syncType === E.messageYjsSyncStep1) {
			const sv = E.readVarUint8Array(decoder);
			ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, doc, sv)));
			if (sync.lacks(doc, sv)) {
				ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc)));
			}
			return;
		}
		if (syncType === E.messageYjsSyncStep2 || syncType === E.messageYjsUpdate) {
			// 2 · Admission: the inbound refusal of a foreign schema stamp.
			const { applied, problem } = sync.applyRemote(doc, E.readVarUint8Array(decoder), ws);
			if (problem !== null) return this.refuse(ws, { reason: 'schema', detail: problem });
			if (!applied) return this.refuse(ws, { reason: 'malformed', detail: 'undecodable update' });
			return;
		}
		this.refuse(ws, { reason: 'malformed', detail: `sync type ${syncType}` });
	}

	/**
	 * Track presence from an awareness update (instance-free codec): the
	 * newest clock per client wins; the socket's attachment records the
	 * clients it speaks for.
	 */
	private onPresence(ws: WebSocket, update: Uint8Array) {
		const mine = new Map((ws.deserializeAttachment() as Attachment | null)?.clients ?? []);
		for (const entry of E.readAwarenessEntries(update)) {
			const known = this.presence.get(entry.clientID);
			if (known && known.clock > entry.clock) continue;
			if (entry.state === null) {
				this.presence.delete(entry.clientID);
				mine.delete(entry.clientID);
			} else {
				this.presence.set(entry.clientID, entry);
				mine.set(entry.clientID, entry.clock);
			}
		}
		ws.serializeAttachment({ clients: [...mine] } satisfies Attachment);
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

	private broadcast(bytes: Uint8Array, except: unknown) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(bytes);
			} catch {
				// a socket that died mid-broadcast gets its close event
			}
		}
	}
}
