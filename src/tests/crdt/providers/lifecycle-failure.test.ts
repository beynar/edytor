/**
 * Provider lifecycle + terminal-failure pins (D4 / D10 / D22 / D24).
 *
 * - `failed` is the terminal half of the sync contract: a provider that can
 *   never reach `synced` reports it exactly once — destroy-before-sync, a
 *   persistence load failure (including a container of another schema
 *   generation, D-2). Never on a synced provider, never twice.
 * - The hydration-refusal latch (D10) is deleted with per-row staging
 *   (L55); its unversioned-row case is a maintainer question (T1).
 * - `whenSynced` settles on destroy-before-open — rejects, never hangs,
 *   and `destroy()` itself still resolves (D22).
 * - A refused inbound payload (a forged stamp) produces exactly one
 *   schema-mismatch report (D24); the provider never reports its own
 *   document's state (D-2: that signal is the document's).
 * - BroadcastChannel room lifecycle: `connectBc`/`disconnectBc` drive
 *   membership; a peer that leaves stops receiving and resyncs on rejoin.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { SchemaMismatchError } from '../../../lib/crdt/admission.js';
import * as encoding from 'lib0-v14/encoding';
import * as bc from 'lib0-v14/broadcastchannel';
import * as idb from 'lib0-v14/indexeddb';
import {
	writeProtocolVersion,
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
const sync = bindSync(Y);

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

/**
 * A rogue doc carrying registry content but NO meta.v — the 'unversioned'
 * refusal path (no EdytorDoc init needed: the gate reads raw roots).
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

/** A same-generation update carrying a forged `meta.v = 99` stamp. */
const makeV99Update = () => {
	const rogue = new Y.Doc();
	rogue.clientID = Number.MAX_SAFE_INTEGER;
	rogue.transact(() => rogue.get('meta').setAttr('v', 99));
	return Y.encodeStateAsUpdate(rogue);
};

/** Seed the v14 generation DB directly: generation record + update rows. */
const seedGenerationDb = async (name, rows, customEntries = {}) => {
	const db = await idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updatesStore, custom] = idb.transact(db, ['updates', 'custom']);
		await idb.rtop(custom.put({ ...GENERATION_RECORD }, GENERATION_KEY));
		for (const [k, v] of Object.entries(customEntries)) {
			await idb.rtop(custom.put(v, k));
		}
		for (const row of rows) {
			const copy = new Uint8Array(row.byteLength);
			copy.set(row);
			await idb.addAutoKey(updatesStore, copy.buffer);
		}
	} finally {
		db.close();
	}
};

describe('failure channel (D4) — IndexeddbPersistence', () => {
	test('destroy before sync rejects whenSynced and emits failed exactly once (D22)', async () => {
		const name = uniqueName('fail-destroy');
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		const failed = [];
		p.on('failed', (error, provider) => failed.push([error, provider]));

		// Destroy BEFORE the open/hydration settles — the provider can never
		// reach synced. destroy() itself resolves (there is a handle to
		// close once the open lands); whenSynced rejects.
		await p.destroy();
		await expect(p.whenSynced).rejects.toThrow(/destroyed before it synced/);
		expect(failed.length).toBe(1);
		expect(failed[0][0]).toBeInstanceOf(Error);
		expect(failed[0][1]).toBe(p);
		expect(p.synced).toBe(false);

		// Idempotent destroy does not re-emit.
		await p.destroy();
		expect(failed.length).toBe(1);
	});

	test('destroy after sync emits no failure', async () => {
		const name = uniqueName('fail-after-sync');
		const p = new providers.IndexeddbPersistence(name, new Y.Doc());
		await p.whenSynced;
		const failed = [];
		p.on('failed', (e) => failed.push(e));
		await p.destroy();
		expect(failed.length).toBe(0);
	});

	test('a generation load failure emits failed once alongside load-error', async () => {
		const name = uniqueName('fail-load');
		// A populated v14-named DB stamped with a FOREIGN record fails the
		// storage gate — the load-error path.
		await seedGenerationDb(name, [makeUnversionedUpdate()], {
			[GENERATION_KEY]: { engine: 'yjs-v13', protocol: 13 }
		});
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		const failed = [];
		const loadErrors = [];
		p.on('failed', (e) => failed.push(e));
		p.on('load-error', (e) => loadErrors.push(e));

		await expect(p.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(p.synced).toBe(false);
		expect(loadErrors.length).toBe(1);
		expect(failed.length).toBe(1);

		// Destroying the failed provider does not double-report.
		await p.destroy();
		expect(failed.length).toBe(1);
	});

	test('a container of another schema generation emits failed once and never joins', async () => {
		const name = uniqueName('fail-schema-gen');
		await seedGenerationDb(name, [makeV99Update()], {
			[GENERATION_KEY]: { ...GENERATION_RECORD, schema: 99 }
		});
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		const failed = [];
		p.on('failed', (e) => failed.push(e));
		await expect(p.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(p.synced).toBe(false);
		expect(p.bcconnected).toBe(false);
		expect(failed.length).toBe(1);
		await p.destroy();
		expect(failed.length).toBe(1);
	});

	// MAINTAINER (T1 limit): unversioned rows are not a stamp write, so under
	// D-2 they hydrate (the doc is then read-only and quarantined, and
	// document admission refuses it) instead of refusing hydration here.
	test.fails('refused hydration emits failed once and latches sync suppression (D10)', async () => {
		const name = uniqueName('fail-refused');
		// Valid generation record + a poisoned row (registry write, no
		// meta.v) → hydration refuses the row.
		await seedGenerationDb(name, [makeUnversionedUpdate()]);
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		const failed = [];
		const mismatches = [];
		p.on('failed', (e) => failed.push(e));
		p.on('schema-mismatch', (d) => mismatches.push(d));

		await expect(p.whenSynced).rejects.toThrow();
		expect(p.synced).toBe(false);
		expect(p._hydrationRefused).not.toBeNull();
		expect(failed.length).toBe(1);
		expect(mismatches.length).toBe(1);
		expect(mismatches[0].problem.kind).toBe('unversioned');
		// The refused row never reached the live doc.
		expect(doc.get('blocks').getAttr('rogue')).toBeUndefined();

		// D10 — the latch is enforced INSIDE connectBc: a manual
		// disconnect/reconnect cycle cannot launder the refusal back into
		// a synced claim.
		p.disconnectBc();
		expect(p.bcconnected).toBe(false);
		p.connectBc();
		expect(p.bcconnected).toBe(true);
		expect(p.synced).toBe(false);
		await expect(p.whenSynced).rejects.toThrow();

		// Destroying after refusal emits no second failure.
		await p.destroy();
		expect(failed.length).toBe(1);
	});

	test('a read-only (forged-stamp) provider still receives valid peer updates', async () => {
		const name = uniqueName('fail-recover');
		await seedGenerationDb(name, [makeV99Update()]);
		const docA = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;

		// A peer in the same room keeps feeding it — a read-only document
		// is quarantined outbound, not deaf inbound.
		const docB = new Y.Doc();
		docB.get('content').setAttr('peer', 'live');
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0);
		sync.writeSyncStep2(e, docB);
		bc.publish(generationDbName(name), encoding.toUint8Array(e).slice().buffer, 'peer');
		await until(() => docA.get('content').getAttr('peer') === 'live', 4000);

		await pA.destroy();
	});
});

describe('schema-mismatch reporting (D24)', () => {
	/** A v14-enveloped SyncStep2 carrying `live`'s state plus a forged v99 stamp. */
	const forgedStep2 = (live) => {
		const rogueDoc = new Y.Doc();
		rogueDoc.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(rogueDoc, Y.encodeStateAsUpdate(live));
		rogueDoc.transact(() => rogueDoc.get('meta').setAttr('v', 99));
		rogueDoc.get('blocks').setAttr('rogue', new Y.Node('block'));
		const e = encoding.createEncoder();
		writeProtocolVersion(e);
		encoding.writeVarUint(e, 0); // messageSync
		sync.writeSyncStep2(e, rogueDoc);
		return encoding.toUint8Array(e).slice().buffer;
	};

	test('a refused inbound payload reports schema-mismatch exactly once', async () => {
		const name = uniqueName('d24');
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		const mismatches = [];
		const msgErrs = [];
		p.on('schema-mismatch', (d) => mismatches.push(d));
		p.on('message-error', (e) => msgErrs.push(e));

		bc.publish(generationDbName(name), forgedStep2(doc), 'foreign');
		await nextTick(60);

		// Exactly one structured report + its SchemaMismatchError mirror on
		// the error channel.
		expect(mismatches.length).toBe(1);
		expect(mismatches[0].problem).toMatchObject({ kind: 'unsupported', version: 99 });
		expect(msgErrs.filter((err) => err instanceof SchemaMismatchError).length).toBe(1);
		expect(doc.get('blocks').getAttr('rogue')).toBeUndefined();
		await p.destroy();
	});

	test('a refused payload on an independently read-only doc adds exactly one report', async () => {
		const name = uniqueName('d24-dirty');
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		const mismatches = [];
		p.on('schema-mismatch', (d) => mismatches.push(d));

		// A local write leaves the doc read-only: the provider quarantines
		// it silently — the visible signal is the document's (D-2).
		doc.get('blocks').setAttr('local-rogue', new Y.Node('block'));
		await nextTick();
		expect(mismatches.length).toBe(0);

		// The refused inbound reports its own verdict exactly once.
		bc.publish(generationDbName(name), forgedStep2(doc), 'foreign');
		await nextTick(60);
		expect(mismatches.length).toBe(1);
		expect(doc.get('blocks').getAttr('rogue')).toBeUndefined();
		await p.destroy();
	});
});

describe('BroadcastChannel room lifecycle', () => {
	test('disconnectBc leaves the room; connectBc rejoins and resyncs', async () => {
		const name = uniqueName('bc-life');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pA.whenSynced;
		await pB.whenSynced;
		expect(pA.bcconnected).toBe(true);
		expect(pB.bcconnected).toBe(true);

		// B leaves the room — A's updates stop reaching it.
		pB.disconnectBc();
		expect(pB.bcconnected).toBe(false);
		docA.get('content').setAttr('while-away', 1);
		await nextTick(80);
		expect(docB.get('content').getAttr('while-away')).toBeUndefined();

		// Rejoin: the SyncStep1 re-handshake pulls the missed state, and
		// live updates flow again.
		pB.connectBc();
		docA.get('content').setAttr('after-back', 2);
		await until(() => docB.get('content').getAttr('while-away') === 1, 4000);
		expect(docB.get('content').getAttr('after-back')).toBe(2);
		expect(pB.synced).toBe(true);

		await pA.destroy();
		await pB.destroy();
	});

	test('awareness removal announces the disconnect to the room', async () => {
		const name = uniqueName('bc-aw');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pA.whenSynced;
		await pB.whenSynced;

		pA.awareness.setLocalStateField('user', { name: 'ada' });
		await until(() => pB.awareness.getStates().get(docA.clientID)?.user?.name === 'ada', 4000);

		// Leaving the room publishes an awareness removal for the doc's
		// client — B observes the departure event. (End-state is NOT
		// pinned: a peer rebroadcasts the removal back to pA, whose live
		// local state rebuts it with a clock bump — upstream semantics —
		// so a still-alive client may reappear. The DELIVERY is the pin.)
		const removals: number[] = [];
		pB.awareness.on('update', ({ removed }) => removals.push(...removed));
		pA.disconnectBc();
		await until(() => removals.includes(docA.clientID), 4000);

		await pA.destroy();
		await pB.destroy();
	});
});
