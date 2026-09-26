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
import { PROTOCOL_VERSION, writeProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';
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

		// Every sent frame starts with the protocol-version varuint (14) and
		// has a real payload — never the bare 2-byte header.
		expect(FakeWebSocket.sentLog.length).toBeGreaterThan(0);
		for (const frame of FakeWebSocket.sentLog) {
			const u = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
			expect(u[0]).toBe(PROTOCOL_VERSION);
			expect(u.length).toBeGreaterThan(2);
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
		expect(mismatches[0].expected).toBe(PROTOCOL_VERSION);
		expect(mismatches[0].found).toBe(0);
		pA.destroy();
	});

	/**
	 * The opaque relay broadcasts every SyncStep2 reply to ALL room
	 * members. A reply computed against ANOTHER member's state vector is
	 * an empty diff for an already-synced pair — applying it must not
	 * complete OUR handshake on a still-empty doc. Otherwise a fresh
	 * client can mark `synced` (and seed initial content) before the real
	 * hydration answer lands, and deterministic block ids let the seed
	 * LWW-clobber edited state.
	 */
	test('a foreign empty SyncStep2 cannot claim synced on a fresh doc', async () => {
		const url = `ws://fake/${counter++}`;
		const docC = new Y.Doc();
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true,
			syncSettleMs: 5000
		});
		await until(() => pC.wsconnected, 4000);
		expect(pC.synced).toBe(false);

		// Forge the foreign reply: v14 | messageSync | SyncStep2(empty).
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0); // messageSync
		sync.writeSyncStep2(e, new Y.Doc());
		pC.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });

		// Applied cleanly, changed nothing, and must not claim the handshake.
		expect(pC.synced).toBe(false);
		pC.destroy();
	});

	/**
	 * Count SyncStep1 requests this suite's providers have sent — the
	 * connect-time request, plus the settle's "are you sure" re-probe.
	 */
	const countSentStep1 = () =>
		FakeWebSocket.sentLog.filter((frame) => {
			const u = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
			const d = decoding.createDecoder(u);
			if (decoding.readVarUint(d) !== PROTOCOL_VERSION) return false;
			if (decoding.readVarUint(d) !== 0) return false; // messageSync
			return decoding.readVarUint(d) === sync.messageYjsSyncStep1;
		}).length;

	test('an empty room completes the handshake via the settle window', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docC = new Y.Doc();
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true,
			syncSettleMs: 40
		});
		await until(() => pC.wsconnected, 4000);

		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0); // messageSync
		sync.writeSyncStep2(e, new Y.Doc());
		pC.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });
		expect(pC.synced).toBe(false);

		// First expiry does NOT decide — it re-probes: a second SyncStep1
		// goes out and the room gets a second window to answer.
		await until(() => countSentStep1() === 2, 4000);
		expect(pC.synced).toBe(false);

		// The doc stays empty past BOTH windows → the room verifiably has
		// nothing for us → synced resolves so the doc may seed itself.
		await until(() => pC.synced, 4000);
		pC.destroy();
	});

	test('a hydration reply landing inside the second settle window still claims synced', async () => {
		const url = `ws://fake/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docC = new Y.Doc();
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true,
			syncSettleMs: 40
		});
		await until(() => pC.wsconnected, 4000);

		// Ambiguous empty reply → settle armed, first window runs.
		const e1 = encoding.createEncoder();
		writeProtocolVersion(e1);
		encoding.writeVarUint(e1, 0);
		sync.writeSyncStep2(e1, new Y.Doc());
		pC.ws.onmessage({ data: encoding.toUint8Array(e1).slice().buffer });

		// Round 2 begins when the probe (a second SyncStep1) goes out —
		// the verdict is still open.
		await until(() => countSentStep1() === 2, 4000);
		expect(pC.synced).toBe(false);

		// The real answer arrives late — inside the second window. It
		// carries room state and claims synced before the verdict.
		const full = new Y.Doc();
		full.get('content').setAttr('x', 'hydrated');
		const e2 = encoding.createEncoder();
		writeProtocolVersion(e2);
		encoding.writeVarUint(e2, 0);
		sync.writeSyncStep2(e2, full);
		pC.ws.onmessage({ data: encoding.toUint8Array(e2).slice().buffer });

		await until(() => pC.synced, 4000);
		expect(docC.get('content').getAttr('x')).toBe('hydrated');
		pC.destroy();
	});

	test('a SyncStep2 carrying real state completes the handshake immediately', async () => {
		const url = `ws://fake/${counter++}`;
		const docC = new Y.Doc();
		const pC = new providers.WebsocketProvider(url, 'room', docC, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true,
			syncSettleMs: 5000
		});
		await until(() => pC.wsconnected, 4000);

		// Foreign empty reply lands first — ambiguous, defers synced.
		const e1 = encoding.createEncoder();
		writeProtocolVersion(e1);
		encoding.writeVarUint(e1, 0);
		sync.writeSyncStep2(e1, new Y.Doc());
		pC.ws.onmessage({ data: encoding.toUint8Array(e1).slice().buffer });
		expect(pC.synced).toBe(false);

		// The real answer carries room state → synced fires at once, well
		// inside the settle window.
		const full = new Y.Doc();
		full.get('content').setAttr('x', 'a-1');
		const e2 = encoding.createEncoder();
		writeProtocolVersion(e2);
		encoding.writeVarUint(e2, 0);
		sync.writeSyncStep2(e2, full);
		pC.ws.onmessage({ data: encoding.toUint8Array(e2).slice().buffer });
		expect(pC.synced).toBe(true);
		expect(docC.get('content').getAttr('x')).toBe('a-1');
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
