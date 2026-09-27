/**
 * Websocket provider — options, socket events, auth replies, and the
 * terminal `failed` contract (D4).
 *
 * - `connect: false` defers the socket until `connect()`; `params` reach
 *   the URL; `status` events fire in order. (`protocols` and the
 *   `wsconnecting` flag are retired — D-24 G-e; see
 *   `src/tests/crdt/arch-v2/g-e-websocket-surface.test.ts`.)
 * - `connection-close`/`connection-error` surface; a transient close is
 *   reconnectable and must NOT emit `failed`.
 * - A forged `permission-denied` auth reply emits `'permission-denied'`
 *   with the reason AND `failed` exactly once (a denied provider can never
 *   reach `synced`); an unknown auth subtype is reported on `message-error`.
 * - `destroy()` before the handshake emits `failed` exactly once; after
 *   `synced` it emits nothing.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { writePermissionDenied } from '../../../lib/crdt/protocols/auth.js';
import { writeProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';
import * as encoding from 'lib0-v14/encoding';

const providers = bindWebsocketProvider(Y);
const sync = bindSync(Y);

/**
 * Minimal opaque-relay fake server (same shape as websocket.test.ts):
 * sockets on the same URL form a room; `send` is delivered to every other
 * member. Constructor args are recorded so option passthrough is testable.
 */
class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map();
	static instances = [];

	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(url, protocols) {
		this.url = url;
		this.protocols = protocols;
		FakeWebSocket.instances.push(this);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			let room = FakeWebSocket.rooms.get(this.url);
			if (!room) FakeWebSocket.rooms.set(this.url, (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		const room = FakeWebSocket.rooms.get(this.url);
		if (!room) return;
		const copy = data instanceof Uint8Array ? data.slice().buffer : data;
		setTimeout(() => {
			for (const peer of room) {
				if (peer !== this && peer.readyState === 1) {
					peer.onmessage?.({ data: copy instanceof ArrayBuffer ? copy.slice(0) : copy });
				}
			}
		});
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		FakeWebSocket.rooms.get(this.url)?.delete(this);
		this.onclose?.({});
	}
}

const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

let counter = 0;
const uniqueUrl = () => `ws://fake/${counter++}`;

/** Deliver a forged server → provider frame to `p`'s open socket. */
const deliverTo = (p, buf) => {
	p.ws.onmessage({ data: buf instanceof Uint8Array ? buf.slice().buffer : buf });
};

describe('websocket options + socket events', () => {
	test('connect: false defers the socket until connect()', async () => {
		const url = uniqueUrl();
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			connect: false,
			WebSocketPolyfill: FakeWebSocket
		});
		await nextTick(60);
		expect(p.ws).toBeNull();
		expect(p.wsconnected).toBe(false);

		p.connect();
		await until(() => p.wsconnected, 4000);
		p.destroy();
	});

	test('params land on the URL', async () => {
		const url = uniqueUrl();
		FakeWebSocket.instances = [];
		const statuses = [];
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			// Deferred: 'connecting' is emitted synchronously inside setupWS —
			// attach the listener first so the order is observable.
			connect: false,
			params: { token: 'abc', region: 'eu' },
			WebSocketPolyfill: FakeWebSocket
		});
		p.on('status', (s) => statuses.push(s.status));

		expect(p.url).toBe(`${url}/room?token=abc&region=eu`);
		p.connect();
		await until(() => p.wsconnected, 4000);
		expect(FakeWebSocket.instances.at(-1).url).toBe(`${url}/room?token=abc&region=eu`);
		expect(statuses).toEqual(['connecting', 'connected']);
		p.destroy();
	});

	test('connection-close fires on socket close and the provider reconnects', async () => {
		const url = uniqueUrl();
		const docA = new Y.Doc();
		docA.get('content').setAttr('x', 'a-1');
		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket
		});
		const docB = new Y.Doc();
		const pB = new providers.WebsocketProvider(url, 'room', docB, {
			WebSocketPolyfill: FakeWebSocket,
			maxBackoffTime: 50
		});
		await until(() => pB.synced, 4000);

		const closes = [];
		const failed = [];
		const statuses = [];
		pB.on('connection-close', (e, prov) => closes.push([e, prov]));
		pB.on('failed', (e) => failed.push(e));
		pB.on('status', (s) => statuses.push(s.status));
		const firstSocket = pB.ws;

		// Server-initiated close — transient: the provider reports the close
		// and reconnects; `failed` must NOT fire for a recoverable path.
		firstSocket.close();
		await until(() => closes.length === 1, 4000);
		expect(closes[0][1]).toBe(pB);
		expect(statuses).toContain('disconnected');
		expect(pB.synced).toBe(false);

		await until(() => pB.wsconnected && pB.ws !== firstSocket, 4000);
		await until(() => pB.synced, 4000);
		expect(failed.length).toBe(0);

		pA.destroy();
		pB.destroy();
	});

	test('connection-error fires on a socket error event', async () => {
		const url = uniqueUrl();
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: FakeWebSocket
		});
		const errors = [];
		const failed = [];
		p.on('connection-error', (e, prov) => errors.push([e, prov]));
		p.on('failed', (e) => failed.push(e));
		await until(() => p.wsconnected, 4000);

		p.ws.onerror({ type: 'error' });
		expect(errors.length).toBe(1);
		expect(errors[0][1]).toBe(p);
		// A socket error is not a terminal sync failure by itself.
		expect(failed.length).toBe(0);
		p.destroy();
	});
});

describe('auth replies', () => {
	test('a forged permission-denied frame emits permission-denied + failed once', async () => {
		const url = uniqueUrl();
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: FakeWebSocket
		});
		const denied = [];
		const failed = [];
		p.on('permission-denied', (reason, prov) => denied.push([reason, prov]));
		p.on('failed', (e, prov) => failed.push([e, prov]));
		await until(() => p.wsconnected, 4000);

		const forge = (reason) => {
			const e = encoding.createEncoder();
			writeProtocolVersion(e);
			encoding.writeVarUint(e, 2); // messageAuth
			writePermissionDenied(e, reason);
			deliverTo(p, encoding.toUint8Array(e));
		};
		forge('no-write-access');
		expect(denied.length).toBe(1);
		expect(denied[0][0]).toBe('no-write-access');
		expect(denied[0][1]).toBe(p);
		expect(failed.length).toBe(1);
		expect(failed[0][0].message).toMatch(/permission denied: no-write-access/);
		expect(failed[0][1]).toBe(p);

		// A second denial must not double-report the terminal failure.
		forge('still-denied');
		expect(denied.length).toBe(2);
		expect(failed.length).toBe(1);
		p.destroy();
	});

	test('an unknown auth subtype is reported on message-error', async () => {
		const url = uniqueUrl();
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: FakeWebSocket
		});
		const denied = [];
		const msgErrs = [];
		const failed = [];
		p.on('permission-denied', (r) => denied.push(r));
		p.on('message-error', (e) => msgErrs.push(e));
		p.on('failed', (e) => failed.push(e));
		await until(() => p.wsconnected, 4000);

		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 2); // messageAuth
		encoding.writeVarUint(e, 7); // auth subtype nothing claims
		deliverTo(p, encoding.toUint8Array(e));

		expect(denied.length).toBe(0);
		expect(failed.length).toBe(0);
		expect(msgErrs.length).toBe(1);
		expect(msgErrs[0].message).toMatch(/Unknown auth message type 7/);
		p.destroy();
	});
});

describe('failure channel (D4) — WebsocketProvider', () => {
	test('destroy before the handshake emits failed exactly once', async () => {
		const url = uniqueUrl();
		// connect:false — the provider is asked to never even dial out.
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			connect: false,
			WebSocketPolyfill: FakeWebSocket
		});
		const failed = [];
		p.on('failed', (e, prov) => failed.push([e, prov]));
		p.destroy();
		expect(failed.length).toBe(1);
		expect(failed[0][0].message).toMatch(/destroyed before it synced/);
		expect(failed[0][1]).toBe(p);
	});

	test('destroy while connecting (socket open, no handshake) emits failed once', async () => {
		const url = uniqueUrl();
		const p = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: FakeWebSocket
		});
		const failed = [];
		p.on('failed', (e) => failed.push(e));
		// Destroyed before the SyncStep2 handshake can complete.
		p.destroy();
		expect(failed.length).toBe(1);
	});

	test('destroy after synced emits no failure', async () => {
		const url = uniqueUrl();
		const docA = new Y.Doc();
		docA.get('content').setAttr('x', 'a-1');
		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket
		});
		const pB = new providers.WebsocketProvider(url, 'room', new Y.Doc(), {
			WebSocketPolyfill: FakeWebSocket
		});
		await until(() => pB.synced, 4000);
		const failed = [];
		pB.on('failed', (e) => failed.push(e));
		pB.destroy();
		expect(failed.length).toBe(0);
		pA.destroy();
	});
});
