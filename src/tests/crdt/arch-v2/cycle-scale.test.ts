/**
 * A cycle resolves locally (design §6, fork patch YP22): a two-block cycle
 * race — Ada nests X under Y while Bob nests Y under X — costs the same
 * index work on a 5,000-block document as on a 1,000-block one. The
 * rejected block is the one whose edge is the oldest of the cycle; it shows
 * at the root's tail (the parentless fallback), and no global pass runs:
 * the placements decided are the cycle's, not the document's (before, the
 * global resolution decided every block: 1,001 and 5,001). A scaling
 * contract on the index's counters, never a wall clock.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, createDocument, loadDocument } from '$lib/crdt/index.js';
import { indexChecks } from '$lib/crdt/text/runs.js';

const crdt = bindCrdt(Y);
// The index's self-checks recompute every cached block after each fold: off, so the counters are the index's own.
const checks = indexChecks.on;
beforeAll(() => void (indexChecks.on = false));
afterAll(() => void (indexChecks.on = checks));
const REMOTE = Object.freeze({ cycle: 'remote' });

const blocks = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block ${i}` }]
	}));
const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** The race on `n` blocks: what Ada's index did to apply Bob's move, and where both blocks landed. */
const race = (n: number) => {
	const seed = createDocument({ value: { children: blocks(n) } });
	const update = seed.encode();
	seed.destroy();
	const a = loadDocument(update);
	const b = loadDocument(update);
	const [x, y] = [`b${n >> 1}`, `b${(n >> 1) + 1}`];
	const svA = Y.encodeStateVector(a.doc);
	const svB = Y.encodeStateVector(b.doc);
	ok(a.facade.nestBlock(x, y));
	ok(b.facade.nestBlock(y, x));
	const ua = Y.encodeStateAsUpdate(a.doc, svA);
	const ub = Y.encodeStateAsUpdate(b.doc, svB);
	a.facade.toJSON();
	b.facade.toJSON();
	const dbg = a.facade.runsView.debug;
	dbg.reset();
	crdt.sync.applyRemote(a.doc, ub, REMOTE);
	a.facade.childrenIds(null);
	const work = {
		folds: dbg.folds,
		foldedPairs: dbg.foldedPairs,
		foldedStructs: dbg.foldedStructs,
		recomputes: dbg.recomputes,
		itemsWalked: dbg.itemsWalked,
		placements: dbg.placements
	};
	crdt.sync.applyRemote(b.doc, ua, REMOTE);
	const converged = JSON.stringify(a.facade.toJSON()) === JSON.stringify(b.facade.toJSON());
	const where = {
		x: a.facade.positionOf(x),
		y: a.facade.positionOf(y),
		top: a.facade.childrenIds(null).length
	};
	a.destroy();
	b.destroy();
	return { work, converged, where, n };
};

describe('a two-block cycle race resolves locally', () => {
	it('the same index work at 5,000 blocks as at 1,000; the rejected block at the root’s tail', () => {
		const small = race(1000);
		const large = race(5000);
		expect(small.converged).toBe(true);
		expect(large.converged).toBe(true);
		for (const key of [
			'folds',
			'foldedPairs',
			'foldedStructs',
			'recomputes',
			'itemsWalked'
		] as const)
			expect(large.work[key], `${key} (${small.work[key]} at 1,000)`).toBeLessThanOrEqual(
				small.work[key] + 4
			);
		// The placements decided: the cycle's two blocks (one of them twice when the
		// incoming edge wins and the standing one is rejected), never the document.
		expect(small.work.placements).toBeLessThanOrEqual(4);
		expect(large.work.placements).toBeLessThanOrEqual(4);
		// One block holds the other; the rejected one shows last at the root (the parentless fallback).
		for (const { where, n } of [small, large]) {
			const [outer, inner] = where.x.parent === null ? [where.x, where.y] : [where.y, where.x];
			expect(outer.parent).toBeNull();
			expect(outer.index).toBe(where.top - 1);
			expect(outer.index).toBe(n - 2);
			expect(inner.index).toBe(0);
		}
	});
});
