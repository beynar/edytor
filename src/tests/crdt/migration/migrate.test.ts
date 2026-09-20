/**
 * CO01–CO03 — v13 → v14 persistence migration evidence.
 *
 * - CO01: legacy binary decoding is tested separately from schema
 *   conversion — the recorded v13 fixture updates materialize into the
 *   exact logical JSONDoc the v13 sidecars pinned, including the
 *   offline-peer pending update.
 * - CO02: end-to-end migration — legacy rows are read from the legacy DB,
 *   converted, verified, persisted into the v14 generation as one snapshot,
 *   and activated; a v14 provider then hydrates the migrated document.
 *   The legacy DB is never written or deleted (rollback surface).
 * - CO03: arbitration + interruption — concurrent callers produce one
 *   winner; a crashed claim (onPhase throw) is resumed via lease expiry;
 *   re-runs are idempotent; rollback is explicit and non-destructive.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindMigration } from '../../../lib/crdt/migration/migrate.js';
import { bindLegacyReader } from '../../../lib/crdt/migration/legacy-schema.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy-v13');

const readFixture = (name) => ({
	sidecar: JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')),
	update: new Uint8Array(readFileSync(join(FIXTURE_DIR, `${name}.update.bin`))),
	pendingPath: join(FIXTURE_DIR, `${name}.pending.update.bin`)
});

const migration = bindMigration(Y);
const reader = bindLegacyReader(Y);
const providers = bindIndexeddbProvider(Y);
const edytorDoc = bindEdytorDoc(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;

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

const legacyRows = async (name) => {
	const db = await idb.openDB(name, () => {});
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return await idb.getAll(updatesStore);
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

describe('CO01: legacy binary decoding (separate from schema conversion)', () => {
	test('each fixture update materializes the pinned logical JSON', () => {
		for (const name of ['nested-marks', 'inline-mentions', 'tombstones', 'offline-peer']) {
			const { sidecar, update } = readFixture(name);
			expect(reader.readLegacyJSON([update])).toEqual(sidecar.expected);
		}
	});

	test('offline-peer pending update applies incrementally after the base', () => {
		const { sidecar, update, pendingPath } = readFixture('offline-peer');
		const pending = new Uint8Array(readFileSync(pendingPath));
		// Base + pending rows decode to the merged logical doc — the same
		// reading a v13 client would produce after the peer reconnects.
		expect(reader.readLegacyJSON([update, pending])).toEqual(sidecar.pending.expectedAfterPending);
	});

	test('a non-legacy document is rejected by the reader', () => {
		const foreign = new Y.Doc();
		foreign.get('someOtherRoot').setAttr('x', 1);
		expect(() => reader.readLegacyJSON([Y.encodeStateAsUpdate(foreign)])).toThrow(
			/Not a legacy v13 Edytor document/
		);
	});
});

describe('CO02: end-to-end migration', () => {
	test('migrates a legacy DB into the v14 generation; legacy stays intact', async () => {
		const name = uniqueName('mig-e2e');
		const { sidecar, update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);

		const result = await migration.migrate(name);
		expect(result.status).toBe('active');
		expect(result.sourceRows).toBe(1);
		expect(result.json).toEqual(sidecar.expected);

		// The generation holds exactly one snapshot row and an active record.
		const rows = await generationRows(name);
		expect(rows.length).toBe(1);
		expect((await migration.status(name)).status).toBe('active');

		// A real v14 provider hydrates the migrated document.
		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(edytorDoc.create(doc).toJSON()).toEqual(sidecar.expected);
		await p.destroy();

		// The legacy DB is untouched — identical row bytes, still present.
		const rowsLegacy = await legacyRows(name);
		expect(rowsLegacy.length).toBe(1);
		expect(new Uint8Array(rowsLegacy[0])).toEqual(update);
	});

	test('logical ids survive; CRDT identity does not (fresh doc)', async () => {
		const name = uniqueName('mig-ids');
		const { update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);
		const { doc } = await migration.migrate(name);

		const json = edytorDoc.create(doc).toJSON();
		// Logical block ids (`b_*`) are data and survive verbatim.
		expect(json.children[0].id).toBe('b_Qs9z29q9tO');
		// The migrated doc is a fresh document — its state vector contains a
		// single new client, not the v13 source client.
		expect(doc.store.clients.size).toBe(1);
		expect(doc.clientID).not.toBe(97606470);
	});

	test('empty/missing legacy DB activates an empty generation', async () => {
		const name = uniqueName('mig-empty');
		const result = await migration.migrate(name);
		expect(result).toMatchObject({ status: 'active', empty: true, sourceRows: 0 });
		expect((await migration.status(name)).status).toBe('active');
	});

	test('a foreign (non-Edytor) legacy DB fails the migration record', async () => {
		const name = uniqueName('mig-foreign');
		const foreign = new Y.Doc();
		foreign.get('otherRoot').setAttr('x', 1);
		await seedLegacyDb(name, [Y.encodeStateAsUpdate(foreign)]);

		const result = await migration.migrate(name);
		expect(result.status).toBe('failed');
		expect((await migration.status(name)).error).toMatch(/legacy decode failed/);
		// The generation holds no applied content.
		expect((await generationRows(name)).length).toBe(0);
	});
});

describe('CO03: arbitration, interruption, rollback', () => {
	test('concurrent migrators: one winner, one alreadyActive, one row', async () => {
		const name = uniqueName('mig-race');
		const { update } = readFixture('tombstones');
		await seedLegacyDb(name, [update]);

		const [r1, r2] = await Promise.all([
			migration.migrate(name, { owner: 'tab-A' }),
			migration.migrate(name, { owner: 'tab-B' })
		]);
		const statuses = [r1, r2].map((r) => (r.alreadyActive ? 'already' : r.status)).sort();
		expect(statuses).toEqual(['active', 'already']);
		// Exactly one snapshot row — no duplicate migrated documents.
		expect((await generationRows(name)).length).toBe(1);
	});

	test('a second call is a no-op (idempotent)', async () => {
		const name = uniqueName('mig-idem');
		const { update } = readFixture('tombstones');
		await seedLegacyDb(name, [update]);
		await migration.migrate(name);
		const rowsFirst = await generationRows(name);

		const again = await migration.migrate(name);
		expect(again).toMatchObject({ status: 'active', alreadyActive: true });
		expect(await generationRows(name)).toEqual(rowsFirst);
	});

	test('crash before persist resumes cleanly (no duplicate, no partial)', async () => {
		const name = uniqueName('mig-crash-pre');
		const { sidecar, update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);

		// First call "crashes" when the persist phase starts.
		await expect(
			migration.migrate(name, {
				owner: 'crasher',
				leaseMs: 30,
				onPhase: (p) => {
					if (p === 'persist') throw new Error('simulated crash');
				}
			})
		).rejects.toThrow('simulated crash');
		expect((await migration.status(name)).status).toBe('pending');
		expect((await generationRows(name)).length).toBe(0);

		// Resume after the stale lease expires — the full flow re-runs.
		const result = await migration.migrate(name, { leaseMs: 30, waitMs: 2000, pollMs: 20 });
		expect(result.status).toBe('active');
		expect(result.json).toEqual(sidecar.expected);
		expect((await generationRows(name)).length).toBe(1);
	});

	test('crash after persist but before activate resumes identically', async () => {
		const name = uniqueName('mig-crash-post');
		const { sidecar, update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);

		await expect(
			migration.migrate(name, {
				owner: 'crasher',
				leaseMs: 30,
				onPhase: (p) => {
					if (p === 'activate') throw new Error('simulated crash');
				}
			})
		).rejects.toThrow('simulated crash');
		// Snapshot persisted but never activated — the generation is not live.
		expect((await migration.status(name)).status).toBe('pending');
		expect((await generationRows(name)).length).toBe(1);

		const result = await migration.migrate(name, { leaseMs: 30, waitMs: 2000, pollMs: 20 });
		expect(result.status).toBe('active');
		expect(result.json).toEqual(sidecar.expected);
		// Re-run rewrote the single row — still exactly one.
		expect((await generationRows(name)).length).toBe(1);
	});

	test('rollback marks the generation and preserves the legacy DB', async () => {
		const name = uniqueName('mig-rb');
		const { update } = readFixture('tombstones');
		await seedLegacyDb(name, [update]);
		await migration.migrate(name);

		await migration.rollback(name);
		expect((await migration.status(name)).status).toBe('rolledback');
		expect((await generationRows(name)).length).toBe(0);
		expect((await legacyRows(name)).length).toBe(1); // legacy intact

		// Rolled-back is explicit: a plain migrate does not silently re-run.
		const refused = await migration.migrate(name);
		expect(refused.status).toBe('rolledback');
		// …but an operator can force a fresh import.
		const forced = await migration.migrate(name, { force: true });
		expect(forced.status).toBe('active');
	});

	test('busy result when a live claim is held and wait=false', async () => {
		const name = uniqueName('mig-busy');
		const { update } = readFixture('tombstones');
		await seedLegacyDb(name, [update]);
		// Simulate a live foreign claim.
		const db = await idb.openDB(generationDbName(name), (db) =>
			idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
		);
		const [custom] = idb.transact(db, ['custom']);
		await idb.rtop(
			custom.put(
				{ v: 1, status: 'pending', owner: 'other-tab', leaseUntil: Date.now() + 60_000 },
				'migration'
			)
		);
		db.close();

		const result = await migration.migrate(name, { wait: false });
		expect(result.status).toBe('busy');
	});
});
