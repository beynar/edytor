/**
 * Migration probes (D23) — the read paths must not create state and must
 * not hang on failure.
 *
 * - `status(name)` on a never-migrated name resolves `{status:'none'}`
 *   and leaves NO phantom `edytor-v14:<name>` database behind — a
 *   store-less shell would poison a later provider open (store creation
 *   only runs inside `onupgradeneeded`).
 * - `waitForSettled` settles when the generation open itself fails — the
 *   poller it replaced once hung forever there (open had no rejection
 *   branch). T5: it waits for the attempt lock, then reads the record.
 * - The legacy read runs inside ONE readonly transaction — the fence that
 *   makes the snapshot atomic against a still-moving v13 writer.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindMigration } from '../../../lib/crdt/migration/migrate.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';

const migration = bindMigration(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;

const openGenerationDb = (name) =>
	idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

describe('migration status() probe (D23)', () => {
	test('status on a fresh name resolves none and creates no phantom DB', async () => {
		const name = uniqueName('status-fresh');
		const rec = await migration.status(name);
		expect(rec).toEqual({ v: 1, status: 'none' });

		// The probe must not leave `edytor-v14:<name>` behind.
		const infos = await indexedDB.databases();
		expect(infos.some((i) => i.name === generationDbName(name))).toBe(false);
	});

	test('status reads an existing generation record', async () => {
		const name = uniqueName('status-existing');
		const db = await openGenerationDb(name);
		try {
			const [custom] = idb.transact(db, ['custom']);
			await idb.rtop(custom.put({ v: 1, status: 'active', migratedAt: 1234 }, 'migration'));
		} finally {
			db.close();
		}
		const rec = await migration.status(name);
		expect(rec.status).toBe('active');
		expect(rec.migratedAt).toBe(1234);
	});

	test('status on a generation DB without a custom store resolves none', async () => {
		const name = uniqueName('status-shell');
		// A store-less shell at the generation name — what a creating probe
		// would have left behind. status() must treat it as absent.
		const db = await idb.openDB(generationDbName(name), () => {});
		db.close();
		const rec = await migration.status(name);
		expect(rec).toEqual({ v: 1, status: 'none' });
	});
});

describe('waitForSettled open failure (D23)', () => {
	test('a failed generation open settles instead of hanging', async () => {
		const name = uniqueName('wait-open-fail');
		// The generation exists, so the non-creating probe must open it.
		(await openGenerationDb(name)).close();
		const original = indexedDB.open;
		// Force every open to fail — the rejection must reach the waiter, not dangle.
		indexedDB.open = () => {
			const req = {};
			setTimeout(() => {
				req.error = new Error('forced open failure');
				req.onerror?.({ target: req });
			});
			return req;
		};
		try {
			await expect(migration.waitForSettled(name)).rejects.toThrow('forced open failure');
		} finally {
			indexedDB.open = original;
		}
	});

	test('a settled active record resolves immediately', async () => {
		const name = uniqueName('wait-active');
		const db = await openGenerationDb(name);
		try {
			const [custom] = idb.transact(db, ['custom']);
			await idb.rtop(custom.put({ v: 1, status: 'active' }, 'migration'));
		} finally {
			db.close();
		}
		const rec = await migration.waitForSettled(name);
		expect(rec.status).toBe('active');
	});
});
