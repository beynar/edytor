/**
 * GATE-2 attack probes — provider lifecycle (attack item 4).
 *
 * - WS reconnect: synced toggles, SyncStep1 re-sent on reconnect, backoff.
 * - resyncInterval fires SyncStep1 periodically.
 * - double destroy on both providers.
 * - awareness ownership asymmetry: IDB destroys owned awareness; WS never does.
 * - whenSynced on a provider destroyed before sync — does it settle?
 * - cross-provider relay: a ws-received update lands in the IDB store.
 * - BC disconnect broadcast clears remote awareness.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import * as bc from 'lib0-v14/broadcastchannel';
import * as decoding from 'lib0-v14/decoding';
import * as encoding from 'lib0-v14/encoding';
import { generationDbName, writeProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
const wsProviders = bindWebsocketProvider(Y);
const sync = bindSync(Y);
const E = bindEdytorDoc(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;
const until = async (cond, timeout = 4000, step = 10) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, step));
	}
};
const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A controllable fake websocket — records sent frames, manual close/open. */
const makeFakeWS = () => {
	const instances = [];
	class FakeWS {
		static OPEN = 1;
		OPEN = 1;
		binaryType = '';
		readyState = 0;
		sent = [];
		constructor(url, protocols) {
			this.url = url;
			this.protocols = protocols;
			instances.push(this);
			setTimeout(() => {
				if (this.readyState === 3) return;
				this.readyState = 1;
				this.onopen?.({ type: 'open' });
			}, 0);
		}
		send(data) {
			this.sent.push(new Uint8Array(data instanceof ArrayBuffer ? data : (data.buffer ?? data)));
		}
		close() {
			this.readyState = 3;
			this.onclose?.({});
		}
		/** Simulate a server-side drop. */
		drop() {
			this.readyState = 3;
			this.onclose?.({ code: 1006 });
		}
	}
	return { FakeWS, instances };
};

/** Decode a v14 frame → {type, syncType}. */
const frameType = (bytes) => {
	const d = decoding.createDecoder(bytes);
	const ver = decoding.readVarUint(d);
	const type = decoding.readVarUint(d);
	let syncType = null;
	if (type === 0) syncType = decoding.readVarUint(d);
	return { ver, type, syncType };
};

describe('WS lifecycle', () => {
	test('reconnect re-syncs: synced false→true, SyncStep1 resent', async () => {
		const { FakeWS, instances } = makeFakeWS();
		const doc = new Y.Doc();
		E.create(doc).init();
		const p = new wsProviders.WebsocketProvider('ws://gate2', 'room', doc, {
			WebSocketPolyfill: FakeWS,
			disableBc: true
		});
		const statuses = [];
		p.on('synced', (s) => statuses.push(s));
		await until(() => p.wsconnected);
		expect(instances.length).toBe(1);

		// Server drops the connection.
		instances[0].drop();
		expect(p.wsconnected).toBe(false);
		expect(p.synced).toBe(false);

		// Backoff reconnects (first retry ~100ms).
		await until(() => p.wsconnected && instances.length === 2, 5000);
		// The new socket immediately sent SyncStep1 — resync on reconnect.
		const first = frameType(instances[1].sent[0]);
		expect(first).toMatchObject({ ver: 14, type: 0, syncType: 0 });
		p.destroy();
	});

	test('resyncInterval re-sends SyncStep1 on the live socket', async () => {
		const { FakeWS, instances } = makeFakeWS();
		const doc = new Y.Doc();
		const p = new wsProviders.WebsocketProvider('ws://gate2r', 'room', doc, {
			WebSocketPolyfill: FakeWS,
			disableBc: true,
			resyncInterval: 40
		});
		await until(() => p.wsconnected);
		await until(() => instances[0].sent.length >= 3, 3000);
		// Frame 1 = SyncStep1 on open; the resync timer adds more SyncStep1s.
		const sync1s = instances[0].sent.filter((f) => {
			const t = frameType(f);
			return t.type === 0 && t.syncType === 0;
		});
		expect(sync1s.length).toBeGreaterThanOrEqual(2);
		p.destroy();
	});

	test('double destroy is safe; owned-awareness asymmetry vs IDB', async () => {
		const { FakeWS } = makeFakeWS();
		const doc = new Y.Doc();
		const p = new wsProviders.WebsocketProvider('ws://gate2d', 'room', doc, {
			WebSocketPolyfill: FakeWS,
			disableBc: true
		});
		await until(() => p.wsconnected);
		const ownedAwareness = p.awareness; // default-constructed by provider
		expect(ownedAwareness.getLocalState()).not.toBeNull();
		p.destroy();
		expect(() => p.destroy()).not.toThrow();
		// WS provider does NOT destroy the awareness it created — unlike the
		// IDB provider's _ownsAwareness path. The awareness instance keeps its
		// doc listeners + local state alive after the provider is gone.
		expect(ownedAwareness.getLocalState()).not.toBeNull(); // ← asymmetry
		p.awareness.destroy(); // consumer must clean it up themselves
	});

	test('destroy before any connection does not throw and stops reconnecting', async () => {
		const { FakeWS, instances } = makeFakeWS();
		const doc = new Y.Doc();
		const p = new wsProviders.WebsocketProvider('ws://gate2e', 'room', doc, {
			WebSocketPolyfill: FakeWS,
			disableBc: true
		});
		p.destroy();
		await nextTick(200);
		expect(instances.length).toBeLessThanOrEqual(1); // no reconnect storm
	});
});

describe('IDB lifecycle', () => {
	test('double destroy is idempotent; owned awareness destroyed, injected survives', async () => {
		const name = uniqueName('lc-idb');
		// Owned awareness → destroyed with the provider.
		const p1 = new providers.IndexeddbPersistence(name, new Y.Doc());
		await p1.whenSynced;
		const owned = p1.awareness;
		expect(owned.getLocalState()).not.toBeNull();
		await p1.destroy();
		await expect(p1.destroy()).resolves.toBeUndefined(); // idempotent
		expect(owned.getLocalState()).toBeNull(); // owned awareness destroyed

		// Injected awareness → survives.
		const doc2 = new Y.Doc();
		const injected = new Awareness(doc2);
		const p2 = new providers.IndexeddbPersistence(name, doc2, { awareness: injected });
		await p2.whenSynced;
		await p2.destroy();
		expect(injected.getLocalState()).not.toBeNull(); // still alive
		injected.destroy();
	});

	test('whenSynced rejects when the provider is destroyed before opening', async () => {
		const p = new providers.IndexeddbPersistence(uniqueName('lc-early'), new Y.Doc());
		void p.destroy();
		const settled = await Promise.race([
			p.whenSynced.then(
				() => 'resolved',
				() => 'rejected'
			),
			nextTick(150).then(() => 'pending')
		]);
		// Post-D22 contract: destroying before hydration settles whenSynced as a
		// rejection (previously it hung forever — see U08/D22 teardown notes).
		expect(settled).toBe('rejected');
	});

	test('BC disconnect broadcasts an awareness-removal (peer sees null state)', async () => {
		const name = uniqueName('lc-bcdisc');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awA = new Awareness(docA);
		const awB = new Awareness(docB);
		const pA = new providers.IndexeddbPersistence(name, docA, { awareness: awA });
		const pB = new providers.IndexeddbPersistence(name, docB, { awareness: awB });
		await Promise.all([pA.whenSynced, pB.whenSynced]);
		awA.setLocalStateField('user', { name: 'A' });
		await until(() => awB.getStates().get(docA.clientID)?.user !== undefined, 4000);
		// Destroy A: the disconnect broadcast must remove A's state on B.
		await pA.destroy();
		await until(() => !awB.getStates().has(docA.clientID), 4000);
		expect(awB.getStates().has(docA.clientID)).toBe(false);
		await pB.destroy();
		awA.destroy();
		awB.destroy();
	});

	test('destroy before hydration completes leaves no row writer attached', async () => {
		const name = uniqueName('lc-fast-destroy');
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.destroy(); // destroy BEFORE whenSynced resolves
		ed.insertText(BOOTSTRAP_CHECK(doc), 0, 'x');
		await nextTick(50);
		// Reopen: nothing was persisted after destroy — the update listener
		// was detached by destroy().
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		expect(doc2.store.clients.size).toBe(0);
		await p2.destroy();
	});
});

const BOOTSTRAP_CHECK = (doc) => E.create(doc).childrenIds(null)[0];

describe('cross-provider relay', () => {
	test('an update received via WS is persisted by the IDB provider on the same doc', async () => {
		const { FakeWS, instances } = makeFakeWS();
		const name = uniqueName('lc-relay');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pIdb = new providers.IndexeddbPersistence(name, docA);
		await pIdb.whenSynced;
		const pWs = new wsProviders.WebsocketProvider('ws://relay', 'r', docA, {
			WebSocketPolyfill: FakeWS,
			disableBc: true
		});
		await until(() => pWs.wsconnected);

		// A remote peer's update arrives via the websocket (v14-enveloped).
		const remote = new Y.Doc();
		const red = E.create(remote);
		red.init();
		red.insertBlock({ parent: null, index: 0 }, { id: 'remote-b', type: 'paragraph' });
		const update = Y.encodeStateAsUpdate(remote);
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0); // messageSync
		sync.writeUpdate(e, update);
		pWs.ws.onmessage({ data: encoding.toUint8Array(e).buffer });
		expect(docA.get('blocks').getAttr('remote-b')).toBeDefined();
		await nextTick(60);

		// Kill the ws, reopen from IDB alone — the ws-received edit persisted.
		pWs.destroy();
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		expect(doc2.get('blocks').getAttr('remote-b')).toBeDefined();
		await pIdb.destroy();
		await p2.destroy();
	});
});
