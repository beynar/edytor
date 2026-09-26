/**
 * HARDENING U0 / R2 — refused IndexedDB rows deleted during compaction
 * (review `docs/crdt-v14-follow-up-review-2026-09-21.md` §R2, P1).
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
// @ts-nocheck -- exercises private provider fields on purpose.
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc, BOOTSTRAP_BLOCK_ID } from '../../../lib/crdt/edytor-doc.js';
import * as idb from 'lib0-v14/indexeddb';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';

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

describe('R2 — compaction must not delete refused rows', () => {
	test('explicit storeState() keeps the refused v99 row byte-for-byte', async () => {
		const name = `h-r2-explicit-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await expect(p.whenSynced).rejects.toThrow(/unsupported/i);
		expect(p._hydrationRefused).not.toBeNull();

		const before = await readRows(name);
		expect(hasRow(before, v99)).toBe(true); // hydration alone is non-destructive

		await providers.storeState(p);
		// The API now settles post-commit; poll anyway to also catch any
		// late async delete the implementation might still schedule.
		let after = before;
		for (let i = 0; i < 50; i++) {
			await sleep(20);
			after = await readRows(name);
			if (after.length !== before.length) break;
		}
		// Pre-fix: after = [{key:3, len:2}] — the compacted snapshot only;
		// the refused v99 row was deleted. Fixed: still present.
		expect(hasRow(after, v99)).toBe(true);
		await p.destroy();
	});

	test('timed compaction (_dbsize >= PREFERRED_TRIM_SIZE) keeps the refused row', async () => {
		const name = `h-r2-timed-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await expect(p.whenSynced).rejects.toThrow(/unsupported/i);

		// The refused doc still accepts LOCAL writes — each one bumps `_dbsize`
		// synchronously in _storeUpdate; crossing PREFERRED_TRIM_SIZE schedules
		// the debounced compaction. (Refused rows cannot be re-applied as
		// updates — the schema gate rejects them — so this is the only way to
		// reach the threshold.)
		for (let i = 0; i < providers.PREFERRED_TRIM_SIZE + 5; i++) {
			doc.transact(() => doc.get('scratch').setAttr(`k${i}`, i));
		}
		expect(p._dbsize).toBeGreaterThanOrEqual(providers.PREFERRED_TRIM_SIZE);

		// _storeTimeout debounce is 1000ms.
		await sleep(1600);
		const after = await readRows(name);
		// Pre-fix: [{key:508, len:9434}] — everything compacted, v99 row
		// gone. Fixed: the refused row survives the timed path.
		expect(hasRow(after, v99)).toBe(true);
		await p.destroy();
	});

	test('mixed valid + refused rows: valid row applies, refused row survives compaction', async () => {
		const name = `h-r2-mixed-${Date.now()}`;
		// A fully valid update from a v1 doc — hydrates cleanly.
		const validDoc = new Y.Doc();
		validDoc.clientID = 7777;
		const ev = E.create(validDoc);
		ev.init();
		ev.insertText(BOOTSTRAP_BLOCK_ID, 0, 'kept');
		const validUpdate = Y.encodeStateAsUpdate(validDoc);
		const v99 = makeV99Update();
		await seedGenerationDb(name, [validUpdate, v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		// Valid rows hydrate; the poisoned row is refused → still rejects.
		await expect(p.whenSynced).rejects.toThrow(/unsupported/i);
		const ed = E.create(doc);
		expect(ed.blockText(BOOTSTRAP_BLOCK_ID)).toBe('kept');

		await providers.storeState(p);
		await sleep(200);
		const after = await readRows(name);
		// The valid row may legitimately be folded into the snapshot; the
		// refused bytes must not be.
		expect(hasRow(after, v99)).toBe(true);
		await p.destroy();
	});
});

/**
 * Extended U2 coverage: close/reopen, repeated attempts, dependency
 * ordering, post-sync refusals, commit-settled promises, error surfacing,
 * and preserved compaction efficiency for fully-admitted stores.
 */
describe('R2 — refusal ↔ compaction contract', () => {
	test('close/reopen: refused row survives destroy; a fresh provider re-refuses and stays blocked', async () => {
		const name = `h-r2-reopen-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc1 = new Y.Doc();
		const p1 = new providers.IndexeddbPersistence(name, doc1);
		await expect(p1.whenSynced).rejects.toThrow(/unsupported/i);
		await p1.destroy();

		// Refused bytes are durable across close.
		expect(hasRow(await readRows(name), v99)).toBe(true);

		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		// Re-hydration re-evaluates the row and refuses it again — the
		// compaction block is re-established on every fresh instance.
		await expect(p2.whenSynced).rejects.toThrow(/unsupported/i);
		expect(p2._hydrationRefused).not.toBeNull();
		expect(doc2.get('blocks').getAttr('evil-v99')).toBeUndefined();

		await providers.storeState(p2);
		await providers.storeState(p2, false);
		expect(hasRow(await readRows(name), v99)).toBe(true);
		await p2.destroy();
	});

	test('repeated compaction attempts are inert — no partial deletion, accepted writes still persist', async () => {
		const name = `h-r2-repeat-${Date.now()}`;
		const v99 = makeV99Update();
		await seedGenerationDb(name, [v99]);

		const doc = new Y.Doc();
		const p = new providers.IndexeddbPersistence(name, doc);
		await expect(p.whenSynced).rejects.toThrow(/unsupported/i);

		const before = await readRows(name);
		await providers.storeState(p);
		await providers.storeState(p);
		// A later accepted write is still persisted as its own row.
		doc.transact(() => doc.get('scratch').setAttr('later', 1));
		await providers.storeState(p);
		await providers.storeState(p, false);

		const after = await readRows(name);
		expect(hasRow(after, v99)).toBe(true);
		// Nothing deleted: every prior row plus exactly the new write row.
		expect(after.length).toBe(before.length + 1);
		await p.destroy();
	});

	/**
	 * A refused update whose dependency lives in a DIFFERENT row — seeded
	 * in both orders. Blocking compaction must keep both rows regardless
	 * (the dep may sit before or after the refused row).
	 */
	const makeV99DeltaOn = (baseUpdate: Uint8Array) => {
		const remote = new Y.Doc();
		remote.clientID = Number.MAX_SAFE_INTEGER; // meta.v LWW winner
		Y.applyUpdate(remote, baseUpdate);
		let captured: Uint8Array | null = null;
		remote.on('update', (u: Uint8Array) => (captured = u));
		remote.transact(() => {
			remote.get('meta').setAttr('v', 99);
			// Dependent write: text into the bootstrap block's content —
			// the new items reference base-row structs as neighbors.
			remote.get('blocks').getAttr(BOOTSTRAP_BLOCK_ID).getAttr('content').insert(0, 'DEP');
		});
		return captured as Uint8Array;
	};

	const makeBaseUpdate = () => {
		const base = new Y.Doc();
		const eb = E.create(base);
		eb.init();
		eb.insertText(BOOTSTRAP_BLOCK_ID, 0, 'base');
		return Y.encodeStateAsUpdate(base);
	};

	test.each([['in-order'], ['out-of-order']] as const)(
		'dependent refused update survives compaction (%s seed order)',
		async (order) => {
			const name = `h-r2-deps-${order}-${Date.now()}`;
			const base = makeBaseUpdate();
			const delta = makeV99DeltaOn(base);
			// Dep first or dep last — both rows must survive either way.
			await seedGenerationDb(name, order === 'in-order' ? [base, delta] : [delta, base]);

			const doc = new Y.Doc();
			const p = new providers.IndexeddbPersistence(name, doc);
			await expect(p.whenSynced).rejects.toThrow(/unsupported/i);
			expect(p._hydrationRefused).not.toBeNull();
			// Engine staging detail (probed): a delta whose deps are absent
			// goes ENTIRELY pending — meta.v=99 is invisible to the gate.
			//   in-order:     base admitted, delta refused → doc is 'base'.
			//   out-of-order: delta admitted as pending bytes; the base
			//                 row's merge resolves the pending v99 → the
			//                 BASE row is refused → doc stays uninitialized
			//                 (delta bytes sit pending in its store).
			// Either way the live doc never enters the unsupported state…
			expect(E.schemaVersion(doc)).not.toBe(99);
			if (order === 'in-order') {
				expect(E.create(doc).blockText(BOOTSTRAP_BLOCK_ID)).toBe('base');
				expect(E.schemaVersion(doc)).toBe(1);
			} else {
				expect(E.create(doc).blockText(BOOTSTRAP_BLOCK_ID)).toBeNull();
			}
			// …and the snapshot can never subsume the refused row(s):
			// out-of-order is the case where a refused row's content has
			// deps sitting in a LATER row — blocking preserves both.
			await providers.storeState(p);
			const after = await readRows(name);
			expect(hasRow(after, base)).toBe(true);
			expect(hasRow(after, delta)).toBe(true);
			await p.destroy();
		}
	);

	test('a row refused during a post-sync fetch blocks the SAME compaction call', async () => {
		const name = `h-r2-late-${Date.now()}`;
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		expect(p._hydrationRefused).toBeNull();

		const mismatches = [];
		p.on('schema-mismatch', (d) => mismatches.push(d));

		// A future-schema tab sharing this generation writes a v99 row
		// directly into the store AFTER our hydration — it lands past the
		// fetch cursor and is first seen inside storeState's own fetch.
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

		// The fetch stages + refuses the late row and sets the flag BEFORE
		// the compaction decision — this call must not delete it.
		await providers.storeState(p);
		expect(p._hydrationRefused).not.toBeNull();
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 99)
		).toBe(true);
		// Refused bytes never touched the live doc…
		expect(doc.get('blocks').getAttr('evil-v99')).toBeUndefined();
		expect(E.schemaVersion(doc)).toBe(1);
		// …and survived the compaction they would otherwise have been in
		// range for (_dbref had just advanced past the late row).
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
		expect(E.create(doc2).blockText(BOOTSTRAP_BLOCK_ID)).toBeDefined();
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
