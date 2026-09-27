/**
 * Active §8 scenarios for the U05 rich-text layer — the maintained run view
 * (`src/lib/crdt/text/runs.ts`) over the U04 text-ownership model, on the
 * ModelOps adapter. Replaces the pending AN02/AN04/AN05/AN06/AN07 rows and
 * adds AN01/AN03 coverage. Golden semantics live in
 * `src/tests/crdt/runs/golden.test.ts`; these scenarios exercise the same
 * contract through the full replica harness — both delivery orders for
 * concurrent cases, convergence + structural-validity assertions, and a
 * persist→reload round-trip per scenario.
 *
 * The mark-conflict spec pinned here is the documented model contract (see
 * docs/crdt-v14-richtext-adr.md), not an accident of raw engine behavior:
 * marks replicate as format items; concurrent same-key writes resolve by
 * item order per atom; end markers restore null and can clear a winner's
 * exclusive suffix; independent keys never interact.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindRuns, decorateRuns } from '../../../lib/crdt/index.js';
import { createPeerPair, type PeerSet } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { MODEL_BASE_SEED, modelSpecSeed } from './seeds.js';
import type { Scenario } from './registry.js';
import { bindModel } from '../../oracles/model-ops.js';

const ops = createModelOps();
const R = bindRuns(Y);
const O = bindRunsOracle(Y);
// Model-level ops not part of the CrdtOps adapter contract (setInlineData).
const opsModel = bindModel(Y);

const runs = (peer, id) => R.attach(peer.doc).runs(id);
const contentJSON = (peer, id) => R.attach(peer.doc).contentJSON(id);

/** Replicas' run views must agree exactly — runs are the comparison surface. */
const assertRunsConverged = (set: PeerSet, ids: string[], context = '') => {
	for (const id of ids) {
		for (const p of set.peers) {
			expect(runs(p, id), `${context} runs(${id}) on ${p.name}`).toEqual(runs(set.peers[0], id));
		}
	}
};

const settled = (set: PeerSet, context = '') => {
	set.deliverAll();
	set.syncAll();
	set.deliverAll();
	assertConverged(set, ops, context);
	assertAllStructurallyValid(set, ops, context);
};

const reloadAndVerify = (set: PeerSet, verify: (set: PeerSet) => void, mode = 'snapshot') => {
	for (const p of set.peers) p.persist();
	for (const p of set.peers) p.reload(mode);
	assertConverged(set, ops, `post-${mode}-reload`);
	assertAllStructurallyValid(set, ops, `post-${mode}-reload`);
	verify(set);
};

const bothOrders = (
	setup: (set: PeerSet) => void,
	verify: (set: PeerSet) => void,
	seed = MODEL_BASE_SEED
): void => {
	for (const order of ['AB', 'BA']) {
		const set = createPeerPair(seed);
		setup(set);
		if (order === 'AB') {
			set.deliver('A', 'B');
			set.deliver('B', 'A');
		} else {
			set.deliver('B', 'A');
			set.deliver('A', 'B');
		}
		settled(set, `order=${order}`);
		verify(set);
		reloadAndVerify(set, verify);
	}
};

const MARK_SEED = modelSpecSeed([
	{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] },
	{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'second block' }] }
]);

const INLINE_SEED = modelSpecSeed([
	{
		id: 'a',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'x ' },
			{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } },
			{ kind: 'text', text: ' y' }
		]
	},
	{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'other' }] }
]);

const ANN_SEED = modelSpecSeed([
	{
		id: 'a',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'hello ' },
			{ kind: 'text', text: 'world', marks: { comment: 'c1' } }
		]
	}
]);

export const richtextScenarios: Scenario[] = [
	// ── AN01 ────────────────────────────────────────────────────────────
	{
		id: 'AN01',
		requirement: 'AN01',
		title: 'independent mark keys merge/split runs; concurrent different-key marks union',
		run: () => {
			bothOrders(
				(set) => {
					ops.setMark(set.A, 'a', 0, 8, 'bold', true); // 'hello wo'
					ops.setMark(set.B, 'a', 6, 5, 'italic', true); // 'world'
					ops.insertText(set.B, 'b', 0, '!'); // unrelated block untouched
				},
				(set) => {
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hello ', marks: { bold: true } },
						{ kind: 'text', text: 'wo', marks: { bold: true, italic: true } },
						{ kind: 'text', text: 'rld', marks: { italic: true } }
					]);
					expect(runs(set.A, 'b')).toEqual([{ kind: 'text', text: '!second block' }]);
					assertRunsConverged(set, ['a', 'b'], 'AN01');
				},
				MARK_SEED
			);
		}
	},

	// ── AN02 ────────────────────────────────────────────────────────────
	{
		id: 'AN02',
		requirement: 'AN02',
		title: 'formatting across split/merge; typing at a marked boundary',
		run: () => {
			bothOrders(
				(set) => {
					ops.setMark(set.A, 'a', 3, 5, 'bold', true); // 'lo wo'
					ops.splitBlock(set.A, 'a', 5, 'a2');
					// Remote unmarked typing inside the marked range on B's replica.
					ops.insertText(set.B, 'a', 4, 'X');
				},
				(set) => {
					// B's 'X' was written while its replica had no mark at that
					// position — a concurrent unmarked insert inside a marked
					// range lands BETWEEN the format-start/end items and so
					// ADOPTS the mark (documented format-item semantics — a
					// local unmarked insert is negated instead, see golden).
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hel' },
						{ kind: 'text', text: 'lXo', marks: { bold: true } }
					]);
					expect(runs(set.A, 'a2')).toEqual([
						{ kind: 'text', text: ' wo', marks: { bold: true } },
						{ kind: 'text', text: 'rld' }
					]);
					assertRunsConverged(set, ['a', 'a2'], 'AN02');
				},
				MARK_SEED
			);
		}
	},

	// ── AN03 ────────────────────────────────────────────────────────────
	{
		id: 'AN03',
		requirement: 'AN03',
		title: 'inline atoms: identity through edits/metadata; no duplication or silent drop',
		run: () => {
			bothOrders(
				(set) => {
					// Metadata update travels as a replicated attr write.
					set.A.transact(() => opsModel.setInlineData(set.A.doc, 'a', 'm1', { user: 'bo' }));
					ops.splitBlock(set.B, 'a', 3, 'a2'); // remote split at the atom
				},
				(set) => {
					// The atom displays exactly once, on whichever side of the seam
					// owns its position, with the latest metadata on every replica.
					const inA = runs(set.A, 'a').filter((r) => r.kind === 'inline');
					const inA2 = runs(set.A, 'a2').filter((r) => r.kind === 'inline');
					expect(inA.length + inA2.length, 'atom exactly once').toBe(1);
					const atom = (inA.length ? inA : inA2)[0];
					expect(atom).toEqual({
						kind: 'inline',
						id: 'm1',
						type: 'mention',
						data: { user: 'bo' }
					});
					assertRunsConverged(set, ['a', 'a2'], 'AN03');
				},
				INLINE_SEED
			);
		}
	},

	// ── AN04 ────────────────────────────────────────────────────────────
	{
		id: 'AN04',
		requirement: 'AN04',
		title: 'live cache vs fresh vs maintained view vs readonly export — all agree',
		run: () => {
			const set = createPeerPair(MARK_SEED);
			const vA = R.attach(set.A.doc);
			const vB = R.attach(set.B.doc);
			// Local edit on A — maintained view, fresh recompute, and the raw
			// live delta cache all describe the same content.
			set.A.transact(() => ops.setMark(set.A, 'a', 0, 5, 'bold', true));
			expect(vA.runs('a')).toEqual([...O.computeAllRuns(set.A.doc).get('a')!]);
			const liveDelta = set.A.doc.get('blocks').getAttr('a').getAttr('content').delta.toJSON();
			// The live cache agrees with the export (bold on 'hello').
			expect(JSON.stringify(liveDelta)).toContain('bold');
			settled(set, 'AN04');
			// After remote application the maintained view still equals fresh.
			expect(vB.runs('a')).toEqual([...O.computeAllRuns(set.B.doc).get('a')!]);
			expect(vB.runs('a')).toEqual(vA.runs('a'));
			// Readonly export is the public shape and is immutable in time.
			const exported = vB.contentJSON('a');
			expect(exported).toEqual([{ text: 'hello', marks: { bold: true } }, { text: ' world' }]);
			set.B.transact(() => ops.insertText(set.B, 'a', 0, '>'));
			expect(exported).toEqual([{ text: 'hello', marks: { bold: true } }, { text: ' world' }]);
			settled(set, 'AN04-post-insert');
			reloadAndVerify(set, (s) => {
				// The unmarked '>' precedes the bold run — its own run.
				expect(runs(s.A, 'a')).toEqual([
					{ kind: 'text', text: '>' },
					{ kind: 'text', text: 'hello', marks: { bold: true } },
					{ kind: 'text', text: ' world' }
				]);
				assertRunsConverged(s, ['a'], 'AN04-post-reload');
			});
		}
	},

	// ── AN05 ────────────────────────────────────────────────────────────
	{
		id: 'AN05',
		requirement: 'AN05',
		title: 'local syntax decorations with remote persistent marks — overlay never replicates',
		run: () => {
			const set = createPeerPair(
				modelSpecSeed([{ id: 'a', type: 'code', content: [{ kind: 'text', text: 'const x = 1' }] }])
			);
			const vA = R.attach(set.A.doc);
			// A applies local Prism-style decorations — pure overlay.
			const decorated = decorateRuns(vA.runs('a'), [
				{ from: 0, to: 5, key: 'syntax', value: 'keyword' }
			]);
			expect(decorated[0]).toEqual({
				kind: 'text',
				text: 'const',
				decorations: { syntax: 'keyword' }
			});
			// B's persistent mark replicates; A's decoration never does.
			ops.setMark(set.B, 'a', 6, 1, 'bold', true);
			settled(set, 'AN05');
			expect(runs(set.A, 'a')).toEqual([
				{ kind: 'text', text: 'const ' },
				{ kind: 'text', text: 'x', marks: { bold: true } },
				{ kind: 'text', text: ' = 1' }
			]);
			expect(runs(set.B, 'a')).toEqual(runs(set.A, 'a'));
			// No 'syntax' key anywhere in either replica's replicated state.
			expect(JSON.stringify(ops.project(set.A))).not.toContain('syntax');
			expect(JSON.stringify(ops.project(set.B))).not.toContain('syntax');
			// A's overlay composes on top of the converged persistent runs.
			expect(
				decorateRuns(vA.runs('a'), [{ from: 6, to: 7, key: 'syntax', value: 'ident' }])[1]
			).toEqual({
				kind: 'text',
				text: 'x',
				marks: { bold: true },
				decorations: { syntax: 'ident' }
			});
			reloadAndVerify(set, (s) => {
				expect(runs(s.A, 'a')).toEqual(runs(set.A, 'a'));
			});
		}
	},

	// ── AN06 ────────────────────────────────────────────────────────────
	{
		id: 'AN06',
		requirement: 'AN06',
		title: 'concurrent overlapping same-key marks — deterministic format-item resolution',
		run: () => {
			// Case 1: identical range, conflicting values — one winner.
			bothOrders(
				(set) => {
					ops.setMark(set.A, 'a', 0, 5, 'color', 'red');
					ops.setMark(set.B, 'a', 0, 5, 'color', 'blue');
				},
				(set) => {
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hello', marks: { color: 'blue' } },
						{ kind: 'text', text: ' world' }
					]);
					assertRunsConverged(set, ['a'], 'AN06-same-range');
				},
				MARK_SEED
			);
			// Case 2: overlapping ranges — overlap resolves to the later-ordered
			// writer; the loser's end marker clears the winner's tail (documented).
			bothOrders(
				(set) => {
					ops.setMark(set.A, 'a', 0, 8, 'color', 'red');
					ops.setMark(set.B, 'a', 3, 8, 'color', 'blue');
				},
				(set) => {
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hel', marks: { color: 'red' } },
						{ kind: 'text', text: 'lo wo', marks: { color: 'blue' } },
						{ kind: 'text', text: 'rld' }
					]);
					assertRunsConverged(set, ['a'], 'AN06-overlap');
				},
				MARK_SEED
			);
			// Case 3: concurrent set vs unset — the null write wins the overlap.
			bothOrders(
				(set) => {
					ops.unsetMark(set.A, 'a', 0, 5, 'bold');
					ops.setMark(set.B, 'a', 0, 5, 'bold', true);
				},
				(set) => {
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hello' },
						{ kind: 'text', text: ' world', marks: { bold: true } }
					]);
					assertRunsConverged(set, ['a'], 'AN06-set-unset');
				},
				modelSpecSeed([
					{
						id: 'a',
						type: 'paragraph',
						content: [{ kind: 'text', text: 'hello world', marks: { bold: true } }]
					}
				])
			);
		}
	},

	// ── AN07 ────────────────────────────────────────────────────────────
	{
		id: 'AN07',
		requirement: 'AN07',
		title: 'insert at annotation endpoints incl. endpoint deleted across split/merge',
		run: () => {
			// Concurrent endpoint inserts — both land outside the annotation.
			bothOrders(
				(set) => {
					ops.insertText(set.A, 'a', 6, 'L'); // left edge, unmarked
					ops.insertText(set.B, 'a', 11, 'R'); // right edge, unmarked
				},
				(set) => {
					expect(runs(set.A, 'a')).toEqual([
						{ kind: 'text', text: 'hello L' },
						{ kind: 'text', text: 'world', marks: { comment: 'c1' } },
						{ kind: 'text', text: 'R' }
					]);
					assertRunsConverged(set, ['a'], 'AN07-endpoints');
				},
				ANN_SEED
			);
			// Endpoint deletion through split+merge — marks track live atoms.
			const set = createPeerPair(ANN_SEED);
			ops.splitBlock(set.A, 'a', 6, 'a2');
			ops.deleteText(set.A, 'a2', 0, 1); // delete the left-endpoint atom 'w'
			ops.mergeBlocks(set.A, 'a2', 'a');
			settled(set, 'AN07-split-merge');
			expect(runs(set.A, 'a')).toEqual([
				{ kind: 'text', text: 'hello ' },
				{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }
			]);
			reloadAndVerify(set, (s) => {
				expect(runs(s.A, 'a')).toEqual([
					{ kind: 'text', text: 'hello ' },
					{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }
				]);
			});
		}
	}
];
