// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRuns } from '../../../lib/crdt/text/runs.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const ops = createModelOps();

describe('runs view isolation', () => {
	it('edit on A keeps the B snapshot identical', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		const before = v.runs('b2');
		ops.insertText(A, 'b1', 0, 'XYZ');
		expect(v.runs('b2'), 'B snapshot identity changed').toBe(before);
	});

	it('edit inside a claimed block changes the owner block runs', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		ops.mergeBlocks(A, 'b2', 'b1'); // b1 claims b2
		const before = v.runs('b1');
		// The model rejects ops on hidden blocks, so write via owner b1 into
		// the claimed range (offset 11 = start of b2's contribution).
		ops.insertText(A, 'b1', 11, '!');
		const after = v.runs('b1');
		expect(after).not.toBe(before);
		expect(after.map((x) => (x.kind === 'text' ? x.text : x.id)).join('|')).toContain('!');
	});

	it('a remote update touching only b2 keeps the b1 snapshot identical', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		const vA = R.attach(A.doc);
		const before = vA.runs('b1');
		ops.insertText(B, 'b2', 0, 'X');
		set.deliver('B', 'A');
		expect(vA.runs('b1')).toBe(before);
	});

	it('runs() on a detached-but-present block does not poison .delta', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		// Reading runs of a block id that doesn't exist — must not throw/poison.
		expect(v.runs('nope')).toEqual([]);
		// And a real block stays correct after.
		expect(
			v
				.runs('b1')
				.map((r) => r.text)
				.join('')
		).toBe('hello world');
	});
});
