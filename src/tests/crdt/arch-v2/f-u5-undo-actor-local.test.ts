/**
 * arch-v2 §8.2 F-U5 — undo after collaboration is actor-local.
 *
 * Scenario (plan row F-U5, contract `conc.undo.actor-local` in
 * `docs/editor-delete-contract.md`): `[aa, bb, cc]`; A deletes `bb`; B
 * edits `cc`; A undoes. Expected: `bb` is restored AND `cc` keeps B's edit,
 * on every replica. Expected values are written from the contract, never
 * read back from the engine.
 *
 * §8 multi-replica rules: both delivery orders, duplicate delivery, a binary
 * reload, and at least three client-id assignments.
 *
 * Axes:
 * - `bSawDelete` — B edits after receiving A's delete (sequential, as in
 *   the DOM-lane `command-simulation` test) or concurrently with it.
 * - `aOrder` — at A, B's edit arrives before A undoes, or after the undo
 *   (A undoes while B's edit is still in flight).
 * - client ids `(seed, A, B)` — three assignments covering A < B, A > B and
 *   the seed writer between them (rank / item-order tiebreaks).
 * - an observer replica C receives the three updates in every permutation,
 *   each delivered twice; every replica is also reloaded from its binary
 *   state and re-checked.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);

const p = (id: string) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text: id }]
});

/** Contract result: `bb` back in its slot, `cc` carries B's `!`. */
const EXPECTED = [
	['aa', 'aa'],
	['bb', 'bb'],
	['cc', 'cc!']
];

/**
 * Transport origin for remote updates — like a provider, remote application
 * never runs under the default `null` origin an UndoManager tracks.
 */
const REMOTE = { remote: true };

const shape = (ed) => ed.project().children.map((b) => [b.id, ed.blockText(b.id)]);

const replica = (seedUpdate: Uint8Array, clientID: number) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, seedUpdate, REMOTE);
	return { doc, ed: E.create(doc) };
};

/** Apply an update twice — duplicate delivery must be idempotent. */
const deliver = (to: Y.Doc, update: Uint8Array) => {
	Y.applyUpdate(to, update, REMOTE);
	Y.applyUpdate(to, update, REMOTE);
};

/** Capture exactly the update(s) one local step emits. */
const capture = (doc: Y.Doc, fn: () => void): Uint8Array => {
	const before = Y.encodeStateVector(doc);
	fn();
	return Y.encodeStateAsUpdate(doc, before);
};

const reloadShape = (doc: Y.Doc, clientID: number) => {
	const fresh = new Y.Doc();
	fresh.clientID = clientID;
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc), REMOTE);
	return shape(E.create(fresh));
};

const permutations = <T>(xs: T[]): T[][] =>
	xs.length <= 1
		? [xs]
		: xs.flatMap((x, i) =>
				permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])
			);

const CLIENT_IDS = [
	{ seed: 10, a: 20, b: 30 },
	{ seed: 10, a: 30, b: 20 },
	{ seed: 25, a: 30, b: 20 }
];

describe('F-U5 — A deletes bb; B edits cc; A undoes → bb restored, cc keeps B’s edit', () => {
	for (const ids of CLIENT_IDS) {
		for (const bSawDelete of [true, false]) {
			for (const aOrder of ['edit-then-undo', 'undo-then-edit'] as const) {
				const name = `ids seed=${ids.seed} A=${ids.a} B=${ids.b} · B ${
					bSawDelete ? 'saw' : 'did not see'
				} the delete · A: ${aOrder}`;
				test(name, () => {
					const seedDoc = new Y.Doc();
					seedDoc.clientID = ids.seed;
					E.create(seedDoc).init({ content: [p('aa'), p('bb'), p('cc')] });
					const seedUpdate = Y.encodeStateAsUpdate(seedDoc);

					const A = replica(seedUpdate, ids.a);
					const B = replica(seedUpdate, ids.b);
					const um = A.ed.createUndoManager({ captureTimeout: 0 });

					// A deletes bb.
					const del = capture(A.doc, () => {
						expect(A.ed.block('bb').delete().status).toBe('applied');
					});
					expect(shape(A.ed)).toEqual([
						['aa', 'aa'],
						['cc', 'cc']
					]);

					// B edits cc (after or concurrently with the delete).
					if (bSawDelete) deliver(B.doc, del);
					const edit = capture(B.doc, () => {
						expect(B.ed.block('cc').insertText(2, '!').status).toBe('applied');
					});

					// A undoes, with B's edit delivered before or after the undo.
					if (aOrder === 'edit-then-undo') deliver(A.doc, edit);
					const undo = capture(A.doc, () => {
						expect(um.undo()).not.toBe(null);
					});
					if (aOrder === 'undo-then-edit') deliver(A.doc, edit);

					// B receives the rest of A's history.
					if (!bSawDelete) deliver(B.doc, del);
					deliver(B.doc, undo);

					expect(shape(A.ed), 'A').toEqual(EXPECTED);
					expect(shape(B.ed), 'B').toEqual(EXPECTED);
					expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(EXPECTED);
					expect(reloadShape(B.doc, 901), 'B reloaded').toEqual(EXPECTED);

					// Observer: every delivery order of the three updates, duplicated.
					for (const order of permutations([del, edit, undo])) {
						const C = replica(seedUpdate, 902);
						for (const u of order) deliver(C.doc, u);
						expect(shape(C.ed), 'observer').toEqual(EXPECTED);
						expect(reloadShape(C.doc, 903), 'observer reloaded').toEqual(EXPECTED);
					}
				});
			}
		}
	}
});
