/**
 * Active §8 scenarios for the U04 text-ownership model (slice claims over
 * stable backing texts) on top of the U03 placement model — the ModelOps
 * adapter. These run in the green lane (`pnpm test:crdt`) via
 * `scenarios.test.ts` and replace the pending TX01–TX09 / ST01–ST03 rows.
 *
 * Coverage contract per the plan and the U04 ADR
 * (docs/crdt-v14-text-ownership-adr.md):
 *
 * - every concurrent case runs BOTH delivery orders and asserts the same
 *   converged state;
 * - every scenario asserts replica convergence, structural validity, and a
 *   persist→reload round-trip (snapshot; 'log' mode on TX08);
 * - content assertions are exact per-block text/position checks — never
 *   weakened to "converges to something".
 *
 * Specified outcomes encoded here (see ADR for the full contract):
 *
 * - same-anchor concurrent splits keep BOTH sibling blocks; the contested
 *   tail resolves to the higher-stamp claim record, the loser sibling stays
 *   as an empty block (multiplicity = one block per requested split);
 * - different-anchor concurrent splits produce the seam-preserving nested
 *   partition (split at 3 + split at 8 ⇒ [0,3)|[3,8)|[8,E)) — every seam
 *   survives, every atom is displayed exactly once;
 * - a merge claim resolves by max-stamp; contested merges pick one canonical
 *   owner; `del` beats merge (a deleted destination's claims are inert);
 * - a split sibling is placed at the splitter's observed source context —
 *   a concurrent move of the source does not drag the sibling (ST01);
 * - backing texts outlive their home block: a live slice record keeps its
 *   atoms displayable and editable after the source block is deleted.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import { createPeerPair, createPeerTriple, type PeerSet } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { MODEL_BASE_SEED, modelSpecSeed } from './seeds.js';
import type { Scenario } from './registry.js';

const ops = createModelOps();

const text = (peer, id) => ops.blockText(peer, id);
const topIds = (peer) => ops.project(peer).children.map((b) => b.id);
const childIds = (peer, id) =>
	ops
		.project(peer)
		.children.find((b) => b.id === id)
		?.children.map((b) => b.id);
const blockOf = (peer, id) => {
	const stack = [...ops.project(peer).children];
	while (stack.length) {
		const b = stack.pop();
		if (b.id === id) return b;
		stack.push(...b.children);
	}
	return undefined;
};

/** Full sync barrier + hard assertions. */
const settled = (set: PeerSet, context = '') => {
	set.deliverAll();
	set.syncAll();
	set.deliverAll();
	assertConverged(set, ops, context);
	assertAllStructurallyValid(set, ops, context);
};

/**
 * Persist + reload every peer, then re-assert convergence and `verify`.
 * Snapshot reload must reproduce the identical projection — slice records,
 * anchors and claims are replicated state, not session state.
 */
const reloadAndVerify = (set: PeerSet, verify: (set: PeerSet) => void, mode = 'snapshot') => {
	for (const p of set.peers) p.persist();
	for (const p of set.peers) p.reload(mode);
	assertConverged(set, ops, `post-${mode}-reload`);
	assertAllStructurallyValid(set, ops, `post-${mode}-reload`);
	verify(set);
};

/**
 * Concurrent-op helper: `setup` issues ops on A and B while both are
 * effectively concurrent (nothing delivered yet); the schedule then ships
 * A's update to B before B's to A (order 'AB') or the reverse ('BA').
 * Both orders must converge to the same state and satisfy `verify`.
 */
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

export const textScenarios: Scenario[] = [
	// ── TX01 ────────────────────────────────────────────────────────────
	{
		id: 'TX01',
		requirement: 'TX01',
		title: 'split `hello world` before `world`; concurrent `!` lands on the live suffix',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 's1');
					ops.insertText(set.B, 'b1', 11, '!');
				},
				(set) => {
					expect(text(set.A, 'b1')).toBe('hello ');
					// The concurrent append lands on the shared backing atoms —
					// the sibling's E-sentinel claim covers it.
					expect(text(set.A, 's1')).toBe('world!');
					expect(ops.crdtId(set.A, 's1')).not.toBeNull();
					expect(topIds(set.A)).toEqual(['b1', 's1', 'b2', 'b3']);
				}
			);
		}
	},

	// ── TX02 ────────────────────────────────────────────────────────────
	{
		id: 'TX02',
		requirement: 'TX02',
		title: 'split while the remote deletes the original suffix — deletion is not recreated',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 's1');
					ops.deleteText(set.B, 'b1', 6, 5); // remote deletes 'world'
				},
				(set) => {
					expect(text(set.A, 'b1')).toBe('hello ');
					// The sibling claims the atoms but they are tombstoned —
					// nothing is resurrected by the split's records.
					expect(text(set.A, 's1')).toBe('');
					expect(JSON.stringify(ops.project(set.A))).not.toContain('world');
				}
			);
		}
	},

	// ── TX03 ────────────────────────────────────────────────────────────
	{
		id: 'TX03',
		requirement: 'TX03',
		title: 'merge two blocks; concurrent edit + format of the second survive in place',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b2', 'b1');
					ops.insertText(set.B, 'b2', 0, '>>');
					ops.setMark(set.B, 'b2', 2, 6, 'italic', true); // 'second' after the insert
				},
				(set) => {
					// b2's atoms display under b1 through the claim — with the
					// remote insert and mark applied to the SAME items.
					expect(text(set.A, 'b1')).toBe('hello world>>second block');
					expect(ops.positionOf(set.A, 'b2')).toBeNull();
					const b1 = blockOf(set.A, 'b1');
					const italicRun = b1.content.find(
						(i) => i.kind === 'text' && i.text === 'second' && i.marks?.italic === true
					);
					expect(italicRun?.marks?.bold).toBe(true);
				}
			);
		}
	},

	// ── TX04 ────────────────────────────────────────────────────────────
	{
		id: 'TX04a',
		requirement: 'TX04',
		title: 'concurrent splits at the SAME anchor — both siblings exist, tail resolves to max stamp',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 'sA');
					ops.splitBlock(set.B, 'b1', 6, 'sB');
				},
				(set) => {
					expect(text(set.A, 'b1')).toBe('hello ');
					// Multiplicity: BOTH requested siblings exist. The contested
					// tail resolves by (g, start, stamp) — identical ranges and
					// starts, so the higher-stamp record (client 2 = B) wins the
					// atoms; the loser sibling stays as an empty block.
					expect(text(set.A, 'sB')).toBe('world');
					expect(text(set.A, 'sA')).toBe('');
					// Sibling order inside the tie is rank-order — convergent on
					// every replica but not pinned cross-run.
					expect(new Set(topIds(set.A))).toEqual(new Set(['b1', 'sA', 'sB', 'b2', 'b3']));
					expect(topIds(set.A)[0]).toBe('b1');
					expect(topIds(set.A).indexOf('sA')).toBeLessThan(topIds(set.A).indexOf('b2'));
					expect(topIds(set.A).indexOf('sB')).toBeLessThan(topIds(set.A).indexOf('b2'));
				}
			);
		}
	},
	{
		id: 'TX04b',
		requirement: 'TX04',
		title: 'concurrent splits at DIFFERENT anchors — seam-preserving nested partition',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 3, 'sA');
					ops.splitBlock(set.B, 'b1', 8, 'sB');
				},
				(set) => {
					// Both seams survive: [0,3) | [3,8) | [8,E) — every atom of
					// 'hello world' displayed exactly once, nothing dropped or
					// duplicated.
					expect(text(set.A, 'b1')).toBe('hel');
					expect(text(set.A, 'sA')).toBe('lo wo');
					expect(text(set.A, 'sB')).toBe('rld');
					expect(new Set(topIds(set.A))).toEqual(new Set(['b1', 'sA', 'sB', 'b2', 'b3']));
				}
			);
		}
	},
	{
		id: 'TX04c',
		requirement: 'TX04',
		title: 'repeated causal splits — each generation partitions the current owner',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.splitBlock(A, 'b1', 6, 's1');
			settled(set, 'after first split');
			ops.splitBlock(B, 's1', 2, 's2');
			settled(set, 'after second split');
			ops.splitBlock(A, 's2', 1, 's3');
			settled(set, 'after third split');
			const verify = (s: PeerSet) => {
				expect(text(s.A, 'b1')).toBe('hello ');
				expect(text(s.A, 's1')).toBe('wo');
				expect(text(s.A, 's2')).toBe('r');
				expect(text(s.A, 's3')).toBe('ld');
				expect(topIds(s.A)).toEqual(['b1', 's1', 's2', 's3', 'b2', 'b3']);
			};
			verify(set);
			reloadAndVerify(set, verify);
		}
	},

	// ── TX05 ────────────────────────────────────────────────────────────
	{
		id: 'TX05a',
		requirement: 'TX05',
		title: 'concurrent chain merges b2→b1 and b3→b2 — transitive claim, one display per atom',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b2', 'b1');
					ops.mergeBlocks(set.B, 'b3', 'b2');
				},
				(set) => {
					// b3's list is claimed by b2, b2's by b1 → owner chain b3→b2→b1:
					// one visible block displays all three texts exactly once.
					expect(text(set.A, 'b1')).toBe('hello worldsecond blockparent');
					expect(ops.positionOf(set.A, 'b2')).toBeNull();
					expect(ops.positionOf(set.A, 'b3')).toBeNull();
					// b3's children were reparented to b2 by the merge, then follow
					// the effective display parent to b1.
					expect(childIds(set.A, 'b1')).toEqual(['b3a', 'b3b']);
					expect(text(set.A, 'b3a')).toBe('child a');
				}
			);
		}
	},
	{
		id: 'TX05b',
		requirement: 'TX05',
		title: 'contested merge b2→b1 vs b2→b3 — one canonical owner by max-stamp claim',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b2', 'b1');
					ops.mergeBlocks(set.B, 'b2', 'b3');
				},
				(set) => {
					// Max-stamp claim wins (B's claim item, client 2 > client 1):
					// b2's atoms display under b3 exactly once; b1 is untouched;
					// b1's losing claim contributes nothing.
					expect(text(set.A, 'b3')).toBe('parentsecond block');
					expect(text(set.A, 'b1')).toBe('hello world');
					expect(ops.positionOf(set.A, 'b2')).toBeNull();
					expect(ops.listBlockIds(set.A).filter((i) => i === 'b2')).toHaveLength(0);
				}
			);
		}
	},
	{
		id: 'TX05c',
		requirement: 'TX05',
		title: 'split b1 vs merge b1→b2 concurrently — claim covers the post-split head only',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 'sA');
					ops.mergeBlocks(set.B, 'b1', 'b2');
				},
				(set) => {
					// The merge claims b1's CURRENT slice list — which the split
					// rewrote to the head only. The tail sibling is an independent
					// block and survives outside the claim.
					expect(text(set.A, 'b2')).toBe('second blockhello ');
					expect(text(set.A, 'sA')).toBe('world');
					expect(ops.positionOf(set.A, 'b1')).toBeNull();
					expect(ops.positionOf(set.A, 'sA')).not.toBeNull();
				}
			);
		}
	},

	// ── TX06 ────────────────────────────────────────────────────────────
	{
		id: 'TX06a',
		requirement: 'TX06',
		title: 'concurrent insert exactly at the split seam — head-side affinity',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 's1');
					ops.insertText(set.B, 'b1', 6, '|'); // the seam: before 'w'
				},
				(set) => {
					// Both anchors bind "before the same item" — the seam insert
					// resolves left of the bound atom → head side.
					expect(text(set.A, 'b1')).toBe('hello |');
					expect(text(set.A, 's1')).toBe('world');
				}
			);
		}
	},
	{
		id: 'TX06b',
		requirement: 'TX06',
		title: 'boundary affinity — merge-join insert, seam-spanning delete and format',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			// Merge-join insert → left (head) side of the join.
			ops.mergeBlocks(A, 'b2', 'b1');
			ops.insertText(A, 'b1', 11, '!');
			expect(text(A, 'b1')).toBe('hello world!second block');
			settled(set, 'merge-join insert');

			// Seam-spanning delete across a split boundary, then format.
			ops.splitBlock(A, 'b1', 6, 's1'); // 'hello ' | 'world!second block'
			expect(ops.deleteText(A, 'b1', 4, 2)).toBe(true);
			expect(ops.deleteText(A, 's1', 0, 2)).toBe(true);
			expect(text(A, 'b1')).toBe('hell');
			expect(text(A, 's1')).toBe('rld!second block');
			ops.setMark(A, 'b1', 1, 3, 'bold', true);
			ops.setMark(A, 's1', 0, 3, 'bold', true);
			settled(set, 'seam delete+format');
			const verify = (s: PeerSet) => {
				const b1 = blockOf(s.A, 'b1');
				expect(b1.content).toEqual([
					{ kind: 'text', text: 'h', marks: undefined },
					{ kind: 'text', text: 'ell', marks: { bold: true } }
				]);
				const s1 = blockOf(s.A, 's1');
				expect(s1.content[0]).toEqual({
					kind: 'text',
					text: 'rld',
					marks: { bold: true }
				});
			};
			verify(set);
			reloadAndVerify(set, verify);
		}
	},
	{
		id: 'TX06c',
		requirement: 'TX06',
		title: 'deleted-anchor fallback — slice survives its bound atom being deleted',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'b1', 6, 's1');
					set.deliverAll(); // B needs s1 to aim at it
					// Concurrently: B deletes the atom the tail's start anchor
					// binds to ('w'), C-side peer B2... on a pair, B deletes and
					// A inserts at the tail's left edge.
					ops.deleteText(set.B, 's1', 0, 1);
					ops.insertText(set.A, 's1', 0, 'X');
				},
				(set) => {
					// The start anchor resolves to the gap where 'w' lived; the
					// concurrent insert at that gap stays inside the claim.
					expect(text(set.A, 'b1')).toBe('hello ');
					expect(text(set.A, 's1')).toBe('Xorld');
				}
			);
		}
	},

	// ── TX07 ────────────────────────────────────────────────────────────
	{
		id: 'TX07',
		requirement: 'TX07',
		title: 'move→split→merge cycles, then a late offline edit resolves to the current owner',
		run: () => {
			const set = createPeerTriple(MODEL_BASE_SEED);
			const { A, B, C } = set;
			ops.nestBlock(A, 'b1', 'b3'); // cycle 1: move
			settled(set, 'cycle 1');
			ops.splitBlock(A, 'b1', 6, 's1'); // cycle 2: split inside b3
			settled(set, 'cycle 2');
			set.isolate('C'); // C keeps s1='world' under b3
			ops.mergeBlocks(B, 's1', 'b2'); // cycle 3: merge the sibling (A,B only)
			ops.moveBlock(B, 'b2', { parent: null, index: 0 });
			set.deliverAll(); // A↔B exchange while C is partitioned
			ops.insertText(C, 's1', 5, '!!'); // late offline edit on the stale view
			set.healPeer('C');
			settled(set, 'after heal');
			const verify = (s: PeerSet) => {
				// The late edit landed on the backing atoms, so the CURRENT
				// owner (b2 through the claim) displays it — no resurrection
				// of s1, no lost edit.
				expect(text(s.A, 'b2')).toBe('second blockworld!!');
				expect(ops.positionOf(s.A, 's1')).toBeNull();
				expect(ops.positionOf(s.A, 'b2')).toEqual({ parent: null, index: 0 });
				expect(ops.positionOf(s.A, 'b1')).toEqual({ parent: 'b3', index: 2 });
				expect(text(s.A, 'b1')).toBe('hello ');
			};
			verify(set);
			reloadAndVerify(set, verify);
		}
	},

	// ── TX08 ────────────────────────────────────────────────────────────
	{
		id: 'TX08',
		requirement: 'TX08',
		title:
			'delete the source block while a sibling displays its slice — live, editable, reloadable',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.splitBlock(A, 'b1', 6, 's1');
			settled(set, 'post-split');
			// Concurrent: A deletes the source, B edits the surviving slice.
			ops.deleteBlock(A, 'b1');
			ops.insertText(B, 's1', 5, '!');
			settled(set, 'del-source + edit');
			const verify = (s: PeerSet) => {
				// b1 is gone together with its head atoms; s1's live record
				// keeps the tail atoms displayable AND editable — the backing
				// text outlives its home block while claimed.
				expect(ops.positionOf(s.A, 'b1')).toBeNull();
				expect(text(s.A, 's1')).toBe('world!');
				expect(topIds(s.A)).toEqual(['s1', 'b2', 'b3']);
			};
			verify(set);
			// The slice remains writable after the source is gone.
			ops.insertText(A, 's1', 0, '>');
			expect(text(A, 's1')).toBe('>world!');
			settled(set, 'post-delete edit');
			// 'log'-mode reload as well: the full update replay must rebuild
			// the same ownership view.
			reloadAndVerify(set, (s) => expect(text(s.A, 's1')).toBe('>world!'), 'log');
		}
	},

	// ── TX09 ────────────────────────────────────────────────────────────
	{
		id: 'TX09a',
		requirement: 'TX09',
		title: 'empty blocks — split produces a live empty sibling; merge claims it cleanly',
		run: () => {
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'e1', 0, 'e1b');
					ops.insertText(set.B, 'e1', 0, 'z'); // revive insert races the split
				},
				(set) => {
					expect(topIds(set.A)).toEqual(['e1', 'e1b', 'e2']);
					// The concurrent insert lands on the head (offset 0 covers
					// the insert point); the sibling stays empty — and stays a
					// live, renderable block.
					expect(text(set.A, 'e1')).toBe('z');
					expect(text(set.A, 'e1b')).toBe('');
					expect(ops.positionOf(set.A, 'e1b')).not.toBeNull();
				},
				modelSpecSeed([
					{ id: 'e1', type: 'paragraph' },
					{ id: 'e2', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
				])
			);
			// Sequential half: merge the empty sibling — the claim resolves,
			// nothing is displayed twice, the empty block hides.
			const set = createPeerPair(
				modelSpecSeed([
					{ id: 'e1', type: 'paragraph' },
					{ id: 'e2', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
				])
			);
			ops.splitBlock(set.A, 'e1', 0, 'e1b');
			ops.mergeBlocks(set.A, 'e1b', 'e2');
			settled(set, 'empty merge');
			expect(text(set.A, 'e2')).toBe('x');
			expect(ops.positionOf(set.A, 'e1b')).toBeNull();
		}
	},
	{
		id: 'TX09b',
		requirement: 'TX09',
		title: 'inline atoms — an atom crossed by the seam moves whole, once, identity kept',
		run: () => {
			const INLINE_SEED = modelSpecSeed([
				{
					id: 'w1',
					type: 'paragraph',
					content: [
						{ kind: 'text', text: 'ab' },
						{ kind: 'inline', id: 'i1', type: 'mention', data: { k: 'v' } },
						{ kind: 'text', text: 'cd' }
					]
				}
			]);
			bothOrders(
				(set) => {
					ops.splitBlock(set.A, 'w1', 2, 'w2'); // seam before the atom
					ops.insertText(set.B, 'w1', 5, '!'); // after the atom
				},
				(set) => {
					expect(blockOf(set.A, 'w1').content).toEqual([
						{ kind: 'text', text: 'ab', marks: undefined }
					]);
					// The atom is unitary: it lands on the tail side whole,
					// exactly once, with its id/type/data intact. The remote
					// append follows it via the E-sentinel.
					expect(blockOf(set.A, 'w2').content).toEqual([
						{ kind: 'inline', id: 'i1', type: 'mention', data: { k: 'v' } },
						{ kind: 'text', text: 'cd!', marks: undefined }
					]);
				},
				INLINE_SEED
			);
		}
	},
	{
		id: 'TX09c',
		requirement: 'TX09',
		title: 'nested children — split reparents children onto the sibling; merge does too',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A } = set;
			ops.splitBlock(A, 'b3', 2, 'b3s');
			settled(set, 'split with children');
			expect(childIds(A, 'b3s')).toEqual(['b3a', 'b3b']);
			expect(childIds(A, 'b3')).toEqual([]);
			expect(text(A, 'b3')).toBe('pa');
			expect(text(A, 'b3s')).toBe('rent');
			// Merge the sibling into b2 — children follow the merge.
			ops.mergeBlocks(A, 'b3s', 'b2');
			settled(set, 'merge sibling');
			expect(childIds(A, 'b2')).toEqual(['b3a', 'b3b']);
			expect(ops.positionOf(A, 'b3s')).toBeNull();
			reloadAndVerify(set, (s) => {
				expect(childIds(s.A, 'b2')).toEqual(['b3a', 'b3b']);
				expect(text(s.A, 'b2')).toBe('second blockrent');
			});
		}
	},

	// ── ST01 ────────────────────────────────────────────────────────────
	{
		id: 'ST01a',
		requirement: 'ST01',
		title: 'move A=P→Q vs split A=ab — head moves, sibling stays at the split context',
		run: () => {
			bothOrders(
				(set) => {
					ops.nestBlock(set.A, 'b1', 'b3'); // A: move b1 root→b3
					ops.splitBlock(set.B, 'b1', 6, 's1'); // B: split b1 at root
				},
				(set) => {
					// The head's placement is LWW data — the move applies. The
					// sibling's placement is written at the SPLITTER's observed
					// context (root, after b1's old slot): a concurrent move of
					// the source does not drag the seam.
					expect(ops.positionOf(set.A, 'b1')).toEqual({ parent: 'b3', index: 2 });
					expect(ops.positionOf(set.A, 's1')).toEqual({ parent: null, index: 0 });
					expect(text(set.A, 'b1')).toBe('hello ');
					expect(text(set.A, 's1')).toBe('world');
				}
			);
		}
	},
	{
		id: 'ST01b',
		requirement: 'ST01',
		title: 'merge A→B vs move source A — the claim wins; the source is hidden under B',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b1', 'b2');
					ops.moveBlock(set.B, 'b1', { parent: 'b3', index: 0 });
				},
				(set) => {
					// owner(b1)=b2 — the concurrent placement write is moot for
					// display: a merged-away block has no position. Its atoms
					// display under b2 at b2's own placement.
					expect(ops.positionOf(set.A, 'b1')).toBeNull();
					expect(ops.positionOf(set.A, 'b2')).toEqual({ parent: null, index: 0 });
					expect(text(set.A, 'b2')).toBe('second blockhello world');
				}
			);
		}
	},
	{
		id: 'ST01c',
		requirement: 'ST01',
		title: 'merge A→B vs move destination B — merged content follows the destination',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b1', 'b2');
					ops.moveBlock(set.B, 'b2', { parent: 'b3', index: 0 });
				},
				(set) => {
					expect(ops.positionOf(set.A, 'b1')).toBeNull();
					expect(ops.positionOf(set.A, 'b2')).toEqual({ parent: 'b3', index: 0 });
					expect(text(set.A, 'b2')).toBe('second blockhello world');
				}
			);
		}
	},

	// ── ST02 ────────────────────────────────────────────────────────────
	{
		id: 'ST02a',
		requirement: 'ST02',
		title: 'delete source vs split — the sibling rescues its claimed tail; head hides with source',
		run: () => {
			bothOrders(
				(set) => {
					ops.deleteBlock(set.A, 'b1');
					ops.splitBlock(set.B, 'b1', 6, 's1');
				},
				(set) => {
					// The split's tail records live on the SIBLING's list (a live
					// holder) — they keep their atoms visible even though the
					// source block is deleted. The head atoms, only covered by
					// the deleted block's own records, hide with it.
					expect(ops.positionOf(set.A, 'b1')).toBeNull();
					expect(text(set.A, 's1')).toBe('world');
					expect(ops.positionOf(set.A, 's1')).not.toBeNull();
				}
			);
		}
	},
	{
		id: 'ST02b',
		requirement: 'ST02',
		title: 'delete merge destination vs merge — dead-holder claim is inert, source survives',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b2', 'b1');
					ops.deleteBlock(set.B, 'b1');
				},
				(set) => {
					// Delete-beats-merge: the claim written by the deleted block
					// is inert — b2 stays visible instead of being swallowed
					// into a dead subtree.
					expect(ops.positionOf(set.A, 'b1')).toBeNull();
					expect(ops.positionOf(set.A, 'b2')).not.toBeNull();
					expect(text(set.A, 'b2')).toBe('second block');
				}
			);
		}
	},
	{
		id: 'ST02c',
		requirement: 'ST02',
		title: 'delete merge source vs merge — deleted source hides with its atoms',
		run: () => {
			bothOrders(
				(set) => {
					ops.mergeBlocks(set.A, 'b2', 'b1');
					ops.deleteBlock(set.B, 'b2');
				},
				(set) => {
					// b2 is deleted: its own records are dead-holder (cannot
					// claim), so the claim on it contributes nothing and its
					// content hides with the deletion — deletion wins.
					expect(ops.positionOf(set.A, 'b2')).toBeNull();
					expect(text(set.A, 'b1')).toBe('hello world');
					expect(JSON.stringify(ops.project(set.A))).not.toContain('second');
				}
			);
		}
	},
	{
		id: 'ST02d',
		requirement: 'ST02',
		title: 'delete ancestor vs split inside it — sibling hides with the subtree',
		run: () => {
			bothOrders(
				(set) => {
					ops.deleteBlock(set.A, 'b3');
					ops.splitBlock(set.B, 'b3a', 3, 'sA');
				},
				(set) => {
					// The sibling's placement points at the deleted b3 —
					// hidden-with-subtree applies to it exactly as to b3a.
					expect(ops.positionOf(set.A, 'b3')).toBeNull();
					expect(ops.positionOf(set.A, 'b3a')).toBeNull();
					expect(ops.positionOf(set.A, 'sA')).toBeNull();
					expect(ops.listBlockIds(set.A)).toEqual(['b1', 'b2']);
				}
			);
		}
	},

	// ── ST03 ────────────────────────────────────────────────────────────
	{
		id: 'ST03',
		requirement: 'ST03',
		title: 'three peers: split + merge + move + edit — one valid tree, exclusive ownership',
		run: () => {
			const verify = (set: PeerSet) => {
				expect(ops.positionOf(set.A, 'b2')).toEqual({ parent: null, index: 0 });
				expect(text(set.A, 'b2')).toBe('second blockparent');
				expect(childIds(set.A, 'b2')).toEqual(['b3a', 'b3b']);
				expect(ops.positionOf(set.A, 'b3')).toBeNull();
				expect(text(set.A, 'b1')).toBe('Xhello ');
				expect(text(set.A, 'sA')).toBe('world');
			};
			for (const order of ['ABC', 'CBA']) {
				const set = createPeerTriple(MODEL_BASE_SEED);
				const { A, B, C } = set;
				ops.splitBlock(A, 'b1', 6, 'sA');
				ops.mergeBlocks(B, 'b3', 'b2');
				ops.moveBlock(C, 'b2', { parent: null, index: 0 });
				ops.insertText(C, 'b1', 0, 'X');
				// Deliver every peer's queued updates in the chosen order.
				for (const from of order) {
					for (const to of ['A', 'B', 'C']) {
						if (from !== to) set.deliver(from, to);
					}
				}
				settled(set, `order=${order}`);
				verify(set);
				reloadAndVerify(set, verify);
			}
		}
	},

	// ── HI01 (engine-level undo proofs for U04; full history contract
	//    remains pending under U09) ──────────────────────────────────────
	{
		id: 'HI01a',
		requirement: 'HI01',
		title: 'undo split after a remote edit to the moved suffix — remote edit survives on the head',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			A.enableUndo({ scope: A.doc.get('blocks') });
			ops.splitBlock(A, 'b1', 6, 's1');
			set.deliver('A', 'B');
			ops.insertText(B, 's1', 5, '!'); // remote edits the moved tail
			set.deliver('B', 'A');
			expect(text(A, 'b1')).toBe('hello ');
			expect(text(A, 's1')).toBe('world!');
			A.undoManager.undo();
			// The split inverts: sibling records tombstone, b1's whole-range
			// record revives — and the REMOTE edit on the shared backing text
			// is preserved inside the restored block.
			expect(text(A, 'b1')).toBe('hello world!');
			expect(ops.positionOf(A, 's1')).toBeNull();
			settled(set, 'post-undo');
			const verify = (s: PeerSet) => {
				expect(text(s.A, 'b1')).toBe('hello world!');
				expect(ops.positionOf(s.A, 's1')).toBeNull();
			};
			verify(set);
			reloadAndVerify(set, verify);
		}
	},
	{
		id: 'HI01b',
		requirement: 'HI01',
		title: 'undo merge after remote edits to merged content + remote move — contributions survive',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			A.enableUndo({ scope: A.doc.get('blocks') });
			ops.mergeBlocks(A, 'b2', 'b1');
			set.deliver('A', 'B');
			ops.insertText(B, 'b1', 15, 'XX'); // remote edits the claimed region
			ops.moveBlock(B, 'b1', { parent: null, index: 2 }); // remote moves b1
			set.deliver('B', 'A');
			A.undoManager.undo();
			// The claim tombstones → b2's self-coverage revives WITH the
			// remote text edit; b1 keeps B's placement write.
			expect(ops.positionOf(A, 'b2')).not.toBeNull();
			expect(text(A, 'b2')).toBe('secoXXnd block');
			expect(text(A, 'b1')).toBe('hello world');
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: null, index: 2 });
			settled(set, 'post-undo');
			const verify = (s: PeerSet) => {
				expect(text(s.A, 'b2')).toBe('secoXXnd block');
				expect(ops.positionOf(s.A, 'b1')).toEqual({ parent: null, index: 2 });
			};
			verify(set);
			reloadAndVerify(set, verify);
		}
	}
];
