/**
 * arch-v2 §7.3 G-e (D-24: taken) — the websocket provider's retained option
 * surface, and the y-websocket options it retires.
 *
 * Retained (what the docs, the demo and the test routes use for real
 * behavior): `status` events and `connect()`/`disconnect()`, the
 * reconnect backoff (`maxBackoffTime`), liveness (a silent socket is
 * closed and redialed), auth `params` on the URL (read at every dial, so a
 * refreshed token reaches the next connection), the permission-denied
 * reply, `WebSocketPolyfill` (the socket seam every test and harness
 * uses), and `resyncInterval` — kept only as the loss-healing knob for the
 * specs and the collab DST that inject harness frame loss (`dropNext`):
 * the join rule needs no timer, but a dropped frame on a live socket is
 * only healed by a later Step1.
 *
 * Retired (no docs, demo or test consumer for real behavior): the
 * `protocols` option, the `sync` alias of `synced`, the `wsconnecting`
 * flag (the `status` event carries it), and on `createWebsocketSync` the `connect`,
 * `protocols` and `resyncInterval` options (a factory-owned provider with
 * `connect: false` could never be connected).
 *
 * Restored after G-e: the BroadcastChannel leg (cross-tab sync, on by
 * default, `disableBc` opts out), with a relay of other tabs' edits to the
 * server.
 *
 * Expectations come from the plan row (§7.3 G-e) and the retained-surface
 * list, never from provider output.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { writePermissionDenied } from '../../../lib/crdt/protocols/auth.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import { GENERATION, writeProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';

const ws = bindWebsocketProvider(Y);
const providers = bindProviders(Y);

/**
 * Opaque relay fake: sockets on one URL form a room; frames are forwarded
 * verbatim to every other member. Every constructed socket and its
 * constructor arguments are recorded; `sent` keeps each outgoing frame.
 */
class Relay {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map();
	static sockets = [];

	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(...args) {
		this.url = args[0];
		this.args = args;
		this.sent = [];
		Relay.sockets.push(this);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			let room = Relay.rooms.get(this.url.split('?')[0]);
			if (!room) Relay.rooms.set(this.url.split('?')[0], (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
		this.sent.push(bytes);
		const room = Relay.rooms.get(this.url.split('?')[0]);
		if (!room) return;
		setTimeout(() => {
			for (const peer of room) {
				if (peer !== this && peer.readyState === 1)
					peer.onmessage?.({ data: bytes.slice().buffer });
			}
		});
	}

	/** Server-side drop: the socket dies without our close(). */
	drop() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		Relay.rooms.get(this.url.split('?')[0])?.delete(this);
		this.onclose?.({});
	}

	close() {
		this.drop();
	}
}

let counter = 0;
const uniqueUrl = () => `ws://g-e/${counter++}`;
/** A dial URL without the default `replica` param. */
const noReplica = (u) => u.replace(/replica=\d+&?/, '').replace(/\?$/, '');
const socketsOf = (url) => Relay.sockets.filter((s) => s.url.startsWith(url));
const until = async (cond, timeout = 4000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** `{ type, syncType }` of an enveloped frame. */
const frameOf = (bytes) => {
	const d = decoding.createDecoder(bytes);
	const gen = decoding.readVarUint(d);
	const type = decoding.readVarUint(d);
	return { gen, type, syncType: type === 0 ? decoding.readVarUint(d) : undefined };
};
const step1Count = (socket) =>
	socket.sent.filter((f) => {
		const t = frameOf(f);
		return t.type === 0 && t.syncType === 0;
	}).length;

describe('G-e retained surface — status, backoff, liveness, auth, the socket seam', () => {
	it('connect: false defers the dial; status runs connecting → connected → disconnected', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), {
			connect: false,
			WebSocketPolyfill: Relay
		});
		const statuses = [];
		p.on('status', (s) => statuses.push(s.status));
		await wait(30);
		expect(socketsOf(url)).toHaveLength(0);
		p.connect();
		await until(() => p.wsconnected);
		p.disconnect();
		expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
		p.destroy();
	});

	it('a dropped socket redials with backoff capped by maxBackoffTime', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: Relay,
			maxBackoffTime: 50
		});
		await until(() => p.wsconnected);
		// Fail the next dials: each unsuccessful reconnect doubles the wait,
		// the cap keeps it at 50 ms (below the 8 in a row past which it grows).
		p.wsUnsuccessfulReconnects = 5;
		const before = socketsOf(url).length;
		// The redial's delay as scheduled (`setTimeout(setupWS, delay,
		// provider)`), never the wall clock (CC-05): 100 ms × 2⁵, capped.
		const timers = vi.spyOn(globalThis, 'setTimeout');
		try {
			p.ws.drop();
			await until(() => socketsOf(url).length > before, 1000);
			expect(timers.mock.calls.filter((call) => call[2] === p).map((call) => call[1])).toEqual([
				50
			]);
		} finally {
			timers.mockRestore();
		}
		await until(() => p.wsconnected);
		p.destroy();
	});

	it('liveness: a connected socket silent past the timeout is closed and redialed', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), { WebSocketPolyfill: Relay });
		await until(() => p.wsconnected);
		const first = p.ws;
		p.wsLastMessageReceived = 0; // nothing heard "for a long time"
		await until(() => p.ws !== first && p.wsconnected, 6000);
		expect(first.readyState).toBe(3);
		p.destroy();
	}, 10000);

	it('auth params land on the URL and are read at every dial', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), {
			params: { token: 'a' },
			WebSocketPolyfill: Relay
		});
		await until(() => p.wsconnected);
		expect(noReplica(p.ws.url)).toBe(`${url}/room?token=a`);
		p.params = { token: 'b' }; // a refreshed token
		p.ws.drop();
		await until(() => p.wsconnected && p.ws.url.endsWith('token=b'));
		p.destroy();
	});

	it('a permission-denied reply emits permission-denied and failed once', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), { WebSocketPolyfill: Relay });
		const denied = [];
		const failed = [];
		p.on('permission-denied', (reason) => denied.push(reason));
		p.on('failed', (e) => failed.push(e));
		await until(() => p.wsconnected);
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 2); // messageAuth
		writePermissionDenied(e, 'nope');
		p.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });
		expect(denied).toEqual(['nope']);
		expect(failed).toHaveLength(1);
		p.destroy();
	});

	it('resyncInterval re-sends Step1 on the live socket; without it only the hello does', async () => {
		const url = uniqueUrl();
		const plain = new ws.WebsocketProvider(url, 'plain', new Y.Doc(), { WebSocketPolyfill: Relay });
		const healing = new ws.WebsocketProvider(url, 'healing', new Y.Doc(), {
			WebSocketPolyfill: Relay,
			resyncInterval: 30
		});
		await until(() => plain.wsconnected && healing.wsconnected);
		await until(() => step1Count(healing.ws) >= 3, 2000);
		expect(step1Count(plain.ws)).toBe(1);
		const socket = healing.ws;
		expect(frameOf(socket.sent[0]).gen).toBe(GENERATION);
		plain.destroy();
		healing.destroy();
		// destroy clears the timer: nothing more is sent on the closed socket.
		const sent = socket.sent.length;
		await wait(80);
		expect(socket.sent.length).toBe(sent);
	});

	it('createWebsocketSync forwards params, the socket seam and the backoff; target = server + room', async () => {
		const url = uniqueUrl();
		const sync = providers.createWebsocketSync({
			server: `${url}/`,
			room: 'r',
			params: { token: 't' },
			WebSocketPolyfill: Relay,
			maxBackoffTime: 50
		});
		expect(sync.target).toBe(`websocket:${url}/r`);
		const doc = new Y.Doc();
		const cleanup = sync({ doc, awareness: new Awareness(doc), synced: () => {} });
		await until(() => socketsOf(url).length === 1);
		expect(noReplica(socketsOf(url)[0].url)).toBe(`${url}/r?token=t`);
		cleanup();
	});
});

describe('G-e retired surface (D-24)', () => {
	it('protocols never reach the socket: the dial passes the URL alone', async () => {
		const url = uniqueUrl();
		const p = new ws.WebsocketProvider(url, 'room', new Y.Doc(), {
			protocols: ['edytor-v14'],
			WebSocketPolyfill: Relay
		});
		await until(() => p.wsconnected);
		expect(p.ws.args.map(noReplica)).toEqual([`${url}/room`]);
		expect('protocols' in p).toBe(false);
		p.destroy();
	});

	it('no `sync` alias: only `synced` fires', async () => {
		const url = uniqueUrl();
		const a = new ws.WebsocketProvider(url, 'room', new Y.Doc(), { WebSocketPolyfill: Relay });
		const b = new ws.WebsocketProvider(url, 'room', new Y.Doc(), { WebSocketPolyfill: Relay });
		const alias = [];
		const synced = [];
		b.on('sync', (s) => alias.push(s));
		b.on('synced', (s) => synced.push(s));
		await until(() => b.synced);
		expect(synced).toEqual([true]);
		expect(alias).toEqual([]);
		a.destroy();
		b.destroy();
	});

	it('no wsconnecting flag: the status event carries it', () => {
		const p = new ws.WebsocketProvider(uniqueUrl(), 'room', new Y.Doc(), {
			connect: false,
			WebSocketPolyfill: Relay
		});
		expect('wsconnecting' in p).toBe(false);
		p.destroy();
	});

	it('cross-tab by default: two same-room providers with no socket sync over the BroadcastChannel', async () => {
		// A socket that never opens: only the BroadcastChannel can carry the edit.
		class Silent extends Relay {
			constructor(...args) {
				super(...args);
				this.readyState = 2;
			}
		}
		const url = uniqueUrl();
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const a = new ws.WebsocketProvider(url, 'room', docA, { WebSocketPolyfill: Silent });
		const b = new ws.WebsocketProvider(url, 'room', docB, { WebSocketPolyfill: Silent });
		docA.get('content').setAttr('k', 'from-a');
		await until(() => docB.get('content').getAttr('k') === 'from-a', 1000);
		a.destroy();
		b.destroy();
	});

	it("a leaving tab's presence leaves the other tab (no re-announce from an echoed removal)", async () => {
		class Silent extends Relay {
			constructor(...args) {
				super(...args);
				this.readyState = 2;
			}
		}
		const url = uniqueUrl();
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awarenessA = new Awareness(docA);
		const awarenessB = new Awareness(docB);
		const a = new ws.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: Silent,
			awareness: awarenessA
		});
		const b = new ws.WebsocketProvider(url, 'room', docB, {
			WebSocketPolyfill: Silent,
			awareness: awarenessB
		});
		awarenessB.setLocalStateField('user', { name: 'Bob' });
		await until(() => awarenessA.getStates().get(docB.clientID)?.user?.name === 'Bob', 1000);
		b.destroy();
		await wait(100);
		expect(awarenessA.getStates().has(docB.clientID)).toBe(false);
		a.destroy();
	});

	it("IndexedDB tabs: a leaving tab's presence leaves the other tab", async () => {
		const name = `g-e-idb-${counter++}`;
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awarenessA = new Awareness(docA);
		const awarenessB = new Awareness(docB);
		const a = new providers.IndexeddbPersistence(name, docA, { awareness: awarenessA });
		const b = new providers.IndexeddbPersistence(name, docB, { awareness: awarenessB });
		await Promise.all([a.whenSynced, b.whenSynced]);
		awarenessB.setLocalStateField('user', { name: 'Bob' });
		await until(() => awarenessA.getStates().get(docB.clientID)?.user?.name === 'Bob', 1000);
		await b.destroy();
		await wait(100);
		expect(awarenessA.getStates().has(docB.clientID)).toBe(false);
		await a.destroy();
	});

	it('disableBc opts out: same-room providers with no socket do not sync in-process', async () => {
		class Silent extends Relay {
			constructor(...args) {
				super(...args);
				this.readyState = 2;
			}
		}
		const url = uniqueUrl();
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const opts = { WebSocketPolyfill: Silent, disableBc: true };
		const a = new ws.WebsocketProvider(url, 'room', docA, opts);
		const b = new ws.WebsocketProvider(url, 'room', docB, opts);
		docA.get('content').setAttr('k', 'from-a');
		await wait(150);
		expect(docB.get('content').getAttr('k')).toBeUndefined();
		a.destroy();
		b.destroy();
	});

	it("another tab's edit is relayed to the server on this tab's socket, not echoed to the channel", async () => {
		// Tab A has no socket (offline); tab B is online. A's edit reaches B over the
		// channel, and B sends it to the server.
		class Silent extends Relay {
			constructor(...args) {
				super(...args);
				this.readyState = 2;
			}
		}
		const url = uniqueUrl();
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const a = new ws.WebsocketProvider(url, 'room', docA, { WebSocketPolyfill: Silent });
		const b = new ws.WebsocketProvider(url, 'room', docB, { WebSocketPolyfill: Relay });
		await until(() => b.wsconnected, 1000);
		const [socket] = socketsOf(url).filter((s) => s.readyState === 1);
		const before = socket.sent.length;
		docA.get('content').setAttr('k', 'offline-edit');
		await until(() => docB.get('content').getAttr('k') === 'offline-edit', 1000);
		await until(() => socket.sent.length > before, 1000);
		const relayed = socket.sent.slice(before).map(frameOf);
		expect(relayed.some((f) => f.type === 0 && f.syncType === 2)).toBe(true);
		a.destroy();
		b.destroy();
	});

	it('createWebsocketSync always dials: connect/protocols/resyncInterval are not options', async () => {
		const url = uniqueUrl();
		const sync = providers.createWebsocketSync({
			server: url,
			room: 'r',
			connect: false,
			protocols: ['x'],
			resyncInterval: 20,
			WebSocketPolyfill: Relay
		});
		const doc = new Y.Doc();
		const cleanup = sync({ doc, awareness: new Awareness(doc), synced: () => {} });
		await until(() => socketsOf(url).length === 1 && socketsOf(url)[0].readyState === 1, 1000);
		const [socket] = socketsOf(url);
		expect(socket.args.map(noReplica)).toEqual([`${url}/r`]);
		await wait(120);
		expect(step1Count(socket)).toBe(1);
		cleanup();
	});
});
