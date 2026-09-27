/**
 * Gate-1 wire-growth probes (passing guard rails).
 *
 * The move/split ADRs claim structural ops are O(record), not O(payload), and
 * that ranks stay bounded. These tests measure actual update bytes and pin
 * generous ceilings (~2-4x observed) so a regression to payload-copy or
 * unbounded rank growth fails loudly.
 *
 * Observed at review time: 53.3B/move (500 sequential), rank length 16 after
 * 200 same-gap inserts, 168.9B/split, 72.8B/char for left-edge typing,
 * 4 live placement candidates per peer after 50 concurrent-move rounds.
 */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED, modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const ops = createModelOps();

const measure = (peer, fn) => {
	let bytes = 0;
	const on = (u) => (bytes += u.byteLength);
	peer.doc.on('update', on);
	try {
		fn();
	} finally {
		peer.doc.off('update', on);
	}
	return bytes;
};

describe('G1-G: wire growth ceilings', () => {
	it('sequential moves stay O(record): <150B/move amortized, bounded doc state', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		const bytes = measure(A, () => {
			for (let i = 0; i < 500; i++) ops.moveBlock(A, 'b1', { parent: null, index: i % 4 });
		});
		const atNode = M.blockNodeOf(A.doc, 'b1').getAttr('at');
		let live = 0;
		atNode.forEachAttr(() => live++);
		const stateBytes = Y.encodeStateAsUpdateV2(A.doc).byteLength;
		console.log(
			`500 moves: ${bytes}B (${(bytes / 500).toFixed(1)}B/move), live candidates=${live}, doc=${stateBytes}B`
		);
		expect(bytes / 500).toBeLessThan(150);
		expect(live).toBeLessThanOrEqual(8);
	});

	it('rank minting stays bounded at the same gap', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		let maxLen = 0;
		for (let i = 0; i < 200; i++) {
			ops.insertBlock(A, { parent: null, index: 0 }, { id: `g${i}`, type: 'paragraph' });
			const pl = M.resolvePlacements(M.collectBlocks(A.doc));
			maxLen = Math.max(maxLen, pl.get(`g${i}`).rank.length);
		}
		console.log('max rank length after 200 same-gap inserts:', maxLen);
		expect(maxLen).toBeLessThanOrEqual(64);
	});

	it('sequential splits stay O(record): <400B/split amortized', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{ id: 't', type: 'paragraph', content: [{ kind: 'text', text: 'x'.repeat(300) }] }
			])
		);
		const { A } = set;
		const bytes = measure(A, () => {
			for (let i = 0; i < 200; i++) {
				if (!ops.splitBlock(A, 't', 1, `sp${i}`)) break;
			}
		});
		console.log(`200 splits: ${bytes}B (${(bytes / 200).toFixed(1)}B/split)`);
		expect(bytes / 200).toBeLessThan(400);
	});

	it('left-edge typing: per-char cost <200B (records rewrite, not content copy)', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A } = set;
		ops.splitBlock(A, 'b1', 6, 's1');
		const bytes = measure(A, () => {
			for (let i = 0; i < 100; i++) ops.insertText(A, 's1', 0, 'x');
		});
		console.log(`100 left-edge inserts: ${bytes}B (${(bytes / 100).toFixed(1)}B/char)`);
		expect(bytes / 100).toBeLessThan(200);
	});

	it('repeated concurrent moves leave bounded candidates per peer', () => {
		const set = createPeerPair(MODEL_BASE_SEED);
		const { A, B } = set;
		for (let i = 0; i < 50; i++) {
			ops.moveBlock(A, 'b1', { parent: null, index: i % 4 });
			ops.moveBlock(B, 'b1', { parent: 'b3', index: i % 2 });
			set.deliverAll();
		}
		for (const [name, p] of [
			['A', A],
			['B', B]
		]) {
			const at = M.blockNodeOf(p.doc, 'b1').getAttr('at');
			let live = 0;
			at.forEachAttr(() => live++);
			console.log(`${name}: ${live} live placement candidates`);
			expect(live, `${name} candidate count`).toBeLessThanOrEqual(8);
		}
	});
});
