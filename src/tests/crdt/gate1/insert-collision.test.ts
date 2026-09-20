/**
 * Gate-1 regression probe — insertBlock spec-child id collision.
 *
 * `insertBlock` refuses a top-level spec.id that already exists, but nested
 * `children[]` ids are not checked: `insertOne` writes
 * `registry.setAttr(childId, newNode)` unconditionally. Map semantics then
 * tombstone the EXISTING block's registry item — its content, slices and
 * placements are silently replaced by the fresh payload, and its engine
 * identity churns.
 */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../lib/crdt/index.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { assertConverged } from '../harness/assert/convergence.js';

const M = bindModel(Y);
const ops = createModelOps();

describe('G1-B: insertBlock nested-child id collision', () => {
	it('a spec child id colliding with a live block must not destroy it', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const textBefore = ops.blockText(A, 'b1');
		const crdtBefore = ops.crdtId(A, 'b1');
		ops.insertBlock(
			A,
			{ parent: null, index: 1 },
			{
				id: 'wrap',
				type: 'paragraph',
				children: [{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'EVIL' }] }]
			}
		);
		// Contract: the existing block's payload and identity are untouched.
		expect(ops.blockText(A, 'b1'), 'existing block content was overwritten').toBe(textBefore);
		expect(ops.crdtId(A, 'b1'), 'existing block identity churned').toBe(crdtBefore);
		set.deliverAll();
		assertConverged(set, ops);
	});
});
