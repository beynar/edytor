/**
 * SY01-WS — the actual supported websocket path for the v14 provider stack.
 *
 * `WebsocketProvider` is exercised end-to-end against an in-memory fake
 * WebSocket relay (a minimal `WebSocketPolyfill`): connect → SyncStep1 →
 * SyncStep2 replies relayed between peers → docs converge; awareness
 * propagates; a v13-shaped frame is dropped at the version gate; the empty-
 * reply threshold (version word + message type = 2 bytes) is respected so no
 * truncated frames are sent.
 *
 * Server compatibility classification (docs/crdt-v14-providers.md): an
 * OPAQUE relay that just forwards frames between peers is reusable — this
 * test's relay does exactly that. A server that participates in sync itself
 * must run the vendored v14 engine + protocols.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import { GENERATION, writeProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';

const providers = bindWebsocketProvider(Y);
const sync = bindSync(Y);

/**
 * Minimal opaque-relay fake server: sockets on the same URL form a room;
 * `send` is delivered (structured-clone semantics) to every other member.
 */
class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	/** url -> Set<FakeWebSocket> */
	static rooms = new Map();
	static sentLog = []; // every frame sent, for assertions

	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(url) {
		this.url = url;
		setTimeout(() => {
			if (this.readyState !== 0) return;
			let room = FakeWebSocket.rooms.get(url);
			if (!room) FakeWebSocket.rooms.set(url, (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		FakeWebSocket.sentLog.push(data.slice ? data.slice() : data);
		const room = FakeWebSocket.rooms.get(this.url);
		if (!room) return;
		// Structured-clone semantics: receivers get their own bytes.
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

const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

let counter = 0;

describe('SY01-WS: websocket provider over an opaque relay', () => {
	test('two providers converge over the websocket path', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awA = new Awareness(docA);
		const awB = new Awareness(docB);

		docA.get('content').setAttr('x', 'a-1');

		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			awareness: awA,
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		const pB = new providers.WebsocketProvider(url, 'room', docB, {
			awareness: awB,
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});

		await until(() => pB.wsconnected && pA.wsconnected);
		await until(() => docB.get('content').getAttr('x') === 'a-1', 4000);
		expect(docB.get('content').getAttr('x')).toBe('a-1');
		expect(pB.synced).toBe(true);

		// live update path
		docB.get('content').setAttr('y', 'b-2');
		await until(() => docA.get('content').getAttr('y') === 'b-2', 4000);
		expect(docA.get('content').getAttr('y')).toBe('b-2');

		// awareness propagates over the same channel
		awA.setLocalStateField('user', { name: 'ada' });
		await until(() => awB.getStates().get(docA.clientID)?.user?.name === 'ada', 4000);
		expect(awB.getStates().get(docA.clientID)?.user?.name).toBe('ada');

		pA.destroy();
		pB.destroy();
	});

	test('every frame carries the v14 envelope; empty replies are never sent', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		const pB = new providers.WebsocketProvider(url, 'room', docB, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		await until(() => pB.wsconnected && pB.synced, 4000);

		// Every sent frame starts with the generation word (D-2: engine +
		// wire + schema) and has a real payload — never the bare header.
		expect(FakeWebSocket.sentLog.length).toBeGreaterThan(0);
		for (const frame of FakeWebSocket.sentLog) {
			const u = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
			expect(decoding.readVarUint(decoding.createDecoder(u))).toBe(GENERATION);
			expect(u.length).toBeGreaterThan(3);
		}
		pA.destroy();
		pB.destroy();
	});

	test('a v13-shaped frame is dropped at the gate before decoding', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docA = new Y.Doc();
		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		const mismatches = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		await until(() => pA.wsconnected, 4000);

		// Forge a v13 sync frame (no version word — first byte is the
		// message type 0) carrying a SyncStep1 for a foreign doc.
		const foreign = new Y.Doc();
		foreign.get('content').setAttr('poison', true);
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, 0); // v13 messageSync
		sync.writeSyncStep1(e, foreign);
		// Deliver it as a server → provider frame.
		pA.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });
		await new Promise((r) => setTimeout(r, 20));

		expect(docA.get('content').getAttr('poison')).toBeUndefined();
		expect(mismatches.length).toBe(1);
		expect(mismatches[0].expected).toBe(GENERATION);
		expect(mismatches[0].found).toBe(0);
		pA.destroy();
	});

	/**
	 * Count SyncStep1 requests this suite's providers have sent.
	 */
	const countSentStep1 = () =>
		FakeWebSocket.sentLog.filter((frame) => {
			const u = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
			const d = decoding.createDecoder(u);
			if (decoding.readVarUint(d) !== GENERATION) return false;
			if (decoding.readVarUint(d) !== 0) return false; // messageSync
			return decoding.readVarUint(d) === sync.messageYjsSyncStep1;
		}).length;

	/** Deliver `v14 | messageSync | <write>` to `p` as a server frame. */
	const deliverSync = (p, write) => {
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0); // messageSync
		write(e);
		p.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });
	};

	/**
	 * arch-v2 T2 (L56; D-3): the two-round settle window is deleted. An
	 * applied SyncStep2 claims the connection's `synced` at once, empty or
	 * not — no probe, no second window. `synced` is a readiness signal; the
	 * seed that an early empty claim could race is made idempotent by D-3's
	 * deterministic seed (T3), not by waiting.
	 */
	test('an applied SyncStep2 claims synced at once, empty or not (no settle window)', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docC = new Y.Doc();
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		await until(() => pC.wsconnected, 4000);
		expect(pC.synced).toBe(false);

		deliverSync(pC, (e) => sync.writeSyncStep2(e, new Y.Doc()));
		expect(pC.synced).toBe(true);
		expect(pC.hasSynced).toBe(true);
		await new Promise((r) => setTimeout(r, 50));
		expect(countSentStep1()).toBe(1); // the hello only — no probe
		pC.destroy();
	});

	test('the join rule: a Step1 we cover claims synced; one holding more is asked back', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docC = new Y.Doc();
		docC.get('content').setAttr('x', 'c');
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		await until(() => pC.wsconnected, 4000);
		expect(countSentStep1()).toBe(1);

		// A member holding more than us: answered with a Step2 AND our Step1.
		const richer = new Y.Doc();
		richer.get('content').setAttr('y', 'r');
		const sent = pC.ws.send.bind(pC.ws);
		const replies = [];
		pC.ws.send = (data) => {
			replies.push(new Uint8Array(data));
			sent(data);
		};
		deliverSync(pC, (e) => sync.writeSyncStep1(e, richer));
		expect(pC.synced).toBe(false);
		const types = replies.map((u) => {
			const d = decoding.createDecoder(u);
			decoding.readVarUint(d);
			decoding.readVarUint(d);
			return decoding.readVarUint(d);
		});
		expect(types).toEqual([sync.messageYjsSyncStep2, sync.messageYjsSyncStep1]);

		// A member we cover: we hold its state — the connection has synced.
		deliverSync(pC, (e) => sync.writeSyncStep1(e, new Y.Doc()));
		expect(pC.synced).toBe(true);
		pC.destroy();
	});

	test('synced survives reconnect through a fresh handshake, not a stale settle', async () => {
		const url = `ws://fake/${counter++}`;
		const docA = new Y.Doc();
		docA.get('content').setAttr('x', 'a-1');
		const pA = new providers.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		const docB = new Y.Doc();
		const pB = new providers.WebsocketProvider(url, 'room', docB, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		await until(() => pB.synced, 4000);
		expect(docB.get('content').getAttr('x')).toBe('a-1');

		// Reconnect: the doc already holds state, so the first applied
		// SyncStep2 resolves synced immediately — no settle needed.
		pB.disconnect();
		await until(() => !pB.wsconnected, 4000);
		expect(pB.synced).toBe(false);
		pB.connect();
		await until(() => pB.synced, 4000);
		expect(docB.get('content').getAttr('x')).toBe('a-1');
		pA.destroy();
		pB.destroy();
	});
});
