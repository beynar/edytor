/**
 * Gate-F1 adversarial probes — WU1 ownership soundness.
 *
 * Probe 1 (revive/alreadyCovered hole): the empty-display revive path in
 * `insertIntoText` skips writing a revive record whenever the block's own
 * slices list holds a `{t:b, e:END}` record whose resolved start is <=
 * text length (model.ts `alreadyCovered`). That check verifies coverage
 * EXISTENCE, never coverage WINNING. A record that covers the text end but
 * loses it to a higher-generation rival leaves the appended atoms claimed
 * by the rival — the typed character lands in a different block.
 *
 * Reachable through legal ops only, single replica:
 *   1. v = 'abc'; c = empty paragraph.
 *   2. mergeBlocks(v -> c): c claims v's list; v hidden; c displays 'abc'.
 *   3. splitBlock(c, 1, 'thief'): seam inside the claim contribution ->
 *      cutClaim materializes 'bc' onto thief's list as
 *      {t:v, s:item('b'), e:END, g1}. c keeps the claim -> displays 'a'.
 *   4. c's records released (pre-D1 delete; staged by registry removal
 *      since D-14): claim inert -> v unhidden -> v displays 'a'.
 *   5. deleteText(v, 0, 1): 'a' tombstoned. thief's record re-anchors to
 *      [0,2) and wins all of T_v (g1 > g0) -> v displays '' (live, empty).
 *   6. insertText(v, 0, 'X'): alreadyCovered sees v's own {B,E,g0} record
 *      covering the end -> skips revive -> 'X' appended at T_v[2] -> thief's
 *      {b,END,g1} wins it -> v stays '', thief displays 'bcX'.
 *
 * The remaining probes exercise the adversarial variants the review asked
 * for: 3+ concurrent splits then left-edge insert, a record fragmented
 * into 3+ disjoint segs, concurrent left-edge inserts on two replicas,
 * boundary (not interior) inserts, and revive racing a tail deletion.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair, createPeerTriple, type Peer } from '../harness/peer-set.js';
import { expandOwnerRow } from '../harness/dense-ownership-oracle.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { collectBlocks } from '../../oracles/fresh-view.js';

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

const text = (peer: Peer, id: string) => ed(peer).blockText(id);

/**
 * D-14 (R3): a delete now hides everything the block displays, including
 * what it displays through merge claims, so the pre-D1 "a deleted holder
 * releases its coverage" state these probes start from is staged by
 * removing the registry entry instead — an absent block's records claim
 * nothing, exactly what the old delete produced.
 */
const dropBlock = (peer: Peer, id: string) =>
	peer.doc.transact(() => peer.doc.get('blocks').deleteAttr(id));
const atomOwners = (peer: Peer, t: string): (string | null)[] => {
	const blocks = collectBlocks(peer.doc);
	const own = ed(peer).text.computeOwnership(peer.doc, blocks);
	return expandOwnerRow(own.intervals.get(t));
};

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

/** Shared staging for probe 1: drives v into the live-but-emptied state. */
const stageEmptiedV = (peer: Peer) => {
	// 2. c claims v's list (v hidden).
	ops.mergeBlocks(peer, 'v', 'c');
	// 3. split inside the claim contribution -> thief owns 'bc' via
	//    {t:v, s:item(b), e:END, g1}.
	ops.splitBlock(peer, 'c', 1, 'thief');
	// 4. claim inert -> v unhidden -> 'a' returns to v.
	dropBlock(peer, 'c');
	// 5. 'a' deleted -> thief's E-ended record covers all of T_v and wins
	//    (g1 > g0) -> v is a LIVE block displaying ''.
	ops.deleteText(peer, 'v', 0, 1);
};

describe('gateF1 probe 1 — alreadyCovered skips revive for a LOSING end-record', () => {
	it('staging reaches the live-but-empty state (control)', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageEmptiedV(A);
		expect(text(A, 'v')).toBe('');
		expect(text(A, 'thief')).toBe('bc');
		expect(ed(A).positionOf('v')).not.toBeNull(); // v is still a live block
	});

	// FINDING F1 — FIXED. The append-point check now verifies coverage
	// WINNING (the ownership contest across all holders), not existence on
	// the block's own list: the rival's g1 record wins the append range, so
	// the revive record fires and claims the typed atoms for v.
	it('typing into a live-but-emptied block must not append to the rival block', () => {
		const set = createPeerPair(SEED_VC);
		const { A, B } = set;
		stageEmptiedV(A);
		// THE FIX: thief's {t:v, s:item(b), e:END, g1} outranks v's own
		//    {B,E,g0} at the append point → the revive record fires → 'X'
		//    lands on v, not in thief.
		ops.insertText(A, 'v', 0, 'X');
		expect(text(A, 'v')).toBe('X');
		expect(text(A, 'thief')).toBe('bc');

		// Sync must still converge (the fix is deterministic).
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops);
	});

	// FINDING F1 variant — two consecutive inserts: the first revives, the
	// second lands inside the revived coverage (non-empty display path).
	it('variant: emptied block with a bounded losing record still revives', () => {
		// Same shape but the rival wins only the tail: v's own list holds an
		// E-record that wins nothing. Insert must revive, not rely on coverage.
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageEmptiedV(A);
		expect(text(A, 'v')).toBe('');
		// Two inserts: both chars must land on v.
		ops.insertText(A, 'v', 0, 'X');
		ops.insertText(A, 'v', 1, 'Y');
		expect(text(A, 'thief')).toBe('bc');
		expect(text(A, 'v')).toBe('XY');
	});

	// FINDING F1 variant — rival-wins-partial: split the thief so TWO rival
	// holders each cover part of T_v's tail. Coverage is split across rivals;
	// the winner at the append point is still not v, so the revive must fire
	// and the typed char must land on v, not under either rival.
	it('variant: rival coverage split across two holders still revives', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageEmptiedV(A);
		// Split thief's display 'bc' at 1 → thief keeps 'b', thief2 takes the
		// rest. Thief's records on T_v get partitioned across the two holders;
		// neither is v, so the append winner remains foreign.
		ops.splitBlock(A, 'thief', 1, 'thief2');
		expect(text(A, 'v')).toBe('');
		ops.insertText(A, 'v', 0, 'Z');
		expect(text(A, 'v')).toBe('Z');
		// Neither rival may swallow the typed char.
		expect(text(A, 'thief') + text(A, 'thief2')).toBe('bc');
	});

	// FINDING F1 variant — the append-point winner is DEAD: tombstone thief's
	// atoms then delete thief, so the only record that could outrank v's own
	// {B,E} sits on a dead holder's list. The contest must skip dead holders
	// (they cannot claim anything), let v's coverage win the append point
	// back, and land the typed char on v.
	it('variant: emptied block reclaims the append point after the winning rival dies', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageEmptiedV(A);
		// Tombstone 'bc' so v's display stays empty once thief is gone — the
		// insert below still takes the empty-display append path.
		ops.deleteText(A, 'thief', 0, 2);
		ops.deleteBlock(A, 'thief');
		expect(text(A, 'v')).toBe('');
		ops.insertText(A, 'v', 0, 'Q');
		expect(text(A, 'v')).toBe('Q');
	});

	// FINDING F1 variant — insert at a coverage seam: after the first revive,
	// v's record covers [seam, E). Deleting the typed atom collapses the
	// record's item-bound start onto the exact append point (s0 === tLen).
	// The seam coverage still WINS for v, so the next insert must reuse it —
	// no double-revive, no rival steal.
	it('variant: insert exactly at the resolved start seam of the revived coverage', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageEmptiedV(A);
		ops.insertText(A, 'v', 0, 'X');
		expect(text(A, 'v')).toBe('X');
		// Empty v again: the revive record's item-bound start resolves to the
		// gap left by the deleted atom — the append point sits exactly on the
		// record's start seam.
		ops.deleteText(A, 'v', 0, 1);
		expect(text(A, 'v')).toBe('');
		ops.insertText(A, 'v', 0, 'Y');
		expect(text(A, 'v')).toBe('Y');
		expect(text(A, 'thief')).toBe('bc');
	});
});

describe('gateF1 probe 2 — three concurrent splits then left-edge insert', () => {
	it('nested 4-way partition stays intact under a contested left-edge type', () => {
		const set = createPeerTriple(SEED);
		const { A, B, C } = set;
		// Three peers concurrently split the same backing at 3, 5, 8.
		ops.splitBlock(A, 'b', 3, 's1');
		ops.splitBlock(B, 'b', 5, 's2');
		ops.splitBlock(C, 'b', 8, 's3');
		set.deliverAll();
		set.syncAll('full');
		assertConverged(set, ops);
		// Expected seam-preserving partition [0,3)|[3,5)|[5,8)|[8,E).
		for (const p of set.peers) {
			expect(text(p, 'b')).toBe('abc');
			expect(text(p, 's1')).toBe('de');
			expect(text(p, 's2')).toBe('fgh');
			expect(text(p, 's3')).toBe('ij');
		}
		// Left-edge insert into the middle block s2 on A.
		ops.insertText(A, 's2', 0, 'X');
		set.deliverAll();
		set.syncAll('full');
		assertConverged(set, ops, 'post-insert');
		assertAllStructurallyValid(set, ops, 'post-insert');
		for (const p of set.peers) {
			expect(text(p, 'b')).toBe('abc');
			expect(text(p, 's1')).toBe('de');
			expect(text(p, 's2')).toBe('Xfgh');
			expect(text(p, 's3')).toBe('ij');
			expect(atomOwners(p, 'b')).toEqual([
				'b',
				'b',
				'b',
				's1',
				's1',
				's2',
				's2',
				's2',
				's2',
				's3',
				's3'
			]);
		}
	});
});

describe('gateF1 probe 3 — left-edge insert into a 3-way fragmented record', () => {
	it('disjoint [3,5)∪[7,8)∪[9,E) coverage is re-anchored per-seg, holes kept', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		// early gets an E-ended record from 3; B carves two bounded holes so
		// that deleting the right records leaves early with THREE disjoint segs.
		ops.splitBlock(A, 'b', 3, 'early'); // early = {3,E}
		ops.splitBlock(B, 'b', 5, 'mid1'); // mid1 = {5,E}
		ops.splitBlock(B, 'mid1', 2, 'mid2'); // mid1={5,7} mid2={7,E}
		ops.splitBlock(B, 'mid2', 1, 'mid3'); // mid2={7,8} mid3={8,E}
		ops.splitBlock(B, 'mid3', 1, 'tail'); // mid3={8,9} tail={9,E}
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops);
		// Kill mid2{7,8} and tail{9,E}: those atoms fall back to early's {3,E}
		// claim -> early = [3,5) ∪ [7,8) ∪ [9,10) — three disjoint segs with
		// mid1{5,7}='fg' and mid3{8,9}='i' as the holes.
		dropBlock(A, 'mid2');
		dropBlock(A, 'tail');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		expect(text(A, 'early')).toBe('dehj');
		// Left-edge insert: rewrites all three disjoint segs of early's record.
		ops.insertText(A, 'early', 0, 'X');
		expect(text(A, 'early')).toBe('Xdehj');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('i');
		// 'X'@3 is early's; holes mid1{fg}@6,7 and mid3{i}@9 preserved.
		expect(atomOwners(A, 'b')).toEqual([
			'b',
			'b',
			'b',
			'early',
			'early',
			'early',
			'mid1',
			'mid1',
			'early',
			'mid3',
			'early'
		]);
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'post-insert');
		assertAllStructurallyValid(set, ops, 'post-insert');
	});
});

describe('gateF1 probe 4 — concurrent left-edge inserts into the same seg', () => {
	it('two replicas type at offset 0 of the same mid block; both chars survive', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 5, 'tail');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		// Both type at the left edge of tail concurrently — each rewrites the
		// same covering record locally.
		ops.insertText(A, 'tail', 0, 'X');
		ops.insertText(B, 'tail', 0, 'Q');
		set.deliver('A', 'B', { times: 2 });
		set.deliver('B', 'A', { times: 2 });
		assertConverged(set, ops, 'concurrent left-edge');
		assertAllStructurallyValid(set, ops, 'concurrent left-edge');
		for (const p of [A, B]) {
			expect(text(p, 'tail')).toHaveLength(7);
			expect([...text(p, 'tail')].sort().join('')).toBe('QXfghij');
			expect(text(p, 'b')).toBe('abcde');
		}
	});
});

describe('gateF1 probe 5 — revive racing a concurrent tail deletion', () => {
	it('insert into empty head + concurrent delete of the tail converges losslessly', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 0, 'tail');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		// Concurrent: A revives the empty head, B deletes the whole tail.
		ops.insertText(A, 'b', 0, 'X');
		ops.deleteBlock(B, 'tail');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'revive vs tail delete');
		assertAllStructurallyValid(set, ops, 'revive vs tail delete');
		// tail is gone; its 10 atoms are dead. 'X' must survive under b.
		expect(text(A, 'b')).toBe('X');
		expect(text(B, 'b')).toBe('X');
	});
});

describe('gateF1 probe 6 — boundary (non-interior) inserts at seg seams', () => {
	it('insert at the seam between two disjoint segs lands left, never in the hole', () => {
		const set = createPeerPair(SEED);
		const { A, B } = set;
		ops.splitBlock(A, 'b', 3, 'early'); // early = {3,E}
		ops.splitBlock(B, 'b', 5, 'mid1'); // mid1 = {5,E}
		ops.splitBlock(B, 'mid1', 2, 'mid2'); // mid1={5,7} mid2={7,E}
		ops.splitBlock(B, 'mid2', 1, 'mid3'); // mid2={7,8} mid3={8,E}
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops);
		// Kill mid2{7,8}: 'h' falls back to early -> early = [3,5)∪[7,8) —
		// 'de' + 'h' = 'deh' with mid1{5,7}='fg' and mid3{8,E}='ij' as holes.
		dropBlock(A, 'mid2');
		expect(text(A, 'early')).toBe('deh');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('ij');
		// Seam at display offset 2 between 'de' and 'h': insert exactly there.
		ops.insertText(A, 'early', 2, 'X');
		const got = text(A, 'early');
		// 'X' must belong to early, and must not land inside mid1's hole.
		expect(got).toContain('X');
		expect(text(A, 'mid1')).toBe('fg');
		expect(text(A, 'mid3')).toBe('ij');
		// Every 'X' atom is owned by early (or at least never by a hole block).
		const owners = atomOwners(A, 'b');
		expect(owners).not.toContain(null);
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'seam insert');
	});
});
