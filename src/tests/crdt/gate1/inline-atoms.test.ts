// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRuns } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { assertConverged } from '../harness/assert/convergence.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const ops = createModelOps();
const findBlock = (p, id) =>
	ops
		.project(p)
		.children.flatMap(function w(b) {
			return [b, ...b.children.flatMap(w)];
		})
		.find((b) => b.id === id);

describe('inline atom edges', () => {
	it('splitting through an inline atom boundary keeps the atom whole and unique', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		ops.insertInline(A, 'b1', 5, { id: 'i1', type: 'mention', data: { u: 'x' } });
		// b1 is now "hello<atom> world" — atom at offset 5 (length 1).
		ops.splitBlock(A, 'b1', 5, 's1'); // split exactly at the atom's left edge
		const b1c = findBlock(A, 'b1').content,
			s1c = findBlock(A, 's1').content;
		const atoms = [b1c, s1c].flat().filter((i) => i.kind === 'inline');
		console.log('b1:', JSON.stringify(b1c), 's1:', JSON.stringify(s1c));
		expect(atoms.length).toBe(1);
		expect(atoms[0].id).toBe('i1');
	});

	it('formatting a range spanning an inline atom does not split the atom', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const v = R.attach(A.doc);
		ops.insertInline(A, 'b1', 5, { id: 'i1', type: 'mention' });
		ops.setMark(A, 'b1', 3, 5, 'bold', true); // spans text+atom+text
		const runs = v.runs('b1');
		const inlineRuns = runs.filter((r) => r.kind === 'inline');
		expect(inlineRuns.length, 'atom split into multiple runs').toBe(1);
		console.log(
			'runs:',
			JSON.stringify(runs.map((r) => ({ k: r.kind, t: r.text, id: r.id, m: r.marks })))
		);
	});

	it('undo of an inline-atom insertion removes exactly the atom', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		A.enableUndo({ scope: A.doc.get('blocks') });
		ops.insertInline(A, 'b1', 5, { id: 'i1', type: 'mention' });
		A.undoManager.stopCapturing?.();
		ops.insertText(A, 'b1', 0, 'Q');
		A.undoManager.stopCapturing?.();
		A.undoManager.undo(); // undo 'Q'
		expect(findBlock(A, 'b1').content.filter((i) => i.kind === 'inline').length).toBe(1);
		A.undoManager.undo(); // undo the atom
		const c = findBlock(A, 'b1').content;
		console.log('after atom undo:', JSON.stringify(c));
		expect(c.filter((i) => i.kind === 'inline').length).toBe(0);
		expect(ops.blockText(A, 'b1')).toBe('hello world');
	});

	it('concurrent edits at both sides of an atom keep it whole after convergence', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.insertInline(A, 'b1', 5, { id: 'i1', type: 'mention' });
		set.deliverAll();
		ops.insertText(A, 'b1', 0, 'L');
		ops.insertText(B, 'b1', 11, 'R'); // offset in B's frame (atom counts 1)
		set.deliverAll();
		set.syncAll();
		set.deliverAll();
		assertConverged(set, ops);
		const c = findBlock(A, 'b1').content;
		expect(c.filter((i) => i.kind === 'inline').length).toBe(1);
		expect(ops.blockText(A, 'b1')).toContain('L');
		expect(ops.blockText(A, 'b1')).toContain('R');
	});
});
