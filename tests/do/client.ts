/**
 * Test clients for the shipped room (`src/lib/cloudflare`), running inside
 * the Workers pool.
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
import { CLOSE } from '../../src/lib/crdt/providers/room.js';
// @ts-ignore -- untyped JS module; typed through `EngineApi` below
import * as RawY from '../../src/lib/crdt/vendor/yjs/src/index.js';

export const Y = RawY as unknown as EngineApi;
export const crdt = E.bindCrdt(Y);
export { E };

export const ORIGIN = 'https://edytor-do.test';

/** A remote-apply origin, so a client never echoes what it received. */
const REMOTE = Symbol('remote');

/** Who dials: the test Worker's `authorize` reads these from the query string. */
export type Dial = {
	user?: string;
	replica?: number;
	access?: 'read' | 'write';
	/** When the credential expires (ms since the epoch; `?expires=`, WU-06). */
	expires?: number | string;
};

/** The `/rooms/<name>` URL for `dial` (query parameters only when given). */
export const roomUrl = (room: string, dial: Dial = {}) => {
	const query = new URLSearchParams();
	if (dial.user) query.set('user', dial.user);
	if (dial.replica !== undefined) query.set('replica', String(dial.replica));
	if (dial.access) query.set('access', dial.access);
	if (dial.expires !== undefined) query.set('expires', String(dial.expires));
	const search = query.size > 0 ? `?${query}` : '';
	return `${ORIGIN}/rooms/${encodeURIComponent(room)}${search}`;
};

/** The upgrade response itself (a refusal is a plain HTTP status). */
export const dialResponse = (room: string, dial: Dial = {}, headers: HeadersInit = {}) =>
	SELF.fetch(roomUrl(room, dial), { headers: { ...headers, Upgrade: 'websocket' } });

/** Open a server socket through the Worker's `/rooms/<name>` route. */
export const upgrade = async (room: string, dial: Dial = {}): Promise<WebSocket> =>
	accept(await dialResponse(room, dial));

/** The close a refused dial gets when its replica belongs to another user. */
export const REPLICA_TAKEN = {
	code: CLOSE.replicaTaken,
	reason: 'replica bound to another user'
} as const;

/**
 * How a write dial ends: `'open'` once the room speaks (its SyncStep1), or
 * the close it was accepted-then-closed with.
 */
export const dialOutcome = async (
	room: string,
	dial: Dial = {}
): Promise<'open' | { code: number; reason: string }> => {
	const ws = await upgrade(room, dial);
	return new Promise((resolve) => {
		ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
		ws.addEventListener('message', () => {
			resolve('open');
			ws.close(1000, 'done');
		});
	});
};

const accept = async (response: Response): Promise<WebSocket> => {
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

/**
 * What the room stored, as one v1 update: its records (`records()`) read
 * as a restart reads them — a v2 container's snapshot (`v2`) converted.
 */
export const storedUpdate = (
	records: Array<{ kind: string; bytes: Uint8Array<ArrayBuffer>; v2?: boolean }>
): Uint8Array =>
	Y.mergeUpdates(
		records
			.filter((record) => record.kind !== 'generation')
			.map((record) =>
				record.v2
					? (Y.convertUpdateFormatV2ToV1(record.bytes) as Uint8Array<ArrayBuffer>)
					: record.bytes
			)
	);

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
	/** Every frame received, raw (chunks included, as they arrived). */
	readonly received: Uint8Array[] = [];
	/** Chunked frames reassembled from `received`. */
	readonly reassembled: Uint8Array[] = [];
	/** The room's `messageSaved` state vectors, in order. */
	readonly acks: Map<number, number>[] = [];
	/** How many delete ranges each `messageSaved` names, in order (0: none). */
	readonly ackedDeletes: number[] = [];
	/** Permission-denied reasons the room sent (its refusals of writes). */
	readonly denied: string[] = [];
	/** The room said, when this socket joined, that it may read but not write. */
	readOnly = false;
	/** Step1 frames the room sent (it asks write sockets only). */
	step1s = 0;
	synced = false;
	private readonly chunks = E.createChunkReader();
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
	static async connect(
		room: string,
		doc: YDoc = crdt.createDoc(),
		dial: Dial = {}
	): Promise<RawClient> {
		const client = new RawClient(await upgrade(room, dial), doc);
		client.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, doc)));
		return client;
	}

	/** Dial without any handshake — for forged frames. */
	static async bare(room: string, dial: Dial = {}): Promise<RawClient> {
		return new RawClient(await upgrade(room, dial), crdt.createDoc());
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
		this.read(bytes);
	}

	private read(bytes: Uint8Array) {
		const decoder = E.createDecoder(bytes);
		if (!E.readProtocolVersion(decoder)) throw new Error('server spoke another generation');
		const type = E.readVarUint(decoder);
		if (type === E.messageChunk) {
			const whole = this.chunks(decoder);
			if (whole !== null) {
				this.reassembled.push(whole);
				this.read(whole);
			}
			return;
		}
		if (type === E.messageSaved) {
			const { stateVector, deletes } = crdt.sync.readSaved(decoder);
			this.acks.push(Y.decodeStateVector(stateVector));
			let ranges = 0;
			for (const ids of deletes?.clients.values() ?? []) ranges += ids.getIds().length;
			this.ackedDeletes.push(ranges);
			return;
		}
		if (type === E.messageAuth) {
			if (E.readVarUint(decoder) === E.messageReadOnly) {
				this.readOnly = true;
				return;
			}
			this.denied.push(new TextDecoder().decode(E.readVarUint8Array(decoder)));
			return;
		}
		if (type === E.messageSync) {
			const syncType = E.readVarUint(decoder);
			const payload = E.readVarUint8Array(decoder);
			if (syncType === E.messageYjsSyncStep1) {
				this.step1s++;
				this.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep2(e, this.doc, payload)));
				return;
			}
			// A SyncStep2 is v2 on the wire (P5).
			const update = syncType === E.messageYjsSyncStep2 ? crdt.sync.step2Update(payload) : payload;
			const { applied, problem } = crdt.sync.applyRemote(this.doc, update, REMOTE);
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
	/** Who answers the upgrade: the test Worker (`SELF`) unless a subclass names another. */
	static fetcher = (url: string, init: RequestInit): Promise<Response> => SELF.fetch(url, init);

	constructor(readonly url: string) {
		// The provider's own URL (its query parameters included).
		const { fetcher } = this.constructor as typeof SelfWebSocket;
		fetcher(url.replace(/^ws/, 'http'), { headers: { Upgrade: 'websocket' } })
			.then(accept)
			.then(
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

	send(data: string | ArrayBuffer | Uint8Array) {
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
