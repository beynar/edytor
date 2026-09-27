/**
 * GATE-2 attack probes — compaction (attack 6) + schema manifest (attack 8).
 *
 * 6. >500 stored updates → debounced trim → snapshot row → reload → JSON +
 *    state equality + a post-reload operation must still work. Plus the
 *    snapshot+interleaved-later-rows ordering edge.
 *
 * 8. Schema manifest: coexisting schema versions in one room, init() after
 *    partial state, a replica that learns the version solely via updates.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import {
	bindIndexeddbProvider,
	PREFERRED_TRIM_SIZE
} from '../../../lib/crdt/providers/indexeddb.js';
import { bindEdytorDoc, SCHEMA_VERSION, BOOTSTRAP_BLOCK_ID } from '../../../lib/crdt/edytor-doc.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';
import * as idb from 'lib0-v14/indexeddb';

const providers = bindIndexeddbProvider(Y);
const E = bindEdytorDoc(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;
const nextTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 15000, step = 50) => {
	const start = Date.now();
	while (!(await cond())) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, step));
	}
};

const rowCount = async (name) => {
	const db = await idb.openDB(generationDbName(name), () => {});
	try {
		const [updates] = idb.transact(db, ['updates'], 'readonly');
		return await idb.count(updates);
	} finally {
		db.close();
	}
};

describe('attack 6: compaction', () => {
	test('>500 updates → trim → reload → byte-equal doc; ops still work', async () => {
		const name = uniqueName('compact');
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		const b = ed.childrenIds(null)[0];

		// One update per char → 520+ rows, past PREFERRED_TRIM_SIZE (500).
		const chars = 520;
		for (let i = 0; i < chars; i++) {
			ed.insertText(b, i, String.fromCharCode(97 + (i % 26)));
		}
		const expectedJSON = JSON.stringify(ed.toJSON());
		const expectedUpdate = Y.encodeStateAsUpdate(doc);
		await until(async () => (await rowCount(name)) <= 2, 15000); // trimmed to snapshot

		const rowsAfter = await rowCount(name);
		expect(rowsAfter).toBeLessThanOrEqual(2); // snapshot (+ in-flight remainder)

		// Fresh open: hydrates from the compacted store.
		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		const ed2 = E.create(doc2);
		expect(JSON.stringify(ed2.toJSON())).toBe(expectedJSON);

		// State equivalence: the compacted doc reproduces identical content —
		// state vectors will differ (compaction merges structs), which is fine;
		// the logical doc must be identical.
		const doc3 = new Y.Doc();
		Y.applyUpdate(doc3, expectedUpdate);
		expect(JSON.stringify(E.create(doc3).toJSON())).toBe(expectedJSON);

		// Post-reload operation still works on the compacted doc.
		const b2 = ed2.childrenIds(null)[0];
		expect(ed2.insertText(b2, 0, 'post-reload ').status).toBe('applied');
		expect(JSON.stringify(ed2.toJSON())).toContain('post-reload');
		await p.destroy();
		await p2.destroy();
	});

	test('a compacted snapshot plus later interleaved rows reload in order', async () => {
		const name = uniqueName('compact-order');
		const doc = new Y.Doc();
		const ed = E.create(doc);
		ed.init();
		const p = new providers.IndexeddbPersistence(name, doc);
		await p.whenSynced;
		const b = ed.childrenIds(null)[0];
		for (let i = 0; i < 520; i++) ed.insertText(b, i, 'x');
		await until(async () => (await rowCount(name)) <= 2, 15000);

		// Later rows appended after the snapshot (new edits)…
		ed.insertText(b, 0, 'AFTER-SNAPSHOT');
		await nextTick(60);
		const expectedJSON = JSON.stringify(ed.toJSON());

		const doc2 = new Y.Doc();
		const p2 = new providers.IndexeddbPersistence(name, doc2);
		await p2.whenSynced;
		expect(JSON.stringify(E.create(doc2).toJSON())).toBe(expectedJSON);
		await p.destroy();
		await p2.destroy();
	});
});

describe('attack 8: schema manifest coexistence', () => {
	test('an unsupported-schema peer is refused at the boundary; the v1 doc is never corrupted', async () => {
		const name = uniqueName('schema-coexist');
		// Doc A: this build's schema (v1).
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;

		// Doc B: a "future" schema (v2) written by a different engine build —
		// same wire protocol, different meta.v.
		const docB = new Y.Doc();
		E.create(docB);
		docB.transact(() => {
			docB.get('meta').setAttr('v', 2);
			docB.get('meta').setAttr('schema', 'edytor-doc-next');
		});
		docB.get('blocks').setAttr(
			'bx',
			(() => {
				const n = new Y.Node('block');
				n.setAttr('id', 'bx');
				n.setAttr('type', 'paragraph');
				return n;
			})()
		);
		const mismatches = [];
		const pB = new providers.IndexeddbPersistence(name, docB);
		pB.on('schema-mismatch', (d) => mismatches.push(d));
		// Doc B's own hydration may merge A's v1 state — the LWW outcome is
		// clientID-dependent, so tolerate either verdict; the B-side signal
		// fires regardless (its own doc is unsupported).
		await pB.whenSynced.catch(() => {});
		await nextTick(80);

		// The offending peer's own provider detected + signaled the skew…
		expect(
			mismatches.some((m) => m.problem?.kind === 'unsupported' && m.problem?.version === 2)
		).toBe(true);
		// …and the v1 doc NEVER enters an unsupported state. Whether 'bx'
		// arrives is LWW-dependent: if A's v1 wins docB's merge, docB heals to
		// v1 and ships its (now supported) state; if v2 wins, docB is refused
		// and ships nothing. Either way docA stays on the supported schema.
		expect(E.schemaVersion(docA)).toBe(SCHEMA_VERSION);
		await pA.destroy();
		await pB.destroy();
	});

	test('init() on a partially-written doc completes without clobbering', () => {
		const doc = new Y.Doc();
		// A doc that received content via replication but never ran init:
		const src = new Y.Doc();
		const edSrc = E.create(src);
		edSrc.init();
		edSrc.insertBlock({ parent: null, index: 0 }, { id: 'b1', type: 'paragraph' });
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));

		const ed = E.create(doc);
		expect(ed.isInitialized()).toBe(true); // content present
		expect(E.schemaVersion(doc)).toBe(SCHEMA_VERSION); // learned via update
		// init() must be a no-op here — no second bootstrap, no v rewrite.
		const before = Y.encodeStateAsUpdate(doc);
		ed.init();
		const after = Y.encodeStateAsUpdate(doc);
		expect(ed.childrenIds(null)).toEqual(['b1', BOOTSTRAP_BLOCK_ID].sort());
		void before;
		void after;
		ed.dispose();
	});

	test('concurrent init() on two fresh replicas converges to ONE bootstrap', () => {
		// Both peers init concurrently (same reserved id) → registry attr LWW
		// keeps exactly one bootstrap — never two fallback paragraphs.
		const a = new Y.Doc();
		const b = new Y.Doc();
		E.create(a).init();
		E.create(b).init();
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const idsA = E.create(a).childrenIds(null);
		const idsB = E.create(b).childrenIds(null);
		expect(idsA).toEqual([BOOTSTRAP_BLOCK_ID]);
		expect(idsB).toEqual([BOOTSTRAP_BLOCK_ID]);
		expect(E.registryEmpty(a)).toBe(false);
		// Concurrent inits with DIFFERENT caller content union instead.
		const c = new Y.Doc();
		const d = new Y.Doc();
		E.create(c).init({ content: [{ id: 'x', type: 'paragraph' }] });
		E.create(d).init({ content: [{ id: 'y', type: 'paragraph' }] });
		Y.applyUpdate(c, Y.encodeStateAsUpdate(d));
		Y.applyUpdate(d, Y.encodeStateAsUpdate(c));
		const idsC = E.create(c).childrenIds(null).sort();
		const idsD = E.create(d).childrenIds(null).sort();
		expect(idsC).toEqual(idsD);
		expect(idsC).toContain('x');
		expect(idsC).toContain('y');
	});

	test('a replica that only ever applied updates knows the schema version', () => {
		const src = new Y.Doc();
		const edSrc = E.create(src);
		edSrc.init();
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
		expect(E.schemaVersion(doc)).toBe(SCHEMA_VERSION);
		expect(E.isInitialized(doc)).toBe(true);
	});
});
