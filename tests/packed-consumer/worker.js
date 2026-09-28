/**
 * Packed-consumer Worker entry: a minimal room Durable Object built ONLY on
 * the packed package's Worker-safe subpaths — `edytor/crdt` (the vendored
 * engine) and `edytor/crdt/edytor` (bindings, frame contract, wire codec,
 * instance-free awareness codec). A compact copy of the test fixture
 * `tests/do/room.ts` (which imports the same modules from source); bundled
 * and run in Miniflare by `smoke-worker.mjs`.
 */
import { DurableObject } from 'cloudflare:workers';
import * as Y from 'edytor/crdt';
import * as E from 'edytor/crdt/edytor';

const crdt = E.bindCrdt(Y);
const sync = crdt.sync;
const MAX_ROW_BYTES = 2_000_000 - 4096; // SQLite-backed DOs cap a row at 2 MB

const encodeJSON = (value) => new TextEncoder().encode(JSON.stringify(value));
const presenceFrame = (entries) =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));
const isGenerationRecord = (found) =>
	found?.engine === E.GENERATION_RECORD.engine &&
	found?.protocol === E.GENERATION_RECORD.protocol &&
	found?.schema === E.GENERATION_RECORD.schema;

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.doc = null;
		this.failure = null;
		this.presence = new Map();
		this.nextRecord = 0;
		void ctx.blockConcurrencyWhile(async () => this.load());
	}

	load() {
		this.sql.exec(
			'CREATE TABLE IF NOT EXISTS rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, record INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, bytes BLOB NOT NULL)'
		);
		const records = this.records();
		if (records.length === 0) {
			this.append('generation', encodeJSON(E.GENERATION_RECORD));
			return this.adopt(crdt.createDoc());
		}
		try {
			const [generation, ...rest] = records;
			const found = JSON.parse(new TextDecoder().decode(generation.bytes));
			if (generation.kind !== 'generation' || !isGenerationRecord(found)) {
				throw new E.GenerationMismatchError(`room ${this.ctx.id}`, found);
			}
			const merged = Y.mergeUpdates(rest.map((record) => record.bytes));
			this.adopt(crdt.admission.admitUpdate(merged, `room ${this.ctx.id}`));
		} catch (error) {
			this.failure = error;
		}
	}

	records() {
		const byRecord = new Map();
		for (const row of this.sql.exec(
			'SELECT kind, record, part, parts, bytes FROM rows ORDER BY seq'
		)) {
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

	append(kind, bytes) {
		this.ctx.storage.transactionSync(() => {
			const record = this.nextRecord++;
			const parts = Math.max(1, Math.ceil(bytes.length / MAX_ROW_BYTES));
			for (let part = 0; part < parts; part++) {
				this.sql.exec(
					'INSERT INTO rows (kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?)',
					kind,
					record,
					part,
					parts,
					bytes.slice(part * MAX_ROW_BYTES, (part + 1) * MAX_ROW_BYTES)
				);
			}
		});
	}

	adopt(doc) {
		this.doc = doc;
		doc.on('update', (update, origin) => {
			this.append('update', update);
			this.broadcast(
				E.frame(E.messageSync, (e) => sync.writeUpdate(e, update)),
				origin
			);
		});
	}

	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a websocket upgrade', { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ clients: [] });
		const doc = this.doc;
		if (doc === null) {
			server.close(1011, 'room container refused');
		} else {
			server.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc)));
			if (this.presence.size > 0) server.send(presenceFrame([...this.presence.values()]));
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, message) {
		const doc = this.doc;
		if (typeof message === 'string' || doc === null) return this.refuse(ws, 'malformed');
		const bytes = new Uint8Array(message);
		const decoder = E.createDecoder(bytes);
		if (!E.readProtocolVersion(decoder)) return this.refuse(ws, 'generation');
		try {
			const type = E.readVarUint(decoder);
			if (type === E.messageSync) {
				const syncType = E.readVarUint(decoder);
				const payload = E.readVarUint8Array(decoder);
				if (syncType === E.messageYjsSyncStep1) {
					ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, doc, payload)));
					if (sync.lacks(doc, payload)) {
						ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc)));
					}
					return;
				}
				const { applied, problem } = sync.applyRemote(doc, payload, ws);
				if (problem !== null) return this.refuse(ws, 'schema');
				if (!applied) return this.refuse(ws, 'malformed');
				return;
			}
			if (type === E.messageAwareness) {
				const mine = new Map(ws.deserializeAttachment()?.clients ?? []);
				for (const entry of E.readAwarenessEntries(E.readVarUint8Array(decoder))) {
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
				ws.serializeAttachment({ clients: [...mine] });
				return this.broadcast(bytes, ws);
			}
			if (type === E.messageQueryAwareness) {
				return ws.send(presenceFrame([...this.presence.values()]));
			}
			this.refuse(ws, 'malformed');
		} catch {
			this.refuse(ws, 'malformed');
		}
	}

	webSocketClose(ws, code, reason) {
		this.depart(ws);
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	webSocketError(ws) {
		this.depart(ws);
	}

	depart(ws) {
		const clients = ws.deserializeAttachment()?.clients ?? [];
		ws.serializeAttachment({ clients: [] });
		if (clients.length === 0) return;
		const gone = clients.map(([clientID, clock]) => {
			this.presence.delete(clientID);
			return { clientID, clock: clock + 1, state: null };
		});
		this.broadcast(presenceFrame(gone), ws);
	}

	refuse(ws, reason) {
		this.depart(ws);
		try {
			ws.close(1008, `refused: ${reason}`);
		} catch {
			// already closing
		}
	}

	broadcast(bytes, except) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(bytes);
			} catch {
				// its close event follows
			}
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ready');
		const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
		if (!match) return new Response('not found', { status: 404 });
		return env.ROOM.getByName(decodeURIComponent(match[1])).fetch(request);
	}
};
