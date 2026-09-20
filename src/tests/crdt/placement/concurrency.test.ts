/**
 * Concurrency proofs for the U03 placement model — every test syncs through
 * the replica harness and asserts on the canonical projection.
 *
 * Coverage maps to pending §8 rows MV01–MV10 plus the undo proof points the
 * ADR requires: move-vs-move, move-vs-edit, cycles (2 and 3 nodes),
 * move-vs-delete, group conflicts, rank collisions, identity retention, and
 * selective undo of local moves that preserves remote contributions.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../lib/crdt/index.js';
import { createPeerPair, createPeerTriple } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import {
	assertConverged,
	assertAllStructurallyValid,
	snapshotIdentities,
	diffIdentities
} from '../harness/assert/convergence.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const ops = createModelOps();

const topIds = (peer) => ops.project(peer).children.map((b) => b.id);
const childIds = (peer, id) =>
	ops
		.project(peer)
		.children.find((b) => b.id === id)
		?.children.map((b) => b.id);

/** Find a block anywhere in the projected tree. */
const find = (peer, id) => {
	const stack = [...ops.project(peer).children];
	while (stack.length) {
		const b = stack.pop();
		if (b.id === id) return b;
		stack.push(...b.children);
	}
	return undefined;
};

describe('placement model — concurrency (MV01–MV10)', () => {
	// ── MV01 ────────────────────────────────────────────────────────────
	it('move while peer edits/formats inside the block — edits land on the live payload', () => {
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
		// b1 moved under b3 AND carries the remote edits — the move did not
		// strand them on a dead copy.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 0 });
		expect(ops.blockText(A, 'b1')).toBe('hello-EDIT world');
		expect(ops.crdtId(A, 'b1')).toBe(idBefore); // identity survived the move
		const content = find(A, 'b1').content;
		expect(content[0]).toEqual({ kind: 'text', text: 'hel', marks: { italic: true } });
	});

	// ── MV02 ────────────────────────────────────────────────────────────
	it('concurrent moves of one block → one deterministic placement', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		// Client ids: A=1, B=2 — same seq → higher client wins (B).
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		ops.moveBlock(B, 'b1', { parent: null, index: 2 });
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// B's stamp (seq 2, client 2) beats A's (seq 2, client 1): root index 2.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
		// Exactly one placement of b1 exists.
		expect(ops.listBlockIds(A).filter((i) => i === 'b1')).toHaveLength(1);
	});

	it('concurrent moves — reversed delivery reaches the same winner', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		ops.moveBlock(B, 'b1', { parent: null, index: 0 });
		// deliver in adversarial order
		set.deliver('B', 'A', { reverse: true });
		set.deliver('A', 'B', { reverse: true });
		assertConverged(set, ops);
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(B, 'b1')).toEqual({ parent: null, index: 0 });
	});

	// ── MV03 ────────────────────────────────────────────────────────────
	it('concurrent reorders of different blocks converge', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.moveBlock(A, 'b1', { parent: null, index: 2 }); // b1 to end
		ops.moveBlock(B, 'b3', { parent: null, index: 0 }); // b3 to front
		set.deliverAll();
		assertConverged(set, ops);
		expect(topIds(A)).toEqual(['b3', 'b2', 'b1']);
	});

	// ── MV04 ────────────────────────────────────────────────────────────
	it('nest + subtree move while a descendant is edited — nothing orphans', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.nestBlock(A, 'b3', 'b1'); // whole b3 subtree under b1
		ops.insertText(B, 'b3a', 7, ' +remote');
		ops.moveBlock(B, 'b3a', { parent: 'b1', index: 1 }); // remote reparent of the child
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// b3 nested under b1; b3a moved to b1 directly (B's placement wins for
		// b3a — seq 2,client 2 vs nothing else), its edit intact.
		expect(ops.positionOf(A, 'b3')).toEqual({ parent: 'b1', index: 0 });
		expect(ops.positionOf(A, 'b3a')).toEqual({ parent: 'b1', index: 1 });
		expect(ops.blockText(A, 'b3a')).toBe('child a +remote');
	});

	// ── MV05 ────────────────────────────────────────────────────────────
	it('two-node cycle A→B / B→A resolves to a deterministic acyclic tree', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.nestBlock(A, 'b1', 'b2'); // b1 under b2   (seq 2, client 1)
		ops.nestBlock(B, 'b2', 'b1'); // b2 under b1   (seq 2, client 2)
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// Acceptance order is (seq,client,id) desc: b2's candidate (2,2,'b2')
		// is accepted first → b2 under b1. b1's candidate (2,1,'b1' → b2)
		// would close the cycle → falls back to its previous placement (root).
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b1', index: 0 });
	});

	it('three-node cycle resolves acyclically regardless of delivery order', () => {
		const run = (deliverOrder: 'forward' | 'reverse') => {
			const set = createPeerTriple(MODEL_BASE_SEED);
			const { A, B, C } = set;
			ops.nestBlock(A, 'b1', 'b3'); // b1 under b3  (2,1)
			ops.nestBlock(B, 'b2', 'b1'); // b2 under b1  (2,2)
			ops.nestBlock(C, 'b3', 'b2'); // b3 under b2  (2,3)
			if (deliverOrder === 'forward') {
				set.deliverAll();
			} else {
				set.deliver('A', 'C', { reverse: true });
				set.deliver('B', 'C', { reverse: true });
				set.deliver('C', 'A', { reverse: true });
				set.deliver('C', 'B', { reverse: true });
				set.deliver('A', 'B', { reverse: true });
				set.deliver('B', 'A', { reverse: true });
			}
			set.syncAll();
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			return set;
		};
		const fwd = run('forward');
		const rev = run('reverse');
		// Same deterministic resolution under both orders: (2,3,b3) accepts
		// b3→b2, (2,2,b2) accepts b2→b1, (2,1,b1) → b3 would cycle → b1 falls
		// back to root. Tree: b1 > b2 > b3 chain.
		expect(ops.positionOf(fwd.A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(fwd.A, 'b2')).toEqual({ parent: 'b1', index: 0 });
		expect(ops.positionOf(fwd.A, 'b3')).toEqual({ parent: 'b2', index: 0 });
		expect(ops.project(rev.A)).toEqual(ops.project(fwd.A));
	});

	it('cycle fallback uses the rejected block’s previous placement, not a void', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		// Put b2 under b3 first (both see it), then create the cycle.
		ops.nestBlock(A, 'b2', 'b3');
		set.deliverAll();
		// Concurrent: A nests b1 under b2 (seq for b1: 2); B nests b2 under b1.
		ops.nestBlock(A, 'b1', 'b2');
		ops.nestBlock(B, 'b2', 'b1');
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// b2's winner (B's move) accepts b2→b1. b1's winner accepts b1→b2 only
		// if acyclic — b1→b2 + b2→b1 IS a cycle → rejected → fallback = b1's
		// previous placement (root).
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b1', index: 0 });
	});

	// ── MV06 ────────────────────────────────────────────────────────────
	it('explicit deletion wins over a concurrent move', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.deleteBlock(A, 'b2');
		ops.moveBlock(B, 'b2', { parent: 'b3', index: 0 });
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// Deleted — the concurrent move does not resurrect it.
		expect(ops.listBlockIds(A)).not.toContain('b2');
		expect(ops.listBlockIds(A)).toEqual(['b1', 'b3', 'b3a', 'b3b']);
	});

	it('move into a deleted parent hides the child with the subtree', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.deleteBlock(A, 'b3');
		ops.moveBlock(B, 'b1', { parent: 'b3', index: 0 });
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		// Documented policy: hidden-with-subtree — b1 is under a deleted
		// parent → hidden; it is NOT deleted itself (no del flag) and would
		// resurface if the parent were ever restored by undo.
		expect(ops.listBlockIds(A)).toEqual(['b2']);
		expect(find(A, 'b1')).toBeUndefined();
		// b1's payload is intact in the registry — it is hidden, not deleted.
		expect(M.blockNodeOf(A.doc, 'b1')).not.toBeNull();
		expect(M.liveNodeOf(A.doc, 'b1')).not.toBeNull();
	});

	it('a peer cannot move a block it has already deleted (local no-op)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		expect(ops.deleteBlock(A, 'b2')).toBe(true);
		expect(ops.moveBlock(A, 'b2', { parent: 'b3', index: 0 })).toBe(false);
	});

	// ── MV07 ────────────────────────────────────────────────────────────
	it('disjoint group moves converge', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
		ops.moveBlocks(B, ['b3a'], { parent: null, index: 0 });
		set.deliverAll();
		assertConverged(set, ops);
		// b1,b2 landed under b3 in source order; b3a moved out to root.
		expect(childIds(A, 'b3')).toEqual(['b1', 'b2', 'b3b']);
		expect(topIds(A)[0]).toBe('b3a');
	});

	it('overlapping group moves resolve per member', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		// b2 is in BOTH groups. A's stamp for b2 is (2,1); B's is (2,2) → B wins b2.
		ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
		ops.moveBlocks(B, ['b2', 'b3'], { parent: null, index: 2 });
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		// b1: only A's candidate → under b3. b2/b3: B's stamps (2,2) beat A's
		// (2,1) → B's placement wins: b1 removed from root by A's op, so the
		// converged root is [b2, b3].
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 0 });
		expect(ops.positionOf(A, 'b2')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(A, 'b3')).toEqual({ parent: null, index: 1 });
	});

	it('group member moved separately by a peer resolves per member', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
		ops.moveBlock(B, 'b1', { parent: null, index: 3 });
		set.deliverAll();
		assertConverged(set, ops);
		// b1: B's (2,2) beats A's (2,1) → root tail (B's index-3 intent clamps
		// to its end; after b2/b3 placements the converged root is [b3, b1]).
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 1 });
		expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b3', index: 0 });
	});

	it('group move is exactly one undo step', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 });
		A.undoManager.undo();
		expect(topIds(A)).toEqual(['b1', 'b2', 'b3']);
		expect(childIds(A, 'b3')).toEqual(['b3a', 'b3b']);
	});

	// ── MV08 ────────────────────────────────────────────────────────────
	it('concurrent prepends collide on the same digit — then a third insert lands between the ties', () => {
		const set = createPeerTriple(MODEL_BASE_SEED);
		const { A, B, C } = set;
		// Both insert at root index 0: same gap (open → b1.rank), boundary-minus
		// → same v, tie = clientId → deterministic order.
		ops.insertBlock(A, { parent: null, index: 0 }, { id: 'insA', type: 'paragraph' });
		ops.insertBlock(B, { parent: null, index: 0 }, { id: 'insB', type: 'paragraph' });
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		const order = topIds(A).slice(0, 3);
		// client 2 > client 1 → insB's tie wins the smaller... check by rank:
		// ties order by (v,t) ascending — both have same v; t=1 < t=2 → insA first.
		expect(order).toEqual(['insA', 'insB', 'b1']);
		// Now C inserts BETWEEN the two tied neighbors: rankBetween(insA.rank,
		// insB.rank) — same digit, adjacent ties → copy left segment + descend.
		const posA = ops.positionOf(C, 'insA');
		expect(posA.index).toBe(0);
		ops.insertBlock(C, { parent: null, index: 1 }, { id: 'insC', type: 'paragraph' });
		set.deliverAll();
		assertConverged(set, ops);
		expect(topIds(A).slice(0, 4)).toEqual(['insA', 'insC', 'insB', 'b1']);
	});

	// ── MV09 ────────────────────────────────────────────────────────────
	it('#694 shape: separate inserts then move, same-transaction reads dense', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		for (const id of ['x', 'y', 'z']) {
			ops.insertBlock(A, { parent: null, index: 99 }, { id, type: 'paragraph' });
		}
		A.transact(() => {
			ops.moveBlock(A, 'z', { parent: null, index: 4 });
			// reads inside the writing transaction: dense + consistent
			expect(ops.listBlockIds(A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b', 'x', 'z', 'y']);
			expect(ops.positionOf(A, 'z')).toEqual({ parent: null, index: 4 });
			expect(ops.project(A).children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'x', 'z', 'y']);
		});
		set.deliverAll();
		assertConverged(set, ops);
	});

	// ── MV10 ────────────────────────────────────────────────────────────
	it('anchors follow content through a move: stable handle, deep events fire', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		const handle = ops.resolveBlock(A, 'b1');
		expect(handle).not.toBeNull();
		let deepEvents = 0;
		handle.observeDeep(() => deepEvents++);
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		// Same engine handle — the anchor followed the move.
		expect(ops.resolveBlock(A, 'b1')).toBe(handle);
		expect(deepEvents).toBeGreaterThan(0); // placement write is visible inside the node
		// Remote edit lands on the same handle.
		ops.insertText(B, 'b1', 0, 'X');
		set.deliver('B', 'A');
		expect(deepEvents).toBeGreaterThan(1);
		expect(ops.blockText(A, 'b1')).toBe('Xhello world');
	});

	// ── identity across the whole op vocabulary ──────────────────────────
	it('identity retained across move/split/merge/nest on the same doc', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		const before = snapshotIdentities(A, ops);
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		ops.splitBlock(A, 'b2', 3, 'b2x');
		ops.mergeBlocks(A, 'b3a', 'b3b');
		ops.nestBlock(A, 'b3', 'b2x');
		const diff = diffIdentities(before, snapshotIdentities(A, ops));
		// b3a was merged away (del flag) → gone from the visible tree.
		expect(diff.removed.sort()).toEqual(['b3a']);
		// nothing else churned identity — the whole point of placement.
		expect(diff.lost).toEqual([]);
		expect(diff.retained.sort()).toEqual(['b1', 'b2', 'b3', 'b3b']);
		expect(diff.added).toEqual(['b2x']); // the split-created sibling
	});
});

describe('placement model — undo proof points', () => {
	it('undo of a local move preserves a concurrent remote move (higher stamp wins)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		// A moves b1 under b3; B concurrently moves b1 to root end.
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		ops.moveBlock(B, 'b1', { parent: null, index: 2 });
		set.deliverAll();
		// B's candidate (2,2) is argmax on both peers.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
		A.undoManager.undo();
		// A's undo removes A's candidate — B's still wins → no visual jump.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
		set.deliverAll();
		assertConverged(set, ops);
		expect(ops.positionOf(B, 'b1')).toEqual({ parent: null, index: 2 });
	});

	it('undo of a local move after a remote edit inside the block keeps the edit', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
		set.deliverAll();
		ops.insertText(B, 'b1', 0, 'REMOTE>');
		set.deliverAll();
		expect(ops.blockText(A, 'b1')).toBe('REMOTE>hello world');
		A.undoManager.undo();
		// Placement reverted to pre-move (root), remote text intact.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.blockText(A, 'b1')).toBe('REMOTE>hello world');
		set.deliverAll();
		assertConverged(set, ops);
	});

	it('undo restores the pre-move placement (not a void) after a quiet move', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.moveBlock(A, 'b3a', { parent: 'b1', index: 0 });
		expect(ops.positionOf(A, 'b3a')).toEqual({ parent: 'b1', index: 0 });
		A.undoManager.undo();
		expect(ops.positionOf(A, 'b3a')).toEqual({ parent: 'b3', index: 0 });
	});

	it('redo after delete: undo unhides, redo re-hides', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.deleteBlock(A, 'b3b');
		ops.moveBlock(B, 'b3b', { parent: 'b1', index: 0 });
		set.deliverAll();
		expect(ops.listBlockIds(A)).not.toContain('b3b');
		A.undoManager.undo();
		// Undone delete: b3b resurfaces at the concurrent-move placement.
		expect(ops.positionOf(A, 'b3b')).toEqual({ parent: 'b1', index: 0 });
		A.undoManager.redo();
		expect(ops.listBlockIds(A)).not.toContain('b3b');
		set.deliverAll();
		assertConverged(set, ops);
	});

	it('undo of a local move is selective: remote moves/edits elsewhere survive', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.moveBlock(A, 'b1', { parent: null, index: 2 });
		ops.moveBlock(B, 'b2', { parent: 'b3', index: 0 });
		ops.insertText(B, 'b2', 0, '!');
		set.deliverAll();
		A.undoManager.undo();
		// A's move reverted; B's move + edit intact.
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 0 });
		expect(ops.positionOf(A, 'b2')).toEqual({ parent: 'b3', index: 0 });
		expect(ops.blockText(A, 'b2')).toBe('!second block');
		set.deliverAll();
		assertConverged(set, ops);
	});
});
