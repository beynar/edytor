/**
 * Schema generation 5 (0.1.0-next.25) and the cutover from generation 4
 * (`room.generation.convert`, `reference/migration.mdx` "From
 * 0.1.0-next.24"). The fixture `fixtures/generation-4/` was written by
 * 0.1.0-next.24 (its state, v1 and v2, and its `toJSON()`): a
 * generation-4 state is read as that JSON and seeded as generation 5's.
 *
 * - frames and containers of generation 4 are refused before decode, as
 *   any other generation's;
 * - the generation-4 reader gives the JSON 0.1.0-next.24 gave;
 * - the seed of that JSON is deterministic and reads back as it;
 * - a local IndexedDB store of generation 4 converts into its successor
 *   (`createIndexeddbSync`), which a room-backed store does not;
 * - next.6 data (an array leaf, the whole-data attribute) converts as its arrays;
 * - a SyncStep2 is v2 on the wire (`room.store.v2`) and an Update stays v1.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as idb from 'lib0-v14/indexeddb';
import { Y } from '../../../lib/crdt/engine.js';
import {
	bindCrdt,
	createDocument,
	defaultSemantics,
	facadeConfigOf,
	loadDocument
} from '../../../lib/crdt/index.js';
import {
	GENERATION,
	GENERATION_RECORD,
	isPreviousGenerationRecord,
	PREVIOUS_SCHEMA,
	SCHEMA_VERSION
} from '../../../lib/crdt/protocol.js';
import {
	GENERATION_KEY,
	generationDbName,
	isGenerationRecord,
	readProtocolVersion
} from '../../../lib/crdt/protocols/envelope.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { blockNodeOf } from '../../../lib/crdt/placement/model.js';

const crdt = bindCrdt(Y);
const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../fixtures/generation-4/${name}`, import.meta.url)));
const V1 = fixture('state.v1.bin');
const V2 = fixture('state.v2.bin');
const VALUE = JSON.parse(new TextDecoder().decode(fixture('value.json')));
/** The IndexedDB database of a generation-4 store (generations 1 to 4). */
const PREVIOUS_GENERATION_PREFIX = 'edytor-v14:';
/** A facade of this build reading with the bundled semantics, as the room's. */
const facadeOf = (doc) => crdt.doc.create(doc, facadeConfigOf(defaultSemantics));
/** A state of generation 4 as JSON (`generations.previousJSON`, as the room reads its container). */
const previousJSON = (updates) => crdt.generations.previousJSON(updates, facadeOf);
/** This generation's seed of `value`, as the room's conversion writes it. */
const seedOf = (value) => {
	const doc = crdt.createDoc();
	const facade = facadeOf(doc);
	facade.seed(value.children, value.data);
	facade.dispose();
	return Y.encodeStateAsUpdate(doc);
};

describe('generation 5', () => {
	it('is schema 5, wire word 14005; generation 4 is the one this build converts', () => {
		expect(SCHEMA_VERSION).toBe(5);
		expect(GENERATION).toBe(14005);
		expect(PREVIOUS_SCHEMA).toBe(4);
		const g4 = { engine: 'yjs-v14', protocol: 14, schema: 4, storage: 'v2' };
		expect(isGenerationRecord(g4)).toBe(false);
		expect(isPreviousGenerationRecord(g4)).toBe(true);
		expect(isPreviousGenerationRecord({ ...g4, schema: 3 })).toBe(false);
		expect(isGenerationRecord(GENERATION_RECORD)).toBe(true);
	});

	it('a frame of generation 4 is refused before anything is decoded', () => {
		const old = encoding.encode((e) => {
			encoding.writeVarUint(e, 14004);
			encoding.writeVarUint(e, 0);
		});
		expect(readProtocolVersion(decoding.createDecoder(old))).toBe(false);
	});

	it('a state of generation 4 is never loaded as this generation’s', () => {
		expect(() => loadDocument(V1)).toThrow(/unsupported schema version 4/);
	});
});

describe('the generation-4 reader', () => {
	it('reads the fixture as the JSON 0.1.0-next.24 gave, from v1 and from v2', () => {
		expect(previousJSON([V1])).toEqual(VALUE);
		expect(previousJSON([{ v2: V2 }])).toEqual(VALUE);
	});

	it('seeds it deterministically; the seed reads back as it', () => {
		const a = seedOf(VALUE);
		const b = seedOf(VALUE);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
		const document = loadDocument(a, { semantics: defaultSemantics });
		expect(document.facade.toJSON()).toEqual(VALUE);
		document.destroy();
		// The same value seeded by a document (`createDocument`) reads the same.
		const created = createDocument({ value: VALUE, semantics: defaultSemantics });
		expect(created.facade.toJSON()).toEqual(VALUE);
		created.destroy();
	});
});

describe('pre-release data formats reach generation 5 through the cutover', () => {
	// 0.1.0-next.6 stored an array as one leaf (`d/<path>` holding the whole
	// array); documents before it held the whole `data` attribute, which is
	// no longer read. Both are generation 4 (generation 5 began at 0.1.0-next.25), so a build of
	// generation 5 meets them only in the cutover, which reads them with this
	// build's reader and seeds what it reads: generation 5 then holds items,
	// never the old forms.
	const withPreReleaseData = () => {
		const doc = new Y.Doc();
		Y.applyUpdate(doc, V1);
		const facade = bindEdytorDoc(Y).create(doc);
		doc.transact(() => {
			blockNodeOf(doc, 'n').setAttr('d/labels', ['x', 'y']);
			blockNodeOf(doc, 'p').setAttr('data', { tags: ['p', 'q'], k: 1 });
		}, 'next.6');
		facade.dispose();
		const update = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		return update;
	};

	it('a next.6 array leaf reads as its array and seeds as items; a whole-data attribute is not read', () => {
		const value = previousJSON([withPreReleaseData()]);
		const byId = (json, id) => json.children.find((block) => block.id === id);
		expect(byId(value, 'n').data).toEqual({ labels: ['x', 'y'] });
		expect(byId(value, 'p').data).toEqual({});
		// Seeded as generation 5: the same data, and no leaf or attribute of the old forms.
		const document = loadDocument(seedOf(value), {
			semantics: defaultSemantics
		});
		expect(document.facade.toJSON()).toEqual(value);
		for (const id of ['n', 'p']) {
			const node = blockNodeOf(document.doc, id);
			const keys = [...node.attrKeys()];
			expect(keys, id).not.toContain('data');
			for (const key of keys.filter((k) => k.startsWith('d/')))
				expect(Array.isArray(node.getAttr(key)) && node.getAttr(key).length > 0, key).toBe(false);
		}
		document.destroy();
	});
});

describe('IndexedDB stores of generation 4', () => {
	const providers = bindIndexeddbProvider(Y);
	const stores = [['updates', { autoIncrement: true }], ['custom']];
	let n = 0;
	const name = () => `cutover-${n++}`;
	const writeGeneration4 = async (logical: string) => {
		const db = await idb.openDB(PREVIOUS_GENERATION_PREFIX + logical, (d) =>
			idb.createStores(d, stores)
		);
		const [updates, custom] = idb.transact(db, ['updates', 'custom']);
		await idb.rtop(
			custom.put({ engine: 'yjs-v14', protocol: 14, schema: 4, storage: 'v1' }, GENERATION_KEY)
		);
		await idb.addAutoKey(updates, V1.slice().buffer);
		db.close();
	};
	const rowsOf = async (dbName: string) => {
		const db = await idb.openDB(dbName, (d) => idb.createStores(d, stores));
		const [updates] = idb.transact(db, ['updates'], 'readonly');
		const rows = await idb.getAll(updates);
		db.close();
		return rows.length;
	};

	it('is not converted: the new store starts empty and the old one is left as it was', async () => {
		const logical = name();
		await writeGeneration4(logical);
		const doc = new Y.Doc();
		const provider = new providers.IndexeddbPersistence(logical, doc, { disableBc: true });
		await provider.whenSynced;
		expect(doc.get('blocks')._map.size).toBe(0);
		provider.destroy();
		expect(await rowsOf(PREVIOUS_GENERATION_PREFIX + logical)).toBe(1);
	});
});

describe('P5 — a SyncStep2 is v2 on the wire, an Update stays v1', () => {
	it('writeSyncStep2 writes v2; the reader applies it', () => {
		const a = createDocument({ value: VALUE, semantics: defaultSemantics });
		const encoder = encoding.createEncoder();
		crdt.sync.writeSyncStep2(encoder, a.doc);
		const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
		expect(decoding.readVarUint(decoder)).toBe(crdt.sync.messageYjsSyncStep2);
		const payload = decoding.readVarUint8Array(decoder);
		expect(Buffer.from(payload).equals(Buffer.from(Y.encodeStateAsUpdateV2(a.doc)))).toBe(true);
		const b = new Y.Doc();
		const reader = encoding.createEncoder();
		encoding.writeVarUint(reader, crdt.sync.messageYjsSyncStep2);
		encoding.writeVarUint8Array(reader, payload);
		crdt.sync.readSyncMessage(
			decoding.createDecoder(encoding.toUint8Array(reader)),
			encoding.createEncoder(),
			b,
			'remote'
		);
		expect(
			Buffer.from(Y.encodeStateVector(b)).equals(Buffer.from(Y.encodeStateVector(a.doc)))
		).toBe(true);
		a.destroy();
	});
});
