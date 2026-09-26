/**
 * Gate-F2 probe — WU6 interval ownership under RANDOMIZED claim
 * topologies. The existing `ownership-intervals.test.ts` verifies
 * interval↔dense parity on 15 fixed scenarios; this fuzz drives random
 * split/merge/move/edit streams on two peers and asserts the SAME
 * full parity (per-position owner + winning claim, maxG, flatten,
 * nearestOwned both directions, resolveAnchor both affinities) after
 * every delivery — plus eventual convergence.
 *
 * Ops are issued through the real facade; refused ops (hidden targets,
 * void/island rules, cycle guards) return false without mutating, which
 * is itself part of the exercised surface. Content deletes go through
 * `deleteRange` — the retained Gate-F2 defect (stale same-backing coords
 * across disjoint segs) can throw mid-mutation; thrown ops are caught and
 * counted so the stream continues and parity still checks the resulting
 * (possibly partial) state.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { nearestOwned } from '../../../lib/crdt/text/model.js';
import { createPeerPair, type Peer, type PeerSet } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged } from '../harness/assert/convergence.js';
import {
	denseOwnership,
	denseFlatten,
	denseResolveAnchor,
	expandOwnerRow,
	expandClaimRow
} from '../harness/dense-ownership-oracle.js';
import { mulberry32, int, pick } from '../harness/rng.js';

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

const denseScan = (row, i, dir, len) => {
	for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < len; j += dir) {
		if (row[j] !== undefined) return j;
	}
	return -1;
};

const stampOf = (e) => (e == null ? null : { c: e.stamp.c, k: e.stamp.k });
const segKey = (s) => [s.t, s.i0, s.i1, s.holder, s.seqIndex, stampOf(s.via)];

const assertOwnershipParity = (peer: Peer, label: string) => {
	const f = ed(peer);
	const blocks = f.model.collectBlocks(peer.doc);
	const own = f.text.computeOwnership(peer.doc, blocks);
	const dense = denseOwnership(peer.doc, blocks);
	const texts = new Set([...own.intervals.keys(), ...dense.atomOwner.keys()]);
	for (const t of texts) {
		const ivs = own.intervals.get(t) ?? [];
		for (let k = 0; k < ivs.length; k++) {
			expect(ivs[k].i0, `${label}:${t} iv${k} non-empty`).toBeLessThan(ivs[k].i1);
			if (k > 0)
				expect(ivs[k - 1].i1, `${label}:${t} iv${k} disjoint`).toBeLessThanOrEqual(ivs[k].i0);
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
	for (const t of new Set([...own.maxG.keys(), ...dense.maxG.keys()])) {
		expect(own.maxG.get(t) ?? 0, `${label}:${t} maxG`).toBe(dense.maxG.get(t) ?? 0);
	}
	for (const b of blocks.keys()) {
		const got = f.text.flatten(b, blocks, own).map(segKey);
		const want = denseFlatten(b, blocks, dense).map(segKey);
		expect(got, `${label}:flatten(${b})`).toEqual(want);
	}
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

const SEED_FUZZ = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'b0', type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] },
			{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'KLMNOPQRST' }] },
			{ id: 'b2', type: 'paragraph', content: [{ kind: 'text', text: 'uvwxyz' }] },
			{
				id: 'b3',
				type: 'list',
				content: [{ kind: 'text', text: 'container' }],
				children: [
					{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child-a' }] },
					{ id: 'b3b', type: 'paragraph', content: [{ kind: 'text', text: 'child-b' }] }
				]
			}
		]
	});
};

const ALL_IDS = ['b0', 'b1', 'b2', 'b3', 'b3a', 'b3b'];
const MARKS = ['bold', 'italic', 'code', 'strike'];

/**
 * One randomized step. Returns 'applied' | 'refused' | 'threw'.
 */
const step = (rng, peer, freshId) => {
	const f = ed(peer);
	const ids = f.listBlockIds();
	const pool = [...new Set([...ids, ...ALL_IDS])];
	const id = pool.length > 0 ? pick(rng, pool) : 'b0';
	const len = (f.blockText(id) ?? '').length;
	const roll = int(rng, 0, 99);
	try {
		if (roll < 22) {
			// NOTE: no surrogate-pair payloads here — mid-pair deletes produce
			// a lone-surrogate wire divergence documented by the retained
			// probe wu9-surrogate-wire.test.ts (upstream-inherited, out of
			// scope for this parity fuzz).
			return ops.insertText(peer, id, int(rng, 0, len), pick(rng, ['x', 'yz', 'ab', '12']))
				? 'applied'
				: 'refused';
		}
		if (roll < 34) {
			if (len === 0) return 'refused';
			const off = int(rng, 0, len - 1);
			return ops.deleteText(peer, id, off, int(rng, 1, len - off)) ? 'applied' : 'refused';
		}
		if (roll < 44) {
			if (len === 0) return 'refused';
			const off = int(rng, 0, len - 1);
			const l = int(rng, 1, len - off);
			return ops.setMark(peer, id, off, l, pick(rng, MARKS), true) ? 'applied' : 'refused';
		}
		if (roll < 50) {
			if (len === 0) return 'refused';
			const off = int(rng, 0, len - 1);
			return ops.unsetMark(peer, id, off, int(rng, 1, len - off), pick(rng, MARKS))
				? 'applied'
				: 'refused';
		}
		if (roll < 62) {
			const off = int(rng, 0, len);
			return ops.splitBlock(peer, id, off, `n${freshId()}`) ? 'applied' : 'refused';
		}
		if (roll < 74) {
			const into = pick(rng, pool);
			return ops.mergeBlocks(peer, id, into) ? 'applied' : 'refused';
		}
		if (roll < 82) {
			const parent = pick(rng, [null, ...pool]);
			return ops.moveBlock(peer, id, { parent, index: int(rng, 0, 3) }) ? 'applied' : 'refused';
		}
		if (roll < 88) {
			const nid = `ins${freshId()}`;
			return ops.insertBlock(
				peer,
				{ parent: pick(rng, [null, ...pool]), index: int(rng, 0, 3) },
				{
					id: nid,
					type: pick(rng, ['paragraph', 'list']),
					content: [{ kind: 'text', text: 'new' }]
				}
			)
				? 'applied'
				: 'refused';
		}
		if (roll < 93) {
			return ops.deleteBlock(peer, id) ? 'applied' : 'refused';
		}
		if (roll < 97) {
			const off = int(rng, 0, len);
			return ops.insertInline(peer, id, off, {
				id: `i${freshId()}`,
				type: 'mention',
				data: { u: int(rng, 0, 9) }
			})
				? 'applied'
				: 'refused';
		}
		return ops.nestBlock(peer, id, pick(rng, pool)) ? 'applied' : 'refused';
	} catch {
		return 'threw';
	}
};

describe('gateF2/WU6 — randomized claim-topology interval parity', () => {
	it('300-op two-peer fuzz keeps interval↔dense parity at every checkpoint', () => {
		const rng = mulberry32(0xf00d);
		const set = createPeerPair(SEED_FUZZ);
		let counter = 0;
		const freshId = () => counter++;
		const tally = { applied: 0, refused: 0, threw: 0 };
		for (let k = 0; k < 300; k++) {
			const peer = pick(rng, set.peers);
			tally[step(rng, peer, freshId)]++;
			if (k % 12 === 11) {
				set.deliverAll();
				assertParityAll(set, `k${k}`);
			}
		}
		set.deliverAll();
		assertParityAll(set, 'final');
		assertConverged(set, ops, 'final');
		// The stream must have actually exercised the surface — not just been refused.
		expect(tally.applied).toBeGreaterThan(100);
	});

	it('single-peer long-run fuzz (splits+merges accumulate claim chains)', () => {
		const rng = mulberry32(0xbeef);
		const set = createPeerPair(SEED_FUZZ);
		const A = set.A;
		let counter = 0;
		const freshId = () => counter++;
		const tally = { applied: 0, refused: 0, threw: 0 };
		for (let k = 0; k < 400; k++) {
			tally[step(rng, A, freshId)]++;
			if (k % 20 === 19) assertParityAll(set, `k${k}`);
		}
		assertParityAll(set, 'final');
		expect(tally.applied).toBeGreaterThan(150);
	});

	it('merge-heavy fuzz: claims, contested claims, and claim chains', () => {
		const rng = mulberry32(0xc1a1);
		const set = createPeerPair(SEED_FUZZ);
		let counter = 0;
		const freshId = () => counter++;
		// First create many siblings so merges have material.
		for (let i = 0; i < 12; i++) {
			ops.splitBlock(set.A, pick(rng, ['b0', 'b1', 'b2']), int(rng, 0, 5), `m${freshId()}`);
		}
		for (let k = 0; k < 160; k++) {
			const peer = pick(rng, set.peers);
			const f = ed(peer);
			const ids = f.listBlockIds();
			const pool = [...new Set([...ids, ...ALL_IDS])];
			const a = pick(rng, pool);
			const b = pick(rng, pool);
			try {
				if (k % 3 === 0) {
					ops.mergeBlocks(peer, a, b);
				} else if (k % 3 === 1) {
					ops.splitBlock(peer, a, int(rng, 0, (f.blockText(a) ?? '').length), `m${freshId()}`);
				} else {
					ops.deleteBlock(peer, a);
				}
			} catch {
				/* refused/threw — stream continues */
			}
			if (k % 16 === 15) {
				set.deliverAll();
				assertParityAll(set, `k${k}`);
			}
		}
		set.deliverAll();
		assertParityAll(set, 'final');
		assertConverged(set, ops, 'final');
	});
});
