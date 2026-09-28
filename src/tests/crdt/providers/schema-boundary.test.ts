/**
 * Schema boundary for the v14 provider stack — rewritten at arch-v2 T1
 * against compatibility by generation (R13, D-2).
 *
 * The pinned intent of each case survives; the mechanism under test is the
 * one D-2 adopts instead of per-update staging:
 *
 * - GENERATION MISMATCH. Frames carry the generation word (engine + wire +
 *   schema) and containers the generation record. A frame or container of
 *   another schema generation is refused before a single byte is decoded:
 *   the live doc is untouched, the refusal is observable
 *   ('protocol-mismatch' / 'load-error' + 'failed'), stored bytes stay
 *   intact.
 * - SAME-GENERATION FORGED STAMP. A writer that speaks this generation but
 *   writes a foreign `meta` stamp (v99, a foreign manifest name, a deleted
 *   stamp) is refused inbound and reported ('schema-mismatch' +
 *   'message-error'); the provider stays usable for valid updates, and the
 *   stamp never reaches the receiver's container or the room. A document
 *   that nonetheless carries a foreign stamp (a raw local write, a forged
 *   row already in a same-generation container) is read-only: it neither
 *   persists, compacts, nor broadcasts, and document admission refuses it.
 * - UNVERSIONED CONTENT (registry writes with no stamp at all) is not a
 *   stamp write: it integrates, and the doc is read-only and quarantined
 *   until a versioned state makes it admissible again.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { checkSchema } from '../../../lib/crdt/admission.js';
import { attachDocument, SCHEMA_VERSION } from '../../../lib/crdt/index.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as bc from 'lib0-v14/broadcastchannel';
import * as idb from 'lib0-v14/indexeddb';
import * as envelope from '../../../lib/crdt/protocols/envelope.js';
import {
	writeProtocolVersion,
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
const wsProviders = bindWebsocketProvider(Y);
const sync = bindSync(Y);
const E = bindEdytorDoc(Y);

const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;

/** The frame word a build of application schema `schema` writes. */
const wordOf = (schema) => envelope.generationWord?.(schema) ?? envelope.PROTOCOL_VERSION;

/** A frame as a build of application schema `schema` writes it. */
const encodeFor = (schema, type, payloadWriter) => {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, wordOf(schema));
	encoding.writeVarUint(e, type);
	payloadWriter?.(e);
	return encoding.toUint8Array(e);
};

const encodeV14 = (type, payloadWriter) => {
	const e = encoding.createEncoder();
	writeProtocolVersion(e);
	encoding.writeVarUint(e, type);
	payloadWriter?.(e);
	return encoding.toUint8Array(e);
};

/**
 * A doc claiming an unsupported application-schema version: init'd under
 * the real schema path (so the layout is legitimate) then bumped to v99
 * with a marker block — exactly what a future-schema peer would replicate.
 */
const makeV99Update = () => {
	const remote = new Y.Doc();
	// Yjs map-attr conflicts resolve by clientID (higher wins) — pin the
	// remote clientID to the max so its meta.v=99 write deterministically
	// wins the merge against any live doc's own meta.v stamp.
	remote.clientID = Number.MAX_SAFE_INTEGER;
	const er = E.create(remote);
	er.init();
	remote.transact(() => remote.get('meta').setAttr('v', 99));
	remote.get('blocks').setAttr(
		'evil-v99',
		(() => {
			const n = new Y.Node('block');
			n.setAttr('id', 'evil-v99');
			n.setAttr('type', 'paragraph');
			return n;
		})()
	);
	return Y.encodeStateAsUpdate(remote);
};

/**
 * A rogue doc carrying registry content but NO meta.v (unversioned).
 */
const makeUnversionedUpdate = (key = 'rogue') => {
	const rogue = new Y.Doc();
	rogue.get('blocks').setAttr(
		key,
		(() => {
			const n = new Y.Node('block');
			n.setAttr('id', key);
			n.setAttr('type', 'paragraph');
			return n;
		})()
	);
	return Y.encodeStateAsUpdate(rogue);
};

/**
 * A valid INCREMENTAL update carrying no schema write: a same-schema peer
 * seeded with `doc`'s state performs an ordinary content edit — the update
 * emitted contains only the edit (no meta.v), like any mid-session peer.
 */
const makeIncrementalUpdate = (doc, marker = 'inc-valid') => {
	const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	let captured = null;
	peer.on('update', (u) => (captured = u));
	peer.get('blocks').setAttr(
		marker,
		(() => {
			const n = new Y.Node('block');
			n.setAttr('id', marker);
			n.setAttr('type', 'paragraph');
			return n;
		})()
	);
	return captured;
};

/** Byte-subsequence search — used to prove a refused payload was never re-sent. */
const containsSubseq = (haystack, needle) => {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
};

const openDb = (name) =>
	idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

/** Write rows directly into a v14-generation DB (store + record). */
const seedGenerationDb = async (name, rows, record = GENERATION_RECORD) => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore, custom] = idb.transact(db, ['updates', 'custom']);
		for (const row of rows) {
			const copy = new Uint8Array(row.byteLength);
			copy.set(row);
			await idb.addAutoKey(updatesStore, copy.buffer);
		}
		await idb.rtop(custom.put({ ...record }, GENERATION_KEY));
	} finally {
		db.close();
	}
};

const sameBytes = (a, b) =>
	new Uint8Array(a).byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

const readRows = async (name) => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return await idb.getAll(updatesStore);
	} finally {
		db.close();
	}
};

/** Minimal opaque-relay fake server — same shape as websocket.test.ts. */
class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map();
	static sentLog = [];

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
			let room = FakeWebSocket.rooms.get(url.split('?')[0]);
			if (!room) FakeWebSocket.rooms.set(url.split('?')[0], (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		FakeWebSocket.sentLog.push(data.slice ? data.slice() : data);
		const room = FakeWebSocket.rooms.get(this.url.split('?')[0]);
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
		FakeWebSocket.rooms.get(this.url.split('?')[0])?.delete(this);
		this.onclose?.({});
	}
}
describe('generation mismatch — refused at the envelope and the container record', () => {
	test('a frame of another schema generation on BC: dropped before decode, observable', async () => {
		const name = uniqueName('gen-bc');
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const before = Y.encodeStateVector(docA);
		const mismatches = [];
		const mismatchSchema = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		pA.on('schema-mismatch', (d) => mismatchSchema.push(d));

		bc.publish(
			generationDbName(name),
			encodeFor(99, 0, (e) => sync.writeUpdate(e, makeV99Update())).slice().buffer,
			'v99-build'
		);
		await nextTick();

		expect(Y.encodeStateVector(docA)).toEqual(before);
		expect(mismatches).toEqual([{ expected: wordOf(SCHEMA_VERSION), found: wordOf(99) }]);
		// Nothing was decoded, so nothing was judged as schema content.
		expect(mismatchSchema.length).toBe(0);

		// This generation's frames keep flowing.
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, makeIncrementalUpdate(docA, 'after-gen'))).slice()
				.buffer,
			'own-generation-peer'
		);
		await until(() => docA.get('blocks').getAttr('after-gen') !== undefined, 3000);
		await pA.destroy();
	});

	test('a SyncStep2 of another schema generation over ws: dropped, no synced', async () => {
		const url = `ws://fake-wu3/${counter++}`;
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new wsProviders.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket
		});
		const mismatches = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		await until(() => pA.wsconnected, 4000);
		const before = Y.encodeStateVector(docA);
		const remote = new Y.Doc();
		Y.applyUpdate(remote, makeV99Update());
		pA.ws.onmessage({
			data: encodeFor(99, 0, (e) => sync.writeSyncStep2(e, remote)).slice().buffer
		});
		await nextTick();
		expect(Y.encodeStateVector(docA)).toEqual(before);
		expect(mismatches.map((m) => m.found)).toEqual([wordOf(99)]);
		expect(pA.synced).toBe(false);
		pA.destroy();
	});

	test('a container of another schema generation never hydrates; bytes intact; failed once', async () => {
		const name = uniqueName('gen-idb');
		const good = new Y.Doc();
		E.create(good).init();
		const row = Y.encodeStateAsUpdate(good);
		await seedGenerationDb(name, [row], { ...GENERATION_RECORD, schema: 99 });

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		const failed = [];
		pB.on('failed', (e) => failed.push(e));
		await expect(pB.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(pB.synced).toBe(false);
		expect(failed.length).toBe(1);
		expect(E.schemaVersion(docB)).toBeUndefined();
		const rows = await readRows(name);
		expect(rows.length).toBe(1);
		expect(sameBytes(rows[0], row)).toBe(true);
		await pB.destroy();
	});

	// Re-pinned at the D1 schema bump (generation 2): a record written before
	// the `schema` field existed was written by a schema-1 build, and schema 1
	// stored deletion as a single `del` flag. Since D1's per-writer
	// `del.<writer>` marks, reading such a container would resurface its
	// deleted blocks — so it is another generation and is refused like one.
	test('a container record written before the schema field is refused as another generation (D1 bump)', async () => {
		const name = uniqueName('gen-legacy-record');
		const good = new Y.Doc();
		E.create(good).init();
		const row = Y.encodeStateAsUpdate(good);
		await seedGenerationDb(name, [row], {
			engine: GENERATION_RECORD.engine,
			protocol: GENERATION_RECORD.protocol
		});
		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		const failed = [];
		pB.on('failed', (e) => failed.push(e));
		await expect(pB.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(pB.synced).toBe(false);
		expect(failed.length).toBe(1);
		expect(E.schemaVersion(docB)).toBeUndefined();
		const rows = await readRows(name);
		expect(rows.length).toBe(1);
		expect(sameBytes(rows[0], row)).toBe(true);
		await pB.destroy();
	});
});

describe('same-generation forged stamp — BroadcastChannel (IndexeddbPersistence)', () => {
	test('v99 stamp: refused, signaled, live doc untouched, recoverable, never persisted', async () => {
		const name = uniqueName('wu3-bc-v99');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const before = Y.encodeStateVector(docA);

		const mismatches = [];
		const msgErrors = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		pA.on('message-error', (e) => msgErrors.push(e));

		const v99Update = makeV99Update();
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, v99Update)).slice().buffer,
			'v99-peer'
		);
		await nextTick();

		// The update was refused BEFORE mutating the live doc.
		expect(E.schemaVersion(docA)).toBe(SCHEMA_VERSION);
		expect(docA.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(Y.encodeStateVector(docA)).toEqual(before);

		// Structured refusal signal.
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		expect(msgErrors.length).toBeGreaterThan(0);

		// Recoverability: a subsequent VALID incremental update still applies.
		const inc = makeIncrementalUpdate(docA, 'inc-after-v99');
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, inc)).slice().buffer,
			'own-generation-peer'
		);
		await until(() => docA.get('blocks').getAttr('inc-after-v99') !== undefined, 3000);
		expect(E.schemaVersion(docA)).toBe(SCHEMA_VERSION);

		// Not persisted: compact the store and decode every row.
		await providers.storeState(pA);
		const rows = await readRows(name);
		for (const row of rows) {
			const probe = new Y.Doc();
			Y.applyUpdate(probe, new Uint8Array(row));
			expect(E.schemaVersion(probe)).not.toBe(99);
		}
		await pA.destroy();
	});

	test('a foreign meta.schema is refused (gate-F1 F5)', async () => {
		const name = uniqueName('wu3-bc-foreign');
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const before = Y.encodeStateVector(docA);

		const mismatches = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));

		const foreign = new Y.Doc();
		foreign.clientID = Number.MAX_SAFE_INTEGER - 1;
		Y.applyUpdate(foreign, Y.encodeStateAsUpdate(docA));
		foreign.get('meta').setAttr('schema', 'not-edytor');
		foreign.get('blocks').setAttr(
			'evil-foreign',
			(() => {
				const n = new Y.Node('block');
				n.setAttr('id', 'evil-foreign');
				n.setAttr('type', 'paragraph');
				return n;
			})()
		);
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, Y.encodeStateAsUpdate(foreign))).slice().buffer,
			'foreign-peer'
		);
		await nextTick();

		expect(E.schemaVersion(docA)).toBe(SCHEMA_VERSION);
		expect(docA.get('meta').getAttr('schema')).toBe('edytor-doc');
		expect(docA.get('blocks').getAttr('evil-foreign')).toBeUndefined();
		expect(Y.encodeStateVector(docA)).toEqual(before);
		expect(mismatches.some((m) => m.problem?.kind === 'foreign')).toBe(true);
		await pA.destroy();
	});

	test('incremental update without a schema write applies (no regression)', async () => {
		const name = uniqueName('wu3-bc-inc');
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;

		const mismatches = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, makeIncrementalUpdate(docA))).slice().buffer,
			'own-generation-peer'
		);
		await until(() => docA.get('blocks').getAttr('inc-valid') !== undefined, 3000);
		expect(mismatches.length).toBe(0);
		await pA.destroy();
	});

	test('a read-only (v99-stamped) doc does not ship its state (SyncStep2 publish + Step1 reply)', async () => {
		const name = uniqueName('wu3-bc-ship');
		const docA = new Y.Doc();
		E.create(docA).init();
		docA.transact(() => docA.get('meta').setAttr('v', 99));

		const seen = [];
		const seenFn = (data) => seen.push(new Uint8Array(data));
		bc.subscribe(generationDbName(name), seenFn);

		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced.catch(() => {});
		await nextTick();

		// SyncStep1 (a harmless state vector) goes out, a SyncStep2 state
		// publish never does.
		const word = encoding.createEncoder();
		encoding.writeVarUint(word, wordOf(SCHEMA_VERSION));
		const prefix = encoding.toUint8Array(word);
		const syncMsgs = seen.filter(
			(f) => prefix.every((b, i) => f[i] === b) && f[prefix.length] === 0
		);
		expect(syncMsgs.length).toBeGreaterThan(0);
		for (const frame of syncMsgs) {
			const dec = decoding.createDecoder(frame);
			decoding.readVarUint(dec); // generation word
			decoding.readVarUint(dec); // outer type (sync)
			expect(decoding.readVarUint(dec)).not.toBe(sync.messageYjsSyncStep2);
		}
		// A peer's state request gets no state back.
		const step1 = encodeV14(0, (e) => sync.writeSyncStep1(e, new Y.Doc()));
		expect(encoding.length(pA.readMessage(step1, false))).toBe(prefix.length + 1);
		bc.unsubscribe(generationDbName(name), seenFn);
		await pA.destroy();
	});
});

describe('same-generation forged stamp — websocket (opaque relay)', () => {
	test('v99 SyncStep2 over ws: refused, no false synced, recoverable', async () => {
		const url = `ws://fake-wu3/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new wsProviders.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket
		});
		const mismatches = [];
		const syncedEvents = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		pA.on('synced', (s) => syncedEvents.push(s));
		await until(() => pA.wsconnected, 4000);

		const v99Update = makeV99Update();
		const frame = encodeV14(0, (e) =>
			sync.writeSyncStep2(
				e,
				(() => {
					const remote = new Y.Doc();
					Y.applyUpdate(remote, v99Update);
					return remote;
				})()
			)
		);
		pA.ws.onmessage({ data: frame.slice().buffer });
		await nextTick();

		expect(E.schemaVersion(docA)).toBe(SCHEMA_VERSION);
		expect(docA.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		expect(pA.synced).toBe(false);
		expect(syncedEvents.filter(Boolean).length).toBe(0);

		const inc = makeIncrementalUpdate(docA, 'inc-ws');
		pA.ws.onmessage({
			data: encodeV14(0, (e) => sync.writeUpdate(e, inc)).slice().buffer
		});
		await nextTick();
		expect(docA.get('blocks').getAttr('inc-ws')).toBeDefined();

		for (const sent of FakeWebSocket.sentLog) {
			const u = sent instanceof Uint8Array ? sent : new Uint8Array(sent);
			expect(containsSubseq(u, v99Update)).toBe(false);
		}
		pA.destroy();
	});

	test('incremental update without schema write applies over ws', async () => {
		const url = `ws://fake-wu3/${counter++}`;
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new wsProviders.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket
		});
		await until(() => pA.wsconnected, 4000);
		pA.ws.onmessage({
			data: encodeV14(0, (e) => sync.writeUpdate(e, makeIncrementalUpdate(docA, 'inc-ws2'))).slice()
				.buffer
		});
		await nextTick();
		expect(docA.get('blocks').getAttr('inc-ws2')).toBeDefined();
		pA.destroy();
	});
});

describe('same-generation forged stamp — already in a same-generation container', () => {
	test('the container hydrates; the doc is read-only; nothing is compacted; admission refuses', async () => {
		const name = uniqueName('wu3-idb-v99');
		const v99Update = makeV99Update();
		await seedGenerationDb(name, [v99Update]);

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		expect(checkSchema(docB)).toMatchObject({ kind: 'unsupported', version: 99 });

		// Read-only: no compaction, the stored bytes survive byte-for-byte.
		await providers.storeState(pB);
		const rows = await readRows(name);
		expect(rows.some((r) => sameBytes(r, v99Update))).toBe(true);
		// The document layer refuses to adopt it.
		expect(() => attachDocument(docB)).toThrow(/unsupported schema version 99/);
		await pB.destroy();
	});

	test('mixed store: every row hydrates, the forged stamp wins → read-only, rows intact', async () => {
		const name = uniqueName('wu3-idb-mixed');
		const good1 = new Y.Doc();
		const eg1 = E.create(good1);
		eg1.init();
		eg1.insertBlock({ parent: null, index: 0 }, { id: 'good-a', type: 'paragraph' });
		const row1 = Y.encodeStateAsUpdate(good1);
		const row2 = makeV99Update();
		const good3 = new Y.Doc();
		const eg3 = E.create(good3);
		eg3.init();
		eg3.insertBlock({ parent: null, index: 0 }, { id: 'good-b', type: 'paragraph' });
		const row3 = Y.encodeStateAsUpdate(good3);
		await seedGenerationDb(name, [row1, row2, row3]);

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		expect(docB.get('blocks').getAttr('good-a')).toBeDefined();
		expect(docB.get('blocks').getAttr('good-b')).toBeDefined();
		// makeV99Update's writer holds the max client id: its stamp wins.
		expect(checkSchema(docB)).toMatchObject({ kind: 'unsupported', version: 99 });

		await providers.storeState(pB);
		const rows = await readRows(name);
		for (const row of [row1, row2, row3]) expect(rows.some((r) => sameBytes(r, row))).toBe(true);
		await pB.destroy();
	});
});

describe('unversioned content (no stamp at all) — D-2 / R13', () => {
	// The frame proves the generation; only foreign stamps are refused at
	// ingress. An unversioned doc is read-only and quarantined until a
	// versioned state makes it admissible again.
	test('an unversioned doc accepts schema-less writes but spreads nothing; a versioned state heals it', async () => {
		const name = uniqueName('wu3-bc-rogue');
		const docA = new Y.Doc();
		docA.get('blocks').setAttr(
			'rogue',
			(() => {
				const n = new Y.Node('block');
				n.setAttr('id', 'rogue');
				n.setAttr('type', 'paragraph');
				return n;
			})()
		);
		const mismatches = [];
		const pA = new providers.IndexeddbPersistence(name, docA);
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		await pA.whenSynced;
		expect(pA.bcconnected).toBe(true);
		expect(checkSchema(docA)?.kind).toBe('unversioned');

		// A schema-less write is not a stamp: it integrates, unreported.
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, makeUnversionedUpdate('rogue-peer'))).slice().buffer,
			'rogue-peer-2'
		);
		await nextTick();
		expect(docA.get('blocks').getAttr('rogue-peer')).toBeDefined();
		expect(mismatches.length).toBe(0);

		// Quarantined: a local write while unversioned is never persisted.
		docA.transact(() => docA.get('scratch').setAttr('before', 1));
		await providers.storeState(pA);
		const stored = () =>
			readRows(name).then((rows) => {
				const d = new Y.Doc();
				for (const r of rows) Y.applyUpdate(d, new Uint8Array(r));
				return d;
			});
		expect((await stored()).get('scratch').getAttr('before')).toBeUndefined();

		// A versioned state heals it: writable again, and it persists again.
		const good = new Y.Doc();
		E.create(good).init();
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, Y.encodeStateAsUpdate(good))).slice().buffer,
			'own-generation-peer'
		);
		await until(() => E.schemaVersion(docA) === SCHEMA_VERSION, 3000);
		expect(checkSchema(docA)).toBeNull();
		docA.transact(() => docA.get('scratch').setAttr('after', 1));
		await nextTick();
		expect((await stored()).get('scratch').getAttr('after')).toBe(1);
		await pA.destroy();
	});
});
