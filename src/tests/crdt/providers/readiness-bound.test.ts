/**
 * The websocket sync's readiness bound runs from transport state (UW-04),
 * and a terminal refusal never seeds (UW-12, document half).
 *
 * - A cold room holds the upgrade (its load blocks it) and answers once
 *   open: the document hydrates from the room's answer, even when that
 *   lands past `DEFAULT_READINESS_BOUND` after the attach. No seed.
 * - A room that answers within the bound hydrates as before; a room that
 *   opens and stays silent is decided locally a bound after the OPEN; an
 *   offline start (every dial refused) seeds after the bound as before.
 * - A room that closes the socket with `1008` before any sync: the empty
 *   document stays pending (nothing seeded), `syncRefusal` names the
 *   refusal, `onSyncRefused` fires once, and the client dials once.
 * - A refusal after the document hydrated: the content stays, the refusal
 *   is still surfaced.
 * - The refusal belongs to the provider that reported it (NW-08): releasing
 *   that provider lifts it, and so does its own later sync (`connect()`
 *   after a refreshed token). Re-attached to an empty room, the document
 *   then seeds the draft (`local`).
 * - Releasing a refused provider beside a settled one decides the document
 *   (RW-06): an empty one seeds the draft. With no provider left it stays
 *   pending until the next attach or `sync()`.
 * - Expired credentials (`4401`) before the first sync hold the bound
 *   (RW-04): the empty document waits for a dial that gets in, then
 *   hydrates with only the room's content.
 * - A dial that neither opens nor fails times out after `connectTimeout`
 *   (10 s by default, NW-09, RW-07): it is closed like a failed dial, so the
 *   bound arms and an empty document is decided `DEFAULT_READINESS_BOUND`
 *   later. A longer `connectTimeout` waits for a slower room; `Infinity`
 *   never gives up.
 *
 * The room here holds a document and speaks the join rule; its open and
 * answer delays and its refusal are set per test. Expected states are
 * hand-authored from the room's content and the value each test passes.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, SyncRefusedError } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { frame, readProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';

const providers = bindProviders(Y);
const sync = bindSync(Y);

/**
 * A room holding `value`. `up: false` refuses every dial (offline);
 * `openAfter` delays the upgrade (a cold room); `answerAfter` delays the
 * Step2 (`Infinity`: never answers); `refuse` closes the socket with that
 * `{ code, reason }` when its first frame arrives.
 */
class Room {
	static byUrl = new Map();
	dials = 0;
	sockets = new Set();

	constructor(url, { value, up = true, openAfter = 0, answerAfter = 0, refuse } = {}) {
		this.doc = value ? loadInto(value) : new Y.Doc();
		Object.assign(this, { up, openAfter, answerAfter, refuse });
		Room.byUrl.set(url, this);
	}

	receive(socket, bytes) {
		if (this.refuse) return socket.close(this.refuse.code, this.refuse.reason);
		const decoder = decoding.createDecoder(bytes);
		if (!readProtocolVersion(decoder) || decoding.readVarUint(decoder) !== 0) return;
		const type = decoding.readVarUint(decoder);
		const payload = decoding.readVarUint8Array(decoder);
		if (type !== sync.messageYjsSyncStep1 || !Number.isFinite(this.answerAfter)) return;
		setTimeout(
			() => socket.deliver(frame(0, (e) => sync.writeSyncStep2(e, this.doc, payload))),
			this.answerAfter
		);
	}
}

/** A document's state as a room document. */
const loadInto = (value) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, createDocument({ value }).encode());
	return doc;
};

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
		this.room = Room.byUrl.get(url.split('?')[0]);
		if (this.room) this.room.dials++;
		setTimeout(
			() => {
				if (this.readyState !== 0) return;
				if (!this.room?.up) return this.close(1006, '');
				this.readyState = 1;
				this.room.sockets.add(this);
				this.onopen?.({});
			},
			this.room?.up ? this.room.openAfter : 0
		);
	}

	send(data) {
		const bytes = new Uint8Array(data).slice();
		setTimeout(() => {
			if (this.readyState === 1) this.room.receive(this, bytes);
		});
	}

	deliver(bytes) {
		if (this.readyState === 1) this.onmessage?.({ data: bytes.slice().buffer });
	}

	close(code = 1005, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.room?.sockets.delete(this);
		this.onclose?.({ code, reason });
	}
}

let counter = 0;
const uniqueUrl = () => `ws://readiness-bound/${counter++}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const texts = (document) =>
	document.facade.project().children.map((block) => document.facade.blockText(block.id));

const roomValue = { children: [{ type: 'paragraph', id: 'r', content: [{ text: 'room' }] }] };
const draft = { children: [{ type: 'paragraph', id: 'd', content: [{ text: 'draft' }] }] };

/** Attach the default websocket sync (with its local store) to a fresh document. */
const open = (url, value = draft) => {
	const document = createDocument();
	document.attachSync(
		providers.createWebsocketSync({ server: url, room: 'room', WebSocketPolyfill: Socket }),
		{ value }
	);
	return document;
};

describe('the readiness bound counts from the socket, not the attach', () => {
	it('a cold room answering 1300 ms after the attach hydrates: nothing seeded', async () => {
		const url = uniqueUrl();
		new Room(`${url}/room`, { value: roomValue, openAfter: 1250, answerAfter: 50 });
		const document = open(url);
		await wait(1150);
		expect(document.ready).toBe(false);
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		await wait(50);
		expect(texts(document)).toEqual(['room']);
		document.destroy();
	});

	it('a room answering 900 ms after the attach hydrates, as before', async () => {
		const url = uniqueUrl();
		new Room(`${url}/room`, { value: roomValue, answerAfter: 900 });
		const document = open(url);
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		expect(texts(document)).toEqual(['room']);
		document.destroy();
	});

	it('a room that opens after 500 ms and stays silent decides a bound after the open', async () => {
		const url = uniqueUrl();
		new Room(`${url}/room`, { openAfter: 500, answerAfter: Infinity });
		const document = open(url);
		await wait(1300);
		expect(document.ready).toBe(false);
		await until(() => document.ready);
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		document.destroy();
	});

	it('offline: every dial refused, the document seeds a bound after the first failure', async () => {
		const url = uniqueUrl();
		new Room(`${url}/room`, { up: false });
		const document = open(url);
		await wait(800);
		expect(document.ready).toBe(false);
		await until(() => document.ready, 700);
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		document.destroy();
	});
});

describe('a terminal refusal never seeds', () => {
	it('closed 1008 before any sync: pending, nothing seeded, the refusal surfaced, one dial', async () => {
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, {
			value: roomValue,
			refuse: { code: 1008, reason: 'refused: generation' }
		});
		const document = open(url);
		const heard = [];
		document.onSyncRefused((refusal) => heard.push(refusal));
		await wait(2000);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(document.syncPending).toBe(false);
		expect(room.dials).toBe(1);
		expect(heard).toHaveLength(1);
		expect(document.syncRefusal).toBe(heard[0]);
		expect(heard[0]).toBeInstanceOf(SyncRefusedError);
		expect([heard[0].code, heard[0].reason]).toEqual([1008, 'refused: generation']);
		document.destroy();
	});

	it('refused after it hydrated: the content stays and the refusal is surfaced', async () => {
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, { value: roomValue });
		const document = open(url);
		await until(() => document.ready && room.sockets.size === 1);
		expect(document.readiness).toBe('hydrated');
		for (const socket of room.sockets) socket.close(4403, 'refused: replica');
		await wait(300);
		expect(document.syncRefusal?.code).toBe(4403);
		expect(document.readiness).toBe('hydrated');
		expect(texts(document)).toEqual(['room']);
		expect(room.dials).toBe(1);
		document.destroy();
	});
});

describe('the refusal belongs to the provider that reported it', () => {
	const refusing = (url) =>
		new Room(`${url}/room`, { refuse: { code: 4403, reason: 'document access denied' } });
	const websocketSync = (url) =>
		providers.createWebsocketSync({ server: url, room: 'room', WebSocketPolyfill: Socket });

	it('refused, released, re-attached to an empty room: local with the draft seeded', async () => {
		const url = uniqueUrl();
		const room = refusing(url);
		const document = createDocument();
		const release = document.attachSync(websocketSync(url), { value: draft });
		await until(() => document.syncRefusal !== undefined);
		await wait(1200);
		expect(document.readiness).toBe('pending');
		release();
		expect(document.syncRefusal).toBeUndefined();
		expect(document.readiness).toBe('pending');
		room.refuse = undefined;
		document.attachSync(websocketSync(url), { value: draft });
		await until(() => document.ready);
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		expect(room.dials).toBe(2);
		document.destroy();
	});

	it('refused, then connect() after a refresh reaches an empty room: local with the draft seeded', async () => {
		const url = uniqueUrl();
		const room = refusing(url);
		const document = createDocument();
		let provider;
		const sync = Object.assign(
			({ doc, awareness, synced, failed }) => {
				provider = new providers.WebsocketProvider(url, 'room', doc, {
					awareness,
					WebSocketPolyfill: Socket,
					disableBc: true
				});
				provider.on('synced', (isSynced) => isSynced && synced(provider));
				provider.on('failed', (error) => failed(error, provider));
				return () => provider.destroy();
			},
			{ bound: Infinity }
		);
		document.attachSync(sync, { value: draft });
		await until(() => document.syncRefusal !== undefined);
		expect(provider.shouldConnect).toBe(false);
		room.refuse = undefined;
		provider.connect();
		await until(() => document.ready);
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		expect(document.syncRefusal).toBeUndefined();
		expect(room.dials).toBe(2);
		document.destroy();
	});

	it('refused beside a settled companion, the refused one released: local with the draft seeded', async () => {
		const url = uniqueUrl();
		refusing(url);
		const document = createDocument();
		document.attachSync(providers.createIndexeddbSync(`companion:${url}`), { value: draft });
		const release = document.attachSync(websocketSync(url), { value: draft });
		await until(() => document.syncRefusal !== undefined);
		await wait(1200);
		expect(document.readiness).toBe('pending');
		expect(document.syncPending).toBe(false);
		release();
		expect(document.syncRefusal).toBeUndefined();
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		document.destroy();
	});

	it("another target's sync does not lift it: the empty document stays pending", async () => {
		const url = uniqueUrl();
		refusing(url);
		const other = uniqueUrl();
		new Room(`${other}/room`);
		const document = createDocument();
		document.attachSync(websocketSync(url), { value: draft });
		await until(() => document.syncRefusal !== undefined);
		document.attachSync(websocketSync(other), { value: draft });
		await wait(1500);
		expect(document.syncPending).toBe(false);
		expect(document.readiness).toBe('pending');
		expect(document.syncRefusal?.code).toBe(4403);
		document.destroy();
	});
});

describe('expired credentials (4401) on a first visit', () => {
	it('4401 for 3 s leaves the document pending; an accepted dial then hydrates with only the room', async () => {
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, {
			value: roomValue,
			refuse: { code: 4401, reason: 'expired' }
		});
		const document = open(url);
		const heard = [];
		document.onSyncRefused((refusal) => heard.push(refusal));
		await wait(3000);
		expect(room.dials).toBeGreaterThan(1);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(document.syncRefusal).toBeUndefined();
		room.refuse = undefined;
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		await wait(50);
		expect(texts(document)).toEqual(['room']);
		expect(heard).toEqual([]);
		document.destroy();
	});

	it('without the local store too (persist: false)', async () => {
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, {
			value: roomValue,
			refuse: { code: 4401, reason: 'expired' }
		});
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: url,
				room: 'room',
				WebSocketPolyfill: Socket,
				persist: false
			}),
			{ value: draft }
		);
		await wait(3000);
		expect(document.readiness).toBe('pending');
		room.refuse = undefined;
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		expect(texts(document)).toEqual(['room']);
		document.destroy();
	});

	it('onExpired reports each 4401 close with the redial delay', async () => {
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, {
			value: roomValue,
			refuse: { code: 4401, reason: 'expired' }
		});
		const expired = [];
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: url,
				room: 'room',
				WebSocketPolyfill: Socket,
				persist: false,
				onExpired: (state) => {
					expired.push(state);
					room.refuse = undefined;
				}
			}),
			{ value: draft }
		);
		await until(() => document.ready);
		expect(expired).toEqual([{ reason: 'expired', attempts: 1, nextRetryMs: 200 }]);
		expect(document.readiness).toBe('hydrated');
		document.destroy();
	});

	it('an onExpired that throws is reported, and the provider still redials and holds (FW-08)', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, {
			value: roomValue,
			refuse: { code: 4401, reason: 'expired' }
		});
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: url,
				room: 'room',
				WebSocketPolyfill: Socket,
				persist: false,
				onExpired: () => {
					throw new Error('token refresh failed');
				}
			}),
			{ value: draft }
		);
		await wait(3000);
		expect(room.dials).toBeGreaterThan(1);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(logged.mock.calls.some((call) => String(call[1]).includes('token refresh failed'))).toBe(
			true
		);
		room.refuse = undefined;
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		expect(texts(document)).toEqual(['room']);
		document.destroy();
		logged.mockRestore();
	});
});

describe('a dial that neither opens nor fails', () => {
	/** A socket the network silently drops: it never opens, errors or closes on its own. */
	class Hanging {
		static OPEN = 1;
		static dials = 0;
		OPEN = 1;
		binaryType = '';
		readyState = 0;
		onopen = null;
		onclose = null;
		onerror = null;
		onmessage = null;
		constructor() {
			Hanging.dials++;
		}
		send() {}
		close(code = 1005, reason = '') {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.onclose?.({ code, reason });
		}
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('times out after 10 s: the bound arms and the empty document seeds a bound later', async () => {
		vi.useFakeTimers();
		Hanging.dials = 0;
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: uniqueUrl(),
				room: 'room',
				WebSocketPolyfill: Hanging,
				persist: false,
				disableBc: true
			}),
			{ value: draft }
		);
		await vi.advanceTimersByTimeAsync(10_000 + 999);
		expect(document.readiness).toBe('pending');
		expect(Hanging.dials).toBe(2); // the timed-out dial, then the redial 200 ms later
		await vi.advanceTimersByTimeAsync(1);
		expect(document.readiness).toBe('local');
		expect(texts(document)).toEqual(['draft']);
		document.destroy();
	});

	it('connectTimeout: 30 s waits for a room that opens after 15 s: hydrated, nothing seeded', async () => {
		vi.useFakeTimers();
		const url = uniqueUrl();
		const room = new Room(`${url}/room`, { value: roomValue, openAfter: 15_000 });
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: url,
				room: 'room',
				WebSocketPolyfill: Socket,
				persist: false,
				disableBc: true,
				connectTimeout: 30_000
			}),
			{ value: draft }
		);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(document.readiness).toBe('pending');
		await vi.advanceTimersByTimeAsync(100);
		expect(document.readiness).toBe('hydrated');
		expect(texts(document)).toEqual(['room']);
		expect(room.dials).toBe(1);
		document.destroy();
	});

	it('connectTimeout: Infinity never gives up on the dial', async () => {
		vi.useFakeTimers();
		Hanging.dials = 0;
		const document = createDocument();
		document.attachSync(
			providers.createWebsocketSync({
				server: uniqueUrl(),
				room: 'room',
				WebSocketPolyfill: Hanging,
				persist: false,
				disableBc: true,
				connectTimeout: Infinity
			}),
			{ value: draft }
		);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(Hanging.dials).toBe(1);
		expect(document.readiness).toBe('pending');
		document.destroy();
	});
});
