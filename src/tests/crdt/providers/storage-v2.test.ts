/**
 * Phase 2, P5 — the IndexedDB store's snapshots are v2 and compressed,
 * tagged in the generation record (`room.store.v2` in
 * `docs/editor-delete-contract.md`):
 *
 * - a store written by 0.1.0-next.22 (v1 rows, a record without
 *   `storage`) loads, and its first compaction rewrites it: one v2
 *   snapshot row, gzip-compressed, and the record stamped `storage: 'v2'`;
 * - without `CompressionStream` the snapshot row is v2, uncompressed, and
 *   loads the same;
 * - a build before 0.1.0-next.23 cannot misread a snapshot row: its row
 *   codec refuses it (the store fails to load instead).
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as idb from 'lib0-v14/indexeddb';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { decodeRow } from '../../../lib/crdt/providers/container.js';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD,
	STORED_GENERATION_RECORD
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;

const open = (name) =>
	idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const readStore = async (name) => {
	const db = await open(name);
	try {
		const [updates, custom] = idb.transact(db, ['updates', 'custom'], 'readonly');
		return {
			rows: await idb.getAll(updates),
			record: await idb.rtop(custom.get(GENERATION_KEY))
		};
	} finally {
		db.close();
	}
};

/** A store as 0.1.0-next.22 wrote it: v1 rows and a record without `storage`. */
const writeNext22Store = async (name, rows) => {
	const db = await open(name);
	try {
		const [updates, custom] = idb.transact(db, ['updates', 'custom']);
		await idb.rtop(custom.put({ ...GENERATION_RECORD }, GENERATION_KEY));
		for (const row of rows) await idb.addAutoKey(updates, row.slice().buffer);
	} finally {
		db.close();
	}
};

const load = async (name) => {
	const doc = new Y.Doc();
	const provider = new providers.IndexeddbPersistence(name, doc, { disableBc: true });
	await provider.whenSynced;
	return { doc, provider };
};

const content = (doc) => ({
	text: doc.get('content').toArray().join(''),
	title: doc.get('content').getAttr('title')
});

const isGzip = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

const saved = globalThis.CompressionStream;
afterEach(() => {
	globalThis.CompressionStream = saved;
});

describe('P5 · IndexedDB snapshots in v2, compressed', () => {
	test('a store written by 0.1.0-next.22 loads; its first compaction migrates it to v2', async () => {
		const name = uniqueName('next22');
		const author = new Y.Doc();
		const updates = [];
		author.on('update', (update) => updates.push(update));
		author.get('content').setAttr('title', 'Notes');
		author.get('content').insert(0, ['lorem ipsum '.repeat(400)]);
		const snapshot = Y.encodeStateAsUpdate(author);
		author.get('content').insert(0, ['first ']);
		await writeNext22Store(name, [snapshot, updates.at(-1)]);

		const { doc, provider } = await load(name);
		expect(content(doc)).toEqual(content(author));
		await providers.storeState(provider);
		const store = await readStore(name);
		expect(store.record).toEqual(STORED_GENERATION_RECORD);
		expect(store.rows).toHaveLength(1);
		const row = new Uint8Array(store.rows[0].v2);
		expect(isGzip(row)).toBe(true);
		expect(row.length).toBeLessThan(Y.encodeStateAsUpdateV2(author).length);
		await provider.destroy();

		const again = await load(name);
		expect(content(again.doc)).toEqual(content(author));
		expect(Y.encodeStateVector(again.doc)).toEqual(Y.encodeStateVector(author));
		// Later edits are v1 update rows beside the snapshot.
		again.doc.get('content').setAttr('title', 'Renamed');
		await new Promise((resolve) => setTimeout(resolve, 10));
		const rows = (await readStore(name)).rows;
		expect(rows[0] instanceof ArrayBuffer).toBe(false);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.slice(1).every((r) => r instanceof ArrayBuffer)).toBe(true);
		await again.provider.destroy();
		const last = await load(name);
		expect(content(last.doc).title).toBe('Renamed');
		await last.provider.destroy();
	});

	test('without CompressionStream the snapshot row is v2, uncompressed, and loads the same', async () => {
		globalThis.CompressionStream = undefined;
		const name = uniqueName('raw');
		const { doc, provider } = await load(name);
		doc.get('content').insert(0, ['hello '.repeat(100)]);
		await providers.storeState(provider);
		const { rows } = await readStore(name);
		const row = new Uint8Array(rows[0].v2);
		expect(row[0]).toBe(0); // a v2 update's feature flag, not gzip
		await provider.destroy();
		const again = await load(name);
		expect(content(again.doc)).toEqual(content(doc));
		await again.provider.destroy();
	});

	test('the row codec of a build before 0.1.0-next.23 refuses a snapshot row', async () => {
		const name = uniqueName('old-reader');
		const { doc, provider } = await load(name);
		doc.get('content').insert(0, ['x']);
		await providers.storeState(provider);
		const { rows } = await readStore(name);
		// `decodeRow` is the only codec next.22 had: it throws, so that build fails to load.
		expect(() => decodeRow(rows[0])).toThrow('not binary data');
		await provider.destroy();
	});
});
