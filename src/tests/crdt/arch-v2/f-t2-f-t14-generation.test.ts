/**
 * arch-v2 §8.6 F-T2 and F-T14 — channels prove their generation (R13, D-2).
 *
 * F-T2 (a) a peer of another schema generation writes: its frames are
 *   dropped at the envelope, observably, and zero of its bytes integrate —
 *   including the ordinary edits that follow its stamp (probe P2: the
 *   reference gate protected the stamp, not the content). A container
 *   stamped by another schema generation never hydrates.
 * F-T2 (b) a same-generation document ends up with a foreign stamp, then the
 *   user types: the document turns read-only once, visibly; the edit is
 *   refused, never accepted and then silently dropped by the transport
 *   (probe P7).
 * F-T14 a same-generation writer produces a foreign stamp: receivers refuse
 *   and report the update, the stamp never reaches their containers, and the
 *   read-only writer neither persists nor broadcasts (F8).
 *
 * Expectations come from the plan rows and R13, never from engine output.
 * "A peer of schema generation N" writes frames the way a build of that
 * generation does: `generationWord(N)` when the envelope carries the schema,
 * else (reference) the bare protocol word, since a reference build of any
 * schema speaks the same word.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as bc from 'lib0-v14/broadcastchannel';
import * as idb from 'lib0-v14/indexeddb';
import { Y } from '../../../lib/crdt/engine.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import * as envelope from '../../../lib/crdt/protocols/envelope.js';
import {
	createDocument,
	schemaVersion,
	SchemaMismatchError,
	SCHEMA_VERSION
} from '../../../lib/crdt/index.js';

const idbProviders = bindIndexeddbProvider(Y);
const wsProviders = bindWebsocketProvider(Y);
const sync = bindSync(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;
const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 4000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

/** The frame word a build of application schema `schema` writes. */
const wordOf = (schema) => envelope.generationWord?.(schema) ?? envelope.PROTOCOL_VERSION;

/** A sync `Update` frame as a build of `schema` sends it. */
const updateFrame = (update, schema = SCHEMA_VERSION) => {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, wordOf(schema));
	encoding.writeVarUint(e, 0); // messageSync
	sync.writeUpdate(e, update);
	return encoding.toUint8Array(e);
};

const block = (id) => {
	const n = new Y.Node('block');
	n.setAttr('id', id);
	n.setAttr('type', 'paragraph');
	return n;
};

const value = { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] }] };

const openDb = (name) =>
	idb.openDB(envelope.generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const readRows = async (name) => {
	const db = await openDb(name);
	try {
		const [updates] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updates)).map((r) => new Uint8Array(r));
	} finally {
		db.close();
	}
};

/** The state the container's rows reconstruct. */
const containerDoc = async (name) => {
	const doc = new Y.Doc();
	for (const row of await readRows(name)) Y.applyUpdate(doc, row);
	return doc;
};

const seedContainer = async (name, record, rows) => {
	const db = await openDb(name);
	try {
		const [updates, custom] = idb.transact(db, ['updates', 'custom']);
		for (const row of rows) await idb.addAutoKey(updates, row.slice().buffer);
		await idb.rtop(custom.put(record, envelope.GENERATION_KEY));
	} finally {
		db.close();
	}
};

/**
 * A peer that shares `from`'s state, then runs `write` on its own doc and
 * returns every update it produced, in order.
 */
const peerUpdates = (from, write, clientID = Number.MAX_SAFE_INTEGER) => {
	const peer = new Y.Doc();
	peer.clientID = clientID;
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(from));
	const out = [];
	peer.on('update', (u) => out.push(u));
	write(peer);
	return out;
};

/** Minimal opaque relay (same shape as the provider suites). */
class FakeWebSocket {
	static rooms = new Map();
	static sent = [];
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
		FakeWebSocket.sent.push(new Uint8Array(data));
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		FakeWebSocket.rooms.get(this.url)?.delete(this);
		this.onclose?.({});
	}
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;

const contains = (haystack, needle) => {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
};

/** The v99 peer's session: it stamps its schema, then edits normally. */
const v99Session = (from) =>
	peerUpdates(from, (peer) => {
		peer.transact(() => peer.get('meta').setAttr('v', 99));
		peer.get('blocks').setAttr('from-v99-peer', block('from-v99-peer'));
	});

describe('F-T2 (a) — a peer of another schema generation integrates zero bytes', () => {
	it('BroadcastChannel: every frame dropped at the envelope, observably', async () => {
		const name = uniqueName('ft2a-bc');
		const a = createDocument({ value });
		const p = new idbProviders.IndexeddbPersistence(name, a.doc);
		await p.whenSynced;
		const before = Y.encodeStateVector(a.doc);
		const mismatches = [];
		p.on('protocol-mismatch', (m) => mismatches.push(m));

		const frames = v99Session(a.doc).map((u) => updateFrame(u, 99));
		for (const frame of frames) {
			bc.publish(envelope.generationDbName(name), frame.slice().buffer, 'v99-build');
		}
		await nextTick(60);

		expect(Y.encodeStateVector(a.doc)).toEqual(before);
		expect(a.doc.get('blocks').getAttr('from-v99-peer')).toBeUndefined();
		expect(schemaVersion(a.doc)).toBe(SCHEMA_VERSION);
		expect(mismatches.length).toBe(frames.length);
		await p.destroy();
		a.destroy();
	});

	it('websocket: every frame dropped at the envelope, observably', async () => {
		const a = createDocument({ value });
		const p = new wsProviders.WebsocketProvider('ws://ft2a', uniqueName('room'), a.doc, {
			WebSocketPolyfill: FakeWebSocket
		});
		await until(() => p.wsconnected);
		const before = Y.encodeStateVector(a.doc);
		const mismatches = [];
		p.on('protocol-mismatch', (m) => mismatches.push(m));

		const frames = v99Session(a.doc).map((u) => updateFrame(u, 99));
		for (const frame of frames) p.ws.onmessage({ data: frame.slice().buffer });
		await nextTick();

		expect(Y.encodeStateVector(a.doc)).toEqual(before);
		expect(a.doc.get('blocks').getAttr('from-v99-peer')).toBeUndefined();
		expect(mismatches.length).toBe(frames.length);
		p.destroy();
		a.destroy();
	});

	it('a container stamped by another schema generation never hydrates; bytes intact', async () => {
		const name = uniqueName('ft2a-container');
		const source = createDocument({ value });
		const row = source.encode();
		await seedContainer(name, { ...envelope.GENERATION_RECORD, schema: 99 }, [row]);

		const doc = new Y.Doc();
		const p = new idbProviders.IndexeddbPersistence(name, doc);
		const loadErrors = [];
		p.on('load-error', (e) => loadErrors.push(e));
		await expect(p.whenSynced).rejects.toThrow();
		expect(loadErrors.length).toBe(1);
		expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(new Y.Doc()));
		const rows = await readRows(name);
		expect(rows.length).toBe(1);
		expect(rows[0]).toEqual(row);
		await p.destroy();
		source.destroy();
	});
});

describe('F-T2 (b) — a foreign stamp turns the document read-only once, visibly', () => {
	it('the edit after the stamp is refused, never accepted then dropped', async () => {
		const name = uniqueName('ft2b');
		const a = createDocument({ value });
		const p = new idbProviders.IndexeddbPersistence(name, a.doc);
		await p.whenSynced;
		const signals = [];
		a.onWritableChange((writable) => signals.push(writable));

		a.transact(() => a.facade.insertText('p', 0, 'kept '));
		expect(a.writable).toBe(true);

		// A same-generation raw write lands a foreign stamp.
		a.doc.transact(() => a.doc.get('meta').setAttr('v', 99));
		expect(a.writable).toBe(false);
		expect(signals).toEqual([false]);

		// The user types: refused (thrown), nothing lands in the model.
		expect(() => a.transact(() => a.facade.insertText('p', 0, 'lost '))).toThrow();
		expect(() => a.transact(() => a.facade.insertText('p', 0, 'lost '))).toThrow();
		expect(a.facade.blockText('p')).toBe('kept hello');
		expect(signals).toEqual([false]);

		// Nothing after the stamp reached the container: it still holds the
		// accepted edit and this build's stamp.
		await nextTick();
		const stored = await containerDoc(name);
		expect(schemaVersion(stored)).toBe(SCHEMA_VERSION);
		expect(stored.get('blocks').getAttr('p')).toBeDefined();
		await p.destroy();
		a.destroy();
	});
});

describe('F-T14 — a same-generation forged stamp is refused, reported, and never spreads', () => {
	const forgeries = {
		'meta.v overwrite': (peer) => peer.transact(() => peer.get('meta').setAttr('v', 99)),
		'foreign meta.schema': (peer) =>
			peer.transact(() => peer.get('meta').setAttr('schema', 'not-edytor')),
		'stamp deleted': (peer) => peer.transact(() => peer.get('meta').deleteAttr('v'))
	};

	for (const [label, forge] of Object.entries(forgeries)) {
		it(`receiver refuses and reports: ${label}`, async () => {
			const name = uniqueName('ft14-rx');
			const r = createDocument({ value });
			const p = new idbProviders.IndexeddbPersistence(name, r.doc);
			await p.whenSynced;
			const before = Y.encodeStateVector(r.doc);
			const reports = [];
			const errors = [];
			p.on('schema-mismatch', (d) => reports.push(d));
			p.on('message-error', (e) => errors.push(e));

			const [forged] = peerUpdates(r.doc, forge);
			bc.publish(envelope.generationDbName(name), updateFrame(forged).slice().buffer, 'forger');
			await nextTick();

			expect(Y.encodeStateVector(r.doc)).toEqual(before);
			expect(r.writable ?? true).toBe(true);
			expect(reports.length).toBe(1);
			expect(errors.filter((e) => e instanceof SchemaMismatchError).length).toBe(1);

			// The receiver keeps accepting valid same-generation updates.
			const [valid] = peerUpdates(
				r.doc,
				(peer) => peer.get('blocks').setAttr('valid', block('valid')),
				7
			);
			bc.publish(envelope.generationDbName(name), updateFrame(valid).slice().buffer, 'peer');
			await until(() => r.doc.get('blocks').getAttr('valid') !== undefined);

			// The stamp never reached the receiver's container.
			await idbProviders.storeState(p);
			const stored = await containerDoc(name);
			expect(schemaVersion(stored)).toBe(SCHEMA_VERSION);
			expect(stored.get('meta').getAttr('schema')).toBe('edytor-doc');
			await p.destroy();
			r.destroy();
		});
	}

	it('a full-state SyncStep2 carrying a forged stamp is refused over the websocket', async () => {
		const r = createDocument({ value });
		const p = new wsProviders.WebsocketProvider('ws://ft14', uniqueName('room'), r.doc, {
			WebSocketPolyfill: FakeWebSocket
		});
		await until(() => p.wsconnected);
		const reports = [];
		p.on('schema-mismatch', (d) => reports.push(d));
		const forger = new Y.Doc();
		forger.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(forger, Y.encodeStateAsUpdate(r.doc));
		forger.transact(() => forger.get('meta').setAttr('v', 99));
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, wordOf(SCHEMA_VERSION));
		encoding.writeVarUint(e, 0);
		sync.writeSyncStep2(e, forger);
		const before = Y.encodeStateVector(r.doc);
		p.ws.onmessage({ data: encoding.toUint8Array(e).slice().buffer });
		await nextTick();
		expect(Y.encodeStateVector(r.doc)).toEqual(before);
		expect(reports.map((d) => d.problem?.version)).toEqual([99]);
		expect(p.synced).toBe(false);
		p.destroy();
		r.destroy();
	});

	it('a read-only writer neither persists nor broadcasts', async () => {
		const name = uniqueName('ft14-tx');
		const w = createDocument({ value });
		const idbP = new idbProviders.IndexeddbPersistence(name, w.doc);
		await idbP.whenSynced;
		FakeWebSocket.sent = [];
		const wsP = new wsProviders.WebsocketProvider('ws://ft14-tx', uniqueName('room'), w.doc, {
			WebSocketPolyfill: FakeWebSocket
		});
		await until(() => wsP.wsconnected);
		const bcSeen = [];
		const onBc = (data) => bcSeen.push(new Uint8Array(data));
		bc.subscribe(envelope.generationDbName(name), onBc);

		let stampUpdate = null;
		w.doc.once('update', (u) => (stampUpdate = u));
		w.doc.transact(() => w.doc.get('meta').setAttr('v', 99));
		await nextTick();

		expect(stampUpdate).not.toBeNull();
		for (const sent of FakeWebSocket.sent) expect(contains(sent, stampUpdate)).toBe(false);
		for (const seen of bcSeen) expect(contains(seen, stampUpdate)).toBe(false);
		// A joining peer's state request gets no state back.
		const step1 = encoding.createEncoder();
		encoding.writeVarUint(step1, wordOf(SCHEMA_VERSION));
		encoding.writeVarUint(step1, 0);
		sync.writeSyncStep1(step1, new Y.Doc());
		const reply = idbP.readMessage(encoding.toUint8Array(step1), false);
		expect(encoding.length(reply)).toBeLessThanOrEqual(2 + 1);
		await idbProviders.storeState(idbP).catch(() => {});
		expect(schemaVersion(await containerDoc(name))).toBe(SCHEMA_VERSION);

		bc.unsubscribe(envelope.generationDbName(name), onBc);
		wsP.destroy();
		await idbP.destroy();
		w.destroy();
	});
});
