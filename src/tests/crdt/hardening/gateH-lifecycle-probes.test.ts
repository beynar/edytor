/**
 * GATE H adversarial probes — lifecycle edges across R2/R3/bonus.
 *
 *  R2: destroy() while storeState is in flight; two concurrent storeState
 *      calls on a clean doc (double compaction must not lose admitted rows).
 *  R3: nested `ed.transact(() => um.redo())` — same origin hole as undo?
 *  Lease bonus: undo AFTER the last facade is disposed (repair listener
 *      detached → unrepaired state persists and broadcasts); re-created
 *      facade must re-arm the repair.
 *  Rank bonus: many candidate-less rehomes + index-0 inserts; cross-replica
 *      determinism after a second convergence round.
 */
// @ts-nocheck -- exercises private internals on purpose.
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc, BOOTSTRAP_BLOCK_ID } from '../../../lib/crdt/edytor-doc.js';
import * as idb from 'lib0-v14/indexeddb';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';

const E = bindEdytorDoc(Y);
const providers = bindIndexeddbProvider(Y);
let cid = 700_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const openDb = (name: string) =>
	idb.openDB(name, (db: IDBDatabase) =>
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

describe('gateH-R2 — lifecycle edges', () => {
	test('destroy() during an in-flight storeState leaves a consistent store', async () => {
		const name = `h-r2-destroy-${Date.now()}`;
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'x'.repeat(600)); // > trim size → debounce path
		await sleep(30);
		let storeErr: unknown = null;
		const pending = providers.storeState(p).catch((e) => (storeErr = e));
		await p.destroy(); // destroy while the store is mid-flight
		await pending;
		console.log(`[r2-destroy] storeErr=${String(storeErr).slice(0, 120)}`);
		const rows = await readRows(name);
		console.log(`[r2-destroy] rowsAfter=${rows.length} destroyed=${p._destroyed}`);
		// Whatever the outcome, a fresh provider must still hydrate cleanly.
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await expect(p2.whenSynced).resolves.toBe(p2);
		expect(p2.synced).toBe(true);
		await p2.destroy();
	});

	test('two concurrent storeState calls on a clean doc keep all content', async () => {
		const name = `h-r2-dbl-${Date.now()}`;
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'CONCURRENT');
		await sleep(50);
		await Promise.all([providers.storeState(p), providers.storeState(p)]);
		// Rehydrate and verify the text survived a double-compaction.
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		const text = doc2.get('blocks').getAttr(BOOTSTRAP_BLOCK_ID)?.getAttr('content')?.toString();
		console.log(`[r2-dbl] rehydrated=${JSON.stringify(text?.slice(0, 40))}`);
		expect(text).toContain('CONCURRENT');
		await p.destroy();
		await p2.destroy();
	});
});

describe('gateH-R3 — nested redo + post-dispose repair', () => {
	const seedSplit = () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
		});
		ed.block('b').split(6, 'tail');
		return { doc, ed };
	};

	test('ed.transact(() => um.redo()) — same origin bypass on the redo path', () => {
		const { ed } = seedSplit();
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo(); // plain — repaired
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
		ed.transact(() => um.redo()); // nested redo — repair gate sees outer origin
		console.log(
			`[r3-redo] b=${JSON.stringify(ed.blockText('b'))} tail=${JSON.stringify(ed.blockText('tail'))}`
		);
		// A correct redo just re-deletes — no repair needed. The interesting
		// direction is a nested undo AFTER a change; covered by the pinned
		// FAIL probes. This test documents the redo direction.
	});

	test('undo after the LAST facade dispose → repair listener detached, state stays broken', () => {
		const { doc, ed } = seedSplit();
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		ed.dispose(); // last facade → repair listener detached
		um.undo(); // UndoManager instance still held by caller
		const bText = ed.blockText('b');
		const tailText = ed.blockText('tail');
		console.log(`[r3-disposed] b=${JSON.stringify(bText)} tail=${JSON.stringify(tailText)}`);
		// Re-create a facade — if repair is armed again, a NEW undo should
		// be repaired; the ALREADY-broken state stays broken.
		const ed2 = E.create(doc);
		const seen2 = ed2.blockText('tail');
		console.log(`[r3-disposed] reattached-tail=${JSON.stringify(seen2)}`);
	});

	test('re-created facade re-arms the repair listener', () => {
		const { doc, ed } = seedSplit();
		ed.dispose();
		const ed2 = E.create(doc);
		const um2 = ed2.createUndoManager({ captureTimeout: 0 });
		ed2.block('tail').deleteText(0, 5);
		um2.undo();
		console.log(
			`[r3-ream] b=${JSON.stringify(ed2.blockText('b'))} tail=${JSON.stringify(ed2.blockText('tail'))}`
		);
		expect(ed2.blockText('tail')).toBe('world');
	});
});

describe('gateH-bonus — rehome rank stress', () => {
	test('many inserts at index 0 after rehomes stay ordered on both replicas', () => {
		const docA = new Y.Doc();
		docA.clientID = cid++;
		const edA = E.create(docA);
		const spec: { id: string; type: string }[] = [];
		for (let i = 0; i < 15; i++) spec.push({ id: `s${i}`, type: 'paragraph' });
		edA.init({ content: spec.map((s) => ({ ...s, content: [{ kind: 'text', text: s.id }] })) });
		// Force rehomes: delete all parents' rank candidates by moving
		// blocks to root index 0 in reverse order.
		const ids = edA.childrenIds(null);
		for (let i = ids.length - 1; i >= 0; i--) {
			edA.moveBlock(ids[i], { parent: null, index: 0 });
		}
		for (let i = 0; i < 10; i++) {
			edA.insertBlock({ parent: null, index: 0 }, { id: `n${i}`, type: 'paragraph' });
		}
		const orderA = edA.childrenIds(null);
		// Converge to a second replica and compare ORDER (not bytes).
		const docB = new Y.Doc();
		docB.clientID = cid++;
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		const edB = E.create(docB);
		const orderB = edB.childrenIds(null);
		console.log(
			`[rank-stress] equal=${JSON.stringify(orderA) === JSON.stringify(orderB)} n=${orderA.length}`
		);
		expect(orderB).toEqual(orderA);
		expect(new Set(orderA).size).toBe(orderA.length);
	});
});
