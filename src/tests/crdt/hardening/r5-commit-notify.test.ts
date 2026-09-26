/**
 * HARDENING U0 / R5 — subscriber notified with mid-transaction state
 * (review `docs/crdt-v14-follow-up-review-2026-09-21.md` §R5, P1).
 *
 * `runs`' maintained block state is published to `subscribeBlock` listeners
 * the moment a facade write lands — `doc.transact`-internal `update` emission
 * happens per nested transaction, so a read INSIDE an outer `ed.transact()`
 * (`void ed.block('b').runs`) materializes + publishes the half-finished
 * state. The listener sees `'ab'` while the transaction is still open, then
 * `'abc'` at commit.
 *
 * EXPECTED: subscribers observe committed states only — a single `'abc'`.
 *
 * OBSERVED today (vitest run, this file):
 *   cb receives ['ab', 'abc'] — 'ab' published mid-transaction.
 *
 * This test asserts the CORRECT semantics — it was RED until U4 deferred
 * publication to the commit boundary (`flushPending` inside the registry
 * `observeDeep` handler, which runs during transaction cleanup).
 */
// @ts-nocheck
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);

const flatten = (runs: readonly { kind: string; text?: string }[]) =>
	runs.map((r) => (r.kind === 'text' ? r.text : `#${r.kind}`)).join('');

describe('R5 — subscribers see committed state only', () => {
	test('a mid-transaction runs read does not publish intermediate state', () => {
		const doc = new Y.Doc();
		doc.clientID = 700_001;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] }]
		});

		const seen: string[] = [];
		const off = ed.subscribeBlock('b', (runs) => seen.push(flatten(runs)));

		ed.transact(() => {
			ed.insertText('b', 1, 'b');
			void ed.block('b').runs; // mid-transaction read — triggers premature publish
			ed.insertText('b', 2, 'c');
		});

		// OBSERVED: ['ab', 'abc']. Expected: ['abc'].
		expect(seen).toEqual(['abc']);
		off();
	});

	test('without the mid-transaction read the listener is called once', () => {
		const doc = new Y.Doc();
		doc.clientID = 700_002;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] }]
		});
		const seen: string[] = [];
		ed.subscribeBlock('b', (runs) => seen.push(flatten(runs)));
		ed.transact(() => {
			ed.insertText('b', 1, 'b');
			ed.insertText('b', 2, 'c');
		});
		// Control case — must stay green both before and after the fix.
		expect(seen).toEqual(['abc']);
	});

	test('nested transactions publish once, at the OUTER commit', () => {
		const doc = new Y.Doc();
		doc.clientID = 700_003;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] }]
		});
		const seen: string[] = [];
		ed.subscribeBlock('b', (runs) => seen.push(flatten(runs)));
		ed.transact(() => {
			ed.insertText('b', 1, 'b');
			ed.transact(() => {
				ed.insertText('b', 2, 'c');
				void ed.block('b').runs; // mid-NESTED-transaction read
			});
			void ed.block('b').runs; // mid-outer read
		});
		expect(seen).toEqual(['abc']);
	});

	test('one commit covering several blocks notifies each subscriber once', () => {
		const doc = new Y.Doc();
		doc.clientID = 700_004;
		const ed = E.create(doc);
		ed.init({
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'A' }] },
				{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'B' }] }
			]
		});
		const seenA: string[] = [];
		const seenB: string[] = [];
		ed.subscribeBlock('a', (runs) => seenA.push(flatten(runs)));
		ed.subscribeBlock('b', (runs) => seenB.push(flatten(runs)));
		ed.transact(() => {
			ed.insertText('a', 1, '1');
			void ed.block('a').runs;
			ed.insertText('b', 1, '2');
			void ed.block('b').runs;
		});
		expect(seenA).toEqual(['A1']);
		expect(seenB).toEqual(['B2']);
	});

	test('change-then-revert inside one transaction publishes nothing', () => {
		const doc = new Y.Doc();
		doc.clientID = 700_005;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] }]
		});
		const seen: string[] = [];
		ed.subscribeBlock('b', (runs) => seen.push(flatten(runs)));
		ed.transact(() => {
			ed.insertText('b', 1, 'x');
			void ed.block('b').runs; // publishes 'ax' before the fix
			ed.deleteText('b', 1, 1);
			void ed.block('b').runs; // and 'a' again — net-zero must stay silent
		});
		expect(seen).toEqual([]);
		// A real follow-up change still notifies exactly once.
		ed.insertText('b', 1, 'z');
		expect(seen).toEqual(['az']);
	});

	test('remote updates and undo/redo notify once with committed state', () => {
		const docA = new Y.Doc();
		docA.clientID = 700_006;
		const edA = E.create(docA);
		edA.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] }]
		});
		const docB = new Y.Doc();
		docB.clientID = 700_007;
		const edB = E.create(docB);
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		const seen: string[] = [];
		edB.subscribeBlock('b', (runs) => seen.push(flatten(runs)));
		const undo = edB.createUndoManager();
		// Remote commit lands as ONE notification with the final state.
		edA.insertText('b', 1, 'x');
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		expect(seen).toEqual(['ax']);

		// Undo/redo are committed transactions too — one notification each.
		undo.undo();
		expect(seen).toEqual(['ax', 'a']);
		undo.redo();
		expect(seen).toEqual(['ax', 'a', 'ax']);
	});
});
