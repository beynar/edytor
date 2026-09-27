/**
 * Gate-F2 probe — `deleteRange` over multiple owned segs of ONE backing text.
 *
 * `T.deleteRange` (src/lib/crdt/text/model.ts) iterates a block's owned segs
 * and calls `text.delete(seg.i0 + (lo - base), hi - lo)` for each — using the
 * seg's PRE-DELETE backing coordinates. Yjs positional deletes are evaluated
 * against the LIVE item list: tombstoned atoms stop counting immediately, so
 * every atom after the first deleted seg shifts left by the deleted count.
 * A second seg of the SAME text then deletes atoms at stale positions —
 * atoms belonging to a different owner (or the wrong own atoms).
 *
 * Reachable through legal ops (splits, then merges of two split-off blocks
 * back into the first): a block displaying DISJOINT pieces of one backing
 * text — 'de', 'h', 'j' — with rival holes 'fg' and 'i'. Deleting across
 * the pieces must remove exactly the displayed atoms (the per-stream delete
 * writes right to left).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair, type Peer } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};

const text = (peer: Peer, id: string) => ed(peer).blockText(id);

const SEED = (doc) => {
	E.init(doc, {
		content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }]
	});
};

/**
 * `early` displays THREE disjoint pieces of T_b — its own stream 'de', then
 * the streams of `mid2` ('h') and `tail` ('j') through merge claims (R2) —
 * with the rival streams mid1 'fg' and mid3 'i' as holes between them.
 */
const stageFragmented = (set) => {
	const { A } = set;
	ops.splitBlock(A, 'b', 3, 'early');
	ops.splitBlock(A, 'early', 2, 'mid1');
	ops.splitBlock(A, 'mid1', 2, 'mid2');
	ops.splitBlock(A, 'mid2', 1, 'mid3');
	ops.splitBlock(A, 'mid3', 1, 'tail');
	ops.mergeBlocks(A, 'mid2', 'early');
	ops.mergeBlocks(A, 'tail', 'early');
	set.deliver('A', 'B');
	set.deliver('B', 'A');
	assertConverged(set, ops);
	expect(text(A, 'early')).toBe('dehj');
	expect(text(A, 'mid1')).toBe('fg');
	expect(text(A, 'mid3')).toBe('i');
};

describe('gateF2 — deleteRange across disjoint same-text segs', () => {
	it('delete spanning three owned segs removes exactly the displayed atoms', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		stageFragmented(set);
		// Delete ALL of early's display: 'd','e','h','j' must die; 'fg','i'
		// (rival-owned) and 'abc' (b-owned) must survive untouched.
		ops.deleteText(A, 'early', 0, 4);
		expect(text(A, 'early')).toBe('');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		expect(text(A, 'b')).toBe('abc');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'post-delete');
		assertAllStructurallyValid(set, ops, 'post-delete');
	});

	it('partial delete starting inside seg0 leaks into a rival seg', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		stageFragmented(set);
		// Delete display [1,4): 'e','h','j' must die → early='d', mid3 keeps 'i'.
		// Bug path: after delete(4,1) kills 'e', the second seg's delete(7,1)
		// hits live position 7 = original atom 8 = mid3's 'i'.
		ops.deleteText(A, 'early', 1, 3);
		expect(text(A, 'early')).toBe('d');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i'); // 'i' is mid3's atom — must NOT die
		expect(text(A, 'b')).toBe('abc');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'post-delete');
	});

	it('delete covering only later segs still shifts correctly (control)', () => {
		const set = createPeerPair(SEED);
		const { A } = set;
		stageFragmented(set);
		// Delete display [2,4): 'h','j' — both in later segs; seg0 untouched.
		// s0 contributes nothing (lo>=hi skip), s1 deletes at true 7, s2 at
		// true 9 — but s2's i0 is computed pre-delete so it shifts by 1.
		ops.deleteText(A, 'early', 2, 2);
		expect(text(A, 'early')).toBe('de');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		expect(text(A, 'b')).toBe('abc');
	});

	it('gap-spanning mid-range delete removes only displayed atoms', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		stageFragmented(set);
		// Display [1,3) = 'e','h' — the range SPANS the rival 'fg' gap.
		// The 'h' seg's backing i0 (7) is stale by 1 after 'e' dies;
		// descending-i0 ordering deletes 'h' first so 'e' still lands true.
		ops.deleteText(A, 'early', 1, 2);
		expect(text(A, 'early')).toBe('dj');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		expect(text(A, 'b')).toBe('abc');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'post-delete');
	});

	it('delete covering every owned atom of a text empties the display', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		// 'b' owns the whole backing text — a full-range delete is the
		// degenerate single-span case.
		ops.deleteText(A, 'b', 0, 10);
		expect(text(A, 'b')).toBe('');
		// Over-range deletes clamp instead of throwing: [3, 100) removes
		// 'd'..'j' only, and [10, ...) on an empty display is a no-op.
		const set2 = createPeerPair(SEED);
		ops.deleteText(set2.A, 'b', 3, 100);
		expect(text(set2.A, 'b')).toBe('abc');
		ops.deleteText(A, 'b', 10, 5);
		expect(text(A, 'b')).toBe('');
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-delete-all');
	});

	it('undo of a multi-segment delete restores the deleting owner and converges', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		stageFragmented(set);
		// Sync the staged state (incl. the mid2/tail deletes) so B sees
		// early='dehj' too — the undo probe needs a converged baseline.
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'pre-undo');
		A.enableUndo();
		ops.deleteText(A, 'early', 0, 4);
		expect(text(A, 'early')).toBe('');
		A.undoManager!.undo();
		// HARDENING U0 / R3 AMENDMENT — this test previously asserted that
		// undo REDISTRIBUTES the restored atoms across rival claim holders
		// (b='abcde', mid1='fgh', mid3='ij', early=''), with a comment calling
		// it "the only convergent choice". That expectation blessed the
		// confirmed P1 defect (follow-up review 2026-09-21 §R3): undo
		// resurrects deleted atoms as new items whose slice anchors resolve
		// past their redone replacements, so the revived text lands under
		// whichever claims re-win — NOT under the owner that displayed it.
		// The same mechanism puts the split-off tail's text back into its
		// source paragraph (see src/tests/crdt/hardening/r3-undo-ownership).
		//
		// CORRECT semantics: undo restores the atoms under the owner that
		// displayed them when they were deleted — 'early' gets 'dehj' back
		// and the rival owners keep exactly their pre-delete displays.
		// Convergence is still required: the fix must restore ownership
		// through replicated state, so remote replicas derive the identical
		// projection. (RED until U3.)
		expect(text(A, 'early')).toBe('dehj');
		expect(text(A, 'b')).toBe('abc');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'post-undo');
		assertAllStructurallyValid(set, ops, 'post-undo');
	});

	it('concurrent local+remote multi-segment deletes converge', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		stageFragmented(set);
		// Sync the staged state (incl. the mid2/tail deletes) so B sees
		// early='dehj' before the concurrent window opens.
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'pre-concurrent');
		// Both peers delete DIFFERENT parts of early's fragmented display
		// without seeing each other: A kills 'de' ([0,2)), B kills 'hj'
		// ([2,4)). The deletes target disjoint atom sets — after delivery
		// both replicas must show early='' with rivals intact.
		ops.deleteText(A, 'early', 0, 2);
		ops.deleteText(B, 'early', 2, 2);
		expect(text(A, 'early')).toBe('hj');
		expect(text(B, 'early')).toBe('de');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		expect(text(A, 'early')).toBe('');
		expect(text(B, 'early')).toBe('');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		expect(text(A, 'b')).toBe('abc');
		assertConverged(set, ops, 'post-concurrent-delete');
		assertAllStructurallyValid(set, ops, 'post-concurrent-delete');
	});
});
