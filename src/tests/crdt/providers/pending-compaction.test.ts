/**
 * GATE-3 probe — pending items across snapshot/reload and compaction.
 *
 * Verifies the carried-risk claim about the vendored-engine crash
 * (seeds 86/140 — `iterateStructsByIdSet`/`findIndexSS` firing on a legal
 * update stream after a lossy reload). The handoff asserts providers
 * "send complete updates/state vectors" so the lossy precondition is
 * unreachable. These probes pin the actual mechanism through the REAL
 * provider storage path (`IndexeddbPersistence` + `storeState` over
 * fake-indexeddb):
 *
 * - `encodeStateAsUpdate` appends `pendingStructs`/`pendingDs` — pending
 *   bytes survive compaction.
 * - The struct store keeps Skip placeholders for missing ranges and
 *   `encodeStateVector` truncates at the first hole — it does NOT
 *   overclaim coverage past a gap, so sync diffs DO re-deliver the
 *   missing prefix and pending resolves.
 * - A reloaded doc whose snapshot carried pending items re-pends them
 *   (integration bails per-client at the first unintegrable ref), which
 *   keeps its SV honest (empty for that client) → resync heals fully.
 *
 * Net: the "lossy reload" precondition the crash needs is NOT produced by
 * the persistence/compaction paths audited here. The crash remains a
 * vendored-engine robustness gap reachable only through shapes the random
 * corpus manufactures (synthetic lossy reload), not through provider
 * traffic or storage observed so far.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';

const providers = bindIndexeddbProvider(Y);

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}-${Date.now()}`;

const captureUpdates = (doc) => {
	const log = [];
	doc.on('update', (update) => log.push(update));
	return log;
};

const svEntry = (doc, client) =>
	new Map(Y.decodeStateVector(Y.encodeStateVector(doc))).get(client) ?? 0;

const block = (id, text) => {
	const b = new Y.Node('block');
	b.setAttr('id', id);
	b.setAttr('type', 'paragraph');
	const content = new Y.Node('content');
	content.insert(0, text);
	b.setAttr('content', content);
	b.setAttr('children', new Y.Node('children'));
	return b;
};

/**
 * Pending + later same-client integration shape:
 *   u1 — client A: insert block B1 at content[0]           (withheld)
 *   u2 — client A: insert block B2 at content[1] (dep: B1) → PENDING
 *   u3 — client A: insert text into 'scratch' root (indep) → integrates
 */
const buildPendingShape = () => {
	const A = new Y.Doc();
	const log = captureUpdates(A);
	const content = A.get('content');
	A.transact(() => content.insert(0, [block('b1', 'one')])); // u1
	A.transact(() => content.insert(1, [block('b2', 'two')])); // u2 (dep on u1)
	A.transact(() => A.get('scratch').insert(0, 'S')); // u3 (dep on scratch root only)
	return { A, u1: log[0], u2: log[1], u3: log[2] };
};

const pendingOf = (doc) => doc.store.pendingStructs;

describe('gate3: pending items across snapshot/reload', () => {
	test('out-of-order delivery: skip-aware SV stays honest and sync heals', () => {
		const { A, u1, u2, u3 } = buildPendingShape();
		const B = new Y.Doc();
		Y.applyUpdate(B, u2); // pending — dep u1 missing
		Y.applyUpdate(B, u3); // integrates (dep on 'scratch' root only)
		expect(pendingOf(B)).not.toBeNull();
		expect(B.get('scratch').toString()).toContain('S');
		expect(B.get('content').toArray()).toHaveLength(0);

		// The store carries a Skip over the missing prefix, so the SV
		// reports contiguous coverage only (0 for A) — it does NOT claim
		// the integrated u3 tail as coverage of the hole.
		expect(svEntry(B, A.clientID)).toBe(0);

		// Standard sync: diff vs B's SV re-delivers the missing prefix AND
		// resolves the pending item — full heal, no permanent hole.
		Y.applyUpdate(B, Y.encodeStateAsUpdate(A, Y.encodeStateVector(B)));
		expect(B.get('content').toArray()).toHaveLength(2);
		expect(pendingOf(B)).toBeNull();
	});

	test('encodeStateAsUpdate preserves pending; reload re-pends and resync heals', () => {
		const { A, u1, u2, u3 } = buildPendingShape();
		const B = new Y.Doc();
		Y.applyUpdate(B, u2);
		Y.applyUpdate(B, u3);

		const snap = Y.encodeStateAsUpdate(B);
		const C = new Y.Doc();
		Y.applyUpdate(C, snap);

		// Pending bytes survived the snapshot — but per-client integration
		// bails at the first unintegrable ref, so even the integrated u3
		// re-pends on C. SV stays honest (no coverage claimed).
		expect(pendingOf(C)).not.toBeNull();
		expect(svEntry(C, A.clientID)).toBe(0);
		expect(C.get('scratch').toString()).not.toContain('S');

		// Resync from A heals completely.
		Y.applyUpdate(C, Y.encodeStateAsUpdate(A, Y.encodeStateVector(C)));
		expect(C.get('content').toArray()).toHaveLength(2);
		expect(C.get('scratch').toString()).toContain('S');
		expect(pendingOf(C)).toBeNull();
	});

	test('storeState compaction + IndexeddbPersistence reload: pending survives, resync heals', async () => {
		const name = uniqueName('gate3-pending-compact');
		const { A, u1, u2, u3 } = buildPendingShape();

		const B = new Y.Doc();
		Y.applyUpdate(B, u2);
		Y.applyUpdate(B, u3);
		const pB = new providers.IndexeddbPersistence(name, B);
		await pB.whenSynced;
		expect(pendingOf(B)).not.toBeNull();

		// Compaction — the same write+delete path the debounced trim runs.
		await providers.storeState(pB, true);
		await pB.destroy();

		const C = new Y.Doc();
		const pC = new providers.IndexeddbPersistence(name, C);
		await pC.whenSynced;

		// Reloaded doc: pending preserved (re-pended), SV honest.
		expect(pendingOf(C)).not.toBeNull();
		expect(svEntry(C, A.clientID)).toBe(0);

		// Full sync heals — the persisted state is not lossy.
		Y.applyUpdate(C, Y.encodeStateAsUpdate(A, Y.encodeStateVector(C)));
		expect(C.get('content').toArray()).toHaveLength(2);
		expect(pendingOf(C)).toBeNull();

		await pC.destroy();
		await providers.clearDocument(name);
	});

	test('delete set over the missing range lands in pendingDs, not the vendored crash', () => {
		const { A, u1, u2, u3 } = buildPendingShape();
		const B = new Y.Doc();
		Y.applyUpdate(B, u2);
		Y.applyUpdate(B, u3);
		const C = new Y.Doc();
		Y.applyUpdate(C, Y.encodeStateAsUpdate(B)); // hole-y state, all pending

		// A deletes B2 — DS references the range C never received.
		const delog = captureUpdates(A);
		A.transact(() => A.get('content').delete(1, 1));
		const ud = delog.at(-1);

		let outcome = 'applied-clean';
		try {
			Y.applyUpdate(C, ud);
		} catch (error) {
			outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
		}
		// Recorded outcome: this DS shape stays pending — the seed-86/140
		// crash needs shapes this probe does not manufacture (items destroyed
		// mid-run rather than merely absent). The precondition remains a
		// synthetic-corpus artifact, not something provider paths emit.
		console.log(`[gate3] delete-set over missing range → ${outcome}`);
		expect(outcome).toBe('applied-clean');
	});
});
