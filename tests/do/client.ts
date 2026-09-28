/**
 * Test clients for the room fixture, running inside the Workers pool.
 *
 * - {@link RawClient}: speaks raw frames (built with the exported `frame`,
 *   `messageSync`, … and `bindCrdt(Y).sync`) over a socket from a real
 *   `SELF.fetch` WebSocket upgrade, on a plain engine doc.
 * - {@link SelfWebSocket}: a `WebSocket`-shaped polyfill over the same
 *   upgrade, so the SHIPPED headless path (`createDocument` +
 *   `createWebsocketSync`) can dial the room.
 */
import { SELF } from 'cloudflare:test';
import * as E from '../../src/lib/crdt/index.js';
import type { AwarenessEntry, EngineApi, YDoc } from '../../src/lib/crdt/index.js';
// @ts-ignore -- untyped JS module; typed through `EngineApi` below
import * as RawY from '../../src/lib/crdt/vendor/yjs/src/index.js';

export const Y = RawY as unknown as EngineApi;
export const crdt = E.bindCrdt(Y);
export { E };

export const ORIGIN = 'https://edytor-do.test';

/** A remote-apply origin, so a client never echoes what it received. */
const REMOTE = Symbol('remote');

/** Open a server socket through the Worker's `/rooms/<name>` route. */
export const upgrade = async (room: string): Promise<WebSocket> => {
	const response = await SELF.fetch(`${ORIGIN}/rooms/${encodeURIComponent(room)}`, {
		headers: { Upgrade: 'websocket' }
	});
	const ws = response.webSocket;
	if (!ws) throw new Error(`upgrade refused: ${response.status} ${await response.text()}`);
	ws.accept();
	// Workers default binary frames to Blob (standard binaryType); the codec reads bytes.
	ws.binaryType = 'arraybuffer';
	return ws;
};

/** A varuint as lib0 writes it — only to forge frames of OTHER builds (foreign generation words). */
export const varUint = (n: number): number[] => {
	const out: number[] = [];
	for (; n > 0x7f; n = Math.floor(n / 128)) out.push(0x80 | (n & 0x7f));
	out.push(n);
	return out;
};

/** A sync Update frame as a build speaking generation word `word` writes it. */
export const updateFrameWithWord = (word: number, update: Uint8Array): Uint8Array => {
	const ours = E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));
	return Uint8Array.from([...varUint(word), ...ours.subarray(varUint(E.GENERATION).length)]);
};

type Facade = ReturnType<typeof crdt.doc.create>;

/**
 * Read `doc` through a bare facade (`bindCrdt(Y).doc.create`), which writes
 * nothing — `attachDocument` would record an actor in the replicated
 * attribution dictionary.
 */
export const readFacade = <T>(doc: YDoc, read: (facade: Facade) => T): T => {
	const facade = crdt.doc.create(doc as unknown as Parameters<typeof crdt.doc.create>[0]);
	try {
		return read(facade);
	} finally {
		facade.dispose();
	}
};

export const presenceFrame = (entries: AwarenessEntry[]): Uint8Array =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));

export class RawClient {
	readonly ws: WebSocket;
	readonly doc: YDoc;
	/** Presence as this client heard it (the relay's view of its peers). */
	readonly presence = new Map<number, AwarenessEntry>();
	/** Every frame received, raw. */
	readonly received: Uint8Array[] = [];
	synced = false;
	closed: { code: number; reason: string } | null = null;

	private constructor(ws: WebSocket, doc: YDoc) {
		this.ws = ws;
		this.doc = doc;
		ws.addEventListener('message', (event) => this.onMessage(event.data));
		ws.addEventListener('close', (event) => {
			this.closed ??= { code: event.code, reason: event.reason };
		});
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE) return;
			this.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update)));
		});
	}

	/** Dial `room` with `doc` (a fresh engine doc by default) and send our SyncStep1. */
	static async connect(room: string, doc: YDoc = crdt.createDoc()): Promise<RawClient> {
		const client = new RawClient(await upgrade(room), doc);
		client.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, doc)));
		return client;
	}

	/** Dial without any handshake — for forged frames. */
	static async bare(room: string): Promise<RawClient> {
		return new RawClient(await upgrade(room), crdt.createDoc());
	}

	send(bytes: Uint8Array) {
		if (this.closed) return;
		this.ws.send(bytes);
	}

	setPresence(clientID: number, clock: number, state: Record<string, unknown> | null) {
		this.send(presenceFrame([{ clientID, clock, state }]));
	}

	/** The document as JSON, read through a bare facade (writes nothing). */
	json() {
		return readFacade(this.doc, (facade) => facade.toJSON());
	}

	close(code = 1000, reason = 'done') {
		if (this.closed) return;
		this.closed = { code, reason };
		this.ws.close(code, reason);
	}

	private onMessage(data: unknown) {
		const bytes =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(String(data));
		this.received.push(bytes);
		const decoder = E.createDecoder(bytes);
		if (!E.readProtocolVersion(decoder)) throw new Error('server spoke another generation');
		const type = E.readVarUint(decoder);
		if (type === E.messageSync) {
			const syncType = E.readVarUint(decoder);
			const payload = E.readVarUint8Array(decoder);
			if (syncType === E.messageYjsSyncStep1) {
				this.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep2(e, this.doc, payload)));
				return;
			}
			const { applied, problem } = crdt.sync.applyRemote(this.doc, payload, REMOTE);
			if (!applied || problem !== null) throw new Error('client refused a server update');
			if (syncType === E.messageYjsSyncStep2) this.synced = true;
			return;
		}
		if (type === E.messageAwareness) {
			for (const entry of E.readAwarenessEntries(E.readVarUint8Array(decoder))) {
				const known = this.presence.get(entry.clientID);
				if (known && known.clock > entry.clock) continue;
				if (entry.state === null) this.presence.delete(entry.clientID);
				else this.presence.set(entry.clientID, entry);
			}
		}
	}
}

/**
 * `WebSocket`-shaped polyfill for the shipped `WebsocketProvider`: the
 * constructor is synchronous (the upgrade resolves later, like a network
 * connect); frames and close events are forwarded to the `on*` handlers.
 */
export class SelfWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	binaryType = 'arraybuffer';
	readyState = 0;
	onopen: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	private socket: WebSocket | null = null;

	constructor(readonly url: string) {
		const room = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop()!);
		upgrade(room).then(
			(ws) => {
				if (this.readyState !== 0) return ws.close(1000, 'abandoned');
				this.socket = ws;
				ws.addEventListener('message', (event) => this.onmessage?.({ data: event.data }));
				ws.addEventListener('close', (event) => this.finish(event.code, event.reason));
				this.readyState = 1;
				this.onopen?.({ type: 'open' });
			},
			(error) => {
				this.onerror?.(error);
				this.finish(1006, 'upgrade failed');
			}
		);
	}

	send(data: ArrayBuffer | Uint8Array) {
		if (this.readyState === 1) this.socket?.send(data);
	}

	close(code = 1000, reason = '') {
		if (this.readyState >= 2) return;
		this.socket?.close(code, reason);
		this.finish(code, reason);
	}

	private finish(code: number, reason: string) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

export const para = (id: string, text: string) => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

/** Strip what the edits do not author (empty data / children) for comparison. */
export const shape = (json: { children: Array<Record<string, any>> }) => ({
	children: json.children.map((b) => ({
		id: b.id,
		type: b.type,
		text: ((b.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
	}))
});
