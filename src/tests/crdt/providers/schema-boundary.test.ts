/**
 * WU3 — application-schema boundary for the v14 provider stack.
 *
 * The transport envelope proves a peer speaks v14; it does NOT prove the
 * payload's application-schema version (`meta.v`). This suite pins the
 * boundary contract on every inbound path:
 *
 * - An update whose merge would move the live doc to an unsupported
 *   (`meta.v=99`) or unversioned schema is REFUSED — staged on a scratch
 *   doc, never integrated: the live doc is not mutated, the payload never
 *   enters accepted persistent state, and it is never rebroadcast.
 * - 'schema-mismatch' + 'message-error' fire per refusal; `synced` never
 *   fires falsely (a refused SyncStep2 handshake does not claim sync).
 * - The provider stays usable for subsequent VALID updates (recoverability
 *   — a refused update does not poison the connection).
 * - A valid incremental update that carries NO schema write still applies
 *   (same-schema peer mid-session — no regression).
 * - IndexedDB: a stored generation whose rows violate the schema boundary
 *   does not hydrate the live doc; the stored bytes are left intact
 *   (non-destructive); clean rows in a mixed store still hydrate.
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
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as bc from 'lib0-v14/broadcastchannel';
import * as idb from 'lib0-v14/indexeddb';
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
	// wins the merge against any live doc's meta.v=1.
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
const seedGenerationDb = async (name, rows) => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore, custom] = idb.transact(db, ['updates', 'custom']);
		for (const row of rows) {
			const copy = new Uint8Array(row.byteLength);
			copy.set(row);
			await idb.addAutoKey(updatesStore, copy.buffer);
		}
		await idb.rtop(custom.put({ ...GENERATION_RECORD }, GENERATION_KEY));
	} finally {
		db.close();
	}
};

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

describe('WU3 boundary — BroadcastChannel (IndexeddbPersistence)', () => {
	test('v99 update on BC: refused, signaled, live doc untouched, recoverable', async () => {
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
		expect(E.schemaVersion(docA)).toBe(1);
		expect(docA.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(Y.encodeStateVector(docA)).toEqual(before);

		// Structured refusal signal.
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		expect(msgErrors.length).toBeGreaterThan(0);

		// Recoverability: a subsequent VALID incremental update (no schema
		// write — a same-schema peer mid-session) still applies.
		const inc = makeIncrementalUpdate(docA, 'inc-after-v99');
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, inc)).slice().buffer,
			'v1-peer'
		);
		await until(() => docA.get('blocks').getAttr('inc-after-v99') !== undefined, 3000);
		expect(docA.get('blocks').getAttr('inc-after-v99')).toBeDefined();
		expect(E.schemaVersion(docA)).toBe(1);

		// Not persisted into accepted state: compact the store and decode
		// every row — none reconstructs a v99 document.
		await providers.storeState(pA);
		const rows = await readRows(name);
		for (const row of rows) {
			const probe = new Y.Doc();
			Y.applyUpdate(probe, new Uint8Array(row));
			expect(E.schemaVersion(probe)).not.toBe(99);
		}
		await pA.destroy();
	});

	test('v1 update carrying a foreign meta.schema is refused (gate-F1 F5)', async () => {
		const name = uniqueName('wu3-bc-foreign');
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const before = Y.encodeStateVector(docA);

		const mismatches = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));

		// A same-generation peer keeps meta.v=1 but rewrites meta.schema to a
		// foreign manifest name — a valid VERSION is not proof the payload is
		// an edytor document. The staging path must refuse it.
		const foreign = new Y.Doc();
		// Pin the clientID high so the foreign meta.schema write wins the
		// LWW merge against the live doc's 'edytor-doc' (same trick as
		// makeV99Update — map attrs resolve by clientID).
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

		expect(E.schemaVersion(docA)).toBe(1);
		expect(docA.get('meta').getAttr('schema')).toBe('edytor-doc');
		expect(docA.get('blocks').getAttr('evil-foreign')).toBeUndefined();
		expect(Y.encodeStateVector(docA)).toEqual(before);
		expect(mismatches.some((m) => m.problem?.kind === 'foreign')).toBe(true);
		await pA.destroy();
	});

	test('a doc in unversioned state refuses schema-less writes, heals on versioned state', async () => {
		const name = uniqueName('wu3-bc-rogue');
		// docA carries rogue registry content with NO meta.v — an unversioned
		// (self-poisoned) doc. Its provider refuses to persist or ship it.
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
		// The self-poisoned doc is treated as hydration refusal: whenSynced
		// rejects, synced never fires, but the BC room is still joined.
		await expect(pA.whenSynced).rejects.toThrow(/no meta\.v schema version/);
		expect(pA.synced).toBe(false);
		expect(pA.bcconnected).toBe(true);
		expect(mismatches.some((m) => m.problem?.kind === 'unversioned')).toBe(true);

		// An incremental write that carries no schema word keeps the merged
		// doc unversioned → refused (not applied, not persisted, not shipped).
		const marker = makeUnversionedUpdate('rogue-peer');
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, marker)).slice().buffer,
			'rogue-peer-2'
		);
		await nextTick();
		expect(docA.get('blocks').getAttr('rogue-peer')).toBeUndefined();
		// docA still has ONLY its own rogue write — nothing new merged.
		expect(E.schemaVersion(docA)).toBeUndefined();

		// …but a full VERSIONED state update heals it: the merge supplies
		// meta.v=1, the staged result is clean, and it applies.
		const good = new Y.Doc();
		E.create(good).init();
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, Y.encodeStateAsUpdate(good))).slice().buffer,
			'v1-peer'
		);
		await until(() => E.schemaVersion(docA) === 1, 3000);
		expect(E.schemaVersion(docA)).toBe(1);
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
			'v1-peer'
		);
		await until(() => docA.get('blocks').getAttr('inc-valid') !== undefined, 3000);
		expect(docA.get('blocks').getAttr('inc-valid')).toBeDefined();
		expect(mismatches.length).toBe(0);
		await pA.destroy();
	});

	test('a v99 doc provider does not ship its state (SyncStep2 publish + Step1 reply gated)', async () => {
		const name = uniqueName('wu3-bc-ship');
		const docA = new Y.Doc();
		E.create(docA).init();
		docA.transact(() => docA.get('meta').setAttr('v', 99));

		// Observe the room at the raw BC level.
		const seen = [];
		const seenFn = (data) => seen.push(new Uint8Array(data));
		bc.subscribe(generationDbName(name), seenFn);

		const mismatches = [];
		const pA = new providers.IndexeddbPersistence(name, docA);
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		// The self-poisoned doc counts as hydration refusal: whenSynced
		// rejects and synced never fires — but the room is still joined.
		await pA.whenSynced.catch(() => {});
		await nextTick();

		// pA signaled its own unsupported state…
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		// …and published SyncStep1 (harmless state vector) but NEVER a
		// SyncStep2 state publish (would ship v99 to the room).
		const syncMsgs = seen.filter((f) => f[0] === 14 && f[1] === 0);
		for (const frame of syncMsgs) {
			const dec = decoding.createDecoder(frame);
			decoding.readVarUint(dec); // version
			decoding.readVarUint(dec); // outer type (sync)
			const sub = decoding.readVarUint(dec);
			expect(sub).not.toBe(sync.messageYjsSyncStep2);
		}
		bc.unsubscribe(generationDbName(name), seenFn);
		await pA.destroy();
	});
});

describe('WU3 boundary — websocket (opaque relay)', () => {
	test('v99 SyncStep2 over ws: refused, no false synced, recoverable', async () => {
		const url = `ws://fake-wu3/${counter++}`;
		FakeWebSocket.sentLog = [];
		const docA = new Y.Doc();
		E.create(docA).init();
		const pA = new wsProviders.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
		});
		const mismatches = [];
		const syncedEvents = [];
		pA.on('schema-mismatch', (d) => mismatches.push(d));
		pA.on('synced', (s) => syncedEvents.push(s));
		await until(() => pA.wsconnected, 4000);

		// Server → provider SyncStep2 carrying v99 state (a peer that speaks
		// v14 but writes a future application schema).
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

		// Refused before mutating the live doc.
		expect(E.schemaVersion(docA)).toBe(1);
		expect(docA.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		// No false synced: the refused handshake payload produced no sync claim.
		expect(pA.synced).toBe(false);
		expect(syncedEvents.filter(Boolean).length).toBe(0);

		// Recoverability: a valid incremental update still applies and the
		// refused payload was never rebroadcast (A sends only its own edits).
		const inc = makeIncrementalUpdate(docA, 'inc-ws');
		pA.ws.onmessage({
			data: encodeV14(0, (e) => sync.writeUpdate(e, inc)).slice().buffer
		});
		await nextTick();
		expect(docA.get('blocks').getAttr('inc-ws')).toBeDefined();

		// The provider never rebroadcast the v99 payload bytes — a refused
		// update never entered the doc, so doc.on('update') never emitted it.
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
			WebSocketPolyfill: FakeWebSocket,
			disableBc: true
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

describe('WU3 boundary — IndexedDB hydration', () => {
	test('a stored v99 generation never hydrates; bytes intact; no synced; recoverable', async () => {
		const name = uniqueName('wu3-idb-v99');
		const v99Update = makeV99Update();
		await seedGenerationDb(name, [v99Update]);

		const docB = new Y.Doc();
		const mismatches = [];
		const msgErrors = [];
		const pB = new providers.IndexeddbPersistence(name, docB);
		pB.on('schema-mismatch', (d) => mismatches.push(d));
		pB.on('message-error', (e) => msgErrors.push(e));

		// Hydration refused the stored rows — whenSynced rejects with the
		// schema verdict and `synced` never fires (no false sync claim).
		await expect(pB.whenSynced).rejects.toThrow(/unsupported schema version 99/);
		expect(pB.synced).toBe(false);
		expect(E.schemaVersion(docB)).toBeUndefined();
		expect(docB.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		expect(msgErrors.length).toBeGreaterThan(0);

		// Non-destructive: the stored row bytes are untouched.
		const rows = await readRows(name);
		const seeded = new Uint8Array(v99Update);
		expect(
			rows.some(
				(r) =>
					new Uint8Array(r).byteLength === seeded.byteLength &&
					new Uint8Array(r).every((b, i) => b === seeded[i])
			)
		).toBe(true);

		// Recoverability: the provider joined the BC room — a subsequent
		// VALID peer update still applies.
		expect(pB.bcconnected).toBe(true);
		const good = new Y.Doc();
		E.create(good).init();
		good.get('blocks').setAttr(
			'recovered',
			(() => {
				const n = new Y.Node('block');
				n.setAttr('id', 'recovered');
				n.setAttr('type', 'paragraph');
				return n;
			})()
		);
		bc.publish(
			generationDbName(name),
			encodeV14(0, (e) => sync.writeUpdate(e, Y.encodeStateAsUpdate(good))).slice().buffer,
			'v1-peer'
		);
		await until(() => docB.get('blocks').getAttr('recovered') !== undefined, 3000);
		expect(docB.get('blocks').getAttr('recovered')).toBeDefined();
		expect(E.schemaVersion(docB)).toBe(1);
		await pB.destroy();
	});

	test('mixed store: clean rows hydrate, the poisoned row is skipped (non-destructive)', async () => {
		const name = uniqueName('wu3-idb-mixed');
		// Row 1: legit v1 doc with block A.
		const good1 = new Y.Doc();
		const eg1 = E.create(good1);
		eg1.init();
		eg1.insertBlock({ parent: null, index: 0 }, { id: 'good-a', type: 'paragraph' });
		const row1 = Y.encodeStateAsUpdate(good1);
		// Row 2: poison — v99.
		const row2 = makeV99Update();
		// Row 3: legit v1 doc with block B (independent clientID — no deps on row 2).
		const good3 = new Y.Doc();
		const eg3 = E.create(good3);
		eg3.init();
		eg3.insertBlock({ parent: null, index: 0 }, { id: 'good-b', type: 'paragraph' });
		const row3 = Y.encodeStateAsUpdate(good3);
		await seedGenerationDb(name, [row1, row2, row3]);

		const docB = new Y.Doc();
		const mismatches = [];
		const pB = new providers.IndexeddbPersistence(name, docB);
		pB.on('schema-mismatch', (d) => mismatches.push(d));

		// The refusal is still reported (and synced suppressed)…
		await expect(pB.whenSynced).rejects.toThrow(/unsupported schema version 99/);
		expect(pB.synced).toBe(false);
		// …but the clean rows hydrated — the doc carries v1 content.
		expect(E.schemaVersion(docB)).toBe(1);
		expect(docB.get('blocks').getAttr('good-a')).toBeDefined();
		expect(docB.get('blocks').getAttr('good-b')).toBeDefined();
		// …while the poisoned row never touched the live doc.
		expect(docB.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(mismatches.length).toBeGreaterThan(0);

		// Non-destructive: all three original rows remain in the store.
		const rows = await readRows(name);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		await pB.destroy();
	});
});
