/**
 * Offline durability by default — `createWebsocketSync` keeps a local copy.
 *
 * The contract (README "Collaboration and persistence"):
 *
 * - `createWebsocketSync` attaches an IndexedDB store beside the socket,
 *   named `edytor:<serverUrl>/<roomName>` (`persistName` overrides it;
 *   `persist: false` opts out) and exposed as `sync.persistName` for
 *   `clearDocument`. Without an `indexedDB` global (Node, Workers, SSR) it
 *   is the socket alone, silently.
 * - Readiness is local-first: stored content decides the document without
 *   the server (an offline start works). An EMPTY store never lets the
 *   document seed before the store answered; then the server's answer, or
 *   the socket's readiness bound (armed at its open or first failed
 *   dial), decides as for a socket alone.
 * - Edits restored from the store reach the server when it comes back (the
 *   join rule exchanges what each side lacks).
 * - Destroying the document releases the socket and the store.
 *
 * The server here is a minimal room that holds a document and speaks the
 * join rule; it can be down (dials are refused) or up. Expectations are
 * hand-authored from the edits each test makes.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import {
	frame,
	generationDbName,
	readProtocolVersion
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindProviders(Y);
const sync = bindSync(Y);

/** A room that holds the document: answers Step1 (plus its own when it lacks), integrates, rebroadcasts. */
class Server {
	static byUrl = new Map();
	up = false;
	sockets = new Set();

	constructor(url, state) {
		this.doc = state ? loadDocument(state).doc : new Y.Doc();
		Server.byUrl.set(url, this);
		this.doc.on('update', (update, origin) => {
			for (const socket of this.sockets) {
				if (socket !== origin) socket.deliver(frame(0, (e) => sync.writeUpdate(e, update)));
			}
		});
	}

	receive(socket, bytes) {
		const decoder = decoding.createDecoder(bytes);
		if (!readProtocolVersion(decoder) || decoding.readVarUint(decoder) !== 0) return;
		const type = decoding.readVarUint(decoder);
		const payload = decoding.readVarUint8Array(decoder);
		if (type === sync.messageYjsSyncStep1) {
			socket.deliver(frame(0, (e) => sync.writeSyncStep2(e, this.doc, payload)));
			if (sync.lacks(this.doc, payload)) {
				socket.deliver(frame(0, (e) => sync.writeSyncStep1(e, this.doc)));
			}
			return;
		}
		Y.applyUpdate(this.doc, payload, socket);
	}

	down() {
		this.up = false;
		for (const socket of [...this.sockets]) socket.close();
	}
}

/** The socket seam: a dial to a down (or missing) server is refused asynchronously. */
class Socket {
	static OPEN = 1;
	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(url) {
		this.server = Server.byUrl.get(url.split('?')[0]);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			if (!this.server?.up) {
				this.readyState = 3;
				this.onclose?.({});
				return;
			}
			this.readyState = 1;
			this.server.sockets.add(this);
			this.onopen?.({});
		});
	}

	send(data) {
		const bytes = new Uint8Array(data).slice();
		setTimeout(() => {
			if (this.readyState === 1) this.server.receive(this, bytes);
		});
	}

	deliver(bytes) {
		setTimeout(() => {
			if (this.readyState === 1) this.onmessage?.({ data: bytes.slice().buffer });
		});
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server?.sockets.delete(this);
		this.onclose?.({});
	}
}

/** A socket that never opens: this tab is offline. */
class Unplugged extends Socket {
	constructor(url) {
		super(url);
		this.readyState = 2;
	}
}

let counter = 0;
const uniqueUrl = () => `ws://offline-default/${counter++}`;
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The server holds everything `document` holds. */
const holds = (server, document) => !sync.lacks(server.doc, Y.encodeStateVector(document.doc));
const databases = async () => (await indexedDB.databases()).map((db) => db.name);

const wsSync = (serverUrl, options = {}) =>
	providers.createWebsocketSync({
		serverUrl,
		roomName: 'room',
		WebSocketPolyfill: Socket,
		maxBackoffTime: 40,
		...options
	});

/** A document whose readiness can only come from its store: the socket never arms its bound. */
const attachWithoutBound = (document, sync, value) =>
	document.attachSync(
		Object.assign((payload) => sync({ ...payload, armBound: undefined }), {
			bound: Infinity,
			target: sync.target
		}),
		{ value }
	);

const draft = { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'draft' }] }] };
const texts = (document) =>
	document.facade.project().children.map((block) => document.facade.blockText(block.id));

describe('createWebsocketSync persists locally by default', () => {
	it('names the store after the server and room; persistName overrides; persist: false has none', () => {
		expect(wsSync('ws://host/rooms/').persistName).toBe('edytor:ws://host/rooms/room');
		expect(wsSync('ws://host/rooms', { persistName: 'mine' }).persistName).toBe('mine');
		expect(wsSync('ws://host/rooms', { persist: false }).persistName).toBeUndefined();
	});

	it('an offline edit survives every tab closing; the restored edit reaches the server when it is back', async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`);

		// First session, offline from the start: the lone empty document
		// seeds after the readiness bound, then takes an edit.
		const first = createDocument();
		first.attachSync(wsSync(url), { value: draft });
		await until(() => first.ready);
		expect(first.readiness).toBe('local');
		first.transact(() => first.facade.insertText('p', 0, 'offline '));
		await wait(50);
		first.destroy();

		// Second session, still offline: the store decides the document.
		const second = createDocument();
		attachWithoutBound(second, wsSync(url), draft);
		await until(() => second.ready);
		expect(second.readiness).toBe('hydrated');
		expect(texts(second)).toEqual(['offline draft']);

		// The server comes back: the restored edit is delivered on reconnect.
		server.up = true;
		await until(() => holds(server, second));
		const reader = createDocument();
		reader.attachSync(wsSync(url, { persist: false, disableBc: true }));
		await until(() => reader.ready && texts(reader)[0] === 'offline draft');
		expect(texts(reader)).toEqual(['offline draft']);

		second.destroy();
		reader.destroy();
		server.down();
	});

	it('destroy releases the socket and the store: the database can be deleted', async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`);
		server.up = true;
		const sync = wsSync(url);
		const document = createDocument();
		document.attachSync(sync, { value: draft });
		await until(() => document.ready && server.sockets.size === 1);
		expect(await databases()).toContain(generationDbName(sync.persistName));
		document.destroy();
		await until(() => server.sockets.size === 0);
		// A database with an open connection blocks its deletion.
		await providers.clearDocument(sync.persistName);
		expect(await databases()).not.toContain(generationDbName(sync.persistName));
		server.down();
	});

	it('persist: false stores nothing', async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`);
		server.up = true;
		const document = createDocument();
		document.attachSync(wsSync(url, { persist: false }), { value: draft });
		await until(() => document.ready);
		document.transact(() => document.facade.insertText('p', 0, 'x'));
		await wait(50);
		expect((await databases()).filter((name) => name.includes(url))).toEqual([]);
		document.destroy();
		server.down();
	});

	it('without an indexedDB global it is the socket alone, with no error', async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`, createDocument({ value: draft }).encode());
		server.up = true;
		const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
		delete globalThis.indexedDB;
		let document;
		try {
			expect(typeof indexedDB).toBe('undefined');
			document = createDocument();
			document.attachSync(wsSync(url));
			await until(() => document.ready);
			expect(document.readiness).toBe('hydrated');
			expect(texts(document)).toEqual(['draft']);
		} finally {
			Object.defineProperty(globalThis, 'indexedDB', saved);
		}
		expect((await databases()).filter((name) => name.includes(url))).toEqual([]);
		document.destroy();
		server.down();
	});
});

describe('readiness and seeding with a local store', () => {
	it('an empty store and a server that holds the document: no seeded duplicate, now or after a reload', async () => {
		const url = uniqueUrl();
		const room = { children: [{ type: 'paragraph', id: 'r1', content: [{ text: 'room' }] }] };
		const server = new Server(`${url}/room`, createDocument({ value: room }).encode());
		server.up = true;
		const device = createDocument();
		device.attachSync(wsSync(url), { value: draft });
		await until(() => device.ready);
		expect(device.readiness).toBe('hydrated');
		await wait(100);
		expect(texts(device)).toEqual(['room']);
		device.destroy();

		// Reload with the server down: the stored copy, still without the default.
		server.down();
		const reload = createDocument();
		attachWithoutBound(reload, wsSync(url), draft);
		await until(() => reload.ready);
		expect(reload.readiness).toBe('hydrated');
		expect(texts(reload)).toEqual(['room']);
		reload.destroy();
	});

	it('a store that holds content decides the document before the server answers', async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`);
		server.up = true;
		const first = createDocument();
		first.attachSync(wsSync(url), { value: draft });
		await until(() => first.ready && server.sockets.size === 1);
		first.transact(() => first.facade.insertText('p', 0, 'kept '));
		await wait(50);
		first.destroy();

		// The server is up but says nothing (an opaque relay alone in its room).
		server.receive = () => {};
		const second = createDocument();
		attachWithoutBound(second, wsSync(url), draft);
		await until(() => second.ready);
		expect(second.readiness).toBe('hydrated');
		expect(texts(second)).toEqual(['kept draft']);
		second.destroy();
		server.down();
	});
});

describe('tabs of one room with a local store', () => {
	it("tabs sync over the store's channel; another tab's edit reaches the server on this tab's socket", async () => {
		const url = uniqueUrl();
		const server = new Server(`${url}/room`, createDocument({ value: draft }).encode());
		server.up = true;
		const online = createDocument();
		online.attachSync(wsSync(url));
		await until(() => online.ready && server.sockets.size === 1);
		const offline = createDocument();
		offline.attachSync(wsSync(url, { WebSocketPolyfill: Unplugged }));
		await until(() => offline.ready && texts(offline)[0] === 'draft');

		offline.transact(() => offline.facade.insertText('p', 0, 'tab '));
		await until(() => texts(online)[0] === 'tab draft' && holds(server, offline));
		const reader = createDocument();
		reader.attachSync(wsSync(url, { persist: false, disableBc: true }));
		await until(() => reader.ready && texts(reader)[0] === 'tab draft');

		for (const document of [online, offline, reader]) document.destroy();
		server.down();
	});

	it('disableBc opts the store out of the channel too', async () => {
		const url = uniqueUrl();
		const a = createDocument({ value: draft });
		const b = createDocument({ value: draft });
		a.attachSync(wsSync(url, { disableBc: true }));
		b.attachSync(wsSync(url, { disableBc: true }));
		await wait(100);
		a.transact(() => a.facade.insertText('p', 0, 'a '));
		await wait(150);
		expect(texts(b)).toEqual(['draft']);
		a.destroy();
		b.destroy();
	});
});
