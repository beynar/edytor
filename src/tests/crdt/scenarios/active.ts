/**
 * Active §8 scenarios — everything expressible today through `RawNodeOps`.
 *
 * These run in the green lane (`pnpm test:crdt`). Each scenario states which
 * §8 requirement it feeds; entries whose *full* contract needs the future
 * model ALSO have pending-registry rows (e.g. MV09 is asserted here for the
 * copy-move adapter and stays pending for the real move representation).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import {
	createPeerSet,
	createPeerPair,
	createPeerTriple,
	isRemoteOrigin
} from '../harness/peer-set.js';
import { createRawNodeOps } from '../harness/ops/raw-node-ops.js';
import {
	assertConverged,
	assertAllStructurallyValid,
	snapshotIdentities,
	diffIdentities
} from '../harness/assert/convergence.js';
import { BASE_SEED, EMPTY_SEED, specSeed } from './seeds.js';
import type { Scenario } from './registry.js';

const ops = createRawNodeOps();

export const activeScenarios: Scenario[] = [
	// ── SY01 — independent offline peers & delivery discipline ──────────
	{
		id: 'SY01a',
		requirement: 'SY01',
		title: 'offline peers converge after in-order delivery',
		run: () => {
			const set = createPeerTriple(BASE_SEED);
			const { A, B, C } = set;
			ops.insertText(A, 'b1', 11, '!');
			ops.insertText(B, 'b2', 6, ' from B');
			ops.deleteText(C, 'b1', 0, 6);
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// intent: all three edits visible on every peer
			expect(ops.blockText(A, 'b1')).toBe('world!');
			expect(ops.blockText(A, 'b2')).toBe('second from B block');
		}
	},
	{
		id: 'SY01b',
		requirement: 'SY01',
		title: 'reversed delivery order still converges',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			// Interleave several transactions so the queue holds many updates.
			for (let i = 0; i < 5; i++) ops.insertText(set.A, 'b1', 11, `${i}`);
			for (let i = 0; i < 5; i++) ops.insertText(set.B, 'b2', 0, `${i}`);
			expect(set.pendingCount).toBeGreaterThan(1);
			set.deliver('A', 'B', { reverse: true });
			set.deliver('B', 'A', { reverse: true });
			assertConverged(set, ops);
		}
	},
	{
		id: 'SY01c',
		requirement: 'SY01',
		title: 'duplicate delivery is idempotent',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			ops.insertText(set.A, 'b1', 0, 'dup ');
			set.deliver('A', 'B', { times: 2 });
			set.deliver('B', 'A');
			assertConverged(set, ops);
			expect(ops.blockText(set.B, 'b1')).toBe('dup hello world');
		}
	},
	{
		id: 'SY01d',
		requirement: 'SY01',
		title: 'batched (mergeUpdates) delivery converges',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			ops.insertText(set.A, 'b1', 0, 'x');
			ops.insertText(set.A, 'b1', 1, 'y');
			ops.setMark(set.A, 'b2', 0, 6, 'italic', true);
			set.deliver('A', 'B', { batch: true });
			set.deliver('B', 'A');
			assertConverged(set, ops);
			const proj = ops.project(set.B);
			expect(proj.children[1].content[0]).toEqual({
				kind: 'text',
				text: 'second',
				marks: { bold: true, italic: true }
			});
		}
	},
	{
		id: 'SY01e',
		requirement: 'SY01',
		title: 'message loss recovered by state-vector (incremental) sync',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			ops.insertText(set.A, 'b1', 0, 'lost-then-found ');
			ops.insertText(set.A, 'b1', 27, '?'); // end of 'lost-then-found hello world'
			// Messages are dropped on the floor; queue never reaches B.
			set.dropQueued('A', 'B');
			expect(set.pending('A', 'B')).toBe(0);
			ops.insertText(set.B, 'b2', 0, 'B saw: ');
			set.dropQueued('B', 'A');
			// Incremental sync must ship exactly the missing ranges.
			set.syncPeer('A', 'B');
			assertConverged(set, ops);
			expect(ops.blockText(set.B, 'b1')).toBe('lost-then-found hello world?');
		}
	},
	{
		id: 'SY01f',
		requirement: 'SY01',
		title: 'complete-state sync converges',
		run: () => {
			const set = createPeerTriple(BASE_SEED);
			ops.insertText(set.A, 'b1', 0, 'A');
			ops.insertText(set.B, 'b2', 0, 'B');
			ops.insertText(set.C, 'b1', 11, 'C');
			set.dropQueued('A', 'B');
			set.dropQueued('A', 'C');
			set.dropQueued('B', 'A');
			set.dropQueued('B', 'C');
			set.dropQueued('C', 'A');
			set.dropQueued('C', 'B');
			set.syncAll('full');
			assertConverged(set, ops);
		}
	},
	{
		id: 'SY01g',
		requirement: 'SY01',
		title: 'persist + reload from snapshot mid-partition, then converge',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			const { A, B } = set;
			ops.insertText(A, 'b1', 0, 'pre ');
			A.persist();
			ops.insertText(A, 'b1', 0, 'post-persist ');
			ops.insertText(B, 'b2', 0, 'B-only ');
			A.reload('snapshot');
			// Reloaded A has the pre-persist state, missing its own last edit and B's.
			expect(ops.blockText(A, 'b1')).toBe('pre hello world');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			expect(ops.blockText(A, 'b1')).toBe('post-persist pre hello world');
		}
	},
	{
		id: 'SY01h',
		requirement: 'SY01',
		title: 'reload from full update log reconstructs the doc',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			const { A, B } = set;
			ops.insertText(A, 'b1', 0, 'first ');
			ops.insertText(B, 'b2', 0, 'remote ');
			set.deliverAll();
			ops.insertText(A, 'b3a', 7, ' tail');
			B.reload('log');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			expect(ops.blockText(B, 'b3a')).toBe('child a tail');
		}
	},
	{
		id: 'SY01i',
		requirement: 'SY01',
		title: 'partition buffers, heal flushes, ops converge',
		run: () => {
			const set = createPeerTriple(BASE_SEED);
			set.isolate('C');
			ops.insertText(set.A, 'b1', 0, 'A');
			ops.insertText(set.B, 'b1', 11, 'B');
			ops.insertText(set.C, 'b2', 0, 'C');
			set.deliverAll(); // A and B exchange; C's queue is held
			expect(ops.blockText(set.A, 'b2')).not.toContain('C');
			set.healPeer('C');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			expect(ops.blockText(set.A, 'b2')).toContain('C');
		}
	},
	{
		id: 'SY01j',
		requirement: 'SY01',
		title: 'three peers: every pair order combination converges',
		run: () => {
			const set = createPeerTriple(BASE_SEED);
			ops.insertText(set.A, 'b1', 0, 'a');
			ops.insertText(set.B, 'b1', 5, 'b');
			ops.insertText(set.C, 'b1', 11, 'c');
			// deliver in an adversarial order
			set.deliver('C', 'A');
			set.deliver('B', 'C');
			set.deliver('A', 'C');
			set.deliver('C', 'B');
			set.deliver('B', 'A');
			set.deliver('A', 'B');
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
		}
	},

	// ── SY03 — concurrent bootstrap ──────────────────────────────────────
	{
		id: 'SY03a',
		requirement: 'SY03',
		title: 'concurrent first inserts into an empty root converge deterministically',
		run: () => {
			const set = createPeerTriple(EMPTY_SEED);
			ops.insertBlock(set.A, { parent: null, index: 0 }, { id: 'a1', type: 'paragraph' });
			ops.insertBlock(set.B, { parent: null, index: 0 }, { id: 'b1', type: 'paragraph' });
			ops.insertBlock(set.C, { parent: null, index: 0 }, { id: 'c1', type: 'paragraph' });
			set.syncAll();
			set.deliverAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// Deterministic order: every peer agrees on the same one.
			expect(ops.project(set.A)).toEqual(ops.project(set.B));
			expect(ops.project(set.B)).toEqual(ops.project(set.C));
		}
	},

	// ── AN01 / AN03 — marks & inline atoms (expressible today) ───────────
	{
		id: 'AN01a',
		requirement: 'AN01',
		title: 'concurrent overlapping different-key marks merge',
		run: () => {
			const set = createPeerPair(
				specSeed([{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }])
			);
			ops.setMark(set.A, 'b1', 0, 6, 'bold', true);
			ops.setMark(set.B, 'b1', 4, 6, 'italic', true);
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			const content = ops.project(set.A).children[0].content;
			// runs: abcd(bold) ef(bold+italic) ghij(italic)
			expect(content).toEqual([
				{ kind: 'text', text: 'abcd', marks: { bold: true } },
				{ kind: 'text', text: 'ef', marks: { bold: true, italic: true } },
				{ kind: 'text', text: 'ghij', marks: { italic: true } }
			]);
		}
	},
	{
		id: 'AN03a',
		requirement: 'AN03',
		title: 'inline atom insert concurrent with remote text edit',
		run: () => {
			const set = createPeerPair(
				specSeed([{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'ab cd' }] }])
			);
			ops.insertInline(set.A, 'b1', 3, { id: 'm1', type: 'mention', data: { user: 'x' } });
			ops.insertText(set.B, 'b1', 0, '>> ');
			ops.deleteText(set.B, 'b1', 4, 2);
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			const content = ops.project(set.A).children[0].content;
			// atom survives, surrounding text merged
			const inline = content.find((i) => i.kind === 'inline');
			expect(inline).toMatchObject({ kind: 'inline', id: 'm1', type: 'mention' });
			const text = content
				.filter((i) => i.kind === 'text')
				.map((i) => (i as any).text)
				.join('');
			expect(text).toContain('>> ');
		}
	},

	// ── MV09 — #694 equivalent on the vendored engine ────────────────────
	{
		id: 'MV09a',
		requirement: 'MV09',
		title:
			'separate inserts then move with same-transaction reads stays dense ' +
			'(vendored engine + adapter copy-move; pending re-verification under ' +
			'the U03 move representation)',
		run: () => {
			// Mirror of issue #694's shape at block granularity: three distinct
			// inserts, then last → middle, with reads inside the transaction.
			const set = createPeerPair(EMPTY_SEED);
			const A = set.A;
			for (const id of ['x', 'y', 'z']) {
				ops.insertBlock(
					A,
					{ parent: null, index: A.doc.get('content').length },
					{
						id,
						type: 'paragraph'
					}
				);
			}
			const root = A.doc.get('content');
			A.transact(() => {
				ops.moveBlock(A, 'z', { parent: null, index: 1 });
				// reads inside the same transaction must be dense + consistent
				expect(root.length).toBe(3);
				expect(root.toArray().map((n: any) => n.getAttr('id'))).toEqual(['x', 'z', 'y']);
				expect(root.get(0).getAttr('id')).toBe('x');
				expect(root.get(1).getAttr('id')).toBe('z');
				expect(root.get(2).getAttr('id')).toBe('y');
				// JSON materialization is dense (no holes/null slots — #694 shape)
				const json = root.toJSON();
				expect(json.children?.map((c: any) => c.attrs?.id)).toEqual(['x', 'z', 'y']);
			});
			set.deliverAll();
			assertConverged(set, ops);
			expect(ops.project(set.B).children.map((b) => b.id)).toEqual(['x', 'z', 'y']);
		}
	},

	// ── HI01-pre — engine-level history subset ───────────────────────────
	{
		id: 'HI01-pre',
		requirement: 'HI01',
		title:
			'engine-level selective undo: local text op undone, remote edit survives ' +
			'(subset — move/split/merge undo is pending U03/U04+U09)',
		run: () => {
			const set = createPeerPair(BASE_SEED);
			const { A, B } = set;
			A.enableUndo();
			ops.insertText(A, 'b1', 0, 'LOCAL ');
			ops.insertText(B, 'b1', 11, ' REMOTE');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			expect(ops.blockText(A, 'b1')).toBe('LOCAL hello world REMOTE');
			A.undoManager!.undo();
			expect(ops.blockText(A, 'b1')).toBe('hello world REMOTE');
			set.deliverAll();
			assertConverged(set, ops);
		}
	}
];
