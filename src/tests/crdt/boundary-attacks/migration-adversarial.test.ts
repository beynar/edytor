/**
 * GATE-2 attack probes — migration (attack item 3).
 *
 * Adversarial cases the CO01–CO03 suite does NOT cover:
 *
 * - Rows whose CRDT deps are MISSING (a peer's update never reached this
 *   browser's IndexedDB before cutover) — does the materializer detect the
 *   pending structs, or silently drop the content?
 * - `migrate()` racing a live v14 provider that already wrote rows into the
 *   generation — `persist` clears the whole `updates` store.
 * - A legacy block without an `id` — `blockToSpec` has a `mig-` fallback,
 *   but `verify` compares produced-vs-expected JSON.
 * - `migrate()` on a name whose legacy DB never existed creates an empty
 *   legacy DB — does that poison a later v13 provider open?
 * - A second caller while the first attempt is still alive (T5: the
 *   attempt is a lock, so the second queues — there is no lease to expire
 *   and no reclaim race).
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as Y13 from 'yjs';
import { bindMigration } from '../../../lib/crdt/migration/migrate.js';
import { bindLegacyReader } from '../../../lib/crdt/migration/legacy-schema.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';

const migration = bindMigration(Y);
const reader = bindLegacyReader(Y);
const providers = bindIndexeddbProvider(Y);
const edytorDoc = bindEdytorDoc(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;
const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Build a minimal v13 Edytor-schema block map (children + content arrays). */
const v13Block = (doc13, { id, type = 'paragraph', text = '', data = {} } = {}) => {
	const b = new Y13.Map();
	b.set('type', type);
	if (id !== undefined) b.set('id', id);
	b.set('data', data);
	const children = new Y13.Array();
	b.set('children', children);
	const content = new Y13.Array();
	b.set('content', content);
	if (text.length > 0) {
		const t = new Y13.Text();
		t.insert(0, text);
		content.push([t]);
	}
	return b;
};

/** Initialize the v13 root: content map + children + content arrays. */
const v13Doc = (blocks = []) => {
	const doc = new Y13.Doc();
	const root = doc.getMap('content');
	root.set('id', 'root');
	root.set('type', 'root');
	root.set('data', {});
	const children = new Y13.Array();
	root.set('children', children);
	root.set('content', new Y13.Array());
	for (const b of blocks) children.push([b]);
	doc.getText('INITIALIZED'); // v13 init marker
	return doc;
};

const seedLegacyDb = async (name, rows) => {
	const db = await idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updatesStore] = idb.transact(db, ['updates']);
		for (const row of rows) {
			const copy = new Uint8Array(row.byteLength);
			copy.set(row);
			await idb.addAutoKey(updatesStore, copy.buffer);
		}
	} finally {
		db.close();
	}
};

const generationRows = async (name) => {
	const db = await idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return await idb.getAll(updatesStore);
	} finally {
		db.close();
	}
};

describe('pending-dep loss: rows with missing CRDT deps are dropped silently', () => {
	test('an update whose deps never landed migrates as "active" — content silently lost', async () => {
		const name = uniqueName('mig-pending');
		// A: the canonical base document — the shared root + one block.
		const docA = v13Doc([v13Block(undefined, { id: 'b_A', text: 'a-content' })]);
		const updateA = Y13.encodeStateAsUpdate(docA);
		const svA = Y13.encodeStateVector(docA);

		// X: receives the base, inserts its OWN block into the shared
		// children array (deps on A's array item).
		const docX = new Y13.Doc();
		Y13.applyUpdate(docX, updateA);
		docX
			.getMap('content')
			.get('children')
			.push([v13Block(undefined, { id: 'b_X', text: 'x-content' })]);
		const updateXDelta = Y13.encodeStateAsUpdate(docX, svA);

		// B: receives base + X's update, then types INSIDE X's block — the
		// insert's left-dep is an X item → pends when updateXDelta is absent.
		const docB = new Y13.Doc();
		Y13.applyUpdate(docB, updateA);
		Y13.applyUpdate(docB, updateXDelta);
		const svBeforeEdit = Y13.encodeStateVector(docB);
		const children13 = docB.getMap('content').get('children');
		let xText = null;
		for (let i = 0; i < children13.length; i++) {
			const blk = children13.get(i);
			if (blk.get('id') === 'b_X') xText = blk.get('content').get(0);
		}
		expect(xText).not.toBeNull();
		xText.insert(xText.length, ' + B typed here');
		const updateBDelta = Y13.encodeStateAsUpdate(docB, svBeforeEdit);

		// The legacy store holds the base + B's delta — but X's update was
		// never persisted (crashed/lost before write). B's delta depends on
		// structs that are absent → its items sit in pendingStructs forever.
		await seedLegacyDb(name, [updateA, updateBDelta]);

		// Prove the pending state exists: applying the stored rows to a
		// scratch v13 doc leaves un-integratable structs behind — the exact
		// rows the migrator is about to read without inspection.
		const scratch = new Y13.Doc();
		Y13.applyUpdate(scratch, updateA);
		Y13.applyUpdate(scratch, updateBDelta);
		expect(scratch.store.pendingStructs).not.toBeNull();
		expect(JSON.stringify(scratch.toJSON())).not.toContain('B typed here');
		expect(JSON.stringify(scratch.toJSON())).not.toContain('x-content');

		const result = await migration.migrate(name);
		const rows = await generationRows(name);
		console.log(
			`[gate2] pending-deps: status=${result.status} rows=${rows.length} json=${JSON.stringify(result.json)}`
		);
		// CONTRACT: the migrator must not silently activate with truncated
		// content. Acceptable fixes: fail closed (non-'active' status), or
		// carry the pending row bytes into the generation so the structs can
		// still integrate when the missing deps finally sync. Either way the
		// offline intent survives — today it does neither.
		const carriesPendingRow = rows.some(
			(r) => new Uint8Array(r).join(',') === updateBDelta.join(',')
		);
		expect(result.status !== 'active' || carriesPendingRow).toBe(true);
	});
});

describe('migrate() against a live v14 generation', () => {
	test('a provider that already wrote v14 rows loses them to persist.clear()', async () => {
		const name = uniqueName('mig-live');
		// Legacy v13 data exists (real pre-cutover doc).
		const doc13 = v13Doc([v13Block(undefined, { id: 'b_legacy', text: 'legacy text' })]);
		await seedLegacyDb(name, [Y13.encodeStateAsUpdate(doc13)]);

		// Meanwhile a v14 provider already opened the generation and stored
		// live v14 edits (e.g. cutover shipped, then a late migration ran).
		const liveDoc = new Y.Doc();
		const ed = edytorDoc.create(liveDoc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, liveDoc);
		await p.whenSynced;
		ed.insertText(ed.childrenIds(null)[0], 0, 'LIVE-V14-EDIT');
		await nextTick(50); // let _storeUpdate's idb write land
		const preRows = await generationRows(name);
		expect(preRows.length).toBeGreaterThan(0);

		const result = await migration.migrate(name);
		expect(result.status).toBe('active');

		// The provider's own in-memory doc still has the live edit…
		expect(JSON.stringify(ed.toJSON())).toContain('LIVE-V14-EDIT');
		// …and the provider's NEXT write lands in the store AFTER the
		// migrated snapshot — but references the wiped structs.
		ed.insertText(ed.childrenIds(null)[0], 0, 'POST-MIGRATION');
		await nextTick(50);
		// Kill the live provider so BC can't resurrect the wiped state —
		// what survives must come from stored rows alone.
		await p.destroy();

		const docReload = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, docReload);
		await p2.whenSynced;
		const reloaded = JSON.stringify(edytorDoc.create(docReload).toJSON());
		expect(reloaded).toContain('legacy text');
		// CONTRACT: migrate() must not clear a generation that already holds
		// live v14 rows — it should refuse or treat the generation as
		// already-active. Today persist.clear() wipes the provider's rows and
		// the provider's next write orphans (its deps were wiped).
		expect(reloaded).toContain('LIVE-V14-EDIT'); // ← fails: wiped by clear()
		expect(reloaded).toContain('POST-MIGRATION'); // ← fails: orphan row can never integrate
		await p2.destroy();
	});
});

describe('verify dead-ends: the `mig-` id fallback can never pass verify', () => {
	test('a legacy block without an id fails migration permanently', async () => {
		const name = uniqueName('mig-noid');
		// Legacy doc with an id-less block — producible by JSON import paths
		// that never assigned ids.
		const doc13 = v13Doc([v13Block(undefined, { text: 'no id here' })]);
		await seedLegacyDb(name, [Y13.encodeStateAsUpdate(doc13)]);

		const result = await migration.migrate(name);
		// CONTRACT: an id-less legacy block must still migrate — the `mig-`
		// fallback exists precisely for this case. Today verify compares
		// produced (id:'mig-0') vs expected (no id) → permanent 'failed' →
		// the doc is unmigratable and every retry fails identically. Fix:
		// normalize expected JSON with the same fallback ids.
		expect(result.status).toBe('active'); // ← fails: verify dead-end
		expect(result.json?.children?.[0]?.id).toMatch(/^mig-/);
	});
});

describe('legacy-DB poisoning by the migrator', () => {
	test('migrate on a never-existing name leaves a store-less legacy DB behind', async () => {
		const name = uniqueName('mig-poison');
		const result = await migration.migrate(name);
		expect(result.status).toBe('active');
		expect(result.empty).toBe(true);

		// CONTRACT: migrate() must not leave a poisoned legacy DB behind. It
		// opened `<name>` with idb.openDB(sourceName, () => {}) — creating an
		// EMPTY v1 database with no object stores. A v13 y-indexeddb provider
		// opening `<name>` later gets this DB back (lib0 openDB passes no
		// version → no onupgradeneeded → its `updates`/`custom` stores are
		// never created) → every transaction throws NotFoundError. Probe the
		// v13 provider's own open pattern: it must find its stores.
		const v13Open = await idb.openDB(name, (db) =>
			idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
		);
		expect(v13Open.objectStoreNames.contains('updates')).toBe(true); // ← fails: poisoned
		expect(v13Open.objectStoreNames.contains('custom')).toBe(true);
		v13Open.close();
	});
});

describe('a second caller while the first attempt is still alive', () => {
	test('the second queues behind a slow first attempt; both finish active with one row', async () => {
		const name = uniqueName('mig-slow');
		const doc13 = v13Doc([v13Block(undefined, { id: 'b1', text: 'owned' })]);
		await seedLegacyDb(name, [Y13.encodeStateAsUpdate(doc13)]);

		// Owner A is slow inside its attempt.
		const a = migration.migrate(name, {
			onPhase: async (p) => {
				if (p === 'persist') await nextTick(60);
			}
		});
		await nextTick(20);
		const b = migration.migrate(name);

		const [ra, rb] = await Promise.all([a, b]);
		// Whatever the interleaving, exactly one import row must survive.
		const rows = await generationRows(name);
		expect(rows.length).toBe(1);
		expect(ra).toMatchObject({ status: 'active' });
		expect(rb).toMatchObject({ status: 'active', alreadyActive: true });
	});
});

describe('rollback readability', () => {
	test('after rollback a v14 provider opens an empty-but-valid generation; legacy intact', async () => {
		const name = uniqueName('mig-rb2');
		const doc13 = v13Doc([v13Block(undefined, { id: 'b1', text: 'kept' })]);
		const update13 = Y13.encodeStateAsUpdate(doc13);
		await seedLegacyDb(name, [update13]);
		await migration.migrate(name);
		await migration.rollback(name);

		expect((await migration.status(name)).status).toBe('rolledback');
		// The v14 generation still passes the provider's storage gate
		// (generation record remains) but hydrates ZERO rows — an
		// empty-looking doc. The record, not the provider, carries the
		// rollback signal — a consumer that skips `status()` sees "empty".
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(edytorDoc.create(doc).toJSON()).toEqual({ children: [] });
		await p.destroy();

		// Legacy rows are byte-identical — v13 can resume on its own data.
		const dbLegacy = await idb.openDB(name, () => {});
		const [store] = idb.transact(dbLegacy, ['updates'], 'readonly');
		const rows = await idb.getAll(store);
		dbLegacy.close();
		expect(new Uint8Array(rows[0])).toEqual(update13);
	});
});
