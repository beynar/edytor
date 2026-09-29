/**
 * A lost socket drops remote presences for its own tab only (UW-19).
 *
 * Tabs A and B of one room share the default local store and its channel
 * (`createWebsocketSync`, persistence on); C is another machine (socket
 * only). When A's socket closes — dropped by the network, or A leaves and
 * its provider is destroyed — A forgets the presences it heard there, but
 * B, whose socket is still open, keeps C. A that left is gone for B.
 * Closing A's tab runs its page-leave hooks in registration order: the
 * socket's provider is destroyed while the store is still live.
 *
 * The server is an opaque relay: every frame reaches every other socket
 * of the room.
 *
 * A reconnect shows the room's present peers at once: the presences dropped
 * with the socket are forgotten, clock included, so the snapshot a room
 * sends on join (entries at the clocks it last heard) is applied, not
 * ignored until each peer renews.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import * as encoding from 'lib0-v14/encoding';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { frame } from '../../../lib/crdt/protocols/envelope.js';
import { writeAwarenessEntries } from '../../../lib/crdt/protocols/awareness.js';

const providers = bindProviders(Y);

class Relay {
	static OPEN = 1;
	static rooms = new Map();
	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(url) {
		this.url = url;
		this.room = url.split('?')[0];
		setTimeout(() => {
			if (this.readyState !== 0) return;
			if (!Relay.rooms.has(this.room)) Relay.rooms.set(this.room, new Set());
			Relay.rooms.get(this.room).add(this);
			this.readyState = 1;
			this.onopen?.({});
		});
	}

	send(data) {
		const bytes = new Uint8Array(data).slice();
		setTimeout(() => {
			for (const peer of Relay.rooms.get(this.room) ?? []) {
				if (peer !== this && peer.readyState === 1)
					peer.onmessage?.({ data: bytes.slice().buffer });
			}
		});
	}

	close(code = 1006) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		Relay.rooms.get(this.room)?.delete(this);
		this.onclose?.({ code, reason: '' });
	}
}

let counter = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 3000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const sees = (document, other) => document.awareness.getStates().has(other.clientID);

/**
 * The page-leave hooks (`beforeunload`) each document's providers register,
 * in order — installed on `globalThis` while `room()` builds the documents.
 */
const leaves = new Map();

/** Two tabs of one browser (A, B) and another machine (C), all present to each other. */
const room = async () => {
	const url = `ws://presence-loss/${counter++}`;
	const value = { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'x' }] }] };
	const attach = (options = {}) => {
		const document = createDocument({ value });
		const sync = providers.createWebsocketSync({
			serverUrl: url,
			roomName: 'room',
			WebSocketPolyfill: Relay,
			...options
		});
		const hooks = [];
		globalThis.addEventListener = (type, hook) => type === 'beforeunload' && hooks.push(hook);
		globalThis.removeEventListener = () => {};
		try {
			document.attachSync(sync);
		} finally {
			delete globalThis.addEventListener;
			delete globalThis.removeEventListener;
		}
		leaves.set(document, hooks);
		return document;
	};
	const a = attach();
	const b = attach();
	const c = attach({ persist: false, disableBc: true });
	await until(() => sees(a, c) && sees(b, c) && sees(c, a) && sees(c, b) && sees(b, a));
	const socketOf = (document) =>
		[...Relay.rooms.get(`${url}/room`)].find((s) => s.url.includes(`replica=${document.clientID}`));
	return { a, b, c, socketOf };
};

describe('a lost socket drops remote presences for its own tab only', () => {
	it("A's socket drops: B still sees C", async () => {
		const { a, b, c, socketOf } = await room();
		socketOf(a).close(1006);
		await wait(50);
		expect(sees(b, c)).toBe(true);
		for (const document of [a, b, c]) document.destroy();
	});

	it("A's tab closes: B still sees C, and A is gone", async () => {
		const { a, b, c } = await room();
		expect(leaves.get(a)).toHaveLength(2); // the socket's provider, then the store
		for (const leave of leaves.get(a)) leave();
		await until(() => !sees(b, a));
		await wait(50);
		expect(sees(b, c)).toBe(true);
		for (const document of [a, b, c]) document.destroy();
	});

	it('A is destroyed (a view unmounts): B still sees C, and A is gone', async () => {
		const { a, b, c } = await room();
		a.destroy();
		await until(() => !sees(b, a));
		await wait(50);
		expect(sees(b, c)).toBe(true);
		for (const document of [b, c]) document.destroy();
	});
});

describe('a reconnect shows the present peers at once', () => {
	it("the room's join snapshot restores a peer dropped with the socket", async () => {
		const peer = { clientID: 4242, clock: 3, state: { user: { name: 'Peer' } } };
		const snapshot = frame(1, (e) => encoding.writeVarUint8Array(e, writeAwarenessEntries([peer])));
		const sockets = [];
		/** A room that sends its present peers to each socket that joins. */
		class Joining {
			static OPEN = 1;
			OPEN = 1;
			binaryType = '';
			readyState = 0;
			constructor() {
				sockets.push(this);
				setTimeout(() => {
					this.readyState = 1;
					this.onopen?.({});
					this.onmessage?.({ data: snapshot.slice().buffer });
				});
			}
			send() {}
			close(code = 1006) {
				if (this.readyState === 3) return;
				this.readyState = 3;
				this.onclose?.({ code, reason: '' });
			}
		}
		const document = createDocument();
		const provider = new providers.WebsocketProvider('ws://rejoin', 'room', document.doc, {
			awareness: document.awareness,
			WebSocketPolyfill: Joining,
			disableBc: true
		});
		await until(() => document.awareness.getStates().has(peer.clientID));
		sockets[0].close(1006);
		expect(document.awareness.getStates().has(peer.clientID)).toBe(false);
		await until(() => sockets.length === 2 && sockets[1].readyState === 1);
		expect(document.awareness.getStates().get(peer.clientID)).toEqual(peer.state);
		provider.destroy();
		document.destroy();
	});
});
