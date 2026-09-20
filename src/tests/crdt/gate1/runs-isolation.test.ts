// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel, bindRuns, decorateRuns } from '../../../lib/crdt/index.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const ops = createModelOps();

describe('runs view isolation', () => {
	it('edit on A does not fire B subscriber; B snapshot stays identical', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		const bCalls = [];
		v.subscribeBlock('b2', (r) => bCalls.push(r));
		const before = v.runs('b2');
		ops.insertText(A, 'b1', 0, 'XYZ');
		expect(bCalls.length, 'B subscriber fired on unrelated edit').toBe(0);
		expect(v.runs('b2'), 'B snapshot identity changed').toBe(before);
	});

	it('edit inside a claimed block fires the owner block subscriber', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		ops.mergeBlocks(A, 'b2', 'b1'); // b1 claims b2
		const calls = [];
		v.subscribeBlock('b1', (r) =>
			calls.push(r.map((x) => (x.kind === 'text' ? x.text : x.id)).join('|'))
		);
		// Edit the claimed region via the merged-away block's own handle — the
		// model rejects ops on hidden blocks, so write via owner b1 into the
		// claimed range (offset 11 = start of b2's contribution).
		ops.insertText(A, 'b1', 11, '!');
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[calls.length - 1]).toContain('!');
	});

	it('a remote update touching only b2 does not recompute b1 subscriber runs', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		const vA = R.attach(A.doc);
		const calls = [];
		vA.subscribeBlock('b1', (r) => calls.push(r));
		const before = vA.runs('b1');
		ops.insertText(B, 'b2', 0, 'X');
		set.deliver('B', 'A');
		expect(calls.length).toBe(0);
		expect(vA.runs('b1')).toBe(before);
	});

	it('decorateRuns writes nothing to the doc (no update emitted)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		let bytes = 0;
		const on = (u) => (bytes += u.byteLength);
		A.doc.on('update', on);
		const dec = decorateRuns(v.runs('b1'), [{ from: 0, to: 3, key: 'syntax', value: 'kw' }]);
		A.doc.off('update', on);
		expect(bytes).toBe(0);
		expect(dec[0].decorations).toEqual({ syntax: 'kw' });
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
