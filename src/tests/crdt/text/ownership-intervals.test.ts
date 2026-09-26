/**
 * WU6 differential tests — the interval ownership implementation
 * (`computeOwnership`/`sweepOwnership` + `flatten`/`resolveAnchor` interval
 * queries) against the corrected dense oracle kept in
 * `harness/dense-ownership-oracle.ts`.
 *
 * For every fixture, at every checkpoint:
 *
 * - per-POSITION ownership parity on every backing text (owner AND winning
 *   record identity — intervals must agree with the dense rows position by
 *   position, gaps included);
 * - interval structural invariants (ordered, disjoint, non-empty);
 * - `maxG` parity per text (losing claims still raise the generation bar);
 * - `flatten` seg parity for every block (interval range queries must emit
 *   exactly the dense walker's segments);
 * - `nearestOwned` parity at every position in both directions (the facade's
 *   outward scan, now interval-boundary hops);
 * - `resolveAnchor` parity for anchors at every index and affinity of every
 *   backing text (adjacent-atom preference + emission-seam fallback).
 *
 * Scenarios cover the three WU1 regressions, overlapping claims routing to
 * the same display owner, gaps, equal endpoints, merge claims and cycles,
 * dead/unknown holders, empty blocks and unresolved anchors, multiple
 * backing texts, Unicode and inline atoms — across local edits, remote
 * delivery in both orders with duplication, reload, and undo/redo.
 *
 * Expected-result tests (`ownership-regression.test.ts`, `wu1-ownership`,
 * `model.test.ts`) are untouched — differential parity complements, never
 * replaces, semantic assertions.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { nearestOwned } from '../../../lib/crdt/text/model.js';
import { createPeerPair, createPeerTriple, type Peer, type PeerSet } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import {
	denseOwnership,
	denseFlatten,
	denseResolveAnchor,
	expandOwnerRow,
	expandClaimRow
} from '../harness/dense-ownership-oracle.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};

/** The dense row's outward scan — the loop the facade used to run. */
const denseScan = (row, i: number, dir: number, len: number): number => {
	for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < len; j += dir) {
		if (row[j] !== undefined) return j;
	}
	return -1;
};

const stampOf = (e) => (e == null ? null : { c: e.stamp.c, k: e.stamp.k });
const segKey = (s) => [s.t, s.i0, s.i1, s.holder, s.seqIndex, stampOf(s.via)];

/**
 * Full interval↔dense parity for one peer's current doc state. `label`
 * tags the checkpoint in failure messages.
 */
const assertOwnershipParity = (peer: Peer, label: string) => {
	const f = ed(peer);
	const blocks = f.model.collectBlocks(peer.doc);
	const own = f.text.computeOwnership(peer.doc, blocks);
	const dense = denseOwnership(peer.doc, blocks);

	// 1. Per-position owner + winning-claim parity on every claimed text.
	const texts = new Set([...own.intervals.keys(), ...dense.atomOwner.keys()]);
	for (const t of texts) {
		const ivs = own.intervals.get(t) ?? [];
		// Interval structural invariants: non-empty, ordered, disjoint.
		for (let k = 0; k < ivs.length; k++) {
			expect(ivs[k].i0, `${label}:${t} iv${k} non-empty`).toBeLessThan(ivs[k].i1);
			if (k > 0) {
				expect(ivs[k - 1].i1, `${label}:${t} iv${k} disjoint`).toBeLessThanOrEqual(ivs[k].i0);
			}
		}
		const expOwners = expandOwnerRow(ivs);
		const expClaims = expandClaimRow(ivs);
		const dOwners = dense.atomOwner.get(t) ?? [];
		const dClaims = dense.atomClaim.get(t) ?? [];
		const len = Math.max(expOwners.length, dOwners.length);
		for (let i = 0; i < len; i++) {
			expect(expOwners[i] ?? null, `${label}:${t}[${i}] owner`).toBe(dOwners[i] ?? null);
			expect(stampOf(expClaims[i]), `${label}:${t}[${i}] claim`).toEqual(
				stampOf(dClaims[i] ?? null)
			);
		}
	}

	// 2. maxG parity — losing/dead-held claims still raise the bar.
	for (const t of new Set([...own.maxG.keys(), ...dense.maxG.keys()])) {
		expect(own.maxG.get(t) ?? 0, `${label}:${t} maxG`).toBe(dense.maxG.get(t) ?? 0);
	}

	// 3. flatten seg parity for every block.
	for (const b of blocks.keys()) {
		const got = f.text.flatten(b, blocks, own).map(segKey);
		const want = denseFlatten(b, blocks, dense).map(segKey);
		expect(got, `${label}:flatten(${b})`).toEqual(want);
	}

	// 4. nearestOwned parity — every position, both directions.
	for (const [t, rec] of blocks) {
		if (!rec.content) continue;
		const len = rec.content.length;
		const ivs = own.intervals.get(t);
		const row = dense.atomOwner.get(t) ?? [];
		for (let i = 0; i <= len; i++) {
			for (const dir of [-1, 1]) {
				expect(nearestOwned(ivs, i, dir, len), `${label}:${t} nearest(${i},${dir})`).toBe(
					denseScan(row, i, dir, len)
				);
			}
		}
	}

	// 5. resolveAnchor parity — anchors at every index, both affinities.
	for (const [t, rec] of blocks) {
		if (!rec.content) continue;
		const len = rec.content.length;
		for (let i = 0; i <= len; i++) {
			for (const assoc of [-1, 0]) {
				const a = f.text.atomAnchorAt(peer.doc, rec.content, i, assoc);
				const got = f.resolveAnchor({ b: t, a });
				const want = denseResolveAnchor(peer.doc, blocks, dense, { b: t, a });
				expect(got, `${label}:${t} resolve(${i},${assoc})`).toEqual(want);
			}
		}
	}
};

const assertParityAll = (set: PeerSet, label: string) => {
	for (const p of set.peers) assertOwnershipParity(p, `${label}:${p.name}`);
};

// ── seeds ────────────────────────────────────────────────────────────

const SEED = (doc) => {
	E.init(doc, {
		content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }]
	});
};

const SEED_VC = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'v', type: 'paragraph', content: [{ kind: 'text', text: 'abc' }] },
			{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: '' }] }
		]
	});
};

const SEED_DEAD = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'dead', type: 'paragraph', content: [{ kind: 'text', text: '0123456789' }] },
			{ id: 'live', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }
		]
	});
};

const SEED_MULTI = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'αβγ 🌟δεζ 12345' }] },
			{ id: 'y', type: 'paragraph', content: [{ kind: 'text', text: 'MNOPQR' }] },
			{ id: 'z', type: 'paragraph', content: [{ kind: 'text', text: 'tail-end' }] }
		]
	});
};

// ── WU1-A: concurrent different-anchor splits + left-edge insert ──────

describe('intervals vs dense — WU1-A nested partition + left-edge steal', () => {
	for (const order of ['AB', 'BA'] as const) {
		it(`split@3 × split@8 then type at inner left edge (delivery ${order})`, () => {
			const set = createPeerPair(SEED);
			const { A, B } = set;
			assertParityAll(set, 'seed');
			// Concurrent different-anchor splits → overlapping records whose
			// resolved ranges nest on one backing text.
			ops.splitBlock(A, 'b', 3, 'mid');
			ops.splitBlock(B, 'b', 8, 'tail');
			assertParityAll(set, 'pre-deliver');
			set.deliver(order === 'AB' ? 'A' : 'B', order === 'AB' ? 'B' : 'A');
			set.deliverAll();
			assertParityAll(set, 'converged');
			// Left-edge insert on 'mid' — WU1's steal shape: the new atoms
			// contest the seam against mid's covering record.
			ops.insertText(A, 'mid', 0, '>>');
			assertParityAll(set, 'post-insert-A');
			set.deliverAll();
			assertConverged(set, ops, 'final');
			assertParityAll(set, 'final');
		});
	}
});

// ── WU1-B: live-but-empty block revive (empty range + unresolved) ─────

describe('intervals vs dense — WU1-B empty-display revive', () => {
	it('live-but-empty v stays empty after anchor-bound revive path', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		assertParityAll(set, 'seed');
		ops.mergeBlocks(A, 'v', 'c');
		ops.splitBlock(A, 'c', 1, 'thief');
		ops.deleteBlock(A, 'c');
		ops.deleteText(A, 'v', 0, 1);
		assertParityAll(set, 'live-empty');
		// Type into the revived empty display — post-insert anchor binding.
		ops.insertText(A, 'v', 0, 'R');
		assertParityAll(set, 'revived');
		set.deliverAll();
		assertParityAll(set, 'final');
	});
});

// ── WU1-C: a block literally named 'dead' ─────────────────────────────

describe("intervals vs dense — WU1-C 'dead' block id", () => {
	it("'dead' stays an ordinary block through split/merge", () => {
		const set = createPeerPair(SEED_DEAD);
		const { A } = set;
		assertParityAll(set, 'seed');
		ops.splitBlock(A, 'dead', 4, 'dead2');
		ops.mergeBlocks(A, 'dead2', 'dead');
		assertParityAll(set, 'split+merge');
		set.deliverAll();
		assertParityAll(set, 'final');
	});
});

// ── merge claims, cycles, dead holders ────────────────────────────────

describe('intervals vs dense — merge claims / cycles / dead holders', () => {
	it('merge routes all of x into y (multiple backing texts)', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A } = set;
		assertParityAll(set, 'seed');
		ops.mergeBlocks(A, 'x', 'y');
		assertParityAll(set, 'merged');
		set.deliverAll();
		assertParityAll(set, 'converged');
	});

	it('concurrent merges both ways resolve the claim cycle', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A, B } = set;
		ops.mergeBlocks(A, 'x', 'y');
		ops.mergeBlocks(B, 'y', 'x');
		assertParityAll(set, 'pre-deliver');
		set.deliverAll();
		set.deliverAll(); // second pass for any queued cross edges
		assertConverged(set, ops, 'cycle');
		assertParityAll(set, 'cycle');
	});

	it('deleting a record holder deadens its coverage (gaps)', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A } = set;
		ops.mergeBlocks(A, 'x', 'y');
		ops.splitBlock(A, 'y', 2, 'sp');
		assertParityAll(set, 'pre-delete');
		// Delete the split's holder — its records die with it, leaving
		// dead-owner coverage holes (unowned positions inside live texts).
		ops.deleteBlock(A, 'sp');
		assertParityAll(set, 'dead-holder');
		set.deliverAll();
		assertParityAll(set, 'converged');
	});
});

// ── equal endpoints: concurrent same-anchor splits ────────────────────

describe('intervals vs dense — equal endpoints', () => {
	it('same-anchor concurrent splits produce stamp-ordered coverage', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 5, 'a2');
		ops.splitBlock(B, 'b', 5, 'b2');
		assertParityAll(set, 'pre-deliver');
		set.deliverAll();
		assertConverged(set, ops, 'same-anchor');
		assertParityAll(set, 'same-anchor');
	});

	it('three-way same-anchor split', () => {
		const set = createPeerTriple(SEED);
		const { A, B, C } = set;
		ops.splitBlock(A, 'b', 5, 'a2');
		ops.splitBlock(B, 'b', 5, 'b2');
		ops.splitBlock(C, 'b', 5, 'c2');
		set.deliverAll();
		assertConverged(set, ops, 'three-way');
		assertParityAll(set, 'three-way');
	});
});

// ── Unicode + inline atoms ────────────────────────────────────────────

describe('intervals vs dense — unicode + inline atoms', () => {
	it('surrogate-pair atoms and inline nodes keep UTF-16 positions', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A } = set;
		// 🌟 is a surrogate pair — 2 UTF-16 units; inline atoms occupy one
		// unit each. Splits land inside the emoji span deliberately.
		ops.insertInline(A, 'x', 6, { id: 'inl1', type: 'mention', data: { u: 'k' } });
		assertParityAll(set, 'inline');
		ops.splitBlock(A, 'x', 5, 'xs');
		assertParityAll(set, 'split-emoji');
		ops.insertText(A, 'xs', 0, 'é🎉');
		assertParityAll(set, 'insert-unicode');
		set.deliverAll();
		assertParityAll(set, 'converged');
	});
});

// ── edits, delivery order, duplication, reload, undo ──────────────────

describe('intervals vs dense — lifecycle', () => {
	it('duplicate + reversed delivery keeps parity', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 4, 'a2');
		ops.splitBlock(B, 'b', 7, 'b2');
		set.deliver('A', 'B', { times: 2 });
		set.deliver('B', 'A', { times: 2, reverse: true });
		set.deliverAll();
		assertConverged(set, ops, 'dup');
		assertParityAll(set, 'dup');
	});

	it('snapshot + log reload keep parity', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A, B } = set;
		ops.mergeBlocks(A, 'x', 'y');
		ops.splitBlock(B, 'z', 3, 'z2');
		set.deliverAll();
		A.persist();
		B.persist();
		A.reload('snapshot');
		B.reload('log');
		assertConverged(set, ops, 'reloaded');
		assertParityAll(set, 'reloaded');
		// The reloaded doc is a new writer — keep editing.
		ops.insertText(A, 'y', 1, '!');
		ops.deleteText(B, 'z2', 0, 1);
		set.deliverAll();
		assertParityAll(set, 'post-reload-edits');
	});

	it('undo/redo of splits, merges and inserts keeps parity', () => {
		const set = createPeerPair(SEED);
		const { A } = set;
		A.enableUndo();
		const undo = () => {
			A.undoManager.undo();
			A.undoManager.stopCapturing();
		};
		ops.splitBlock(A, 'b', 4, 'a2');
		A.undoManager.stopCapturing();
		ops.mergeBlocks(A, 'a2', 'b');
		A.undoManager.stopCapturing();
		ops.insertText(A, 'b', 2, 'ZZ');
		A.undoManager.stopCapturing();
		assertParityAll(set, 'ops');
		undo();
		assertParityAll(set, 'undo-insert');
		undo();
		assertParityAll(set, 'undo-merge');
		A.undoManager.redo();
		assertParityAll(set, 'redo-merge');
		undo(); // undo the merge again, then the split
		undo();
		assertParityAll(set, 'undo-all');
		set.deliverAll();
		assertParityAll(set, 'final');
	});

	it('undo revives merged-away content with remote edits intact', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A, B } = set;
		A.enableUndo();
		ops.mergeBlocks(A, 'x', 'y');
		A.undoManager.stopCapturing();
		set.deliverAll();
		// Remote edit inside the merged-away block's backing text region.
		ops.insertText(B, 'y', 9, '~');
		set.deliverAll();
		assertParityAll(set, 'remote-edit');
		A.undoManager.undo();
		assertParityAll(set, 'undo-merge');
		set.deliverAll();
		assertConverged(set, ops, 'final');
		assertParityAll(set, 'final');
	});
});

// ── structural validity alongside parity ──────────────────────────────

describe('intervals vs dense — structural validity', () => {
	it('fixtures stay structurally valid end to end', () => {
		const set = createPeerPair(SEED_MULTI);
		const { A, B } = set;
		ops.splitBlock(A, 'x', 6, 'x2');
		ops.mergeBlocks(B, 'y', 'z');
		set.deliverAll();
		assertAllStructurallyValid(set, ops, 'post-ops');
		assertParityAll(set, 'post-ops');
	});
});
