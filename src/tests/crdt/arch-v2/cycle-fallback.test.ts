/**
 * The cycle fallback (fork patch YP22, `placement/resolve.ts`): when two
 * peers move two blocks into each other at once, the later move wins, and the
 * block whose move is the oldest edge of the cycle is back where it stood
 * before that move: at its next live move record (strongest first), else at
 * its home slot. A fallback that closes a cycle too falls further, down the
 * block's own records to home. Every replica, in every delivery order, reads
 * the same tree; the index (maintained) equals its rebuild after every fold
 * (the lanes' self-checks).
 *
 * Expected values come from that rule, never from running code.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, createDocument, loadDocument } from '$lib/crdt/index.js';

const crdt = bindCrdt(Y);
const REMOTE = Object.freeze({ cycle: 'remote' });
const para = (id: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children ? { children } : {})
});
const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};
/** Peers loaded from one seed; `sv` remembers each one's state for its own diff. */
const peers = (children: unknown[], n = 2) => {
	const seed = createDocument({ value: { children } });
	const update = seed.encode();
	seed.destroy();
	return Array.from({ length: n }, () => loadDocument(update));
};
const sync = (from, to) =>
	crdt.sync.applyRemote(
		to.doc,
		Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
		REMOTE
	);
/** The tree as nested ids. */
const tree = (d, parent: string | null = null): unknown[] =>
	d.facade.childrenIds(parent).map((id) => {
		const kids = tree(d, id);
		return kids.length === 0 ? id : { [id]: kids };
	});

describe('cycle fallback: the later move wins, the dropped block is back where it stood', () => {
	it('a block moved twice falls back to its previous record, not home', () => {
		// [p, x, y, z]: Ada nests x under z, then (seen by Bob) Ada nests x under y
		// while Bob nests y under x. Bob's record is the later one (it saw Ada's
		// first move): y under x stands, and x's newest record (under y) closes
		// the cycle → x is back under z, where it stood before.
		const [a, b] = peers([para('p'), para('x'), para('y'), para('z')]);
		ok(a.facade.nestBlock('x', 'z'));
		sync(a, b);
		expect(tree(b)).toEqual(['p', 'y', { z: ['x'] }]);
		ok(a.facade.moveBlocks(['x'], { parent: 'y', index: 0 }));
		ok(b.facade.nestBlock('y', 'x'));
		// Bob writes after seeing Ada's records: his priority is the greater.
		sync(b, a);
		sync(a, b);
		const want = ['p', { z: [{ x: ['y'] }] }];
		expect(tree(a)).toEqual(want);
		expect(tree(b)).toEqual(want);
		a.destroy();
		b.destroy();
	});

	it('when the previous record closes a cycle too, the block falls back home', () => {
		// [p, x, y, z]: Ada nests x under z, everyone sees it. Then at once: Ada
		// nests x under y, Bob nests y under x, Carol nests z under y (Bob's and
		// Carol's records are the later: they saw Ada's first). x→y closes
		// x→y→x; x's older record (under z) closes x→z→y→x → x is back home.
		const [a, b, c] = peers([para('p'), para('x'), para('y'), para('z')], 3);
		ok(a.facade.nestBlock('x', 'z'));
		sync(a, b);
		sync(a, c);
		ok(a.facade.moveBlocks(['x'], { parent: 'y', index: 0 }));
		ok(b.facade.nestBlock('y', 'x'));
		ok(c.facade.nestBlock('z', 'y'));
		for (const [from, to] of [
			[a, b],
			[c, b],
			[b, a],
			[c, a],
			[a, c],
			[b, c]
		])
			sync(from, to);
		const want = ['p', { x: [{ y: ['z'] }] }];
		for (const d of [a, b, c]) expect(tree(d)).toEqual(want);
		for (const d of [a, b, c]) d.destroy();
	});

	it('every delivery order reads the same tree (three peers)', () => {
		const seedTree = [para('p'), para('x'), para('y'), para('z')];
		const run = (order: number[]) => {
			const ps = peers(seedTree, 3);
			const [a, b, c] = ps;
			ok(a.facade.nestBlock('x', 'z'));
			sync(a, b);
			sync(a, c);
			ok(a.facade.moveBlocks(['x'], { parent: 'y', index: 0 }));
			ok(b.facade.nestBlock('y', 'x'));
			ok(c.facade.moveBlocks(['z'], { parent: 'p', index: 0 }));
			const updates = ps.map((p) => Y.encodeStateAsUpdate(p.doc));
			const fresh = peers(seedTree, 1)[0];
			for (const i of order) crdt.sync.applyRemote(fresh.doc, updates[i], REMOTE);
			const out = JSON.stringify(tree(fresh));
			for (const p of [...ps, fresh]) p.destroy();
			return out;
		};
		const orders = [
			[0, 1, 2],
			[0, 2, 1],
			[1, 0, 2],
			[1, 2, 0],
			[2, 0, 1],
			[2, 1, 0]
		];
		const seen = new Set(orders.map(run));
		expect(seen.size).toBe(1);
		// y under x (Bob's), x back under z (its previous record), z under p (Carol's).
		expect(JSON.parse([...seen][0])).toEqual([{ p: [{ z: [{ x: ['y'] }] }] }]);
	});

	it('an undo of the winning move puts the dropped block back at its newest move', () => {
		const seed = createDocument({ value: { children: [para('p'), para('x'), para('y')] } });
		const update = seed.encode();
		seed.destroy();
		const a = loadDocument(update);
		const b = loadDocument(update, { history: { captureTimeout: 0 } });
		void b.history;
		ok(a.facade.nestBlock('x', 'y'));
		sync(a, b);
		ok(a.facade.unNestBlock('x'));
		sync(a, b);
		// Ada nests x under y again while Bob, who saw her moves, nests y under x:
		// Bob's record is the later; x is back where it stood (the root).
		ok(a.facade.nestBlock('x', 'y'));
		b.transact(() => ok(b.facade.nestBlock('y', 'x')));
		sync(b, a);
		sync(a, b);
		expect(tree(a)).toEqual(['p', { x: ['y'] }]);
		expect(tree(b)).toEqual(['p', { x: ['y'] }]);
		// Bob undoes: his record goes, Ada's newest move stands again.
		b.history.undo();
		sync(b, a);
		expect(tree(b)).toEqual(['p', { y: ['x'] }]);
		expect(tree(a)).toEqual(['p', { y: ['x'] }]);
		a.destroy();
		b.destroy();
	});
});
