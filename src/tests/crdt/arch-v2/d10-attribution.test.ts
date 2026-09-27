/**
 * arch-v2 D10 — attribution keyed by the replicated incarnation nonce `n`,
 * no attribution stamp for undo/redo transactions, lineage for undo/redo
 * from a `beforeTransaction` listener.
 *
 * Rows (plan §8): F-O12 (§8.7, R6/R25/F4) and the lineage half of F-U9
 * (§8.2, F4), plus the incarnation contract of §2.1 / O23 / F7 that L64's
 * deletion rests on.
 *
 * - F-O12: attribution over undo/redo. No stamp for undo/redo
 *   transactions; the last changer is restored by undo (R25: `contributors`
 *   is add-only and survives undo, `lastChangedBy` restores).
 * - F-U9 (lineage half): with lineage on, one update per undo and per redo,
 *   and redo stays available.
 * - F7 / O23: a block's incarnation is the replicated nonce `n` (random for
 *   a new block, derived from the seed hash for a seeded one). Redo copies
 *   carry `n`, so every replica — including one that received the redo
 *   remotely and has no local `redone` chain — keeps the same record.
 *
 * Expected values come from the plan rows and R25, never from engine
 * output. Multi-replica rows run three client-id assignments, both delivery
 * orders where two writers are concurrent, duplicate delivery and a binary
 * reload.
 */
// @ts-nocheck -- tests reach raw engine internals (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, createDocument } from '../../../lib/crdt/index.js';
import { lineageOf } from '../../../lib/crdt/attribution/block.js';

const E = bindEdytorDoc(Y);
/** Red on the reference (`arch-v2/ref-d10`); flipped to `it` by the implementation. */
const red = it.fails;
const REMOTE = { remote: true };
const alice = { id: 'alice' };
const bob = { id: 'bob' };

const CLIENT_IDS = [
	{ a: 7, b: 3 },
	{ a: 3, b: 7 },
	{ a: 100, b: 50 }
];

const seeded = (text = 'hello'): Uint8Array => {
	const doc = new Y.Doc();
	E.seed(doc, [{ id: 'p', type: 'paragraph', content: [{ text }] }]);
	return Y.encodeStateAsUpdate(doc);
};

const replica = (base: Uint8Array | null, clientID: number, actor, lineageDepth = 0) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	if (base !== null) Y.applyUpdate(doc, base, REMOTE);
	else E.seed(doc, []);
	const ed = E.create(doc, { actor: () => actor, lineageDepth });
	return { doc, ed };
};

const deliver = (to: Y.Doc, update: Uint8Array) => {
	Y.applyUpdate(to, update, REMOTE);
	Y.applyUpdate(to, update, REMOTE);
};

/** The bytes one local step writes, and how many `update` events it emitted. */
const step = (doc: Y.Doc, fn: () => unknown) => {
	const before = Y.encodeStateVector(doc);
	let updates = 0;
	const count = () => updates++;
	doc.on('update', count);
	try {
		fn();
	} finally {
		doc.off('update', count);
	}
	return { bytes: Y.encodeStateAsUpdate(doc, before), updates };
};

const attr = (ed, id) => {
	const a = ed.blockAttribution(id);
	return a === undefined
		? undefined
		: { createdBy: a.createdBy, contributors: [...a.contributors].sort(), l: a.lastChangedBy };
};

const append = (ed, id, text) => ed.insertText(id, ed.blockText(id).length, text);

/** Nodes on the attribution root (`blockattr`) — records and their attrs. */
const underBlockAttr = (doc, type) => {
	const root = doc.get('blockattr');
	for (let t = type; t !== null && t !== undefined; t = t._item?.parent ?? null) {
		if (t === root) return true;
	}
	return false;
};

/**
 * Every attribution write the transactions `fn` runs make: `[kind, key]`
 * where kind is `record-attr` (a `b/` record's `c`, `k/*`, `i`), `ring` (a
 * lineage list insert/delete), `root` (a `b/` key swap) or `l`.
 */
const attributionWrites = (doc: Y.Doc, fn: () => unknown) => {
	const writes: string[] = [];
	const listen = (tr) => {
		for (const [type, subs] of tr.changed) {
			if (type === doc.get('blockattr')) {
				for (const s of subs) writes.push(`root:${s}`);
			} else if (underBlockAttr(doc, type)) {
				for (const s of subs) writes.push(s === null ? 'ring' : `record-attr:${s}`);
			} else if (subs.has('l') && tr.origin?.constructor?.name !== 'UndoManager') {
				writes.push('l');
			}
		}
	};
	doc.on('afterTransaction', listen);
	try {
		fn();
	} finally {
		doc.off('afterTransaction', listen);
	}
	return writes;
};

const reload = (doc: Y.Doc, clientID: number) => {
	const fresh = new Y.Doc();
	fresh.clientID = clientID;
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc), REMOTE);
	return E.create(fresh);
};

describe('F-O12 — attribution over undo/redo: no stamp; the last changer is restored by undo', () => {
	for (const ids of CLIENT_IDS) {
		for (const depth of [0, 5]) {
			it(`A=${ids.a} B=${ids.b} · lineage ${depth}`, () => {
				const base = seeded();
				const A = replica(base, ids.a, alice, depth);
				const B = replica(base, ids.b, bob, depth);
				const um = B.ed.createUndoManager({ captureTimeout: 0 });

				const a1 = step(A.doc, () => append(A.ed, 'p', '-a'));
				deliver(B.doc, a1.bytes);
				const b1 = step(B.doc, () => append(B.ed, 'p', '-b'));
				deliver(A.doc, b1.bytes);
				const edited = { createdBy: undefined, contributors: ['alice', 'bob'], l: 'bob' };
				expect(attr(A.ed, 'p')).toEqual(edited);

				// Undo: the engine replay restores alice as the last changer;
				// the undo transaction stamps nothing (contributors keep bob).
				let undo;
				const undoWrites = attributionWrites(B.doc, () => {
					undo = step(B.doc, () => expect(um.undo()).not.toBe(null));
				});
				expect(undoWrites.filter((w) => w !== 'ring')).toEqual([]);
				if (depth === 0) expect(undoWrites).toEqual([]);
				deliver(A.doc, undo.bytes);
				const undone = { createdBy: undefined, contributors: ['alice', 'bob'], l: 'alice' };
				for (const ed of [A.ed, B.ed, reload(A.doc, 900), reload(B.doc, 901)]) {
					expect(ed.blockText('p')).toBe('hello-a');
					expect(attr(ed, 'p')).toEqual(undone);
				}

				// Redo: bob is the last changer again; still no stamp.
				let redo;
				const redoWrites = attributionWrites(B.doc, () => {
					redo = step(B.doc, () => expect(um.redo()).not.toBe(null));
				});
				expect(redoWrites.filter((w) => w !== 'ring')).toEqual([]);
				if (depth === 0) expect(redoWrites).toEqual([]);
				deliver(A.doc, redo.bytes);
				for (const ed of [A.ed, B.ed, reload(A.doc, 902), reload(B.doc, 903)]) {
					expect(ed.blockText('p')).toBe('hello-a-b');
					expect(attr(ed, 'p')).toEqual(edited);
				}
			});
		}
	}
});

describe('F-U9 (lineage half) — one update per undo and per redo with lineage on', () => {
	for (const ids of CLIENT_IDS) {
		red(`A=${ids.a} B=${ids.b}`, () => {
			const base = seeded();
			const A = replica(base, ids.a, alice, 5);
			const B = replica(base, ids.b, bob, 5);
			const um = B.ed.createUndoManager({ captureTimeout: 0 });
			deliver(B.doc, step(A.doc, () => append(A.ed, 'p', '-a')).bytes);
			deliver(A.doc, step(B.doc, () => append(B.ed, 'p', '-b')).bytes);

			const undo = step(B.doc, () => expect(um.undo()).not.toBe(null));
			expect(undo.updates).toBe(1);
			expect(um.redoStack.length).toBe(1);
			// The one update carries the text change AND the ring entry.
			const probe = new Y.Doc();
			deliver(probe, Y.encodeStateAsUpdate(A.doc));
			deliver(probe, undo.bytes);
			deliver(A.doc, undo.bytes);
			for (const doc of [A.doc, B.doc, probe]) {
				const ring = lineageOf(doc, 'p');
				expect(ring.at(-1)).toMatchObject({ by: 'bob', j: { content: [{ text: 'hello-a-b' }] } });
			}

			const redo = step(B.doc, () => expect(um.redo()).not.toBe(null));
			expect(redo.updates).toBe(1);
			deliver(A.doc, redo.bytes);
			for (const doc of [A.doc, B.doc]) {
				expect(lineageOf(doc, 'p').at(-1)).toMatchObject({
					by: 'bob',
					j: { content: [{ text: 'hello-a' }] }
				});
			}
			// The public surface: one update per history command as well.
			const D = createDocument({
				actor: bob,
				lineage: { depth: 5 },
				history: { captureTimeout: 0 }
			});
			D.sync();
			const id = D.facade.project().children[0].id;
			D.transact(() => D.facade.insertText(id, 0, 'x'));
			expect(step(D.doc, () => D.history.undo()).updates).toBe(1);
			expect(D.history.canRedo()).toBe(true);
			expect(step(D.doc, () => D.history.redo()).updates).toBe(1);
			D.destroy();
		});
	}
});

describe('F7 / O23 — the incarnation is the replicated nonce; redo copies carry it', () => {
	const nonceOf = (doc, id) => doc.get('blocks').getAttr(id)?.getAttr('n');

	for (const ids of CLIENT_IDS) {
		for (const firstEditor of ['redoer', 'receiver'] as const) {
			red(`A=${ids.a} B=${ids.b} · ${firstEditor} edits first after the redo`, () => {
				const base = seeded();
				const A = replica(base, ids.a, alice);
				const B = replica(base, ids.b, bob);
				const um = A.ed.createUndoManager({ captureTimeout: 0 });

				// Alice creates `x`, undoes the creation, then redoes it: the
				// engine re-creates the registry node as a NEW item.
				const created = step(A.doc, () =>
					A.ed.insertBlock(
						{ parent: null, index: 1 },
						{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
					)
				);
				const n = nonceOf(A.doc, 'x');
				expect(n).not.toBe(undefined);
				const undo = step(A.doc, () => expect(um.undo()).not.toBe(null));
				expect(A.ed.hasBlock('x')).toBe(false);
				const redo = step(A.doc, () => expect(um.redo()).not.toBe(null));
				expect(A.ed.blockText('x')).toBe('x');
				for (const u of [created, undo, redo]) deliver(B.doc, u.bytes);

				// The redo copy carries the nonce on both replicas.
				expect(nonceOf(A.doc, 'x')).toBe(n);
				expect(nonceOf(B.doc, 'x')).toBe(n);
				const born = { createdBy: 'alice', contributors: ['alice'], l: 'alice' };
				expect(attr(A.ed, 'x')).toEqual(born);
				expect(attr(B.ed, 'x')).toEqual(born);

				// Both edit — concurrently, delivered in both orders, duplicated.
				const edits =
					firstEditor === 'redoer'
						? [step(A.doc, () => append(A.ed, 'x', 'A')), step(B.doc, () => append(B.ed, 'x', 'B'))]
						: [
								step(B.doc, () => append(B.ed, 'x', 'B')),
								step(A.doc, () => append(A.ed, 'x', 'A'))
							];
				deliver(B.doc, (firstEditor === 'redoer' ? edits[0] : edits[1]).bytes);
				deliver(A.doc, (firstEditor === 'redoer' ? edits[1] : edits[0]).bytes);

				// Same record on every replica: alice created it; both contributed.
				for (const ed of [A.ed, B.ed, reload(A.doc, 905), reload(B.doc, 906)]) {
					const a = attr(ed, 'x');
					expect(a.createdBy).toBe('alice');
					expect(a.contributors).toEqual(['alice', 'bob']);
				}
				expect(attr(A.ed, 'x')).toEqual(attr(B.ed, 'x'));
			});
		}
	}

	red('a recycled id is a new incarnation: a fresh nonce and a fresh record', () => {
		const A = replica(seeded(), 7, alice);
		const um = A.ed.createUndoManager({ captureTimeout: 0 });
		A.ed.insertBlock({ parent: null, index: 1 }, { id: 'x', type: 'paragraph' });
		const first = nonceOf(A.doc, 'x');
		um.undo();
		const B = replica(Y.encodeStateAsUpdate(A.doc), 3, bob);
		B.ed.insertBlock({ parent: null, index: 1 }, { id: 'x', type: 'paragraph' });
		expect(nonceOf(B.doc, 'x')).not.toBe(first);
		expect(attr(B.ed, 'x')).toEqual({ createdBy: 'bob', contributors: ['bob'], l: 'bob' });
	});

	red('seeded nonces derive from the seed: identical seeds agree, different seeds differ', () => {
		const one = new Y.Doc();
		const two = new Y.Doc();
		const other = new Y.Doc();
		const value = (text) => [{ id: 'p', type: 'paragraph', content: [{ text }] }];
		E.seed(one, value('hello'));
		E.seed(two, value('hello'));
		E.seed(other, value('bye'));
		expect(nonceOf(one, 'p')).not.toBe(undefined);
		expect(nonceOf(one, 'p')).toBe(nonceOf(two, 'p'));
		expect(nonceOf(other, 'p')).not.toBe(nonceOf(one, 'p'));
		// The seed's empty record belongs to the seeded incarnation.
		expect(one.get('blockattr').getAttr('b/p').getAttr('i')).toBe(nonceOf(one, 'p'));
	});
});
