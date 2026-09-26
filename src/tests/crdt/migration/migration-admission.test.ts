/**
 * U8 — migration output feeds the same document-admission path.
 *
 * `migrate()` produces a v14 update (`result.update`, byte-identical to
 * the persisted generation row); restoring it MUST go through
 * `loadDocument` — the same staged gate every load crosses — and land
 * `hydrated` with clean history. A raw v13 payload offered to the load
 * path refuses as `legacy` (route to `migrate`), and the legacy DB is
 * never touched by either direction.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, loadDocument, UnsupportedDocError } from '../../../lib/crdt/index.js';
import { bindMigration } from '../../../lib/crdt/migration/migrate.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineDoc, YDoc } from '../../../lib/crdt/engine-api.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy-v13');

const readFixture = (name: string) => ({
	sidecar: JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as {
		expected: unknown;
	},
	update: new Uint8Array(readFileSync(join(FIXTURE_DIR, `${name}.update.bin`)))
});

const migration = bindMigration(Y);
const edytorDoc = bindEdytorDoc(Y);

let counter = 0;
const uniqueName = (base: string) => `${base}-${counter++}`;

const seedLegacyDb = async (name: string, rows: Uint8Array[]) => {
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

const legacyRows = async (name: string): Promise<Uint8Array[]> => {
	const db = await idb.openDB(name, () => {});
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updatesStore)).map((row) => new Uint8Array(row as ArrayBuffer));
	} finally {
		db.close();
	}
};

describe('migrate → loadDocument (the same admission path)', () => {
	test('the migrated snapshot restores as a hydrated document with clean history', async () => {
		const name = uniqueName('mig-load');
		const { sidecar, update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);

		const result = await migration.migrate(name);
		expect(result.status).toBe('active');
		expect(result.update).toBeDefined();

		// The same load path every restore crosses — staged admission,
		// hydrated readiness, bootstrap/hydration writes excluded from undo.
		const document = loadDocument(result.update!);
		expect(document.readiness).toBe('hydrated');
		expect(document.facade.toJSON()).toEqual(result.json);
		expect(document.facade.toJSON()).toEqual(sidecar.expected);
		expect(document.history.undoStack).toHaveLength(0);
		document.destroy();

		// The legacy DB is byte-identical — migration never rewrites it.
		expect(await legacyRows(name)).toEqual([update]);
	});

	test('the migrated doc attaches → sync() hydrates it', async () => {
		const name = uniqueName('mig-attach');
		const { update } = readFixture('nested-marks');
		await seedLegacyDb(name, [update]);

		const result = await migration.migrate(name);
		expect(result.status).toBe('active');
		expect(result.doc).toBeDefined();

		const document = attachDocument(result.doc!);
		expect(document.readiness).toBe('pending');
		document.sync();
		expect(document.readiness).toBe('hydrated');
		expect(document.facade.toJSON()).toEqual(result.json);
		expect(document.history.undoStack).toHaveLength(0);
		document.destroy();
		(result.doc as YDoc).destroy();
	});

	test('a raw v13 payload refuses the load path as legacy', () => {
		const { update } = readFixture('nested-marks');
		expect(() => loadDocument(update)).toThrowError(UnsupportedDocError);
		try {
			loadDocument(update);
		} catch (error) {
			expect((error as UnsupportedDocError).kind).toBe('legacy');
		}
	});

	test('a failed migration leaves nothing for the load path to pick up', async () => {
		const name = uniqueName('mig-fail');
		const foreign = new Y.Doc();
		foreign.get('otherRoot').setAttr('x', 1);
		await seedLegacyDb(name, [Y.encodeStateAsUpdate(foreign)]);

		const result = await migration.migrate(name);
		expect(result.status).toBe('failed');
		expect(result.update).toBeUndefined();
		// The generation holds no activated output — nothing to load.
		const db = await idb.openDB(generationDbName(name), (db) =>
			idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
		);
		try {
			const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
			expect(await idb.count(updatesStore)).toBe(0);
		} finally {
			db.close();
		}
		// And the failed migration's source rows are untouched.
		expect((await legacyRows(name)).length).toBe(1);
	});
});

describe('migrated doc — admission verdict', () => {
	test('the rebuilt doc inspects as initialized (no foreign residue)', async () => {
		const name = uniqueName('mig-verdict');
		const { update } = readFixture('inline-mentions');
		await seedLegacyDb(name, [update]);
		const { doc } = await migration.migrate(name);
		expect(doc).toBeDefined();
		expect(edytorDoc.isInitialized(doc as unknown as EngineDoc)).toBe(true);
		expect(edytorDoc.checkSchema(doc as unknown as EngineDoc)).toBeNull();
	});
});
