/**
 * Sequential behavior of the U03 placement model — single-doc ops, local
 * validation, destination-index semantics, projection shape.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const ops = createModelOps();

const ids = (doc) => ops.listBlockIds({ doc });
const projIds = (peer) => ops.listBlockIds(peer);

describe('placement model — sequential ops', () => {
	it('inserts and projects nested specs', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		expect(ops.listBlockIds(set.A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b']);
		const proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
		expect(proj.children[2].children.map((b) => b.id)).toEqual(['b3a', 'b3b']);
		expect(ops.blockText(set.A, 'b3a')).toBe('child a');
	});

	it('same-parent reorder: last → first, first → last, middle swap', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		expect(ops.moveBlock(A, 'b3', { parent: null, index: 0 })).toBe(true);
		expect(projIds(A)).toEqual(['b3', 'b3a', 'b3b', 'b1', 'b2']);
		expect(ops.moveBlock(A, 'b3', { parent: null, index: 2 })).toBe(true);
		expect(projIds(A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b']);
		// move down one slot (final-index: removing b1 first)
		expect(ops.moveBlock(A, 'b1', { parent: null, index: 1 })).toBe(true);
		expect(projIds(A)).toEqual(['b2', 'b1', 'b3', 'b3a', 'b3b']);
		// no-op move (index of own position after removal)
		expect(ops.moveBlock(A, 'b1', { parent: null, index: 1 })).toBe(true);
		expect(projIds(A)).toEqual(['b2', 'b1', 'b3', 'b3a', 'b3b']);
	});

	it('cross-parent move keeps subtree + engine identity', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		const before = ops.crdtId(A, 'b3a');
		expect(ops.moveBlock(A, 'b3a', { parent: 'b1', index: 0 })).toBe(true);
		expect(ops.positionOf(A, 'b3a')).toEqual({ parent: 'b1', index: 0 });
		expect(ops.crdtId(A, 'b3a')).toBe(before);
		// parent subtree still dense
		expect(ops.project(set.A).children.find((b) => b.id === 'b1').children[0].id).toBe('b3a');
	});

	it('nest / unnest round-trip', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		expect(ops.nestBlock(A, 'b1', 'b3')).toBe(true);
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 2 });
		expect(ops.unNestBlock(A, 'b1')).toBe(true);
		expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
	});

	it('rejects a move into the block’s own subtree without mutating', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		const before = ops.project(A);
		expect(ops.moveBlock(A, 'b3', { parent: 'b3a', index: 0 })).toBe(false);
		expect(ops.moveBlock(A, 'b3', { parent: 'b3', index: 0 })).toBe(false); // self
		expect(ops.moveBlock(A, 'nope', { parent: null, index: 0 })).toBe(false);
		expect(ops.moveBlock(A, 'b1', { parent: 'nope', index: 0 })).toBe(false);
		expect(ops.project(A)).toEqual(before); // no mutation
	});

	it('group move: consecutive positions, one undo step', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		A.enableUndo({ scope: A.doc.get('blocks') });
		// move b1+b2 under b3 as a group (source order b1,b2)
		expect(ops.moveBlocks(A, ['b1', 'b2'], { parent: 'b3', index: 0 })).toBe(true);
		expect(
			ops
				.project(A)
				.children.find((b) => b.id === 'b3')
				.children.map((c) => c.id)
		).toEqual(['b1', 'b2', 'b3a', 'b3b']);
		A.undoManager.undo();
		expect(ops.project(A).children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
		A.undoManager.redo();
		expect(
			ops
				.project(A)
				.children.find((b) => b.id === 'b3')
				.children.map((c) => c.id)
		).toEqual(['b1', 'b2', 'b3a', 'b3b']);
	});

	it('delete hides the block and its subtree; payload retained', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		expect(ops.deleteBlock(A, 'b3')).toBe(true);
		expect(ops.listBlockIds(A)).toEqual(['b1', 'b2']);
		// registry still holds the payload (undo / offline-integration ready)
		expect(M.blockNodeOf(A.doc, 'b3a')).not.toBeNull();
		expect(ops.crdtId(A, 'b3a')).toBeNull(); // hidden → no visible identity
	});

	it('split keeps identity, moves children + content tail to new sibling', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		const before = ops.crdtId(A, 'b3');
		expect(ops.splitBlock(A, 'b3', 3, 'b3x')).toBe(true);
		const proj = ops.project(A);
		const b3 = proj.children.find((b) => b.id === 'b3');
		const b3x = proj.children.find((b) => b.id === 'b3x');
		expect(ops.blockText(A, 'b3')).toBe('par');
		expect(ops.blockText(A, 'b3x')).toBe('ent');
		expect(b3.children).toEqual([]);
		expect(b3x.children.map((c) => c.id)).toEqual(['b3a', 'b3b']);
		expect(ops.crdtId(A, 'b3')).toBe(before); // source keeps identity
		expect(ops.crdtId(A, 'b3x')).not.toBeNull(); // sibling is a new stable entry
	});

	it('merge appends content + children into target, hides source', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		expect(ops.mergeBlocks(A, 'b1', 'b2')).toBe(true);
		const b2 = ops.project(A).children.find((b) => b.id === 'b2');
		expect(ops.blockText(A, 'b2')).toBe('second blockhello world');
		expect(ops.listBlockIds(A)).not.toContain('b1');
		// b3's children unchanged; merge b3 into b1? b1 deleted → refuse
		expect(ops.mergeBlocks(A, 'b3', 'b1')).toBe(false);
	});

	it('marks and inline atoms in content survive projection', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'p',
					type: 'paragraph',
					content: [
						{ kind: 'text', text: 'ab' },
						{ kind: 'inline', id: 'm1', type: 'mention', data: { u: 1 } },
						{ kind: 'text', text: 'cd', marks: { bold: true } }
					]
				}
			])
		);
		const proj = ops.project(set.A);
		expect(proj.children[0].content).toEqual([
			{ kind: 'text', text: 'ab', marks: undefined },
			{ kind: 'inline', id: 'm1', type: 'mention', data: { u: 1 } },
			{ kind: 'text', text: 'cd', marks: { bold: true } }
		]);
	});

	it('insert clamps index into range; positionOf is exact', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		ops.insertBlock(A, { parent: null, index: 99 }, { id: 'x', type: 'paragraph' });
		expect(ops.positionOf(A, 'x')).toEqual({ parent: null, index: 3 });
		ops.insertBlock(A, { parent: null, index: -5 }, { id: 'y', type: 'paragraph' });
		expect(ops.positionOf(A, 'y')).toEqual({ parent: null, index: 0 });
	});

	it('re-inserting a taken id is a no-op (registry keyed by id)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		ops.insertBlock(A, { parent: null, index: 0 }, { id: 'b1', type: 'quote' });
		expect(ops.project(A).children.find((b) => b.id === 'b1').type).toBe('paragraph');
	});

	it('same-transaction reads stay dense and consistent (#694 shape)', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{ id: 'x', type: 'paragraph' },
				{ id: 'y', type: 'paragraph' },
				{ id: 'z', type: 'paragraph' }
			])
		);
		const A = set.A;
		A.doc.transact(() => {
			M.moveBlock(A.doc, 'z', { parent: null, index: 1 });
			// projection reads inside the writing transaction are consistent
			expect(M.project(A.doc).children.map((b) => b.id)).toEqual(['x', 'z', 'y']);
			expect(M.positionOf(A.doc, 'z')).toEqual({ parent: null, index: 1 });
			expect(M.listBlockIds(A.doc)).toEqual(['x', 'z', 'y']);
		});
	});
});
