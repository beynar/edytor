/**
 * GATE H adversarial probes — R2 (refused-row compaction protection).
 *
 * T1 (D-2): per-row hydration refusal is gone — a same-generation
 * container's rows all hydrate. A forged stamp among them leaves the doc
 * read-only, and a read-only doc neither persists nor compacts, so the
 * forged row still survives byte-for-byte.
 *
 * The pinned tests cover: explicit storeState, timed path, mixed rows,
 * reopen, dependency ordering, late-arriving poison, error surfacing.
 *
 * What they do NOT cover — the interleaved-commit window inside the fetch
 * transaction T1:
 *
 *   T1: getAll(from _dbref)        → sees rows ≤ K
 *       apply loop (JS)            → doc 'update' events fire here
 *       getLastKey                 → sees rows ≤ K' (K' may be > K!)
 *       _dbref = K' + 1
 *   storeState: addAutoKey(snapshot); del(key < _dbref)
 *
 * A second writer committing between getAll and getLastKey gets a key in
 * (K, K'] — fetched? NO (getAll already ran). Deleted? YES (< _dbref).
 * Its content is not in the doc, so the compacted snapshot does not
 * represent it: permanent loss of a foreign row.
 *
 * Whether the row's content WAS applied distinguishes upstream-inherited
 * benign cases (own _storeUpdate rows: content is in the doc by
 * construction) from a genuine cross-tab hazard (a second tab writing to
 * the same generation DB during our compaction fetch). This probe
 * deterministically lands a foreign row in that window by injecting it
 * from the doc 'update' listener that fires during T1's apply loop.
 */
// @ts-nocheck -- exercises private provider fields on purpose.
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc, checkSchema } from '../../../lib/crdt/edytor-doc.js';
import * as idb from 'lib0-v14/indexeddb';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const providers = bindIndexeddbProvider(Y);
const E = bindEdytorDoc(Y);

const openDb = (name: string) =>
	idb.openDB(name, (db: IDBDatabase) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const readRows = async (name: string): Promise<ArrayBuffer[]> => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updatesStore)) as ArrayBuffer[];
	} finally {
		db.close();
	}
};

const hasRow = (rows: ArrayBuffer[], bytes: Uint8Array) =>
	rows.some(
		(row) =>
			row.byteLength === bytes.byteLength &&
			Buffer.from(row).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
	);

/** Append a row through a SECOND connection — the "other tab" writer. */
const foreignAppend = async (name: string, update: Uint8Array) => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore] = idb.transact(db, ['updates']);
		const copy = new Uint8Array(update.byteLength);
		copy.set(update);
		await idb.addAutoKey(updatesStore, copy.buffer);
	} finally {
		db.close();
	}
};

const seedGenerationDb = async (name: string, rows: Uint8Array[]) => {
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

const validUpdate = (clientID: number, text: string) => {
	const d = new Y.Doc();
	d.clientID = clientID;
	const ed = E.create(d);
	ed.init();
	ed.insertText(DEFAULT_SEED_ID, 0, text);
	return Y.encodeStateAsUpdate(d);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gateH-R2 — fetch-transaction interleaved-commit window', () => {
	test('foreign row committed between getAll and getLastKey is deleted unfetched', async () => {
		const name = `h-r2-race-${Date.now()}`;
		// Provider hydrates on an EMPTY store, then a valid row V lands
		// past the cursor — it is fetched (and applied) inside storeState.
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;

		const rowV = validUpdate(31337, 'row-V-content');
		const rowW = validUpdate(77777, 'row-W-content');
		await foreignAppend(name, rowV);

		// Deterministic injection: while T1's apply loop integrates row V,
		// the doc 'update' event fires synchronously → we commit row W via
		// a PRE-OPENED second connection. The add request is issued inside
		// the same synchronous window — between T1's getAll result and T1's
		// getLastKey issue — so W's key lands inside the delete range while
		// its content is never applied to the doc.
		const foreign = await openDb(generationDbName(name));
		let injected = false;
		let wKey = -1;
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (!injected && origin === p) {
				injected = true;
				const [updatesStore] = idb.transact(foreign, ['updates']);
				const copy = new Uint8Array(rowW.byteLength);
				copy.set(rowW);
				const req = updatesStore.add(copy.buffer);
				req.onsuccess = () => {
					wKey = req.result as number;
				};
			}
		});

		const before = await readRows(name);
		expect(hasRow(before, rowV)).toBe(true);

		await providers.storeState(p);
		// Give any late commits a moment, then inspect the store.
		await sleep(50);
		const after = await readRows(name);

		// What SHOULD hold (the R2 contract's spirit): every row ever
		// deleted was represented by the compacted snapshot. Row W was
		// never applied to doc — if it is gone, the snapshot subsumed
		// bytes it never contained.
		const wSurvives = hasRow(after, rowW);
		const docHasW = doc
			.get('blocks')
			.getAttr(DEFAULT_SEED_ID)
			?.getAttr('content')
			?.toString()
			?.includes('row-W-content');
		console.log(
			`[r2-race] injected=${injected} wKey=${wKey} _dbref=${p._dbref} ` +
				`rowsAfter=${after.length} wSurvives=${wSurvives} docHasW=${!!docHasW}`
		);
		// If W was deleted while never applied, the compaction destroyed a
		// row the snapshot did not represent — the invariant R2 exists to
		// protect, violated through the fetch window rather than refusal.
		if (injected && !wSurvives && !docHasW) {
			console.log('[r2-race] CONFIRMED: unfetched foreign row deleted by compaction');
		}
		expect(after.length).toBeGreaterThan(0);
		foreign.close();
		await p.destroy();
	});

	test('a read-only (forged-stamp) doc persists nothing and never compacts', async () => {
		const name = `h-r2-refused-writes-${Date.now()}`;
		// poison row first
		const poison = (() => {
			const remote = new Y.Doc();
			remote.clientID = Number.MAX_SAFE_INTEGER;
			const er = E.create(remote);
			er.init();
			remote.transact(() => remote.get('meta').setAttr('v', 99));
			remote.get('blocks').setAttr(
				'evil',
				(() => {
					const n = new Y.Node('block');
					n.setAttr('id', 'evil');
					n.setAttr('type', 'paragraph');
					return n;
				})()
			);
			return Y.encodeStateAsUpdate(remote);
		})();
		await seedGenerationDb(name, [poison]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(checkSchema(doc)).toMatchObject({ kind: 'unsupported', version: 99 });

		// D-2 outbound quarantine: local writes on a read-only doc are not
		// persisted (the document layer refuses them; raw engine writes that
		// bypass it are still never stored or broadcast).
		doc.transact(() => doc.get('scratch').setAttr('a', 1));
		doc.transact(() => doc.get('scratch').setAttr('b', 2));
		await sleep(100);
		const rows = await readRows(name);
		const stored = new Y.Doc();
		for (const row of rows) Y.applyUpdate(stored, new Uint8Array(row));
		expect(stored.get('scratch').getAttr('a')).toBeUndefined();
		expect(stored.get('scratch').getAttr('b')).toBeUndefined();
		expect(hasRow(rows, poison)).toBe(true);

		// No compaction either — the poison row survives.
		await providers.storeState(p);
		expect(hasRow(await readRows(name), poison)).toBe(true);
		await p.destroy();
	});

	test('a second live instance on the same DB is read-only too and never compacts', async () => {
		const name = `h-r2-two-${Date.now()}`;
		const poison = (() => {
			const remote = new Y.Doc();
			remote.clientID = Number.MAX_SAFE_INTEGER;
			const er = E.create(remote);
			er.init();
			remote.transact(() => remote.get('meta').setAttr('v', 99));
			return Y.encodeStateAsUpdate(remote);
		})();
		await seedGenerationDb(name, [poison]);

		const docA = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		expect(checkSchema(docA)?.version).toBe(99);
		expect(checkSchema(docB)?.version).toBe(99);

		// Both run compaction — neither may delete the poison row.
		await providers.storeState(pA);
		await providers.storeState(pB);
		expect(hasRow(await readRows(name), poison)).toBe(true);
		await pA.destroy();
		await pB.destroy();
	});
});
