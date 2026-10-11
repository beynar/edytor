/**
 * The IndexedDB store's snapshots (`room.store.v2` in
 * `docs/editor-delete-contract.md`): every row holds an update in the
 * engine's one encoding; a compaction's snapshot row is gzip-compressed.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as idb from 'lib0-v14/indexeddb';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD
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

describe('P5 · IndexedDB snapshots, compressed', () => {
	test('a compaction writes one compressed snapshot row; later edits are update rows beside it', async () => {
		const name = uniqueName('compacted');
		const { doc, provider } = await load(name);
		doc.get('content').setAttr('title', 'Notes');
		doc.get('content').insert(0, ['lorem ipsum '.repeat(400)]);
		await providers.storeState(provider);
		const store = await readStore(name);
		expect(store.record).toEqual(GENERATION_RECORD);
		expect(store.rows).toHaveLength(1);
		const row = new Uint8Array(store.rows[0]);
		expect(isGzip(row)).toBe(true);
		expect(row.length).toBeLessThan(Y.encodeStateAsUpdate(doc).length);
		await provider.destroy();

		const again = await load(name);
		expect(content(again.doc)).toEqual(content(doc));
		expect(Y.encodeStateVector(again.doc)).toEqual(Y.encodeStateVector(doc));
		again.doc.get('content').setAttr('title', 'Renamed');
		await new Promise((resolve) => setTimeout(resolve, 10));
		const rows = (await readStore(name)).rows;
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.every((r) => r instanceof ArrayBuffer)).toBe(true);
		expect(rows.slice(1).some((r) => isGzip(new Uint8Array(r)))).toBe(false);
		await again.provider.destroy();
		const last = await load(name);
		expect(content(last.doc).title).toBe('Renamed');
		await last.provider.destroy();
	});
});
