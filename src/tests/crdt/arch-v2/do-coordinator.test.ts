/**
 * Infra — the Worker-safe CRDT boundary, proven at runtime: a MINIMAL
 * server coordinator built the way a Cloudflare Durable Object would build
 * it, with no Svelte and no browser globals.
 *
 * Maintainer constraint (architecture v2): the CRDT engine runs
 * server-side in a Durable Object that coordinates clients over WebSockets
 * (a central DO, not P2P). This file imports ONLY the public CRDT entry
 * (`src/lib/crdt/index.ts` = `edytor/crdt/edytor`: the frame contract, the
 * wire read helpers, the instance-free awareness codec) and the vendored
 * engine (`src/lib/crdt/vendor/yjs/src/index.js` = `edytor/crdt`) — no
 * direct lib0 — and it loads them only AFTER `window`, `document`, `indexedDB`,
 * `BroadcastChannel`, `localStorage` and `navigator.locks` are gone from
 * `globalThis` (`navigator` is left Worker-shaped: a user agent, no locks).
 *
 * What the coordinator does — the DO contract the README's "Server
 * coordinator" section names:
 * - ADMIT every inbound frame: the generation word first (a frame of
 *   another generation is refused before anything is decoded), then the
 *   inbound refusal of an update that writes a foreign schema stamp
 *   (`applyRemote`); a refused frame is never applied, stored or relayed,
 *   and the offending socket is closed (1008);
 * - SYNC: answer Step1 with Step2 (plus our own Step1 when the asker holds
 *   anything we lack — the join rule), integrate Step2/Update;
 * - PERSIST append-only: every integrated update becomes one record in an
 *   in-memory row store standing in for DO SQLite storage, split into
 *   parts no larger than `maxRowBytes` (SQLite-backed DOs cap a row/BLOB
 *   at 2 MB) and written as one atomic batch;
 * - COMPACT: replace the rows with a chunked snapshot of the state;
 * - BROADCAST each integrated update to every other connection;
 * - RELAY awareness without an `Awareness` instance (its constructor
 *   starts a 3 s sweep interval, and a Durable Object with a pending
 *   timer never hibernates) through `readAwarenessEntries` /
 *   `writeAwarenessEntries`: forward each presence frame to the others,
 *   keep the latest entry per client so a joiner gets every present peer,
 *   record each socket's client ids + clocks in its attachment
 *   (`serializeAttachment`, which survives hibernation), and on close
 *   announce them removed — also after a hibernation wake.
 *
 * Hibernation compatibility is asserted, not assumed: every coordinator
 * entry point runs under {@link noTimers}, which throws if the engine, the
 * sync protocol or the admission gate schedules a timer.
 *
 * The coordinator is a proof, not a product module — it lives in this test
 * on purpose. Clients are the shipped headless path: `createDocument` +
 * `document.attachSync(createWebsocketSync(...))` over a socket fake that
 * delivers asynchronously, like the network.
 *
 * Expectations are hand-authored from the edits the test performs, never
 * derived from coordinator output.
 */
// @ts-nocheck -- test lane is excluded from svelte-check; engine internals are untyped here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ── Worker-shaped globals ────────────────────────────────────────────────
//
// Removed BEFORE the CRDT modules load (dynamic imports in `beforeAll`), so
// an import-time or runtime dependency on any of them fails this test.
const REMOVED = ['window', 'document', 'indexedDB', 'BroadcastChannel', 'localStorage'];
const saved = new Map<string, PropertyDescriptor | undefined>();

const stripBrowserGlobals = () => {
	for (const key of [...REMOVED, 'navigator']) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	for (const key of REMOVED) {
		Object.defineProperty(globalThis, key, {
			value: undefined,
			configurable: true,
			writable: true
		});
		delete globalThis[key];
	}
	// Workers have a `navigator` (user agent) but no Web Locks.
	Object.defineProperty(globalThis, 'navigator', {
		value: { userAgent: 'Cloudflare-Workers' },
		configurable: true,
		writable: true
	});
};

const restoreBrowserGlobals = () => {
	for (const [key, descriptor] of saved) {
		delete globalThis[key];
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
	}
};

let Y; // vendored engine — `edytor/crdt`
let E; // public CRDT entry — `edytor/crdt/edytor`
let crdt;
let sync;

beforeAll(async () => {
	stripBrowserGlobals();
	for (const key of REMOVED) expect(key in globalThis, key).toBe(false);
	expect(globalThis.navigator.locks).toBeUndefined();
	Y = await import('../../../lib/crdt/vendor/yjs/src/index.js');
	E = await import('../../../lib/crdt/index.js');
	crdt = E.bindCrdt(Y);
	sync = crdt.sync;
});

afterAll(() => {
	restoreBrowserGlobals();
});

// ── Transport: a Durable Object's hibernatable sockets, faked ────────────
//
// `ClientSocket` is what the client's WebsocketProvider dials
// (`WebSocketPolyfill`); `accept` hands its server end to the room's
// coordinator like `ctx.acceptWebSocket(server)`. Every delivery is a
// macrotask, both ways.

const rooms = new Map<string, Coordinator>();
const roomOf = (url: string) => new URL(url).pathname.split('/').filter(Boolean).pop()!;
// Captured before any guard: the fake network's own deliveries.
const nativeSetTimeout = globalThis.setTimeout;
/**
 * Deliveries scheduled and not yet run. Convergence is asserted at
 * quiescence (`inFlight === 0`): matching JSON alone can be a transient
 * state — e.g. B's delete / undo / delete of p3 arrive as three frames,
 * and a peer holding only the first already renders the final JSON while
 * the other two are still on the wire (seen under load: the state
 * vectors then differ by B's last struct).
 */
let inFlight = 0;
const later = (fn: () => void) => {
	inFlight++;
	nativeSetTimeout(() => {
		inFlight--;
		fn();
	}, 0);
};

/**
 * Run a coordinator entry point with timers forbidden — a Durable Object
 * with a pending `setTimeout`/`setInterval` cannot hibernate.
 */
const noTimers = <T>(fn: () => T): T => {
	const saved = [globalThis.setTimeout, globalThis.setInterval];
	const forbidden = () => {
		throw new Error('coordinator scheduled a timer (a Durable Object could not hibernate)');
	};
	globalThis.setTimeout = forbidden;
	globalThis.setInterval = forbidden;
	try {
		return fn();
	} finally {
		[globalThis.setTimeout, globalThis.setInterval] = saved;
	}
};

/** Max serialized attachment per hibernatable socket (DO `serializeAttachment`). */
const ATTACHMENT_LIMIT = 16384;

class ServerSocket {
	closed: { code: number; reason: string } | null = null;
	private attachment: string | undefined;
	constructor(private client: ClientSocket) {}
	send(bytes: Uint8Array) {
		if (this.closed) return;
		const copy = bytes.slice();
		later(() => this.client._deliver(copy));
	}
	close(code = 1000, reason = '') {
		if (this.closed) return;
		this.closed = { code, reason };
		later(() => this.client._closedByServer(code, reason));
	}
	serializeAttachment(value: unknown) {
		const json = JSON.stringify(value);
		if (json.length > ATTACHMENT_LIMIT) throw new Error('attachment over 16 KiB');
		this.attachment = json;
	}
	deserializeAttachment() {
		return this.attachment === undefined ? null : JSON.parse(this.attachment);
	}
}

/**
 * The client end. Frames are routed to whatever coordinator holds the room
 * at delivery time — after a hibernation wake that is a NEW instance
 * holding the same (server-end) sockets.
 */
class ClientSocket {
	static OPEN = 1;
	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;
	server: ServerSocket;
	private room: string;
	constructor(public url: string) {
		this.server = new ServerSocket(this);
		this.room = roomOf(url);
		later(() => {
			const coordinator = rooms.get(this.room);
			if (this.readyState !== 0 || !coordinator) return this._closedByServer(1011, 'no room');
			this.readyState = 1;
			coordinator.acceptWebSocket(this.server);
			this.onopen?.({ type: 'open' });
		});
	}
	send(data: Uint8Array | ArrayBuffer) {
		if (this.readyState !== 1) return;
		const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
		later(() => {
			if (!this.server.closed) rooms.get(this.room)?.webSocketMessage(this.server, bytes);
		});
	}
	close() {
		this.drop();
	}
	/** The socket goes away without any goodbye frame (close, or a network drop). */
	drop() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server.closed ??= { code: 1000, reason: 'client close' };
		later(() => rooms.get(this.room)?.webSocketClose(this.server));
		this.onclose?.({ code: 1000 });
	}
	_deliver(bytes: Uint8Array) {
		if (this.readyState !== 1) return;
		this.onmessage?.({ data: bytes.buffer });
	}
	_closedByServer(code: number, reason: string) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

// ── Storage: an append-only row store standing in for DO SQLite ──────────

type Row = {
	seq: number;
	kind: 'generation' | 'update' | 'snapshot';
	record: number;
	part: number;
	parts: number;
	bytes: Uint8Array;
};

class RowStore {
	rows: Row[] = [];
	private seq = 0;
	private record = 0;
	writes = 0;
	constructor(readonly maxRowBytes: number) {}
	/** One logical record, split into parts ≤ `maxRowBytes`, written as one batch (DO: `transactionSync`). */
	append(kind: Row['kind'], bytes: Uint8Array) {
		this.rows.push(...this.split(kind, bytes));
		this.writes++;
	}
	/** Compaction: the whole table replaced by `rows`, atomically. */
	replace(rows: Array<[Row['kind'], Uint8Array]>) {
		this.rows = rows.flatMap(([kind, bytes]) => this.split(kind, bytes));
		this.writes++;
	}
	/** Reassembled records in write order. */
	records(): Array<{ kind: Row['kind']; bytes: Uint8Array }> {
		const byRecord = new Map<number, Row[]>();
		for (const row of [...this.rows].sort((a, b) => a.seq - b.seq)) {
			byRecord.set(row.record, [...(byRecord.get(row.record) ?? []), row]);
		}
		return [...byRecord.values()].map((parts) => {
			if (parts.length !== parts[0].parts) throw new Error('torn record');
			const bytes = new Uint8Array(parts.reduce((n, p) => n + p.bytes.length, 0));
			let at = 0;
			for (const p of parts.sort((a, b) => a.part - b.part)) {
				bytes.set(p.bytes, at);
				at += p.bytes.length;
			}
			return { kind: parts[0].kind, bytes };
		});
	}
	private split(kind: Row['kind'], bytes: Uint8Array): Row[] {
		const record = this.record++;
		const parts = Math.max(1, Math.ceil(bytes.length / this.maxRowBytes));
		return Array.from({ length: parts }, (_, part) => ({
			seq: this.seq++,
			kind,
			record,
			part,
			parts,
			bytes: bytes.slice(part * this.maxRowBytes, (part + 1) * this.maxRowBytes)
		}));
	}
}

// ── The coordinator (what a Durable Object would run) ────────────────────

type AwarenessEntry = { clientID: number; clock: number; state: Record<string, unknown> | null };

type Refusal = { reason: 'generation' | 'schema' | 'malformed'; detail: unknown };

/** What a socket's attachment holds: the awareness clients it speaks for, with their last clock. */
type Attachment = { clients: Array<[clientID: number, clock: number]> };

class Coordinator {
	doc;
	/** The accepted sockets — a DO reads them back with `ctx.getWebSockets()`. */
	sockets = new Set<ServerSocket>();
	/** Latest awareness entry per client id, for join snapshots (in memory: lost on hibernation). */
	presence = new Map<number, AwarenessEntry>();
	refusals: Refusal[] = [];
	private encodeText = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

	private constructor(
		readonly name: string,
		readonly store: RowStore,
		doc
	) {
		this.doc = doc;
		// Every INTEGRATED update — never the raw inbound payload — is
		// persisted first, then relayed to everyone but its sender.
		doc.on('update', (update: Uint8Array, origin) => {
			this.store.append('update', update);
			this.broadcast(
				E.frame(E.messageSync, (e) => sync.writeUpdate(e, update)),
				origin
			);
		});
	}

	/** A fresh room: the generation record is the container's first row. */
	static create(name: string, store: RowStore) {
		return noTimers(() => {
			store.append('generation', new TextEncoder().encode(JSON.stringify(E.GENERATION_RECORD)));
			return new Coordinator(name, store, crdt.createDoc());
		});
	}

	/**
	 * Rebuild from storage alone (DO constructor after eviction): verify
	 * the container generation, then stage the merged records through the
	 * document admission gate before adopting them.
	 */
	static restore(name: string, store: RowStore) {
		return noTimers(() => {
			const [generation, ...records] = store.records();
			const found = JSON.parse(new TextDecoder().decode(generation.bytes));
			if (
				generation.kind !== 'generation' ||
				found.engine !== E.GENERATION_RECORD.engine ||
				found.protocol !== E.GENERATION_RECORD.protocol ||
				found.schema !== E.GENERATION_RECORD.schema
			) {
				throw new E.GenerationMismatchError(name, found);
			}
			const merged = Y.mergeUpdates(records.map((r) => r.bytes));
			const doc = crdt.admission.admitUpdate(merged, `room ${name}`);
			return new Coordinator(name, store, doc);
		});
	}

	// Durable Object hibernation-API shaped entry points.

	acceptWebSocket(ws: ServerSocket) {
		noTimers(() => {
			this.sockets.add(ws);
			ws.serializeAttachment({ clients: [] } satisfies Attachment);
			// The join rule from our side: ask for what the client holds, and
			// hand it every present peer.
			ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, this.doc)));
			if (this.presence.size > 0) ws.send(presenceFrame([...this.presence.values()]));
		});
	}

	webSocketMessage(ws: ServerSocket, bytes: Uint8Array) {
		noTimers(() => {
			const decoder = E.createDecoder(bytes);
			// 1 · Admission: the generation word, before anything is decoded.
			if (!E.readProtocolVersion(decoder)) {
				return this.refuse(ws, { reason: 'generation', detail: bytes[0] });
			}
			try {
				const type = E.readVarUint(decoder);
				if (type === E.messageSync) return this.onSync(ws, decoder);
				if (type === E.messageAwareness) {
					this.onPresence(ws, E.readVarUint8Array(decoder));
					return this.broadcast(bytes, ws); // relayed verbatim
				}
				if (type === E.messageQueryAwareness) {
					return ws.send(presenceFrame([...this.presence.values()]));
				}
				this.refuse(ws, { reason: 'malformed', detail: `message type ${type}` });
			} catch (error) {
				this.refuse(ws, { reason: 'malformed', detail: error });
			}
		});
	}

	/**
	 * The departure announcement the client may not have sent — read from
	 * the socket's attachment, so it works after a hibernation wake too.
	 */
	webSocketClose(ws: ServerSocket) {
		noTimers(() => {
			if (!this.sockets.delete(ws)) return;
			const { clients } = (ws.deserializeAttachment() ?? { clients: [] }) as Attachment;
			if (clients.length === 0) return;
			const gone = clients.map(([clientID, clock]) => {
				this.presence.delete(clientID);
				return { clientID, clock: clock + 1, state: null };
			});
			this.broadcast(presenceFrame(gone), ws);
		});
	}

	/** Hibernation: the in-memory object goes away, the sockets (and their attachments) stay. */
	hibernate(): ServerSocket[] {
		const sockets = [...this.sockets];
		this.sockets.clear();
		this.presence.clear();
		this.doc.destroy();
		return sockets;
	}

	/** After a wake: the runtime hands the surviving sockets back (`ctx.getWebSockets()`). */
	adopt(sockets: ServerSocket[]) {
		for (const ws of sockets) this.sockets.add(ws);
	}

	/** Compaction — the rows become the generation record + one chunked snapshot. */
	compact() {
		noTimers(() =>
			this.store.replace([
				['generation', this.encodeText(E.GENERATION_RECORD)],
				['snapshot', Y.encodeStateAsUpdate(this.doc)]
			])
		);
	}

	/** Eviction: sockets die with the object; nothing in memory survives. */
	evict() {
		for (const ws of this.sockets) ws.close(1001, 'evicted');
		this.sockets.clear();
		this.presence.clear();
		this.doc.destroy();
	}

	private onSync(ws: ServerSocket, decoder) {
		const syncType = E.readVarUint(decoder);
		if (syncType === E.messageYjsSyncStep1) {
			const sv = E.readVarUint8Array(decoder);
			ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, this.doc, sv)));
			if (sync.lacks(this.doc, sv)) {
				ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, this.doc)));
			}
			return;
		}
		if (syncType === E.messageYjsSyncStep2 || syncType === E.messageYjsUpdate) {
			// 2 · Admission: the inbound refusal of a foreign schema stamp.
			// `ws` is the transaction origin, so the doc's `update` handler
			// persists + relays to everyone else.
			const { applied, problem } = sync.applyRemote(this.doc, E.readVarUint8Array(decoder), ws);
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
	private onPresence(ws: ServerSocket, update: Uint8Array) {
		const mine = new Map((ws.deserializeAttachment() as Attachment).clients);
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
	private refuse(ws: ServerSocket, refusal: Refusal) {
		this.refusals.push(refusal);
		ws.close(1008, `refused: ${refusal.reason}`);
		this.webSocketClose(ws);
	}

	private broadcast(bytes: Uint8Array, except: unknown) {
		for (const ws of this.sockets) if (ws !== except) ws.send(bytes);
	}
}

/** An awareness frame carrying `entries` — no `Awareness` instance involved. */
const presenceFrame = (entries: AwarenessEntry[]): Uint8Array =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));

// ── Clients: the shipped headless document + websocket sync path ─────────

const SERVER = 'wss://edytor.example/rooms';

const until = async (cond: () => boolean, what: string, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
};

const connect = (document, room: string) =>
	document.attachSync(
		crdt.providers.createWebsocketSync({
			serverUrl: SERVER,
			roomName: room,
			WebSocketPolyfill: ClientSocket,
			// Each client stands for another machine: no cross-tab channel between them.
			disableBc: true
		})
	);

/**
 * The server's document as JSON — read through a bare facade
 * (`bindCrdt(Y).doc.create`), which writes nothing. (`attachDocument`
 * would compose an ACTOR: it records the server's client id in the
 * replicated attribution dictionary — a write every client then receives.)
 */
const serverJSON = (coordinator: Coordinator) => {
	const facade = crdt.doc.create(coordinator.doc);
	try {
		return facade.toJSON();
	} finally {
		facade.dispose();
	}
};

/** A varuint as lib0 writes it — only to forge frames of OTHER builds (foreign generation words). */
const varUint = (n: number): number[] => {
	const out: number[] = [];
	for (; n > 0x7f; n = Math.floor(n / 128)) out.push(0x80 | (n & 0x7f));
	out.push(n);
	return out;
};

const svOf = (doc) => Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc)));

const para = (id: string, text: string) => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

/** Strip what the edits do not author (empty data / children) for comparison. */
const shape = (json) => ({
	children: json.children.map((b) => ({
		id: b.id,
		type: b.type,
		text: (b.content ?? []).map((c) => c.text ?? '').join('')
	}))
});

describe('Infra — Worker-safe CRDT boundary: a Durable Object coordinator', () => {
	it('runs without browser globals: sync, refusal, persistence, rebuild, late join', async () => {
		const ROOM = 'doc-1';
		const MAX_ROW_BYTES = 256; // forces multi-part records (DO SQLite: 2 MB/row)
		const store = new RowStore(MAX_ROW_BYTES);
		const server = Coordinator.create(ROOM, store);
		rooms.set(ROOM, server);

		// Client A starts local-first with a seed; client B joins empty.
		const a = E.createDocument({
			value: { children: [para('p1', 'hello')] },
			actor: { id: 'ada' },
			history: { captureTimeout: 0 }
		});
		const releaseA = connect(a, ROOM);
		await until(() => serverJSON(server).children.length === 1, 'A seed on the server');

		// A's presence is held by the relay before B exists.
		a.awareness.setLocalStateField('user', { name: 'Ada' });
		await until(() => server.presence.has(a.doc.clientID), 'A presence at the relay');

		const b = E.createDocument({ actor: { id: 'bob' }, history: { captureTimeout: 0 } });
		expect(b.ready).toBe(false);
		const releaseB = connect(b, ROOM);
		await until(() => b.ready, 'B hydrated from the coordinator');
		expect(shape(b.facade.toJSON())).toEqual({
			children: [{ id: 'p1', type: 'paragraph', text: 'hello' }]
		});
		// The joiner received the presence already in the room.
		await until(
			() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Ada',
			'A presence at B (join snapshot)'
		);

		// Concurrent editing through the document facade.
		const ok = (result) => expect(result.status).toBe('applied');
		ok(a.transact(() => a.facade.insertText('p1', 5, ' world')));
		ok(
			b.transact(() =>
				b.facade.insertBlock({ parent: null, index: 1 }, { id: 'p2', type: 'paragraph' })
			)
		);
		ok(b.transact(() => b.facade.insertText('p2', 0, 'second line')));
		await until(
			() =>
				a.facade.isVisibleBlock('p2') &&
				a.facade.blockText('p2') === 'second line' &&
				b.facade.blockText('p1') === 'hello world',
			'first exchange'
		);
		ok(a.transact(() => a.facade.splitBlock('p1', 5, 'p1b'))); // "hello" | " world"
		ok(b.transact(() => b.facade.deleteText('p2', 0, 7))); // "line"
		ok(
			b.transact(() =>
				b.facade.insertBlock(
					{ parent: null, index: 3 },
					{ id: 'p3', type: 'paragraph', content: [{ kind: 'text', text: 'doomed' }] }
				)
			)
		);
		await until(
			() =>
				b.facade.isVisibleBlock('p1b') &&
				a.facade.isVisibleBlock('p3') &&
				a.facade.blockText('p2') === 'line',
			'second exchange'
		);
		// Undo is actor-local: each client undoes only its own last step.
		ok(a.transact(() => a.facade.insertText('p1b', 6, '!')));
		expect(a.facade.blockText('p1b')).toBe(' world!');
		a.history.undo(); // drops "!"
		expect(a.facade.blockText('p1b')).toBe(' world');
		ok(b.transact(() => b.facade.deleteBlock('p3')));
		expect(b.facade.isVisibleBlock('p3')).toBe(false);
		b.history.undo(); // restores p3
		expect(b.facade.isVisibleBlock('p3')).toBe(true);
		expect(b.facade.blockText('p3')).toBe('doomed');
		ok(b.transact(() => b.facade.deleteBlock('p3'))); // and deletes it for good

		const expected = {
			children: [
				{ id: 'p1', type: 'paragraph', text: 'hello' },
				{ id: 'p1b', type: 'paragraph', text: ' world' },
				{ id: 'p2', type: 'paragraph', text: 'line' }
			]
		};
		await until(
			() =>
				JSON.stringify(shape(a.facade.toJSON())) === JSON.stringify(expected) &&
				JSON.stringify(shape(b.facade.toJSON())) === JSON.stringify(expected) &&
				JSON.stringify(shape(serverJSON(server))) === JSON.stringify(expected) &&
				inFlight === 0,
			'convergence'
		);
		// Convergence: both clients and the server serialize identically.
		expect(b.facade.toJSON()).toEqual(a.facade.toJSON());
		expect(serverJSON(server)).toEqual(a.facade.toJSON());
		expect(svOf(server.doc)).toEqual(svOf(a.doc));
		expect(svOf(b.doc)).toEqual(svOf(a.doc));

		// Awareness relay, live: B's presence reaches A through the DO.
		b.awareness.setLocalStateField('user', { name: 'Bob' });
		await until(
			() => a.awareness.getStates().get(b.doc.clientID)?.user?.name === 'Bob',
			'B presence at A'
		);
		expect(server.presence.get(b.doc.clientID)!.state!.user).toEqual({ name: 'Bob' });
		expect(server.presence.has(server.doc.clientID)).toBe(false);

		// Records are stored in parts no larger than a row allows.
		expect(store.rows.every((r) => r.bytes.length <= MAX_ROW_BYTES)).toBe(true);

		// ── Refusal: another generation, and a same-generation forged stamp ──
		const rowsBefore = store.rows.map((r) => r.bytes);
		const refusalsBefore = server.refusals.length;
		const aJSON = JSON.stringify(a.facade.toJSON());

		const rogue = async (bytes: Uint8Array) => {
			const socket = new ClientSocket(`${SERVER}/${ROOM}`);
			await until(() => socket.readyState === 1, 'rogue open');
			socket.send(bytes);
			await until(() => socket.readyState === 3, 'rogue closed by the coordinator');
		};
		/** An update from a peer holding the server's state. */
		const peerUpdate = (write) => {
			const peer = new Y.Doc();
			Y.applyUpdate(peer, Y.encodeStateAsUpdate(server.doc));
			const out = [];
			peer.on('update', (u) => out.push(u));
			write(peer);
			return Y.mergeUpdates(out);
		};
		/** A sync Update frame as a build speaking generation word `word` writes it. */
		const updateFrame = (word: number, update: Uint8Array) => {
			const ours = E.frame(E.messageSync, (e) => sync.writeUpdate(e, update));
			return Uint8Array.from([...varUint(word), ...ours.subarray(varUint(E.GENERATION).length)]);
		};
		const GENERATION = E.generationWord(E.SCHEMA_VERSION);
		expect(E.GENERATION).toBe(GENERATION);
		// A peer of the NEXT schema generation types into p1 — valid content,
		// wrong generation: refused at the envelope.
		const typed = peerUpdate((peer) =>
			E.attachDocument(peer).facade.insertText('p1', 0, 'FOREIGN ')
		);
		await rogue(updateFrame(E.generationWord(E.SCHEMA_VERSION + 1), typed));
		// A v13-era peer: its first word is a bare message type.
		await rogue(updateFrame(E.messageSync, typed));
		// Same generation, forged stamps (unsupported version, foreign manifest).
		await rogue(
			updateFrame(
				GENERATION,
				peerUpdate((p) => p.get(E.META_KEY).setAttr('v', 99))
			)
		);
		await rogue(
			updateFrame(
				GENERATION,
				peerUpdate((p) => p.get(E.META_KEY).setAttr('schema', 'not-edytor'))
			)
		);
		await new Promise((r) => setTimeout(r, 30));

		expect(server.refusals.slice(refusalsBefore).map((r) => r.reason)).toEqual([
			'generation',
			'generation',
			'schema',
			'schema'
		]);
		expect(server.refusals.slice(refusalsBefore + 2).map((r) => r.detail.kind)).toEqual([
			'unsupported',
			'foreign'
		]);
		// Never stored, never applied, never relayed.
		expect(store.rows.map((r) => r.bytes)).toEqual(rowsBefore);
		expect(E.schemaVersion(server.doc)).toBe(E.SCHEMA_VERSION);
		expect(serverJSON(server)).toEqual(JSON.parse(aJSON));
		expect(JSON.stringify(a.facade.toJSON())).toBe(aJSON);
		expect(JSON.stringify(b.facade.toJSON())).toBe(aJSON);
		expect(a.writable && b.writable).toBe(true);

		// ── Persistence: compaction, a tail, then a rebuild from rows alone ──
		const appendsBefore = store.rows.filter((r) => r.kind === 'update').length;
		expect(appendsBefore).toBeGreaterThan(0);
		server.compact();
		expect(store.rows.map((r) => r.kind).filter((k) => k === 'update')).toEqual([]);
		expect(store.rows.filter((r) => r.kind === 'snapshot').length).toBeGreaterThan(1);
		ok(a.transact(() => a.facade.insertText('p2', 4, ' three')));
		await until(() => shape(serverJSON(server)).children[2]?.text === 'line three', 'tail');
		expect(store.rows.some((r) => r.kind === 'update')).toBe(true);

		const liveJSON = serverJSON(server);
		const rebuilt = Coordinator.restore(ROOM, store);
		expect(serverJSON(rebuilt)).toEqual(liveJSON);
		expect(svOf(rebuilt.doc)).toEqual(svOf(server.doc));
		rebuilt.evict();
		// A container of another generation never rebuilds.
		const tampered = new RowStore(MAX_ROW_BYTES);
		tampered.append(
			'generation',
			new TextEncoder().encode(
				JSON.stringify({ ...E.GENERATION_RECORD, schema: E.SCHEMA_VERSION + 1 })
			)
		);
		expect(() => Coordinator.restore('tampered', tampered)).toThrow(E.GenerationMismatchError);

		// ── Hibernation: presence tracked in socket attachments survives ──
		// A presence-only client (no provider, so no goodbye frame on leave).
		const ghost = new ClientSocket(`${SERVER}/${ROOM}`);
		await until(() => ghost.readyState === 1, 'ghost open');
		ghost.send(presenceFrame([{ clientID: 777, clock: 4, state: { user: { name: 'Zed' } } }]));
		await until(() => a.awareness.getStates().get(777)?.user?.name === 'Zed', 'Zed at A');
		expect(ghost.server.deserializeAttachment()).toEqual({ clients: [[777, 4]] });

		const sockets = noTimers(() => server.hibernate());
		const woke = Coordinator.restore(ROOM, store); // the DO constructor on wake
		noTimers(() => woke.adopt(sockets));
		rooms.set(ROOM, woke);
		expect(woke.presence.size).toBe(0); // memory is gone; attachments are not

		ghost.drop();
		await until(() => !a.awareness.getStates().has(777), 'Zed removed at A after the wake');
		expect(b.awareness.getStates().has(777)).toBe(false);
		// The surviving sockets keep syncing through the woken instance.
		ok(a.transact(() => a.facade.insertText('p1', 5, ','))); // "hello,"
		await until(() => b.facade.blockText('p1') === 'hello,', 'edit after the wake');
		expect(serverJSON(woke)).toEqual(a.facade.toJSON());
		const wokeJSON = serverJSON(woke);

		// ── Late join: A and B leave, the DO is evicted, C syncs from storage ──
		releaseB();
		await until(() => !a.awareness.getStates().has(b.doc.clientID), 'B presence removed at A');
		releaseA();
		a.destroy();
		b.destroy();
		await until(() => woke.sockets.size === 0, 'all sockets closed');
		expect(woke.presence.size).toBe(0);
		woke.evict();
		const final = Coordinator.restore(ROOM, store);
		rooms.set(ROOM, final);

		const c = E.createDocument({ actor: { id: 'cy' }, history: { captureTimeout: 0 } });
		const releaseC = connect(c, ROOM);
		await until(() => c.ready, 'C hydrated from the rebuilt coordinator');
		expect(c.facade.toJSON()).toEqual(wokeJSON);
		expect(shape(c.facade.toJSON())).toEqual({
			children: [
				{ id: 'p1', type: 'paragraph', text: 'hello,' },
				{ id: 'p1b', type: 'paragraph', text: ' world' },
				{ id: 'p2', type: 'paragraph', text: 'line three' }
			]
		});
		// C's own edits land in the rebuilt coordinator's store.
		const writes = store.writes;
		ok(c.transact(() => c.facade.insertText('p1', 6, '!')));
		await until(() => shape(serverJSON(final)).children[0].text === 'hello,!', 'C edit stored');
		expect(store.writes).toBeGreaterThan(writes);
		const again = Coordinator.restore(ROOM, store);
		expect(serverJSON(again)).toEqual(c.facade.toJSON());
		again.evict();

		releaseC();
		c.destroy();
		await until(() => final.sockets.size === 0, 'C socket closed');
		final.evict();
		rooms.clear();
	});

	it('the instance-free awareness codec is wire-compatible with Awareness, both ways', () => {
		// Awareness → entries: decode what the instance encoder wrote.
		const doc = new Y.Doc();
		const aw = new crdt.Awareness(doc);
		aw.setLocalStateField('user', { name: 'Ada' });
		const peers = E.writeAwarenessEntries([
			{ clientID: 11, clock: 3, state: { cursor: 4 } },
			{ clientID: 12, clock: 1, state: { user: { name: 'Bo' } } }
		]);
		E.applyAwarenessUpdate(aw, peers, 'test');
		const ids = [doc.clientID, 11, 12];
		const encoded = E.encodeAwarenessUpdate(aw, ids);
		const entries = E.readAwarenessEntries(encoded);
		expect(entries).toEqual([
			{
				clientID: doc.clientID,
				clock: aw.meta.get(doc.clientID).clock,
				state: { user: { name: 'Ada' } }
			},
			{ clientID: 11, clock: 3, state: { cursor: 4 } },
			{ clientID: 12, clock: 1, state: { user: { name: 'Bo' } } }
		]);
		expect(E.writeAwarenessEntries(entries)).toEqual(encoded);

		// Entries → Awareness: an instance applies what the codec wrote, and
		// re-encodes it byte-identically; a null state removes the client.
		const other = new crdt.Awareness(new Y.Doc());
		E.applyAwarenessUpdate(other, E.writeAwarenessEntries(entries), 'test');
		for (const { clientID, clock, state } of entries) {
			expect(other.getStates().get(clientID)).toEqual(state);
			expect(other.meta.get(clientID).clock).toBe(clock);
		}
		expect(E.encodeAwarenessUpdate(other, ids)).toEqual(encoded);
		E.applyAwarenessUpdate(
			other,
			E.writeAwarenessEntries([{ clientID: 11, clock: 4, state: null }]),
			'test'
		);
		expect(other.getStates().has(11)).toBe(false);
		expect(E.readAwarenessEntries(E.encodeAwarenessUpdate(other, [11]))).toEqual([
			{ clientID: 11, clock: 4, state: null }
		]);

		// modifyAwarenessUpdate (now built on the codec) keeps its contract.
		const modified = E.modifyAwarenessUpdate(encoded, (state) =>
			state && 'cursor' in state ? null : state
		);
		expect(E.readAwarenessEntries(modified).map((e) => e.state)).toEqual([
			{ user: { name: 'Ada' } },
			null,
			{ user: { name: 'Bo' } }
		]);
		aw.destroy();
		other.destroy();
	});
});
