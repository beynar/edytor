/**
 * U04-F1 ownership regressions — the three defects reproduced in the
 * 2026-09-20 progress review (docs/crdt-v14-progress-review-2026-09-20.md),
 * pinned as hard failures through the assembled `EdytorDoc` facade:
 *
 * - A: typing at the left edge of a mid text after CONCURRENT splits stole
 *   another block's atoms — the rewrite kept the record's original end
 *   anchor, so the elevated generation re-claimed coverage the record had
 *   already lost (early='Xdefghij', late='').
 * - B: typing into an EMPTY head left by a split-at-0 appended to the tail —
 *   the revival record's start was the dynamic end sentinel, which advanced
 *   past the inserted character (b='', tail='abcdefghijX').
 * - C: a caller block literally named 'dead' collided with the internal
 *   deleted-owner sentinel — its text never displayed and different
 *   consumers disagreed about whether it existed at all.
 *
 * Every scenario runs through `bindEdytorDoc` on INDEPENDENT replicas
 * (binary-state seed → per-peer docs), asserts exact ownership and content
 * (never mere replica equality), survives duplicate delivery and both
 * delivery orders, and re-asserts after a snapshot reload (encode → apply
 * into a fresh doc). Follow-up insert/delete/format/inline-atom and
 * undo/redo ops extend each scenario.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair, type Peer } from '../harness/peer-set.js';
import { contentOwners } from '../harness/streams.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { collectBlocks } from '../../oracles/fresh-view.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

// Facades for reads (project/anchors/ownership internals). Mutations go
// through `ops.*`, which wraps each call in `peer.transact` so undo scopes
// track them under the peer's local origin.
const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};

const text = (peer: Peer, id: string) => ed(peer).blockText(id);

/**
 * D-14 (R3): a delete now hides everything the block displays, so the
 * pre-D1 "a deleted holder releases its coverage" state is staged by
 * removing the registry entry — an absent block's records claim nothing,
 * exactly what the old delete produced.
 */
const dropBlock = (peer: Peer, id: string) =>
	peer.doc.transact(() => peer.doc.get('blocks').deleteAttr(id));
const topIds = (peer: Peer) => ed(peer).childrenIds(null);

/**
 * Run an undo-tracked op as its OWN undo stack item. `captureTimeout: 0`
 * still merges same-millisecond transactions (Date.now granularity), so
 * `stopCapturing()` is the only deterministic separator.
 */
const op = (peer: Peer, fn: () => unknown) => {
	fn();
	peer.undoManager?.stopCapturing();
};

/**
 * The per-atom owner row of backing text `t` — the direct ownership
 * assertion: WHICH block displays each atom, not just the concatenated
 * result. `null` marks unowned (dead/unclaimed) atoms.
 */
const atomOwners = (peer: Peer, t: string): (string | null)[] => contentOwners(peer.doc, t);

/**
 * Flush every queued update + state-vector sync, persist + reload every
 * peer (encode → apply into a fresh doc), then re-assert convergence and
 * `verify`.
 */
const reloadAndVerify = (set, verify) => {
	set.deliverAll();
	set.syncAll('full');
	for (const p of set.peers) p.persist();
	for (const p of set.peers) p.reload('snapshot');
	assertConverged(set, ops, 'post-reload');
	assertAllStructurallyValid(set, ops, 'post-reload');
	verify(set);
};

const SEED = (doc) => {
	E.init(doc, {
		content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }]
	});
};

// ── A: left-edge insert after concurrent splits ─────────────────────────

describe('regression A — insert after concurrent splits must not steal owned atoms', () => {
	for (const order of ['AB', 'BA'] as const) {
		it(`nested partition then left-edge type (delivery ${order}, duplicated)`, () => {
			const set = createPeerPair(SEED);
			const { A, B } = set;
			// Concurrent splits of the same text at different anchors.
			ops.splitBlock(A, 'b', 3, 'early');
			ops.splitBlock(B, 'b', 8, 'late');
			const exchange = () => {
				// {times:2} = duplicate delivery — every update applied twice
				// must remain a no-op.
				if (order === 'AB') {
					set.deliver('A', 'B', { times: 2 });
					set.deliver('B', 'A', { times: 2 });
				} else {
					set.deliver('B', 'A', { times: 2 });
					set.deliver('A', 'B', { times: 2 });
				}
			};
			exchange();
			// The seam-preserving nested partition: [0,3)|[3,8)|[8,E).
			const mid = (s) => {
				for (const p of [s.A, s.B]) {
					expect(text(p, 'b')).toBe('abc');
					expect(text(p, 'early')).toBe('defgh');
					expect(text(p, 'late')).toBe('ij');
				}
			};
			mid(set);
			A.enableUndo({ scope: A.doc.get('blocks'), captureTimeout: 0 });
			// The reproducing op: left-edge insert into the middle segment.
			op(A, () => ops.insertText(A, 'early', 0, 'X'));
			exchange();
			assertConverged(set, ops, `order=${order}`);
			assertAllStructurallyValid(set, ops, `order=${order}`);
			const verify = (s) => {
				for (const p of [s.A, s.B]) {
					// 'X' joins early's segment; late's atoms are NOT re-claimed.
					expect(text(p, 'b')).toBe('abc');
					expect(text(p, 'early')).toBe('Xdefgh');
					expect(text(p, 'late')).toBe('ij');
					// Ownership, not just content: per-atom owner row of the
					// shared backing text.
					expect(atomOwners(p, 'b')).toEqual([
						'b',
						'b',
						'b',
						'early',
						'early',
						'early',
						'early',
						'early',
						'early',
						'late',
						'late'
					]);
				}
			};
			verify(set);

			// ── follow-ups on the same contested shape ──────────────────
			// Right-edge append into early; left-edge insert into late
			// (another covering-record rewrite, E-ended this time).
			op(A, () => ops.insertText(A, 'early', 6, 'Y'));
			op(A, () => ops.insertText(A, 'late', 0, 'Z'));
			// Format strictly inside early's owned span.
			op(A, () => ops.setMark(A, 'early', 1, 5, 'bold', true));
			// Inline atom at the contested left edge.
			op(A, () => ops.insertInline(A, 'early', 0, { id: 'in-a', type: 'mention', data: { k: 1 } }));
			// Delete inside the rewritten segment.
			op(A, () => ops.deleteText(A, 'early', 1, 1)); // removes 'X'
			settledExchange(set, exchange, `order=${order} follow-ups`);
			const verify2 = (s) => {
				for (const p of [s.A, s.B]) {
					expect(text(p, 'b')).toBe('abc');
					expect(text(p, 'early')).toBe('defghY');
					expect(text(p, 'late')).toBe('Zij');
					const early = ed(p)
						.project()
						.children.find((x) => x.id === 'early');
					expect(early.content).toEqual([
						{ kind: 'inline', id: 'in-a', type: 'mention', data: { k: 1 } },
						{ kind: 'text', text: 'defgh', marks: { bold: true } },
						{ kind: 'text', text: 'Y', marks: undefined }
					]);
					// b atoms: abc | in-a | defgh | Y | Z | ij
					expect(atomOwners(p, 'b')).toEqual([
						'b',
						'b',
						'b',
						'early',
						'early',
						'early',
						'early',
						'early',
						'early',
						'early',
						'late',
						'late',
						'late'
					]);
				}
			};
			verify2(set);

			// ── undo/redo over the six writes (each its own stack item) ──
			// R3 undo-ownership repair (docs/crdt-v14-undo-ownership-adr.md):
			// the engine resurrects a deleted atom as a NEW item whose slice
			// anchors do not follow it — the repair re-asserts the pre-delete
			// holder's claim over the copy atoms as replicated state, so a
			// resurrected atom displays under the SAME block that held it
			// when it was deleted (no drift on undoing the delete AND no
			// drift on redoing the inserts: Z returns to 'late').
			for (let i = 0; i < 6; i++) A.undoManager.undo();
			// All six writes undone → back to the nested partition.
			expect(text(A, 'b')).toBe('abc');
			expect(text(A, 'early')).toBe('defgh');
			expect(text(A, 'late')).toBe('ij');
			for (let i = 0; i < 6; i++) A.undoManager.redo();
			// After the full redo the resurrection path restores each atom
			// to the block that displayed it: Z lands back on 'late' (the
			// pre-repair drift put it under early's still-covering record).
			expect(text(A, 'b')).toBe('abc');
			expect(text(A, 'early')).toBe('defghY');
			expect(text(A, 'late')).toBe('Zij');
			expect(atomOwners(A, 'b')).toEqual([
				'b',
				'b',
				'b',
				'early',
				'early',
				'early',
				'early',
				'early',
				'early',
				'early',
				'late',
				'late',
				'late'
			]);
			expect([...(text(A, 'b') + text(A, 'early') + text(A, 'late'))].sort().join('')).toBe(
				'YZabcdefghij'
			);
			exchange();
			assertConverged(set, ops, `order=${order} post-undo`);
			assertAllStructurallyValid(set, ops, `order=${order} post-undo`);
			// Binary reload: encode → apply into a fresh doc, re-assert.
			reloadAndVerify(set, (s) => {
				for (const p of [s.A, s.B]) {
					expect(text(p, 'b')).toBe('abc');
					expect(text(p, 'late')).toBe('Zij');
					expect(text(p, 'early')).toBe('defghY');
				}
			});
		});
	}

	it('duplicate delivery of the contested insert stays idempotent', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 3, 'early');
		ops.splitBlock(B, 'b', 8, 'late');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		ops.insertText(A, 'early', 0, 'X');
		// Deliver the same queued update three times.
		set.deliver('A', 'B', { times: 3 });
		set.deliver('B', 'A', { times: 3 });
		assertConverged(set, ops, 'dup×3');
		expect(text(B, 'early')).toBe('Xdefgh');
		expect(text(B, 'late')).toBe('ij');
		expect(atomOwners(B, 'b')).toEqual([
			'b',
			'b',
			'b',
			'early',
			'early',
			'early',
			'early',
			'early',
			'early',
			'late',
			'late'
		]);
	});
});

/** Flush queued updates both ways (dup-safe), then hard-assert. */
const settledExchange = (set, exchange, context: string) => {
	exchange();
	assertConverged(set, ops, context);
	assertAllStructurallyValid(set, ops, context);
};

// ── B: insert into the empty head left by a split-at-0 ──────────────────

describe('regression B — insert into an empty head must not edit the tail', () => {
	it('revive claims the inserted atoms on the head, tail untouched', () => {
		const set = createPeerPair(SEED);
		const { A } = set;
		A.enableUndo({ scope: A.doc.get('blocks'), captureTimeout: 0 });
		op(A, () => ops.splitBlock(A, 'b', 0, 'tail'));
		expect(text(A, 'b')).toBe('');
		expect(text(A, 'tail')).toBe('abcdefghij');
		// The reproduced op: insert into the EMPTY head. It must own the new
		// atoms — the tail's E-sentinel must not swallow them.
		op(A, () => expect(ops.insertText(A, 'b', 0, 'X')).toBe(true));
		expect(text(A, 'b')).toBe('X');
		expect(text(A, 'tail')).toBe('abcdefghij');
		// Ownership row (R2): 'X' lands in b's stream — before tail's boundary
		// at the text start — and the 10 original atoms stay with tail.
		expect(atomOwners(A, 'b')).toEqual(['b', ...Array(10).fill('tail')]);
		// Follow-ups: the revived block is a real editable target.
		op(A, () => ops.insertText(A, 'b', 1, 'Y')); // right edge of b's revived span
		expect(text(A, 'b')).toBe('XY');
		op(A, () => ops.insertInline(A, 'b', 2, { id: 'in-b', type: 'mention' }));
		op(A, () => ops.setMark(A, 'b', 0, 2, 'bold', true));
		op(A, () => ops.deleteText(A, 'b', 0, 1)); // removes 'X'
		const bBlock = ed(A)
			.project()
			.children.find((x) => x.id === 'b');
		expect(bBlock.content).toEqual([
			{ kind: 'text', text: 'Y', marks: { bold: true } },
			{ kind: 'inline', id: 'in-b', type: 'mention' }
		]);
		expect(text(A, 'tail')).toBe('abcdefghij');
		// ── undo/redo: undoing the delete resurrects X as a NEW item, which
		// `redoItem` integrates beside its tombstone — before tail's boundary,
		// in b's stream (R2): X comes home to 'b' with no repair write.
		A.undoManager.undo(); // undoes `del` — X resurrects in b's stream
		expect(text(A, 'b')).toBe('XY');
		expect(text(A, 'tail')).toBe('abcdefghij');
		// Undo the rest (mark, in-b, Y, X-insert) — the insert's own undo
		// removes the resurrected successor too, restoring the split state.
		for (let i = 0; i < 4; i++) A.undoManager.undo();
		expect(text(A, 'b')).toBe('');
		expect(text(A, 'tail')).toBe('abcdefghij');
		// And the split itself:
		A.undoManager.undo();
		expect(text(A, 'b')).toBe('abcdefghij');
		expect(ed(A).positionOf('tail')).toBeNull();
		// Redo the whole stack — returns to the pre-undo state exactly.
		for (let i = 0; i < 6; i++) A.undoManager.redo();
		expect(text(A, 'b')).toBe('Y');
		expect(text(A, 'tail')).toBe('abcdefghij');
		reloadAndVerify(set, (s) => {
			for (const p of [s.A, s.B]) {
				expect(text(p, 'b')).toBe('Y');
				expect(text(p, 'tail')).toBe('abcdefghij');
			}
		});
	});

	it('concurrent revive inserts into the same empty head all land on it', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 0, 'tail');
		set.deliver('A', 'B');
		// Both peers type into the still-empty head concurrently — two
		// independent revive records on b's list.
		ops.insertText(A, 'b', 0, 'X');
		ops.insertText(B, 'b', 0, 'Q');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'concurrent revive');
		assertAllStructurallyValid(set, ops, 'concurrent revive');
		for (const p of [A, B]) {
			// Both chars display under b — order is the deterministic item
			// order, so assert the convergent SET plus the tail's integrity.
			expect(text(p, 'b')).toHaveLength(2);
			expect([...text(p, 'b')].sort().join('')).toBe('QX');
			expect(text(p, 'tail')).toBe('abcdefghij');
			expect(atomOwners(p, 'b')).toEqual(['b', 'b', ...Array(10).fill('tail')]);
		}
		reloadAndVerify(set, (s) => {
			expect(text(s.A, 'tail')).toBe('abcdefghij');
			expect([...text(s.A, 'b')].sort().join('')).toBe('QX');
		});
	});
});

// ── C: a caller block named 'dead' ──────────────────────────────────────

const DEAD_SEED = (doc) => {
	E.init(doc, {
		content: [
			{
				id: 'dead',
				type: 'paragraph',
				content: [{ kind: 'text', text: 'abcdefghij' }],
				children: [{ id: 'kid', type: 'paragraph', content: [{ kind: 'text', text: 'kidtext' }] }]
			},
			{ id: 'sib', type: 'paragraph', content: [{ kind: 'text', text: 'sibling' }] }
		]
	});
};

describe("regression C — a block literally named 'dead' is not the deletion sentinel", () => {
	it('its text, subtree, anchors and JSON stay visible and consistent', () => {
		const set = createPeerPair(DEAD_SEED);
		const { A } = set;
		const deadBlock = () =>
			ed(A)
				.project()
				.children.find((x) => x.id === 'dead');
		// Content claims — the sentinel must not suppress the caller id.
		expect(text(A, 'dead')).toBe('abcdefghij');
		expect(ed(A).displayLength('dead')).toBe(10);
		expect(ed(A).runs('dead')).toEqual([{ kind: 'text', text: 'abcdefghij' }]);
		expect(ed(A).contentJSON('dead')).toEqual([{ text: 'abcdefghij' }]);
		// Subtree: childrenIds / project / positionOf must AGREE (the run view
		// and the placement projection shared the colliding sentinel).
		expect(ed(A).childrenIds('dead')).toEqual(['kid']);
		expect(deadBlock().children.map((c) => c.id)).toEqual(['kid']);
		expect(ed(A).positionOf('kid')).toEqual({ parent: 'dead', index: 0 });
		expect(text(A, 'kid')).toBe('kidtext');
		// Anchors into the block resolve back to it (owner !== DEAD).
		const anchor = ed(A).anchorAt('dead', 5);
		expect(anchor).not.toBeNull();
		expect(ed(A).resolveAnchor(anchor)).toEqual({ blockId: 'dead', offset: 5 });
		// Ownership internals: 'dead' owns itself; it is not hidden.
		const blocks = collectBlocks(A.doc);
		const own = ed(A).text.computeOwnership(A.doc, blocks);
		expect(own.hidden('dead')).toBe(false);
		expect(atomOwners(A, 'dead')).toEqual(new Array(10).fill('dead'));
		// The JSON boundary agrees with the projection.
		const dead = ed(A)
			.toJSON()
			.children.find((x) => x.id === 'dead');
		expect(dead.content).toEqual([{ text: 'abcdefghij' }]);
		expect(dead.children?.map((c) => c.id)).toEqual(['kid']);
	});

	it('merge claims route to a block named dead like any other block', () => {
		const set = createPeerPair(DEAD_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks'), captureTimeout: 0 });
		// sib merges INTO dead: dead displays both texts, sib hides.
		op(A, () => ops.mergeBlocks(A, 'sib', 'dead'));
		expect(text(A, 'dead')).toBe('abcdefghijsibling');
		expect(ed(A).positionOf('sib')).toBeNull();
		A.undoManager.undo();
		expect(text(A, 'sib')).toBe('sibling');
		// dead merges into sib: the claim works in the other direction too.
		op(A, () => ops.mergeBlocks(A, 'dead', 'sib'));
		expect(text(A, 'sib')).toBe('siblingabcdefghij');
		expect(ed(A).positionOf('dead')).toBeNull();
		expect(ed(A).positionOf('kid')).not.toBeNull(); // children follow the claim
		A.undoManager.undo();
		expect(ed(A).positionOf('dead')).not.toBeNull();
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops);
		assertAllStructurallyValid(set, ops);
	});

	it('edits, delete and reload all treat dead as an ordinary block', () => {
		const set = createPeerPair(DEAD_SEED);
		const { A, B } = set;
		A.enableUndo({ scope: A.doc.get('blocks'), captureTimeout: 0 });
		op(A, () => ops.insertText(A, 'dead', 0, '!'));
		op(A, () => ops.setMark(A, 'dead', 1, 3, 'bold', true));
		op(A, () => ops.insertInline(A, 'dead', 4, { id: 'in-d', type: 'mention', data: { v: 2 } }));
		expect(text(A, 'dead')).toBe('!abcdefghij');
		set.deliver('A', 'B');
		assertConverged(set, ops);
		// A REAL deletion hides it (and its subtree) — the del flag, not the id.
		op(A, () => ops.deleteBlock(A, 'dead'));
		expect(ed(A).positionOf('dead')).toBeNull();
		expect(ed(A).positionOf('kid')).toBeNull();
		A.undoManager.undo();
		expect(text(A, 'dead')).toBe('!abcdefghij');
		expect(ed(A).positionOf('kid')).toEqual({ parent: 'dead', index: 0 });
		reloadAndVerify(set, (s) => {
			for (const p of [s.A, s.B]) {
				expect(text(p, 'dead')).toBe('!abcdefghij');
				expect(text(p, 'kid')).toBe('kidtext');
				expect(ed(p).positionOf('kid')).toEqual({ parent: 'dead', index: 0 });
			}
		});
		// Editing continues to work after the reload.
		ops.insertText(A, 'dead', 1, '?');
		expect(text(A, 'dead')).toBe('!?abcdefghij');
		set.deliver('A', 'B');
		assertConverged(set, ops);
	});
});
