/**
 * HARDENING D2 — `moveBlocks` must not throw on an equal-rank seam
 * (review `docs/archive/elegance-review-2026-09-23.md` §D2).
 *
 * Placement ranks are strings minted by `rankBetween(left, right)`, which
 * throws `RankSpaceExhausted` when `left >= right` with both defined —
 * there is no string strictly between them. Equal-rank neighbours are a
 * legal replicated state: `resolvePlacements`' cycle-fallback rehoming
 * places a block under the rank of its best surviving candidate, and
 * candidates minted in DIFFERENT sibling lists carry no ordering
 * guarantee against each other — two siblings can hold the same rank
 * string (the `(rank, id)` sort then disambiguates by id).
 *
 * `insertBlocks` already guarded this (`ranksAt` joins the left tie);
 * `moveBlocks` called `rankBetween` directly and crashed on the seam —
 * a valid move became an exception inside `doc.transact`. Both ops now
 * share `ranksAt`: on a degenerate seam each moved member takes the LEFT
 * rank verbatim, joining the tie the `(rank, id)` display sort already
 * defines — deterministic and convergent (the rank is replicated state;
 * every replica resolves the same order).
 *
 * (An INVERTED seam — `left.rank > right.rank` — cannot exist between
 * adjacent siblings: the sibling list is `(rank, id)`-sorted, so
 * `left >= right` reduces to `left === right`. The guard covers `>=`
 * anyway; the tests pin the reachable equal-rank shape.)
 *
 * The tests stage the precondition the way the rehome fallback leaves it
 * behind: a direct `at`-map write gives a sibling the SAME rank as its
 * left neighbour, then `moveBlocks`/`moveBlock` target the seam.
 */
// @ts-nocheck -- reaches into engine internals to stage the precondition.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import type { EngineNode } from '../../../lib/crdt/engine-api.js';

const M = bindModel(Y);

const seedRow = (doc) => {
	// a m b x y — x/y are the move payloads; the a|m seam is the tied one.
	M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
	M.insertBlock(doc, { parent: null, index: 1 }, { id: 'm', type: 'paragraph' });
	M.insertBlock(doc, { parent: null, index: 2 }, { id: 'b', type: 'paragraph' });
	M.insertBlock(doc, { parent: null, index: 3 }, { id: 'x', type: 'paragraph' });
	M.insertBlock(doc, { parent: null, index: 4 }, { id: 'y', type: 'paragraph' });
};

/** Overwrite `id`'s winning placement candidate with a doctored rank. */
const plantRank = (doc, id, parent, rank) => {
	doc.transact(() => {
		const at = M.blockNodeOf(doc, id)!.getAttr('at') as EngineNode;
		// seq 9 outranks every `1.<client>` candidate the writes stamped.
		at.setAttr(`9.${doc.clientID}`, { p: parent, r: rank });
	});
};

const rankOf = (doc, id): string => M.view(doc).placements.get(id)!.rank;

describe('D2 — moveBlocks on an equal-rank seam', () => {
	test('equal-rank neighbours: the move joins the left tie, no throw', () => {
		const doc = new Y.Doc();
		seedRow(doc);
		plantRank(doc, 'm', null, rankOf(doc, 'a')); // a and m share one rank
		expect(rankOf(doc, 'a')).toBe(rankOf(doc, 'm'));
		// Seam a|m — left === right: the old `rankBetween(R, R)` threw.
		expect(() => M.moveBlocks(doc, ['x'], { parent: null, index: 1 })).not.toThrow();
		// x joined the tie: (rank, id) order a < m < x.
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'x', 'b', 'y']);
		expect(M.positionOf(doc, 'x')).toEqual({ parent: null, index: 2 });
	});

	test('grouped move onto an equal-rank seam lands consecutively, no throw', () => {
		const doc = new Y.Doc();
		seedRow(doc);
		plantRank(doc, 'm', null, rankOf(doc, 'a'));
		expect(() => M.moveBlocks(doc, ['x', 'y'], { parent: null, index: 1 })).not.toThrow();
		// Both members took the left rank; ids order the group.
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'x', 'y', 'b']);
	});

	test('equal-rank seam under a non-root parent', () => {
		const doc = new Y.Doc();
		// pa with children a, m; x/y at the root.
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'pa', type: 'paragraph' });
		M.insertBlock(doc, { parent: 'pa', index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: 'pa', index: 1 }, { id: 'm', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'x', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 2 }, { id: 'y', type: 'paragraph' });
		plantRank(doc, 'm', 'pa', rankOf(doc, 'a'));
		expect(rankOf(doc, 'a')).toBe(rankOf(doc, 'm'));
		expect(() => M.moveBlocks(doc, ['x', 'y'], { parent: 'pa', index: 1 })).not.toThrow();
		expect(M.positionOf(doc, 'x')).toEqual({ parent: 'pa', index: 2 });
		expect(M.positionOf(doc, 'y')).toEqual({ parent: 'pa', index: 3 });
		// Pre-order: pa, then pa's tied children (rank,id) a m x y.
		expect(M.listBlockIds(doc)).toEqual(['pa', 'a', 'm', 'x', 'y']);
	});

	test('moveBlock (singular) on the same seam also survives', () => {
		const doc = new Y.Doc();
		seedRow(doc);
		plantRank(doc, 'm', null, rankOf(doc, 'a'));
		expect(() => M.moveBlock(doc, 'x', { parent: null, index: 1 })).not.toThrow();
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'x', 'b', 'y']);
	});

	test('the joined-tie placement resolves identically on a synced replica', () => {
		const doc = new Y.Doc();
		seedRow(doc);
		plantRank(doc, 'm', null, rankOf(doc, 'a'));
		M.moveBlocks(doc, ['x', 'y'], { parent: null, index: 1 });
		const remote = new Y.Doc();
		remote.clientID = doc.clientID + 999;
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
		const local = M.view(doc).placements;
		const repl = M.view(remote).placements;
		expect(M.listBlockIds(remote)).toEqual(M.listBlockIds(doc));
		for (const id of ['a', 'm', 'x', 'y', 'b']) {
			expect(repl.get(id)).toEqual(local.get(id));
		}
	});

	test('moving the tied members OFF and BACK does not corrupt the row', () => {
		const doc = new Y.Doc();
		seedRow(doc);
		plantRank(doc, 'm', null, rankOf(doc, 'a'));
		expect(M.moveBlocks(doc, ['x', 'y'], { parent: null, index: 1 })).toBe(true);
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'x', 'y', 'b']);
		// Back out past the tie group — a normal seam mints fresh ranks.
		expect(M.moveBlocks(doc, ['x', 'y'], { parent: null, index: 3 })).toBe(true);
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'b', 'x', 'y']);
		// And back onto the tied seam again — still no throw.
		expect(M.moveBlocks(doc, ['x', 'y'], { parent: null, index: 1 })).toBe(true);
		expect(M.listBlockIds(doc)).toEqual(['a', 'm', 'x', 'y', 'b']);
	});
});
