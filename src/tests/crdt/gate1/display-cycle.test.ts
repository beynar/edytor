/**
 * Gate-1 regression probes — display-parent cycles.
 *
 * The placement layer resolves candidates acyclically over the RAW
 * `pl.parent` relation. But `displayParentOf` composes that relation with
 * the merge-claim owner map (`own.ownerOf(pl.parent)`), and the COMPOSED
 * relation can cycle — a state `resolvePlacements` cannot see and
 * `project`/`positionOf` cannot render. Affected blocks become silently
 * unreachable on every replica: live, unclaimed, un-deleted — gone from the
 * tree.
 *
 * These tests assert the required contract (every live self-owned block is
 * reachable / the op is rejected). They FAIL against the current
 * implementation — kept as durable regression evidence.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { bindText, DEAD } from '../../../lib/crdt/text/model.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';

const M = bindModel(Y);
const T = bindText(Y);
const ops = createModelOps();

/**
 * Oracle: every block the model itself treats as visible (live + self-owned)
 * must be reachable in the projection — i.e. `positionOf` must not be null.
 * Blocks legitimately hidden (del flag, claimed by a live merge, under a
 * deleted ancestor) are excluded by checking `isVisible` semantics directly.
 */
const unreachableLiveBlocks = (doc) => {
	const blocks = M.collectBlocks(doc);
	const placements = M.resolvePlacements(blocks);
	const own = T.computeOwnership(doc, blocks);
	const isVis = (id) => {
		const r = blocks.get(id);
		return r && !r.deleted && !own.hidden(id);
	};
	const bugs = [];
	for (const [id] of blocks) {
		if (!isVis(id)) continue;
		const seen = new Set();
		let cur = id;
		let cyclic = false;
		while (cur !== null) {
			if (seen.has(cur)) {
				cyclic = true;
				break;
			}
			seen.add(cur);
			const pl = placements.get(cur);
			const dp = pl.parent === null ? null : own.ownerOf(pl.parent);
			if (dp === DEAD || dp === null) break;
			cur = dp;
		}
		if (cyclic) bugs.push(id);
	}
	return bugs;
};

describe('G1-A: merge claim × placement display cycles', () => {
	it('mergeBlocks(parent, descendant) must not orphan the subtree', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		// b3 has children b3a, b3b. Merging b3 into its own child must be
		// rejected (or at worst leave all blocks reachable).
		const r = ops.mergeBlocks(A, 'b3', 'b3a');
		if (r === true) {
			// Accepted: then every live self-owned block MUST stay reachable.
			expect(
				unreachableLiveBlocks(A.doc),
				'live self-owned blocks unreachable after ancestor-merge'
			).toEqual([]);
			expect(ops.listBlockIds(A)).toContain('b3a');
		}
	});

	it('concurrent merge(B→A) + move(A under B) must not orphan both blocks', () => {
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.mergeBlocks(A, 'b2', 'b1'); // b1 claims b2 → owner(b2)=b1
			ops.moveBlock(B, 'b1', { parent: 'b2', index: 0 }); // b1 under b2
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.deliverAll();
			assertConverged(set, ops, `order=${order}`);
			expect(
				unreachableLiveBlocks(A.doc),
				`order=${order}: display-parent cycle orphaned blocks`
			).toEqual([]);
			// The surviving content must still be reachable: b1's claim on b2
			// makes b1 display 'hello world' + b2's 'second block' — the
			// assertion checks both halves are reachable through b1, not that
			// the claim was dropped (claim content in blockText IS the U04
			// merge contract).
			const text = ops.blockText(A, 'b1');
			expect(text, `order=${order}: b1 lost its own text`).toContain('hello world');
			expect(text, `order=${order}: b2's claimed text is unreachable`).toContain('second block');
		}
	});

	it('validator coverage: checkStructurallyValid must flag unreachable live blocks', () => {
		// The harness's structural oracle only walks projected blocks, so the
		// vanish bug above is invisible to it. This test pins the requirement
		// that the oracle gains a reachability/completeness check.
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		ops.mergeBlocks(A, 'b3', 'b3a');
		// b3a is live + self-owned but unreachable — the validator must see it.
		const missing = unreachableLiveBlocks(A.doc);
		expect(missing, 'validator cannot see vanished blocks — oracle gap').toEqual([]);
	});
});
