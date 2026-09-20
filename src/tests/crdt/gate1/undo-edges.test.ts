// @ts-nocheck
// Caveat (gate-1 finding #9, informational): UndoManager groups local ops
// landing within `captureTimeout` (~500ms) into ONE undo step. Below, the
// split + left-edge insert in "undo insertText that re-anchored a record"
// run back-to-back, so they may be captured as a single stack item — the
// second `undo()` is then a no-op. These probes intentionally keep default
// capture (the logged output is the evidence); a test asserting strict
// step-wise undo must call `undoManager.stopCapturing()` between ops or pass
// `captureTimeout: 0` to `enableUndo`.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../lib/crdt/index.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';

const M = bindModel(Y);
const ops = createModelOps();
const text = (p, id) => ops.blockText(p, id);
const ids = (p) => ops.listBlockIds(p);

describe('undo edge cases', () => {
	it('undo split after remote edit lands on the sibling tail', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.splitBlock(A, 'b1', 6, 's1');
		set.deliverAll();
		// Remote edits the sibling tail, then A undoes the split.
		ops.insertText(B, 's1', 5, '!!');
		set.deliverAll();
		expect(text(A, 's1')).toBe('world!!');
		A.undoManager.undo();
		// Undo must remove the split (s1 gone, atoms reclaimed by b1) while
		// keeping B's remote edit — 'world!!' should reappear under b1.
		console.log('after undo:', text(A, 'b1'), '| ids:', ids(A));
		set.deliverAll();
		set.syncAll();
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		console.log('B view b1:', text(B, 'b1'));
	});

	it('undo merge after remote moves the merged-away block', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.mergeBlocks(A, 'b2', 'b1');
		set.deliverAll();
		// Remote moves the (hidden) merged-away block b2 — legal on B's view?
		console.log('b2 visible on B?', ops.positionOf(B, 'b2'));
		const mv = ops.moveBlock(B, 'b3', { parent: null, index: 0 });
		console.log('remote move b3:', mv);
		set.deliverAll();
		A.undoManager.undo();
		console.log(
			'after undo: b1=',
			text(A, 'b1'),
			'b2 pos:',
			ops.positionOf(A, 'b2'),
			'ids:',
			ids(A)
		);
		set.deliverAll();
		set.syncAll();
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
	});

	it('undo delete while remote edited inside the deleted subtree', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.deleteBlock(A, 'b3');
		set.deliverAll();
		ops.insertText(B, 'b3a', 0, 'REMOTE');
		set.deliverAll();
		A.undoManager.undo();
		// b3 subtree restored; b3a carries remote edit.
		console.log('after undo: ids=', ids(A), 'b3a=', text(A, 'b3a'));
		set.deliverAll();
		set.syncAll();
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
	});

	it('undo insertText that re-anchored a record (left edge)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.splitBlock(A, 'b1', 6, 's1');
		// type at s1's left edge — rewrites the tail record (delete+insert on slices)
		ops.insertText(A, 's1', 0, 'XX');
		expect(text(A, 's1')).toBe('XXworld');
		A.undoManager.undo();
		console.log('after undo: s1=', text(A, 's1'), 'b1=', text(A, 'b1'));
		A.undoManager.undo(); // undo the split too
		console.log('after 2nd undo: ids=', ids(A), 'b1=', text(A, 'b1'));
	});

	it('undo merge claim restores claimed block + content routing', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.mergeBlocks(A, 'b2', 'b1');
		expect(text(A, 'b1')).toBe('hello worldsecond block');
		set.deliverAll();
		// B concurrently splits inside the claimed region (b2's atoms under b1)
		ops.splitBlock(B, 'b1', 15, 'sp');
		set.deliverAll();
		console.log(
			'before undo: b1=',
			JSON.stringify(text(A, 'b1')),
			'sp=',
			JSON.stringify(text(A, 'sp'))
		);
		A.undoManager.undo(); // undo the merge — b2 must resurface with its atoms
		console.log(
			'after undo: ids=',
			ids(A),
			'b2=',
			text(A, 'b2'),
			'b1=',
			text(A, 'b1'),
			'sp=',
			text(A, 'sp')
		);
		set.deliverAll();
		set.syncAll();
		set.deliverAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
	});
});
