/**
 * HARDENING U5 — FIXED model bug (was corpus seed 96, strict lanes).
 *
 * `resolvePlacements` used to rehome a block whose placement candidates
 * were ALL gone — "every placement write was undone", candidates consumed
 * by a pending-drop + reload, or every candidate cycle-rejected with no
 * rank surviving — at the root under `MIN_RANK = encodeRank([{v:
 * RANK_VMIN, t: 0}])` (the "deterministic bottom rank" fallback). The
 * rehomed block sorted FIRST in its sibling list, and the next legal
 * `insertBlock`/`moveBlock` targeting index 0 called
 * `rankBetween(undefined, MIN_RANK)` → `rSeg.v <= RANK_VMIN` →
 * `RankSpaceExhausted` — the guard documented as "requires ~2^40
 * sequential boundary inserts; unreachable in practice", reached with
 * zero boundary inserts (corpus seed 96, step 185; artifacts were
 * `random/failures/seed-96.{model,doc}.json`, self-cleaned by the corpus
 * once the seed went green).
 *
 * FIX (placement/model.ts `rehomeRankBelow`): a candidate-less block now
 * mints a deterministic rank strictly BELOW the current root minimum
 * (`min[0].v - 1`, fixed tiebreak) instead of the absolute floor. Because
 * resolution is pure over replicated state, the minted rank tracks the
 * current minimum — the rehomed block stays pinned at the front of the
 * root (the documented "orphans rehome to the front" intent) and inserts
 * targeting index 0 land immediately after it, never throwing. The
 * ~2^40-insert exhaustion bound is restored: each boundary insert
 * consumes one more digit of headroom instead of crashing at zero.
 */
// @ts-nocheck -- reaches into engine internals to stage the precondition.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../lib/crdt/index.js';
import { decodeRank, RANK_VMIN } from '../../../lib/crdt/placement/rank.js';
import type { EngineNode } from '../../../lib/crdt/engine-api.js';

const M = bindModel(Y);

/** Strip every placement candidate off `id`'s `at` node — the rehome precondition. */
const stripCandidates = (doc, id) => {
	doc.transact(() => {
		const at = M.blockNodeOf(doc, id)!.getAttr('at') as EngineNode;
		for (const k of [...at.attrKeys()]) at.deleteAttr(k);
	});
};

describe('U5 — candidate-less rehome stays insertable-around (seed 96 fixed)', () => {
	test('insertBlock above a candidate-less rehomed sibling does not throw', () => {
		const doc = new Y.Doc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'orphan', type: 'paragraph' });
		stripCandidates(doc, 'orphan');
		// Precondition: no candidates → rehomed at root index 0.
		expect(M.candidatesOf(M.blockNodeOf(doc, 'orphan')!)).toEqual([]);
		expect(M.positionOf(doc, 'orphan')).toEqual({ parent: null, index: 0 });
		// The op that used to crash with RankSpaceExhausted.
		expect(() =>
			M.insertBlock(doc, { parent: null, index: 0 }, { id: 'b', type: 'paragraph' })
		).not.toThrow();
		// The rehome stays pinned at the front; the insert lands right
		// below it — deterministic, convergent, no throw.
		expect(M.positionOf(doc, 'orphan')).toEqual({ parent: null, index: 0 });
		expect(M.positionOf(doc, 'b')).toEqual({ parent: null, index: 1 });
		expect(M.positionOf(doc, 'a')).toEqual({ parent: null, index: 2 });
	});

	test('rehomed ranks sit strictly above the absolute floor — repeated inserts at 0 keep working', () => {
		const doc = new Y.Doc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'orphan', type: 'paragraph' });
		stripCandidates(doc, 'orphan');
		// The rehome rank must not itself be the floor — inserts above it
		// need digit headroom below it.
		const { placements } = M.view(doc);
		const rehomeRank = placements.get('orphan')!.rank;
		expect(decodeRank(rehomeRank)[0].v).toBeGreaterThan(RANK_VMIN);
		// Sequential inserts at index 0 — the path that threw — now mints
		// `v-1` each time; the floater re-sinks below each new minimum.
		for (let i = 0; i < 4; i++) {
			expect(
				M.insertBlock(doc, { parent: null, index: 0 }, { id: `b${i}`, type: 'paragraph' })
			).toBe(true);
		}
		expect(M.listBlockIds(doc)).toEqual(['orphan', 'b3', 'b2', 'b1', 'b0', 'a']);
	});

	test('multiple candidate-less blocks rehome to distinct deterministic ranks (id order)', () => {
		const doc = new Y.Doc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'o1', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 2 }, { id: 'o2', type: 'paragraph' });
		stripCandidates(doc, 'o1');
		stripCandidates(doc, 'o2');
		const { placements } = M.view(doc);
		const r1 = placements.get('o1')!.rank;
		const r2 = placements.get('o2')!.rank;
		expect(r1).not.toBe(r2);
		// Ascending-id order at the root — the old MIN_RANK tie order.
		expect(r1 < r2).toBe(true);
		expect(M.positionOf(doc, 'o1')).toEqual({ parent: null, index: 0 });
		expect(M.positionOf(doc, 'o2')).toEqual({ parent: null, index: 1 });
		expect(M.positionOf(doc, 'a')).toEqual({ parent: null, index: 2 });
		// Insertable next to the stack — lands below both floaters.
		expect(M.insertBlock(doc, { parent: null, index: 0 }, { id: 'b', type: 'paragraph' })).toBe(
			true
		);
		expect(M.listBlockIds(doc)).toEqual(['o1', 'o2', 'b', 'a']);
	});

	test('rehome resolution is identical on a synced replica (deterministic)', () => {
		const doc = new Y.Doc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'o1', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 2 }, { id: 'o2', type: 'paragraph' });
		stripCandidates(doc, 'o1');
		stripCandidates(doc, 'o2');
		const remote = new Y.Doc();
		remote.clientID = doc.clientID + 999; // different clientID — must not matter
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
		const local = M.view(doc).placements;
		const repl = M.view(remote).placements;
		for (const id of ['o1', 'o2', 'a']) {
			expect(repl.get(id)).toEqual(local.get(id));
		}
	});

	// Control: the same rehome state is itself a legal projection — the
	// defect was in rank allocation, not in the oracle reading it.
	test('a candidate-less block rehomes to root index 0 (precondition check)', () => {
		const doc = new Y.Doc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'orphan', type: 'paragraph' });
		stripCandidates(doc, 'orphan');
		expect(M.positionOf(doc, 'orphan')).toEqual({ parent: null, index: 0 });
		// Inserting BELOW the rehomed sibling was always legal — the defect
		// was specific to inserting ABOVE the floor sentinel.
		expect(M.insertBlock(doc, { parent: null, index: 1 }, { id: 'b', type: 'paragraph' })).toBe(
			true
		);
	});
});
