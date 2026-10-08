/**
 * arch-v2 §8.6 F-T3, F-T15, F-T16 — migration attempt vs progress (T5, O79,
 * O24, D-15, D-22, U-5).
 *
 * O79: the migration ATTEMPT is a crash-released platform lock
 * (`navigator.locks`, an in-process mutex where absent); PROGRESS is the
 * appended import row plus the `active` record, written in ONE transaction.
 * No durable lease or owner field exists. `status()` reports `pending` while
 * the lock is held; `migrate({wait: false})` returns `busy` (FP-12).
 *
 * O24 / D-22: `force` goes through restore-definition — hydrate the
 * generation, then one replace transaction that clears every delete mark on
 * each legacy id and rewrites its type, data, placement and content in place
 * — and APPENDS its diff (the store is append-only for every writer). A
 * forced re-migration reproduces the legacy ids; verify compares ids; two
 * devices forcing independently converge without duplicates (F13).
 *
 * Expectations come from the plan rows, the runbook contract
 * (`docs/crdt-v14-migration.md`) and the reader's invariant ("the generation
 * store is append-only for every writer; a completed import is visible iff
 * its row and its `active` record committed together; at most one tab
 * imports a given name at a time, and that exclusivity ends with the tab") —
 * never from engine output.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import * as idb from 'lib0-v14/indexeddb';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Y } from '../../../lib/crdt/engine.js';
import { loadDocument } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { bindMigration } from '../../../lib/crdt/migration/migrate.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy-v13');
const fixture = (name) => ({
	expected: JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')).expected,
	update: new Uint8Array(readFileSync(join(FIXTURE_DIR, `${name}.update.bin`)))
});
const LEGACY = fixture('nested-marks');

const HEADING = 'b_Qs9z29q9tO';
const PARA = 'b_NIq2lE62ps';
const NESTED = 'b_z0UIzQd6UL';
const QUOTE = 'b_EO9q9yh2A6';
const TAIL = 'b_OcAL5sCI6I';
const LEGACY_IDS = [HEADING, PARA, NESTED, QUOTE, TAIL];

const edytorDoc = bindEdytorDoc(Y);
const providers = bindIndexeddbProvider(Y);
/** One "tab": its own binding, sharing the origin's IndexedDB and lock manager. */
const tab = () => bindMigration(Y);

let counter = 0;
const uniqueName = (base) => `t5-${base}-${counter++}`;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const openGeneration = (name) =>
	idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const seedLegacyDb = async (name, rows) => {
	const db = await idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updates] = idb.transact(db, ['updates']);
		for (const row of rows) await idb.addAutoKey(updates, row.slice().buffer);
	} finally {
		db.close();
	}
};

const generationRows = async (name) => {
	const db = await openGeneration(name);
	try {
		const [updates] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updates)).map((r) => new Uint8Array(r));
	} finally {
		db.close();
	}
};

/** The durable migration record exactly as stored (not `status()`'s answer). */
const storedRecord = async (name) => {
	const db = await openGeneration(name);
	try {
		const [custom] = idb.transact(db, ['custom'], 'readonly');
		return await idb.rtop(custom.get('migration'));
	} finally {
		db.close();
	}
};

/** Copy every row and custom record of generation `from` into generation `to` (a device sync). */
const copyGeneration = async (from, to) => {
	const src = await openGeneration(from);
	const dst = await openGeneration(to);
	try {
		const [su, sc] = idb.transact(src, ['updates', 'custom'], 'readonly');
		const rows = await idb.getAll(su);
		const keys = await idb.getAllKeys(sc);
		const values = await idb.getAll(sc);
		const [du, dc] = idb.transact(dst, ['updates', 'custom']);
		for (const row of rows) await idb.addAutoKey(du, row);
		for (let i = 0; i < keys.length; i++) await idb.rtop(dc.put(values[i], keys[i]));
	} finally {
		src.close();
		dst.close();
	}
};

/** Hydrate a fresh doc from a generation through the real provider (a reload / a tab). */
const openTab = async (name) => {
	const doc = new Y.Doc();
	const provider = new providers.IndexeddbPersistence(name, doc);
	await provider.whenSynced;
	return { doc, provider, ed: edytorDoc.create(doc) };
};

const reload = async (name) => {
	const { doc, provider, ed } = await openTab(name);
	const json = ed.toJSON();
	const pending = doc.store.pendingStructs;
	await provider.destroy();
	return { json, pending, doc };
};

const allIds = (json) => {
	const out = [];
	const walk = (bs) =>
		bs.forEach((b) => {
			out.push(b.id);
			walk(b.children ?? []);
		});
	walk(json.children);
	return out;
};

describe('F-T3: migrate → edit → force → reload (6 trials, 2 tabs)', () => {
	for (let trial = 0; trial < 6; trial++) {
		const compacted = trial % 2 === 1;
		it(`trial ${trial} (${compacted ? 'compacted' : 'uncompacted'} edit rows)`, async () => {
			const name = uniqueName(`ft3-${trial}`);
			await seedLegacyDb(name, [LEGACY.update]);
			expect((await tab().migrate(name)).status).toBe('active');

			// Two tabs are open while the user edits.
			const a = await openTab(name);
			const b = await openTab(name);
			a.ed.insertText(TAIL, 0, `EDIT-${trial} `);
			b.ed.insertText(HEADING, 0, `B-${trial} `);
			b.ed.insertBlock({ parent: null, index: 3 }, { id: `new-${trial}`, type: 'paragraph' });
			await settle();
			if (compacted) await providers.storeState(a.provider);
			await a.provider.destroy();
			await b.provider.destroy();

			const forced = await tab().migrate(name, { force: true });
			expect(forced.status).toBe('active');
			expect(forced.json).toEqual(LEGACY.expected);

			// Every tab that reloads sees exactly the legacy materialization,
			// and no stored row is left without its causal base (P3b).
			for (let t = 0; t < 2; t++) {
				const { json, pending } = await reload(name);
				expect(json).toEqual(LEGACY.expected);
				expect(pending).toBeNull();
			}
		});
	}
});

describe('F-T15: force restores legacy ids in place (restore-definition)', () => {
	it('an edit deletes / splits / merges / retypes legacy blocks; force restores every id in place', async () => {
		const name = uniqueName('ft15-one');
		await seedLegacyDb(name, [LEGACY.update]);
		await tab().migrate(name);

		const a = await openTab(name);
		const identity = Object.fromEntries(LEGACY_IDS.map((id) => [id, a.ed.crdtId(id)]));
		expect(Object.values(identity).every((v) => typeof v === 'string')).toBe(true);
		expect(a.ed.deleteBlock(TAIL).status).toBe('applied');
		expect(a.ed.splitBlock(HEADING, 7, 'post-split').status).toBe('applied');
		a.ed.insertText('post-split', 0, 'X');
		expect(a.ed.mergeBlocks(QUOTE, NESTED).status).toBe('applied');
		a.ed.setBlockType(PARA, 'heading');
		a.ed.insertBlock({ parent: null, index: 0 }, { id: 'post-new', type: 'paragraph' });
		await settle();
		await a.provider.destroy();

		const forced = await tab().migrate(name, { force: true });
		expect(forced.status).toBe('active');
		// Verify compares ids: the result carries the legacy ids verbatim.
		expect(allIds(forced.json)).toEqual(allIds(LEGACY.expected));

		const r = await openTab(name);
		expect(r.ed.toJSON()).toEqual(LEGACY.expected);
		expect(r.doc.store.pendingStructs).toBeNull();
		// In place: every legacy id is the SAME registry entry it was before.
		for (const id of LEGACY_IDS) expect(r.ed.crdtId(id)).toBe(identity[id]);
		await r.provider.destroy();
	});

	for (let assignment = 0; assignment < 3; assignment++) {
		it(`two devices force independently, then sync: no duplicate (assignment ${assignment})`, async () => {
			const legacy = uniqueName('ft15-legacy');
			const devA = uniqueName('ft15-devA');
			const devB = uniqueName('ft15-devB');
			await seedLegacyDb(legacy, [LEGACY.update]);
			await tab().migrate(devA, { sourceName: legacy });

			// Device A edits; device B has synced everything A has.
			const a = await openTab(devA);
			a.ed.deleteBlock(TAIL);
			a.ed.splitBlock(HEADING, 3, `split-${assignment}`);
			a.ed.insertText(QUOTE, 0, 'offline ');
			await settle();
			await providers.storeState(a.provider);
			await a.provider.destroy();
			await copyGeneration(devA, devB);

			// Both force independently (order varies with the assignment).
			const order = assignment === 1 ? [devB, devA] : [devA, devB];
			if (assignment === 2) {
				await Promise.all(order.map((n) => tab().migrate(n, { sourceName: legacy, force: true })));
			} else {
				for (const n of order) await tab().migrate(n, { sourceName: legacy, force: true });
			}

			// Then sync: each device receives the other's state (duplicated delivery too).
			const ra = await openTab(devA);
			const rb = await openTab(devB);
			const ua = Y.encodeStateAsUpdate(ra.doc);
			const ub = Y.encodeStateAsUpdate(rb.doc);
			Y.applyUpdate(ra.doc, ub);
			Y.applyUpdate(rb.doc, ua);
			Y.applyUpdate(rb.doc, ua);
			for (const r of [ra, rb]) {
				const json = r.ed.toJSON();
				expect(json).toEqual(LEGACY.expected);
				expect(new Set(allIds(json)).size).toBe(allIds(json).length);
				expect(r.doc.store.pendingStructs).toBeNull();
			}
			await ra.provider.destroy();
			await rb.provider.destroy();
		});
	}
});

describe('F-T15 bridge: a live document receives the forced restore', () => {
	it('an open, edited document that applies the forced state renders the legacy materialization', async () => {
		const name = uniqueName('bridge');
		await seedLegacyDb(name, [LEGACY.update]);
		const first = await tab().migrate(name);
		const live = loadDocument(first.update);
		live.facade.deleteBlock(TAIL);
		live.facade.splitBlock(HEADING, 4, 'live-split');
		live.facade.insertText(QUOTE, 0, 'live ');
		// The edits reach the generation as a provider would store them.
		const db = await openGeneration(name);
		const [updates] = idb.transact(db, ['updates']);
		await idb.addAutoKey(updates, Y.encodeStateAsUpdate(live.doc).slice().buffer);
		db.close();

		const forced = await tab().migrate(name, { force: true });
		Y.applyUpdate(live.doc, forced.update);
		expect(live.facade.toJSON()).toEqual(LEGACY.expected);
		live.destroy();
	});
});

/** Hold a migration inside its attempt until `release()` — a tab mid-import. */
const heldMigration = (name, migration = tab()) => {
	let release;
	const gate = new Promise((r) => (release = r));
	let entered;
	const inside = new Promise((r) => (entered = r));
	const done = migration.migrate(name, {
		onPhase: async (p) => {
			if (p === 'read') {
				entered();
				await gate;
			}
		}
	});
	return { done, inside, release };
};

describe('F-T16: status() and wait:false while another tab holds the attempt', () => {
	it('a second tab reads pending and gets busy; the first activates; the waiter sees it', async () => {
		const name = uniqueName('ft16');
		await seedLegacyDb(name, [LEGACY.update]);
		const first = heldMigration(name);
		await first.inside;

		const second = tab();
		expect((await second.status(name)).status).toBe('pending');
		expect((await second.migrate(name, { wait: false })).status).toBe('busy');
		const waiting = second.migrate(name);

		first.release();
		expect((await first.done).status).toBe('active');
		expect(await waiting).toMatchObject({ status: 'active', alreadyActive: true });
		expect((await second.status(name)).status).toBe('active');
		expect((await generationRows(name)).length).toBe(1);
	});
});

describe('attempt vs progress (O79): no lease, no owner, atomic progress', () => {
	it('the durable record never carries a lease or an owner, and is never "pending"', async () => {
		const name = uniqueName('no-lease');
		await seedLegacyDb(name, [LEGACY.update]);
		const held = heldMigration(name);
		await held.inside;
		// Mid-attempt: the attempt is the lock, not a durable record.
		const during = await storedRecord(name);
		expect(during?.status).not.toBe('pending');
		held.release();
		await held.done;
		const after = await storedRecord(name);
		expect(after.status).toBe('active');
		expect(after).not.toHaveProperty('owner');
		expect(after).not.toHaveProperty('leaseUntil');
	});

	it('a crashed attempt never blocks the next one (the exclusivity ends with the attempt)', async () => {
		const name = uniqueName('crash');
		await seedLegacyDb(name, [LEGACY.update]);
		await expect(
			tab().migrate(name, {
				onPhase: (p) => {
					if (p === 'verify') throw new Error('simulated crash');
				}
			})
		).rejects.toThrow('simulated crash');
		expect((await tab().status(name)).status).not.toBe('pending');
		expect((await generationRows(name)).length).toBe(0);

		// No lease to wait out: the next attempt runs at once.
		const next = await Promise.race([
			tab().migrate(name),
			settle(1500).then(() => ({ status: 'timed out' }))
		]);
		expect(next.status).toBe('active');
		expect((await generationRows(name)).length).toBe(1);
	});

	it('the import row and the active record commit together (a failed record write leaves no row)', async () => {
		const name = uniqueName('atomic');
		await seedLegacyDb(name, [LEGACY.update]);
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value, key) {
			if (key === 'migration' && value?.status === 'active') throw new Error('record write failed');
			return put.call(this, value, key);
		};
		try {
			await tab()
				.migrate(name)
				.catch(() => undefined);
		} finally {
			IDBObjectStore.prototype.put = put;
		}
		await settle();
		expect((await tab().status(name)).status).not.toBe('active');
		expect((await generationRows(name)).length).toBe(0);

		expect((await tab().migrate(name)).status).toBe('active');
		expect((await generationRows(name)).length).toBe(1);
	});

	it('force appends: every row a provider stored before it survives', async () => {
		const name = uniqueName('append');
		await seedLegacyDb(name, [LEGACY.update]);
		await tab().migrate(name);
		const a = await openTab(name);
		a.ed.insertText(TAIL, 0, 'kept row ');
		await settle();
		await a.provider.destroy();
		const before = await generationRows(name);

		await tab().migrate(name, { force: true });
		const after = await generationRows(name);
		expect(after.length).toBe(before.length + 1);
		after.slice(0, before.length).forEach((row, i) => expect(row).toEqual(before[i]));
	});
});

describe('U-5: in-process fallback where navigator.locks is absent', () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	const withoutLocks = () =>
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { userAgent: 'node-without-locks' }
		});
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, 'navigator', original);
	});

	it('F-T16 holds under the fallback', async () => {
		withoutLocks();
		const name = uniqueName('u5-ft16');
		await seedLegacyDb(name, [LEGACY.update]);
		const first = heldMigration(name);
		await first.inside;
		const second = tab();
		expect((await second.status(name)).status).toBe('pending');
		expect((await second.migrate(name, { wait: false })).status).toBe('busy');
		first.release();
		expect((await first.done).status).toBe('active');
	});

	it('concurrent migrators under the fallback: one import, one alreadyActive, one row', async () => {
		withoutLocks();
		const name = uniqueName('u5-race');
		await seedLegacyDb(name, [LEGACY.update]);
		const results = await Promise.all([tab().migrate(name), tab().migrate(name)]);
		expect(results.map((r) => (r.alreadyActive ? 'already' : r.status)).sort()).toEqual([
			'active',
			'already'
		]);
		expect((await generationRows(name)).length).toBe(1);
	});
});
