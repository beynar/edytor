/**
 * arch-v2 — P2.8 fix row (doc lane): the index's cached display of a block is
 * invalidated by EVERY claim its display walk read, including the claims it
 * did not follow.
 *
 * `display(x)` follows a merge claim `{m}` on `x`'s list only while `m` is live
 * and `x` is `m`'s max-stamp live claimer. A claim that fails either test is
 * still an input: when it becomes effective, `x`'s display grows. The wide R1
 * corpus (`R1_CELLS_SEEDS=1-1500`, 33 red seeds) splits into exactly two such
 * groups:
 *
 * - (A) revival: `m` is deleted while `x` claims it (a concurrent delete and
 *   merge), then the delete mark goes away (undo) — `x` now shows `m`.
 * - (B) claimer hand-over: `m`'s winning claim is held by another block `z`;
 *   `z`'s claim goes away (undo of its merge) or `z` is deleted — `x` becomes
 *   `m`'s top claimer and now shows `m`.
 *
 * In both, no fact of `x` itself changes: before the fix the cached runs of
 * `x` stayed stale and no report named it.
 *
 * The wider corpus (`R1_CELLS_SEEDS=1-3000`) found one more seed (2999) with a
 * different cause, in the report's `removed` set: (C) a block that leaves
 * while its before-parent stays visible (moved out of a removed subtree) is a
 * removed ROOT. The report named only the subtree's top, the cells' drop
 * stops at a surviving child, and the orphan cell came back stale (K7) when
 * the block became visible again.
 *
 * Expected values come from `project()` (the from-scratch display), never
 * from the cache under test.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { setDocRand } from '../../../lib/crdt/rand.js';

const lib = import.meta.glob('../../../lib/surface/cells.ts', { eager: true });
const { createCells } = Object.values(lib)[0] ?? {};

const E = bindEdytorDoc(Y);

const p = (id: string, text: string) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text }]
});

const open = (clientID: number, content?: unknown[], bytes?: Uint8Array) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	let seed = clientID * 7919;
	setDocRand(doc, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
	if (bytes) Y.applyUpdate(doc, bytes);
	const ed = E.create(doc);
	if (content) ed.init({ content });
	return { doc, ed, reports: [] as unknown[] };
};

/** Deliver every update each side has that the other lacks. */
const sync = (a, b) => {
	const [sa, sb] = [Y.encodeStateVector(a.doc), Y.encodeStateVector(b.doc)];
	Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, sb), 'remote');
	Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, sa), 'remote');
};

const text = (runs) => runs.map((r) => (r.kind === 'text' ? r.text : `[${r.id}]`)).join('');

/** The from-scratch display of `id`, read from the projection. */
const projected = (ed, id: string) => {
	const find = (nodes) => {
		for (const n of nodes) {
			if (n.id === id) return n;
			const hit = find(n.children);
			if (hit) return hit;
		}
	};
	return text(find(ed.project().children)?.content ?? []);
};

/** Subscribe, run `op`, and return the display `id` reports in the last change (or undefined). */
const reported = (r, op: () => void, id: string) => {
	const changes = [];
	const off = r.ed.onChange((c) => changes.push(c));
	op();
	off();
	const last = changes.filter((c) => c.content.has(id)).at(-1);
	return last && text(last.content.get(id));
};

// Three client-id assignments: which side's stamp wins must not matter.
const assignments = [
	[1, 2],
	[2, 1],
	[100, 50]
];

describe('P2.8 fix — a skipped claim still invalidates its holder', () => {
	for (const [a, b] of assignments) {
		test(`(A) revival: an undone delete of a claimed block shows in its claimer (clients ${a}/${b})`, () => {
			const A = open(a, [p('x', 'xx'), p('m', 'mm')]);
			const B = open(b, undefined, Y.encodeStateAsUpdate(A.doc));
			const um = A.ed.createUndoManager({ captureTimeout: 0 });
			// Concurrently: A deletes `m`, B merges `m` into `x`.
			A.ed.deleteBlock('m');
			B.ed.mergeBlocks('m', 'x');
			sync(A, B);
			// `x` claims a deleted block: the claim is inert, `x` shows its own text.
			expect(text(A.ed.runs('x'))).toBe('xx');
			expect(projected(A.ed, 'x')).toBe('xx');
			// A's undo removes the delete mark: `x` now shows `m`.
			const got = reported(A, () => um.undo(), 'x');
			expect(projected(A.ed, 'x')).toBe('xxmm');
			expect(text(A.ed.runs('x'))).toBe('xxmm');
			expect(got).toBe('xxmm');
			sync(A, B);
			expect(text(B.ed.runs('x'))).toBe(projected(B.ed, 'x'));
		});

		test(`(B) hand-over: undoing the winning merge hands the claimed block to the other claimer (clients ${a}/${b})`, () => {
			const A = open(a, [p('x', 'xx'), p('z', 'zz'), p('m', 'mm')]);
			const B = open(b, undefined, Y.encodeStateAsUpdate(A.doc));
			const ua = A.ed.createUndoManager({ captureTimeout: 0 });
			const ub = B.ed.createUndoManager({ captureTimeout: 0 });
			// Concurrently: A merges `m` into `x`, B merges `m` into `z`.
			A.ed.mergeBlocks('m', 'x');
			B.ed.mergeBlocks('m', 'z');
			sync(A, B);
			const winner = projected(A.ed, 'x') === 'xxmm' ? 'x' : 'z';
			const loser = winner === 'x' ? 'z' : 'x';
			const W = winner === 'x' ? A : B;
			const L = winner === 'x' ? B : A;
			expect(projected(W.ed, loser)).toBe(`${loser}${loser}`);
			expect(text(W.ed.runs(loser))).toBe(`${loser}${loser}`);
			expect(text(L.ed.runs(loser))).toBe(`${loser}${loser}`);
			// The winner's replica undoes its merge: the loser now shows `m`.
			const got = reported(W, () => (winner === 'x' ? ua : ub).undo(), loser);
			expect(projected(W.ed, loser)).toBe(`${loser}${loser}mm`);
			expect(text(W.ed.runs(loser))).toBe(`${loser}${loser}mm`);
			expect(got).toBe(`${loser}${loser}mm`);
			// The other replica learns it remotely.
			const remote = reported(L, () => sync(A, B), loser);
			expect(text(L.ed.runs(loser))).toBe(`${loser}${loser}mm`);
			expect(remote).toBe(`${loser}${loser}mm`);
		});

		test(`(B) hand-over: a remote delete of the winning claimer hands the claimed block over (clients ${a}/${b})`, () => {
			const A = open(a, [p('x', 'xx'), p('z', 'zz'), p('m', 'mm')]);
			const B = open(b, undefined, Y.encodeStateAsUpdate(A.doc));
			// Concurrently: A merges `m` into `x`, B merges `m` into `z`.
			A.ed.mergeBlocks('m', 'x');
			B.ed.mergeBlocks('m', 'z');
			// Third replicas, each forked before seeing the other merge.
			const CA = open(a + b + 1000, undefined, Y.encodeStateAsUpdate(A.doc));
			const CB = open(a + b + 2000, undefined, Y.encodeStateAsUpdate(B.doc));
			sync(A, B);
			const winner = projected(A.ed, 'x') === 'xxmm' ? 'x' : 'z';
			const loser = winner === 'x' ? 'z' : 'x';
			expect(text(A.ed.runs(loser))).toBe(`${loser}${loser}`);
			// A replica that never saw the winning merge deletes the winner:
			// its claims go inert and the loser becomes `m`'s claimer.
			const C = winner === 'x' ? CB : CA;
			C.ed.deleteBlock(winner);
			const got = reported(
				A,
				() => Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(C.doc), 'remote'),
				loser
			);
			expect(projected(A.ed, loser)).toBe(`${loser}${loser}mm`);
			expect(text(A.ed.runs(loser))).toBe(`${loser}${loser}mm`);
			expect(got).toBe(`${loser}${loser}mm`);
		});
	}

	for (const [a, b] of assignments) {
		test(`(C) a block removed under a surviving moved parent is a removed root (clients ${a}/${b})`, () => {
			const A = open(a, [
				p('r', 'rr'),
				{ ...p('a', 'aa'), children: [{ ...p('k', 'kk'), children: [p('g', 'gg')] }] }
			]);
			const B = open(b, undefined, Y.encodeStateAsUpdate(A.doc));
			const um = A.ed.createUndoManager({ captureTimeout: 0 });
			const cells = createCells(A.ed);
			const changes = [];
			A.ed.onChange((c) => changes.push(c));
			// One commit: `k` moves to the root, `a` and `g` are deleted.
			A.ed.transact(() => {
				A.ed.moveBlock('k', { parent: null, index: 0 });
				A.ed.deleteBlock('a');
				A.ed.deleteBlock('g');
			});
			expect(changes).toHaveLength(1);
			expect([...changes[0].removed].sort()).toEqual(['a', 'g']);
			expect(cells.get('g')).toBeUndefined();
			// Concurrently B edits `g`; A learns it while `g` is not visible, then undoes.
			B.ed.insertText('g', 2, '!');
			Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc, Y.encodeStateVector(A.doc)), 'remote');
			um.undo();
			expect(projected(A.ed, 'g')).toBe('gg!');
			expect(text(cells.get('g').runs)).toBe('gg!');
			cells.dispose();
		});
	}
});
