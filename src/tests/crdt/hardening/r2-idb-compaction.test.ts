/**
 * HARDENING U0 / R2 — refused IndexedDB rows deleted during compaction
 * (review `docs/archive/crdt-v14-follow-up-review-2026-09-21.md` §R2, P1).
 *
 * Hydration correctly refuses a generation-tagged row whose content carries an
 * unsupported schema (`meta.v = 99`): `whenSynced` rejects, the row's bytes are
 * never applied, and `_hydrationRefused` is set. Pre-fix, nothing stopped
 * compaction: `storeState()` (and the timed `_dbsize >= PREFERRED_TRIM_SIZE`
 * path) wrote a snapshot of the clean live doc and then deleted EVERY update
 * row `< _dbref` — including the refused one. Data the local doc never
 * accepted was destroyed.
 *
 * FIXED CONTRACT (U2): while `_hydrationRefused` is set, `storeState`
 * performs the fetch (valid peer rows keep hydrating) but skips the
 * snapshot+delete entirely — a live-doc snapshot cannot subsume rows it
 * never admitted, and blocking preserves every excluded row AND its
 * dependencies regardless of row order. The returned promise settles only
 * after the storage transaction commits; failures reject (the timed caller
 * forwards them to 'message-error').
 *
 * OBSERVED pre-fix (vitest run, this file, fake-indexeddb):
 *   explicit path: rows before = [{key:1,len:430 v99},{key:2,len:2 snapshot}]
 *                  after storeState() = [{key:3,len:2}] — v99 row GONE.
 *   timed path:    after 505 local updates + debounce = [{key:508,len:9434}]
 *                  — v99 row GONE.
 *   `p._hydrationRefused` was set in both cases but did not protect the row.
 */
/*
 * T1 (D-2) re-pin: rows of a proven generation are never refused one by
 * one any more — they all hydrate, and a forged `meta.v = 99` row leaves
 * the doc read-only. The pinned intent survives unchanged: compaction never
 * deletes bytes its snapshot does not represent, because a read-only
 * document neither persists nor compacts (outbound quarantine).
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

/** Write a generation record + raw update rows exactly like a real session. */
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

/**
 * An update whose content hydrates into a schema-unsupported doc: engine-valid
 * (a real block row) but `meta.v = 99` wins over the provider doc's `v = 1`.
 */
const makeV99Update = () => {
	const remote = new Y.Doc();
	remote.clientID = Number.MAX_SAFE_INTEGER; // wins the 'v' map-entry merge
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readOnly = (doc) => checkSchema(doc)?.kind === 'unsupported';

describe('R2 — compaction must not delete a forged row', () => {
	test('explicit storeState() keeps the forged v99 row byte-for-byte', async () => {
		const name = `h-r2-explicit-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(readOnly(doc)).toBe(true);

		await providers.storeState(p);
		await providers.storeState(p, false);
		expect(hasRow(await readRows(name), v99)).toBe(true);
		await p.destroy();
	});

	test('the timed path never runs for a read-only doc: nothing is stored', async () => {
		const name = `h-r2-timed-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		const dbsize = p._dbsize;
		for (let i = 0; i < providers.PREFERRED_TRIM_SIZE + 5; i++) {
			doc.transact(() => doc.get('scratch').setAttr(`k${i}`, i));
		}
		expect(p._dbsize).toBe(dbsize);
		await sleep(1200);
		expect(hasRow(await readRows(name), v99)).toBe(true);
		await p.destroy();
	});

	test('mixed valid + forged rows: both hydrate, the doc is read-only, both survive', async () => {
		const name = `h-r2-mixed-${Date.now()}`;
		const validDoc = new Y.Doc();
		validDoc.clientID = 7777;
		const ev = E.create(validDoc);
		ev.init();
		ev.insertText(DEFAULT_SEED_ID, 0, 'kept');
		const validUpdate = Y.encodeStateAsUpdate(validDoc);
		const v99 = makeV99Update();
		await seedGenerationDb(name, [validUpdate, v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(readOnly(doc)).toBe(true);

		await providers.storeState(p);
		const after = await readRows(name);
		expect(hasRow(after, validUpdate)).toBe(true);
		expect(hasRow(after, v99)).toBe(true);
		await p.destroy();
	});
});

describe('R2 — read-only ↔ compaction contract', () => {
	test('close/reopen: the forged row survives; every fresh provider is read-only too', async () => {
		const name = `h-r2-reopen-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc1 = new Y.Doc();
		const p1 = new providers.IndexeddbPersistence(name, doc1);
		await p1.whenSynced;
		await p1.destroy();
		expect(hasRow(await readRows(name), v99)).toBe(true);

		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		expect(readOnly(doc2)).toBe(true);
		await providers.storeState(p2);
		await providers.storeState(p2, false);
		expect(hasRow(await readRows(name), v99)).toBe(true);
		await p2.destroy();
	});

	test('repeated compaction attempts are inert — nothing deleted, nothing added', async () => {
		const name = `h-r2-repeat-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;

		const before = await readRows(name);
		await providers.storeState(p);
		await providers.storeState(p);
		doc.transact(() => doc.get('scratch').setAttr('later', 1));
		await providers.storeState(p);
		await providers.storeState(p, false);

		const after = await readRows(name);
		expect(after.length).toBe(before.length);
		expect(hasRow(after, v99)).toBe(true);
		await p.destroy();
	});

	/** A forged update whose dependency lives in a DIFFERENT row. */
	const makeV99DeltaOn = (baseUpdate: Uint8Array) => {
		const remote = new Y.Doc();
		remote.clientID = Number.MAX_SAFE_INTEGER; // meta.v LWW winner
		Y.applyUpdate(remote, baseUpdate);
		let captured: Uint8Array | null = null;
		remote.on('update', (u: Uint8Array) => (captured = u));
		remote.transact(() => {
			remote.get('meta').setAttr('v', 99);
			remote.get('blocks').getAttr(DEFAULT_SEED_ID).getAttr('content').insert(0, 'DEP');
		});
		return captured as Uint8Array;
	};

	const makeBaseUpdate = () => {
		const base = new Y.Doc();
		const eb = E.create(base);
		eb.init();
		eb.insertText(DEFAULT_SEED_ID, 0, 'base');
		return Y.encodeStateAsUpdate(base);
	};

	test.each([['in-order'], ['out-of-order']] as const)(
		'a forged update and its dependency both survive (%s seed order)',
		async (order) => {
			const name = `h-r2-deps-${order}-${Date.now()}`;
			const base = makeBaseUpdate();
			const delta = makeV99DeltaOn(base);
			await seedGenerationDb(name, order === 'in-order' ? [base, delta] : [delta, base]);

			const doc = new Y.Doc();
			const p = new providers.IndexeddbPersistence(name, doc);
			await p.whenSynced;
			// One hydration transaction resolves either order.
			expect(E.schemaVersion(doc)).toBe(99);
			await providers.storeState(p);
			const after = await readRows(name);
			expect(hasRow(after, base)).toBe(true);
			expect(hasRow(after, delta)).toBe(true);
			await p.destroy();
		}
	);

	test('a forged row fetched after sync turns the doc read-only before the same compaction', async () => {
		const name = `h-r2-late-${Date.now()}`;
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;

		// A same-generation writer appends a forged row after our hydration —
		// it is first seen inside storeState's own fetch.
		const v99 = makeV99Update();
		const db = await openDb(generationDbName(name));
		try {
			const [updatesStore] = idb.transact(db, ['updates']);
			const copy = new Uint8Array(v99.byteLength);
			copy.set(v99);
			await idb.addAutoKey(updatesStore, copy.buffer);
		} finally {
			db.close();
		}

		await providers.storeState(p);
		expect(readOnly(doc)).toBe(true);
		expect(hasRow(await readRows(name), v99)).toBe(true);
		await p.destroy();
	});

	test('fully-admitted store still compacts; storeState resolves only after commit', async () => {
		const name = `h-r2-clean-${Date.now()}`;
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		for (let i = 0; i < 5; i++) doc.transact(() => doc.get('scratch').setAttr(`k${i}`, i));

		await providers.storeState(p);
		// No polling: the promise settling IS the completion signal — the
		// snapshot+delete+recount transaction must already be committed.
		const rows = await readRows(name);
		expect(rows.length).toBe(1); // single compacted snapshot row

		// Reopen reconstructs everything from the compacted store.
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		for (let i = 0; i < 5; i++) expect(doc2.get('scratch').getAttr(`k${i}`)).toBe(i);
		expect(E.create(doc2).blockText(DEFAULT_SEED_ID)).toBeDefined();
		await p.destroy();
		await p2.destroy();
	});

	test('failures surface: closed-handle storeState rejects; _storeUpdate emits message-error', async () => {
		const name = `h-r2-errors-${Date.now()}`;
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;

		const errors = [];
		p.on('message-error', (e) => errors.push(e));

		// Force a storage failure on the steady-state write path — the
		// synchronous transact throw must reach the error channel, not the
		// doc's update dispatch.
		p.db.close();
		doc.transact(() => doc.get('scratch').setAttr('x', 1));
		expect(errors.length).toBeGreaterThan(0);

		// The maintenance path surfaces the same failure as a rejection —
		// never a synchronous throw escaping the API, never a silent drop.
		await expect(providers.storeState(p)).rejects.toThrow();
		await p.destroy();
	});
});
