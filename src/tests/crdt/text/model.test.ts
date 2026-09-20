/**
 * U04 text-ownership unit tests — sequential behavior of the slice/claim
 * model plus two-peer convergence of split/merge.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../lib/crdt/index.js';
import { createPeerPair, createPeerTriple } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';

const M = bindModel(Y);
const ops = createModelOps();

const text = (peer, id) => ops.blockText(peer, id);
const topIds = (peer) => ops.project(peer).children.map((b) => b.id);

describe('u04 text ownership — sequential', () => {
	it('split divides slices; merge rejoins; content identity survives', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		const b1Id = ops.crdtId(A, 'b1');
		expect(ops.splitBlock(A, 'b1', 6, 's1')).toBe(true);
		expect(text(A, 'b1')).toBe('hello ');
		expect(text(A, 's1')).toBe('world');
		expect(topIds(A)).toEqual(['b1', 's1', 'b2', 'b3']);
		expect(ops.crdtId(A, 'b1')).toBe(b1Id); // source identity survives
		// merge the sibling back
		expect(ops.mergeBlocks(A, 's1', 'b1')).toBe(true);
		expect(text(A, 'b1')).toBe('hello world');
		expect(ops.positionOf(A, 's1')).toBeNull(); // merged-away → hidden
		expect(topIds(A)).toEqual(['b1', 'b2', 'b3']);
	});

	it('edits into a merged block’s claimed region land via the backing text', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		ops.mergeBlocks(A, 'b2', 'b1'); // b1 gets claim(b2)
		expect(text(A, 'b1')).toBe('hello worldsecond block');
		// insert inside the claimed region (offset 15 = 4 chars into b2's text)
		ops.insertText(A, 'b1', 15, 'XX');
		expect(text(A, 'b1')).toBe('hello worldsecoXXnd block');
	});

	it('typing at a split-boundary start extends the tail slice', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		ops.splitBlock(A, 'b1', 6, 's1');
		// type at start of the sibling
		ops.insertText(A, 's1', 0, '>>');
		expect(text(A, 's1')).toBe('>>world');
		expect(text(A, 'b1')).toBe('hello ');
		// type at end of head
		ops.insertText(A, 'b1', 6, '<<');
		expect(text(A, 'b1')).toBe('hello <<');
		expect(text(A, 's1')).toBe('>>world');
	});

	it('typing at a merge join goes to the left (head) side', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const A = set.A;
		ops.mergeBlocks(A, 'b2', 'b1'); // 'hello world' + 'second block'
		// offset 11 = the join: belongs to the left (b1's own) slice end
		ops.insertText(A, 'b1', 11, '!');
		expect(text(A, 'b1')).toBe('hello world!second block');
	});

	it('empty block stays renderable; revive record covers later typing', () => {
		const set = createPeerPair(modelSpecSeed([{ id: 'e1', type: 'paragraph' }]));
		const A = set.A;
		expect(text(A, 'e1')).toBe('');
		expect(topIds(A)).toEqual(['e1']);
		ops.insertText(A, 'e1', 0, 'later');
		expect(text(A, 'e1')).toBe('later');
	});

	it('split/merge wire bytes are O(record), not O(text) — no char re-encode', () => {
		const CHARS = 100_000;
		const set = createPeerPair(
			modelSpecSeed([
				{ id: 'big', type: 'paragraph', content: [{ kind: 'text', text: 'x'.repeat(CHARS) }] },
				{ id: 'dst', type: 'paragraph', content: [{ kind: 'text', text: 'y'.repeat(CHARS) }] }
			])
		);
		const A = set.A;
		const bytesOf = (fn) => {
			let bytes = 0;
			const on = (u) => (bytes += u.byteLength);
			A.doc.on('update', on);
			try {
				fn();
			} finally {
				A.doc.off('update', on);
			}
			return bytes;
		};
		// Splitting a 100k-char block emits the slice records + the sibling
		// block — orders of magnitude below the payload (copy-split would
		// re-encode ~50k chars ≈ 50kB).
		const splitBytes = bytesOf(() => ops.splitBlock(A, 'big', CHARS / 2, 'big-s'));
		expect(splitBytes).toBeLessThan(2_000);
		// Merging a 100k block emits ONE claim item — ~tens of bytes, vs
		// ~100kB for a copy-merge.
		const mergeBytes = bytesOf(() => ops.mergeBlocks(A, 'dst', 'big'));
		expect(mergeBytes).toBeLessThan(500);
		expect(text(A, 'big')).toBe('x'.repeat(CHARS / 2) + 'y'.repeat(CHARS));
	});
});

describe('u04 text ownership — two-peer', () => {
	it('TX01: split hello|world + concurrent ! append → tail keeps it', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b1', 6, 's1');
		ops.insertText(B, 'b1', 11, '!'); // remote appends to end of b1's content
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		expect(text(A, 'b1')).toBe('hello ');
		expect(text(A, 's1')).toBe('world!');
		expect(ops.crdtId(A, 's1')).not.toBeNull();
	});

	it('TX02: split + concurrent suffix delete → deleted stays deleted', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b1', 6, 's1');
		ops.deleteText(B, 'b1', 8, 3); // remote deletes 'rld' (last 3 of 'world')
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		expect(text(A, 'b1')).toBe('hello ');
		expect(text(A, 's1')).toBe('wo');
	});

	it('TX03: merge + concurrent edit of the source survives', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		ops.mergeBlocks(A, 'b2', 'b1');
		ops.insertText(B, 'b2', 0, '>>');
		set.deliverAll();
		set.syncAll();
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
		expect(text(A, 'b1')).toBe('hello world>>second block');
		expect(ops.positionOf(A, 'b2')).toBeNull();
	});
});
