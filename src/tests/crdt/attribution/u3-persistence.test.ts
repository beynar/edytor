/**
 * U3 — block attribution across every persistence/sync path.
 *
 *   - `encode()` → `loadDocument` round-trips `b/` records + `l` attrs
 *     byte-faithfully (per-record attr snapshots, not just read-API parity).
 *   - `IndexeddbPersistence` stores and compacts the same bytes — the
 *     hydration schema gate treats `blockattr` state as supported.
 *   - The `createIndexeddbSync`/`createWebsocketSync` factories (the
 *     `<Edytor {sync}>` contract, also reachable via `document.attachSync`)
 *     carry attribution live between replicas.
 *   - Foreign roots coexist through every path; unknown schema markers are
 *     refused/preserved per the existing gates.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as idb from 'lib0-v14/indexeddb';
import { Y } from '../../../lib/crdt/engine.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import {
	GENERATION_KEY,
	GENERATION_RECORD,
	generationDbName
} from '../../../lib/crdt/protocols/envelope.js';
import {
	attachDocument,
	createDocument,
	loadDocument,
	type DocumentActor
} from '../../../lib/crdt/index.js';
import { docValue, firstBlock, wireDocs } from './helpers.js';
import type { EngineNode, YDoc } from '../../../lib/crdt/engine-api.js';

const idbProviders = bindIndexeddbProvider(Y);
const providers = bindProviders(Y);

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };
const carol: DocumentActor = { id: 'carol', name: 'Carol' };

let counter = 0;
const uniqueName = (base: string) => `${base}-${counter++}`;

const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

const openDb = (name: string) =>
	idb.openDB(name, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

const readRows = async (name: string): Promise<ArrayBuffer[]> => {
	const db = await openDb(generationDbName(name));
	try {
		const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updatesStore)) as ArrayBuffer[];
	} finally {
		db.close();
	}
};

/** Write rows directly into a v14-generation DB (store + generation record). */
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

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/**
 * Byte-level snapshot of durable attribution state — every `b/` record's
 * full attr map plus every block node's surviving `l` value.
 */
const blockattrSnapshot = (doc: YDoc) => {
	const records: Record<string, Record<string, unknown>> = {};
	const root = doc.get('blockattr');
	for (const key of root.attrKeys()) {
		const rec = root.getAttr(key) as EngineNode | undefined;
		const attrs: Record<string, unknown> = {};
		if (isNodeLike(rec)) {
			for (const k of rec.attrKeys()) attrs[k] = rec.getAttr(k);
		}
		records[key] = attrs;
	}
	const lastChanged: Record<string, string> = {};
	const registry = doc.get('blocks');
	for (const key of registry.attrKeys()) {
		const node = registry.getAttr(key) as EngineNode | undefined;
		const l = isNodeLike(node) ? node.getAttr('l') : undefined;
		if (typeof l === 'string') lastChanged[key] = l;
	}
	return { records, lastChanged };
};

/** Minimal opaque-relay fake server — same shape as websocket.test.ts. */
class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map<string, Set<FakeWebSocket>>();

	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;

	constructor(public url: string) {
		setTimeout(() => {
			if (this.readyState !== 0) return;
			let room = FakeWebSocket.rooms.get(url);
			if (!room) FakeWebSocket.rooms.set(url, (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data: Uint8Array | ArrayBuffer) {
		const room = FakeWebSocket.rooms.get(this.url);
		if (!room) return;
		const copy = data instanceof Uint8Array ? data.slice().buffer : data;
		setTimeout(() => {
			for (const peer of room) {
				if (peer !== this && peer.readyState === 1) {
					peer.onmessage?.({ data: copy instanceof ArrayBuffer ? copy.slice(0) : copy });
				}
			}
		});
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		FakeWebSocket.rooms.get(this.url)?.delete(this);
		this.onclose?.({});
	}
}

// ──────────────────────────────────────────────────────────────────────
// Path 4 — encode()/loadDocument + IndexedDB persistence
// ──────────────────────────────────────────────────────────────────────

describe('encode → loadDocument', () => {
	it('multi-block, multi-actor attribution round-trips byte-faithfully (incl. a deleted block)', () => {
		const a = createDocument({
			value: {
				children: [
					{ type: 'paragraph', id: 'p1', content: [{ text: 'one' }] },
					{ type: 'paragraph', id: 'p2', content: [{ text: 'two' }] }
				]
			},
			actor: alice
		});
		const b = createDocument({ actor: bob });
		Y.applyUpdate(b.doc, a.encode());
		b.sync();
		const unwire = wireDocs(a, b);

		// bob touches p1 and authors p3; alice deletes p2 (its record survives).
		b.transact(() => b.facade.insertText('p1', 3, '!'));
		b.transact(() =>
			b.facade.insertBlock(
				{ parent: null, index: 2 },
				{ id: 'p3', type: 'paragraph', content: [{ kind: 'text', text: 'three' }] }
			)
		);
		a.transact(() => a.facade.deleteBlock('p2'));
		const snap = blockattrSnapshot(a.doc);
		expect(snap.records['b/p2']).toBeDefined(); // dead block keeps its record

		const restored = loadDocument(a.encode(), { actor: carol });
		expect(blockattrSnapshot(restored.doc)).toEqual(snap);
		expect(restored.facade.toJSON()).toEqual(a.facade.toJSON());
		expect(restored.attribution.block('p1')).toEqual(a.attribution.block('p1'));
		expect(restored.attribution.block('p1')).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'bob'
		});
		// The restored replica's edits stamp carol — stored records are never
		// relabeled by the restore.
		restored.transact(() => restored.facade.insertText('p1', 0, 'C'));
		expect(restored.attribution.block('p1')).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob', 'carol']),
			lastChangedBy: 'carol'
		});
		unwire();
		restored.destroy();
		a.destroy();
		b.destroy();
	});
});

describe('IndexedDB persistence + compaction', () => {
	it('blockattr state hydrates from stored rows AND from a compacted snapshot', async () => {
		const name = uniqueName('u3-attr-idb');
		const a = createDocument({ value: docValue('hi'), actor: alice });
		const blockId = firstBlock(a).id;
		const pA = new idbProviders.IndexeddbPersistence(name, a.doc as never);
		await pA.whenSynced;

		// Two attributing edits → incremental rows.
		a.transact(() => a.facade.insertText(blockId, 2, '!'));
		a.transact(() =>
			a.facade.insertBlock({ parent: null, index: 1 }, { id: 'p2', type: 'paragraph' })
		);
		await nextTick();
		// Force compaction: one snapshot row subsumes every update row —
		// `b/` records and `l` attrs ride the snapshot bytes.
		await idbProviders.storeState(pA);
		expect((await readRows(name)).length).toBe(1);
		const snap = blockattrSnapshot(a.doc);
		await pA.destroy();

		// A fresh doc hydrates from the compacted store — schema gate clean.
		const docB = new Y.Doc();
		const pB = new idbProviders.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		const restored = attachDocument(docB, { actor: bob });
		restored.sync();
		expect(blockattrSnapshot(docB)).toEqual(snap);
		expect(restored.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		expect(restored.attribution.block('p2')?.createdBy).toBe('alice');
		await pB.destroy();
		restored.destroy();
		a.destroy();
	});

	it('stored rows carrying ONLY blockattr/dictionary writes hydrate cleanly', async () => {
		const name = uniqueName('u3-attr-only');
		const a = createDocument({ value: docValue('x'), actor: alice });
		const blockId = firstBlock(a).id;
		a.transact(() => a.facade.insertText(blockId, 0, 'y'));
		// The whole document state — meta + blocks + blockattr + dictionary —
		// is what the gate must accept.
		await seedGenerationDb(name, [a.encode()]);

		const docB = new Y.Doc();
		const pB = new idbProviders.IndexeddbPersistence(name, docB);
		const mismatches: unknown[] = [];
		pB.on('schema-mismatch', (d: unknown) => mismatches.push(d));
		await pB.whenSynced; // gate accepted — synced fired
		expect(mismatches).toHaveLength(0);
		expect(docB.get('blockattr').getAttr(`b/${blockId}`)).toBeDefined();

		// Compaction remains legal on the hydrated doc.
		await idbProviders.storeState(pB);
		expect((await readRows(name)).length).toBe(1);
		await pB.destroy();
		a.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 5 — provider sync (room sync, attachSync factories, websocket)
// ──────────────────────────────────────────────────────────────────────

describe('provider sync', () => {
	it('two IndexeddbPersistence providers sync attribution live over BroadcastChannel', async () => {
		const name = uniqueName('u3-bc');
		const a = createDocument({ value: docValue('room'), actor: alice });
		const blockId = firstBlock(a).id;
		const pA = new idbProviders.IndexeddbPersistence(name, a.doc as never);
		await pA.whenSynced;

		const docB = new Y.Doc();
		const pB = new idbProviders.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		await until(() => docB.get('blocks').getAttr(blockId) !== undefined, 4000);

		const b = attachDocument(docB, { actor: bob });
		b.sync();
		// B reads alice's stamps verbatim — hydration never relabels.
		expect(b.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});

		// B edits → the update reaches A over the room — l flips to bob,
		// the union grows, and B's dictionary binding arrives too.
		b.transact(() => b.facade.insertText(blockId, 0, 'B'));
		await until(() => a.attribution.block(blockId)?.lastChangedBy === 'bob', 4000);
		expect(a.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'bob'
		});
		expect(a.attribution.actorOf(docB.clientID)).toBe('bob');
		await pA.destroy();
		await pB.destroy();
		a.destroy();
		b.destroy();
	});

	it('attachSync(createIndexeddbSync) hydrates a pending document with attribution intact', async () => {
		const name = uniqueName('u3-sync-factory');
		const a = createDocument({ actor: alice }); // pending until provider syncs
		a.attachSync(providers.createIndexeddbSync(name), { value: docValue('seed') });
		await until(() => a.ready);
		const blockId = firstBlock(a).id;
		a.transact(() => a.facade.insertText(blockId, 0, '!'));
		await nextTick();

		const b = createDocument({ actor: bob });
		b.attachSync(providers.createIndexeddbSync(name));
		await until(() => b.ready && b.attribution.block(blockId)?.createdBy === 'alice', 4000);
		expect(b.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		a.destroy();
		b.destroy();
	});

	it('createWebsocketSync over an opaque relay carries attribution both ways', async () => {
		const url = `ws://fake-u3/${counter++}`;
		const a = createDocument({ value: docValue('ws'), actor: alice });
		const blockId = firstBlock(a).id;
		a.attachSync(
			providers.createWebsocketSync({
				serverUrl: url,
				roomName: 'room',
				WebSocketPolyfill: FakeWebSocket as never,
				disableBc: true
			})
		);
		const b = createDocument({ actor: bob });
		b.attachSync(
			providers.createWebsocketSync({
				serverUrl: url,
				roomName: 'room',
				WebSocketPolyfill: FakeWebSocket as never,
				disableBc: true
			})
		);
		await until(() => b.ready && b.facade.hasBlock(blockId), 4000);
		expect(b.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});

		b.transact(() => b.facade.insertText(blockId, 0, 'B'));
		await until(() => a.attribution.block(blockId)?.lastChangedBy === 'bob', 4000);
		expect(a.attribution.block(blockId)?.contributors).toEqual(new Set(['alice', 'bob']));
		a.destroy();
		b.destroy();
	});
});
