/**
 * SY02/SY03 — IndexedDB persistence, compaction, generation separation and
 * provider lifecycle for the v14 provider stack.
 *
 * - Real IndexedDB (fake-indexeddb) hydration: updates written by one
 *   provider reconstruct the doc in a fresh provider+doc.
 * - Compaction: a `storeState` snapshot row plus later update rows
 *   reconstruct the complete document.
 * - Storage generation: providers open `edytor-v14:<name>` only; a legacy
 *   `<name>` database is never read and never written.
 * - Generation gate: a v14-named DB populated without the `generation`
 *   record (or with a foreign record) fails closed — `load-error`, no
 *   `synced`.
 * - Lifecycle: idempotent `destroy()`, owned vs injected awareness cleanup.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';

const providers = bindIndexeddbProvider(Y);

let dbCounter = 0;
const uniqueName = (base) => `${base}-${dbCounter++}`;

const openDb = (name) =>
	idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const readRows = async (name) => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return await idb.getAll(updatesStore);
	} finally {
		db.close();
	}
};

const readCustom = async (name, key) => {
	const db = await openDb(generationDbName(name));
	try {
		const [custom] = idb.transact(db, ['custom'], 'readonly');
		return await idb.rtop(custom.get(key));
	} finally {
		db.close();
	}
};

/** Write rows directly into a legacy-layout DB (`<name>` — the v13 shape). */
const seedLegacyDb = async (name, rows, customEntries = {}) => {
	const db = await idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updatesStore, custom] = idb.transact(db, ['updates', 'custom']);
		for (const row of rows) {
			const copy = new Uint8Array(row.byteLength);
			copy.set(row);
			await idb.addAutoKey(updatesStore, copy.buffer);
		}
		for (const [k, v] of Object.entries(customEntries)) {
			await idb.rtop(custom.put(v, k));
		}
	} finally {
		db.close();
	}
};

describe('SY02: IndexedDB persistence', () => {
	test('a fresh provider reconstructs stored state', async () => {
		const name = uniqueName('persist');
		const docA = new Y.Doc();
		docA.get('content').setAttr('x', 'a-1');
		docA.transact(() => docA.get('content').insert(0, ['hello', 'world']));
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		await pA.destroy();

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		expect(docB.get('content').getAttr('x')).toBe('a-1');
		expect(docB.get('content').toArray()).toEqual(['hello', 'world']);
		expect(Y.encodeStateVector(docB)).toEqual(Y.encodeStateVector(docA));
		await pB.destroy();
	});

	test('compaction snapshot + later updates reconstruct the full document', async () => {
		const name = uniqueName('compact');
		const docA = new Y.Doc();
		docA.get('content').setAttr('before', 1);
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;

		// A handful of incremental rows, then force compaction.
		for (let i = 0; i < 5; i++) docA.get('content').setAttr(`k${i}`, i);
		await new Promise((r) => setTimeout(r, 10));
		await providers.storeState(pA);

		const rowsAfterCompact = await readRows(name);
		expect(rowsAfterCompact.length).toBe(1); // single snapshot row

		// Later updates land AFTER the snapshot.
		docA.get('content').setAttr('after', 2);
		await new Promise((r) => setTimeout(r, 10));
		const rowsFinal = await readRows(name);
		expect(rowsFinal.length).toBe(2);

		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		expect(docB.get('content').getAttr('before')).toBe(1);
		expect(docB.get('content').getAttr('after')).toBe(2);
		for (let i = 0; i < 5; i++) expect(docB.get('content').getAttr(`k${i}`)).toBe(i);
		expect(Y.encodeStateVector(docB)).toEqual(Y.encodeStateVector(docA));
		await pA.destroy();
		await pB.destroy();
	});
});

describe('SY03: storage generation boundary', () => {
	test('providers use the edytor-v14: generation and stamp the record', async () => {
		const name = uniqueName('gen');
		const doc = new Y.Doc();
		doc.get('content').setAttr('x', 1);
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		await p.destroy();

		// The generation record was written to `custom`.
		expect(await readCustom(name, GENERATION_KEY)).toEqual(GENERATION_RECORD);
		// The legacy-named DB must not have been created by the provider.
		const legacy = await new Promise((res) => {
			const req = indexedDB.open(name);
			req.onupgradeneeded = () => res('created-now'); // didn't exist before
			req.onsuccess = () => {
				req.result.close();
				res('existed');
			};
			req.onerror = () => res('error');
		});
		expect(legacy).toBe('created-now'); // proves the provider never opened it
		indexedDB.deleteDatabase(name);
	});

	test('a v13 database sharing the logical name is ignored, never read', async () => {
		const name = uniqueName('v13-shadow');
		// Seed a foreign doc under the LEGACY name — this is the v13 layout.
		const foreign = new Y.Doc();
		foreign.get('content').setAttr('poison', true);
		const foreignUpdate = Y.encodeStateAsUpdate(foreign);
		await seedLegacyDb(name, [foreignUpdate]);

		// Provider loads cleanly from the empty v14 generation.
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(doc.get('content').getAttr('poison')).toBeUndefined();
		await p.destroy();

		// The legacy DB is untouched (same single row still there).
		const db = await openDb(name);
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		const rows = await idb.getAll(updatesStore);
		expect(rows.length).toBe(1);
		db.close();
	});

	test('populated v14-named DB without a generation record fails closed', async () => {
		const name = uniqueName('no-record');
		// Forge a v14-named DB with rows but NO generation record — as if a
		// foreign writer populated our namespace.
		const foreign = new Y.Doc();
		foreign.get('content').setAttr('poison', true);
		await seedLegacyDb(generationDbName(name), [Y.encodeStateAsUpdate(foreign)]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		const errors = [];
		p.on('load-error', (e) => errors.push(e));
		await expect(p.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(p.synced).toBe(false);
		expect(errors.length).toBe(1);
		expect(doc.get('content').getAttr('poison')).toBeUndefined();
		await p.destroy();
	});

	test('a foreign generation record fails closed', async () => {
		const name = uniqueName('bad-record');
		await seedLegacyDb(generationDbName(name), [], {
			[GENERATION_KEY]: { engine: 'yjs-v13', protocol: 13 }
		});

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await expect(p.whenSynced).rejects.toThrow(/not a v14 document generation/);
		expect(p.synced).toBe(false);
		await p.destroy();
	});
});

describe('SY03: lifecycle', () => {
	test('destroy is idempotent and stops storing', async () => {
		const name = uniqueName('destroy');
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		await p.destroy();
		await p.destroy(); // idempotent

		const rowsBefore = (await readRows(name)).length;
		doc.get('content').setAttr('after-destroy', true);
		await new Promise((r) => setTimeout(r, 20));
		expect((await readRows(name)).length).toBe(rowsBefore);
	});

	test('owned awareness is destroyed with the provider; injected awareness is not', async () => {
		const name = uniqueName('aw-own');
		const docOwned = new Y.Doc();
		const pOwned = new providers.IndexeddbPersistence(name, docOwned);
		await pOwned.whenSynced;
		const ownedAwareness = pOwned.awareness;
		let ownedDestroyed = false;
		ownedAwareness.on('destroy', () => (ownedDestroyed = true));
		await pOwned.destroy();
		expect(ownedDestroyed).toBe(true);

		const docInjected = new Y.Doc();
		const injected = new Awareness(docInjected);
		const pInjected = new providers.IndexeddbPersistence(uniqueName('aw-inj'), docInjected, {
			awareness: injected
		});
		await pInjected.whenSynced;
		await pInjected.destroy();
		// The caller-supplied awareness survives the provider.
		expect(injected.getLocalState()).not.toBeNull();
		injected.destroy();
	});
});
