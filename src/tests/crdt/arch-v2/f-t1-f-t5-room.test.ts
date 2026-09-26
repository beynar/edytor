/**
 * arch-v2 §8.6 F-T1 and F-T5 — the room lifecycle and the join rule (T2).
 *
 * F-T1 two websocket clients sync; B's socket drops; `B.destroy()` → no
 *   `failed` event (G11). A provider that synced, lost its socket, then is
 *   destroyed did not fail: `connected` (transient) and `hasSynced`
 *   (lifetime) are two facts (D37, probe P1).
 * F-T5 opaque relay, default options; B edits offline and reconnects → A
 *   receives B's offline edits without `resyncInterval` (G2, probe P5). The
 *   join rule is derived from state vectors: a Step1 is answered with a
 *   Step2 and, when the asker holds what we lack (or we have not heard the
 *   room yet), with our own Step1 — on the socket and the BroadcastChannel
 *   alike (O76).
 *
 * Expectations come from the plan rows (§8.6, §6.4 D37/D38, O74/O76), never
 * from engine output. Multi-replica rows run under three client-id
 * assignments and with duplicated delivery.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';

const ws = bindWebsocketProvider(Y);
const idbProviders = bindIndexeddbProvider(Y);

/**
 * Opaque relay fake: sockets on one URL form a room; every frame is
 * forwarded verbatim to every OTHER member (never decoded, never answered).
 * `dup` delivers each frame that many times (duplicate delivery must be a
 * no-op). `kill(url)` severs every socket of a room without a close frame
 * reaching the peers — a transient network loss.
 */
class Relay {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map();
	static dup = 1;

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
			let room = Relay.rooms.get(url);
			if (!room) Relay.rooms.set(url, (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		const room = Relay.rooms.get(this.url);
		if (!room) return;
		const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
		setTimeout(() => {
			for (const peer of room) {
				if (peer === this || peer.readyState !== 1) continue;
				for (let i = 0; i < Relay.dup; i++) peer.onmessage?.({ data: bytes.slice().buffer });
			}
		});
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		Relay.rooms.get(this.url)?.delete(this);
		this.onclose?.({});
	}
}

let counter = 0;
const uniqueUrl = () => `ws://relay/${counter++}`;
const until = async (cond, timeout = 4000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A provider with the library's DEFAULT options (no `resyncInterval`). */
const open = (url, doc) =>
	new ws.WebsocketProvider(url, 'room', doc, { WebSocketPolyfill: Relay, disableBc: true });

const docWith = (clientID) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	return doc;
};

const attr = (doc, key) => doc.get('content').getAttr(key);

/** Three client-id assignments: A < B, A > B, far apart. */
const ASSIGNMENTS = [
	[11, 22],
	[22, 11],
	[3, 2 ** 31 - 5]
];

describe('F-T1 — a provider that synced never reports failed (G11, D37)', () => {
	it('socket drop after sync, then destroy: no failed event', async () => {
		const url = uniqueUrl();
		const docA = docWith(1);
		docA.get('content').setAttr('x', 'a');
		const pA = open(url, docA);
		const pB = open(url, docWith(2));
		await until(() => pB.synced && attr(pB.doc, 'x') === 'a');
		const failed = [];
		pB.on('failed', (error) => failed.push(error));

		// Transient loss: the socket drops; the provider keeps reconnecting.
		pB.ws.close();
		await until(() => !pB.wsconnected);
		pB.destroy();

		expect(failed).toEqual([]);
		pA.destroy();
	});

	it('connected is transient, hasSynced is the lifetime fact', async () => {
		const url = uniqueUrl();
		const docA = docWith(1);
		docA.get('content').setAttr('x', 'a');
		const pA = open(url, docA);
		const pB = open(url, docWith(2));
		await until(() => pB.synced);
		expect(pB.hasSynced).toBe(true);

		pB.ws.close();
		await until(() => !pB.wsconnected);
		expect(pB.synced).toBe(false); // this connection has not synced
		expect(pB.hasSynced).toBe(true); // the provider has

		// `whenSynced` is the lifetime promise, on both providers.
		await expect(pB.whenSynced).resolves.toBe(pB);
		pA.destroy();
		pB.destroy();
	});

	it('a provider destroyed before it ever synced still fails exactly once', async () => {
		const pB = open(uniqueUrl(), docWith(2));
		const failed = [];
		pB.on('failed', (error) => failed.push(error));
		pB.destroy();
		pB.destroy(); // destroy guard: a second destroy is a no-op
		expect(failed).toHaveLength(1);
	});
});

describe('F-T5 — offline edits reach peers without resyncInterval (G2, O76)', () => {
	for (const [idA, idB] of ASSIGNMENTS) {
		for (const dup of [1, 2]) {
			it(`clients ${idA}/${idB}, delivery ×${dup}: B's offline edit reaches A`, async () => {
				Relay.dup = dup;
				try {
					const url = uniqueUrl();
					const docA = docWith(idA);
					const docB = docWith(idB);
					docA.get('content').setAttr('seed', 1);
					const pA = open(url, docA);
					const pB = open(url, docB);
					await until(() => pB.synced && attr(docB, 'seed') === 1);

					// B goes offline; both sides edit; B comes back.
					pB.disconnect();
					await until(() => !pB.wsconnected);
					docB.get('content').setAttr('offlineB', 'b');
					docA.get('content').setAttr('whileAway', 'a');
					pB.connect();

					await until(() => attr(docA, 'offlineB') === 'b' && attr(docB, 'whileAway') === 'a');
					expect(Y.encodeStateVector(docA)).toEqual(Y.encodeStateVector(docB));
					pA.destroy();
					pB.destroy();
				} finally {
					Relay.dup = 1;
				}
			});
		}
	}

	it('the first member of a room hears the room once a second member joins', async () => {
		// P6b: the first client's hello had no one to answer it; the joiner's
		// Step1 is answered with a Step2 AND the first client's own Step1.
		const url = uniqueUrl();
		const docA = docWith(1);
		const pA = open(url, docA);
		await until(() => pA.wsconnected);
		await wait(50);
		expect(pA.synced).toBe(false);

		const docB = docWith(2);
		docB.get('content').setAttr('fromB', 'b');
		const pB = open(url, docB);
		await until(() => pA.synced && attr(docA, 'fromB') === 'b');
		expect(pB.synced).toBe(true);
		pA.destroy();
		pB.destroy();
	});

	it('the BroadcastChannel room follows the same rule: offline edits converge both ways', async () => {
		const name = `f-t5-bc-${counter++}`;
		const docA = docWith(1);
		const docB = docWith(2);
		const pA = new idbProviders.IndexeddbPersistence(name, docA);
		const pB = new idbProviders.IndexeddbPersistence(`${name}-b`, docB);
		// Different containers, one room: point B's channel at A's.
		pB.dbName = pA.dbName;
		await Promise.all([pA.whenSynced, pB.whenSynced]);
		pB.disconnectBc();
		docA.get('content').setAttr('fromA', 'a');
		docB.get('content').setAttr('fromB', 'b');
		pB.connectBc();
		await until(() => attr(docA, 'fromB') === 'b' && attr(docB, 'fromA') === 'a');
		await pA.destroy();
		await pB.destroy();
	});
});
