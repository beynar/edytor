/**
 * Active §8 scenarios for the U03 placement model (ModelOps adapter).
 *
 * These run in the green lane (`pnpm test:crdt`) via `scenarios.test.ts`.
 * Each scenario states which §8 requirement it satisfies under the placement
 * representation — the pending rows for MV01–MV10 are removed by the same
 * unit that lands this file.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import { createPeerPair, createPeerTriple } from '../harness/peer-set.js';
import { createModelOps, model } from '../harness/ops/model-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { MODEL_BASE_SEED, modelSpecSeed } from './seeds.js';
import type { Scenario } from './registry.js';

const ops = createModelOps();

const topIds = (peer) => ops.project(peer).children.map((b) => b.id);
const childIds = (peer, id) =>
	ops
		.project(peer)
		.children.find((b) => b.id === id)
		?.children.map((b) => b.id);

export const modelScenarios: Scenario[] = [
	// ── MV01 ────────────────────────────────────────────────────────────
	{
		id: 'MV01',
		requirement: 'MV01',
		title: 'move text-bearing block while peer edits/formats inside it',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			const idBefore = ops.crdtId(A, 'b1');
			ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
			ops.insertText(B, 'b1', 5, '-EDIT');
			ops.setMark(B, 'b1', 0, 3, 'italic', true);
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 0 });
			expect(ops.blockText(A, 'b1')).toBe('hello-EDIT world');
			expect(ops.crdtId(A, 'b1')).toBe(idBefore); // engine identity survived
		}
	},

	// ── MV02 ────────────────────────────────────────────────────────────
	{
		id: 'MV02',
		requirement: 'MV02',
		title: 'same block concurrently moved to different positions/parents → one winner',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 }); // (seq 2, client 1)
			ops.moveBlock(B, 'b1', { parent: null, index: 2 }); // (seq 2, client 2) wins
			set.deliver('A', 'B', { reverse: true });
			set.deliver('B', 'A', { reverse: true });
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
			expect(ops.listBlockIds(A).filter((i) => i === 'b1')).toHaveLength(1);
		}
	},

	// ── MV03 ────────────────────────────────────────────────────────────
	{
		id: 'MV03',
		requirement: 'MV03',
		title: 'reorder first/last/middle, no-op, adjacent gap, both directions',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const A = set.A;
			// first → last
			expect(ops.moveBlock(A, 'b1', { parent: null, index: 2 })).toBe(true);
			expect(topIds(A)).toEqual(['b2', 'b3', 'b1']);
			// last → first
			expect(ops.moveBlock(A, 'b1', { parent: null, index: 0 })).toBe(true);
			expect(topIds(A)).toEqual(['b1', 'b2', 'b3']);
			// middle swap both directions
			expect(ops.moveBlock(A, 'b2', { parent: null, index: 2 })).toBe(true);
			expect(topIds(A)).toEqual(['b1', 'b3', 'b2']);
			expect(ops.moveBlock(A, 'b2', { parent: null, index: 0 })).toBe(true);
			expect(topIds(A)).toEqual(['b2', 'b1', 'b3']);
			// no-op
			expect(ops.moveBlock(A, 'b1', { parent: null, index: 1 })).toBe(true);
			expect(topIds(A)).toEqual(['b2', 'b1', 'b3']);
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
		}
	},

	// ── MV04 ────────────────────────────────────────────────────────────
	{
		id: 'MV04',
		requirement: 'MV04',
		title: 'nest/unnest and move subtree while descendants are edited',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.nestBlock(A, 'b3', 'b1');
			ops.insertText(B, 'b3a', 7, ' +remote');
			ops.moveBlock(B, 'b3a', { parent: 'b1', index: 1 });
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.positionOf(A, 'b3')).toEqual({ parent: 'b1', index: 0 });
			expect(ops.positionOf(A, 'b3a')).toEqual({ parent: 'b1', index: 1 });
			expect(ops.blockText(A, 'b3a')).toBe('child a +remote');
		}
	},

	// ── MV05 ────────────────────────────────────────────────────────────
	{
		id: 'MV05a',
		requirement: 'MV05',
		title: 'two-node cycle A-under-B / B-under-A resolves deterministically acyclic',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.nestBlock(A, 'b1', 'b2');
			ops.nestBlock(B, 'b2', 'b1');
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// Winner order (seq,client): b2's cand accepted → b2 under b1;
			// b1's cand would close the cycle → falls back to previous (root).
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
			expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b1', index: 0 });
		}
	},
	{
		id: 'MV05b',
		requirement: 'MV05',
		title: 'three-node ancestor cycle resolves acyclically under any delivery order',
		run: () => {
			const run = (reverse: boolean) => {
				const set = createPeerTriple(MODEL_BASE_SEED);
				ops.nestBlock(set.A, 'b1', 'b3');
				ops.nestBlock(set.B, 'b2', 'b1');
				ops.nestBlock(set.C, 'b3', 'b2');
				if (reverse) {
					for (const [f, t] of [
						['A', 'C'],
						['B', 'C'],
						['C', 'A'],
						['C', 'B'],
						['A', 'B'],
						['B', 'A']
					]) {
						set.deliver(f, t, { reverse: true });
					}
				} else {
					set.deliverAll();
				}
				set.syncAll();
				set.deliverAll();
				assertConverged(set, ops);
				assertAllStructurallyValid(set, ops);
				return set;
			};
			const fwd = run(false);
			const rev = run(true);
			expect(ops.positionOf(fwd.A, 'b1')).toEqual({ parent: null, index: 0 });
			expect(ops.positionOf(fwd.A, 'b2')).toEqual({ parent: 'b1', index: 0 });
			expect(ops.positionOf(fwd.A, 'b3')).toEqual({ parent: 'b2', index: 0 });
			expect(ops.project(rev.A)).toEqual(ops.project(fwd.A));
		}
	},

	// ── MV06 ────────────────────────────────────────────────────────────
	{
		id: 'MV06a',
		requirement: 'MV06',
		title: 'move vs block/subtree deletion — deletion wins, no resurrection',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.deleteBlock(A, 'b2');
			ops.moveBlock(B, 'b2', { parent: 'b3', index: 0 });
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.listBlockIds(A)).toEqual(['b1', 'b3', 'b3a', 'b3b']);
		}
	},
	{
		id: 'MV06b',
		requirement: 'MV06',
		title: 'delete destination parent — child hides with subtree (payload retained)',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.deleteBlock(A, 'b3');
			ops.moveBlock(B, 'b1', { parent: 'b3', index: 0 });
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.listBlockIds(A)).toEqual(['b2']);
			// b1 hidden, not deleted — payload intact in the registry.
			expect(model.blockNodeOf(A.doc, 'b1')).not.toBeNull();
			expect(model.liveNodeOf(A.doc, 'b1')).not.toBeNull();
		}
	},

	// ── MV07 ────────────────────────────────────────────────────────────
	{
		id: 'MV07a',
		requirement: 'MV07',
		title: 'disjoint + overlapping group moves resolve per member',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
			ops.moveBlocks(B, ['b2', 'b3'], { parent: null, index: 2 });
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 0 });
			expect(ops.positionOf(A, 'b2')).toEqual({ parent: null, index: 0 });
			expect(ops.positionOf(A, 'b3')).toEqual({ parent: null, index: 1 });
		}
	},
	{
		id: 'MV07b',
		requirement: 'MV07',
		title: 'group member moved separately resolves per member; group is one undo step',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			A.enableUndo({ scope: A.doc.get('blocks') });
			ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
			ops.moveBlock(B, 'b1', { parent: null, index: 3 });
			set.deliverAll();
			assertConverged(set, ops);
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 1 });
			expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b3', index: 0 });
			// One undo reverts BOTH of A's group writes (single transaction).
			// b1 keeps B's surviving remote placement (root, clamped to index 2);
			// b2 returns to its seed slot. Remote state is untouched.
			A.undoManager.undo();
			expect(topIds(A)).toEqual(['b2', 'b3', 'b1']);
			expect(childIds(A, 'b3')).toEqual(['b3a', 'b3b']);
			expect(ops.crdtId(A, 'b1')).not.toBeNull(); // no resurrection/dup
		}
	},

	// ── MV08 ────────────────────────────────────────────────────────────
	{
		id: 'MV08',
		requirement: 'MV08',
		title: 'concurrent rank collision, then insert between tied neighbors',
		run: () => {
			const set = createPeerTriple(MODEL_BASE_SEED);
			const { A, B, C } = set;
			// Concurrent prepends → same boundary digit, ordered by clientId tie.
			ops.insertBlock(A, { parent: null, index: 0 }, { id: 'insA', type: 'paragraph' });
			ops.insertBlock(B, { parent: null, index: 0 }, { id: 'insB', type: 'paragraph' });
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(topIds(A).slice(0, 3)).toEqual(['insA', 'insB', 'b1']);
			// Insert between the tied neighbors (adjacent-tie descent).
			ops.insertBlock(C, { parent: null, index: 1 }, { id: 'insC', type: 'paragraph' });
			set.deliverAll();
			assertConverged(set, ops);
			expect(topIds(A).slice(0, 4)).toEqual(['insA', 'insC', 'insB', 'b1']);
		}
	},

	// ── MV09 ────────────────────────────────────────────────────────────
	{
		id: 'MV09',
		requirement: 'MV09',
		title: '#694 inserts-then-move with same-transaction reads stays dense (model)',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A } = set;
			for (const id of ['x', 'y', 'z']) {
				ops.insertBlock(A, { parent: null, index: 99 }, { id, type: 'paragraph' });
			}
			A.transact(() => {
				ops.moveBlock(A, 'z', { parent: null, index: 4 });
				// canonical view reads inside the writing transaction: dense,
				// consistent across project / listBlockIds / positionOf.
				expect(ops.listBlockIds(A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b', 'x', 'z', 'y']);
				expect(ops.positionOf(A, 'z')).toEqual({ parent: null, index: 4 });
				expect(ops.project(A).children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'x', 'z', 'y']);
			});
			set.deliverAll();
			assertConverged(set, ops);
		}
	},

	// ── MV10 ────────────────────────────────────────────────────────────
	{
		id: 'MV10',
		requirement: 'MV10',
		title: 'anchor to a moved element: stable handle, deep observer survives the move',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			const handle = ops.resolveBlock(A, 'b1');
			let deepEvents = 0;
			handle.observeDeep(() => deepEvents++);
			ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
			expect(ops.resolveBlock(A, 'b1')).toBe(handle); // same engine handle
			expect(deepEvents).toBeGreaterThan(0);
			ops.insertText(B, 'b1', 0, 'X');
			set.deliver('B', 'A');
			expect(ops.blockText(A, 'b1')).toBe('Xhello world');
			expect(deepEvents).toBeGreaterThan(1);
		}
	}
];
