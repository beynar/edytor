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
 *
 * The room here holds a document and speaks the join rule; its open and
 * answer delays and its refusal are set per test. Expected states are
 * hand-authored from the room's content and the value each test passes.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
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
		providers.createWebsocketSync({ serverUrl: url, roomName: 'room', WebSocketPolyfill: Socket }),
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
