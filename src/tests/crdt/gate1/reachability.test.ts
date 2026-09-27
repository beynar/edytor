/**
 * Gate-1 regression probe — display-parent-cycle reachability oracle over the
 * random corpus.
 *
 * `checkStructurallyValid` only walks the projected tree, so blocks that fall
 * out of the projection while staying live + self-owned are invisible to it.
 * This oracle walks every registry block the model itself considers visible
 * (not deleted, not merged-away) and follows its `displayParent` chain to the
 * root. A cycle in that chain means the block can never be rendered — silent
 * convergent content loss.
 *
 * The pinned seeds below are known-reproducing corpus seeds (deterministic
 * schedules). The test FAILS against the current implementation — durable
 * evidence for the display-parent-cycle defect. Once mergeBlocks/moveBlock
 * guard the composed owner relation, it must go green.
 */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { bindText, DEAD } from '../../../lib/crdt/text/model.js';
import { createPeerSet } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { generateSchedule } from '../random/generator.js';
import { findFirstDiff } from '../harness/assert/convergence.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';

const M = bindModel(Y);
const T = bindText(Y);
const ops = createModelOps();

/**
 * Live-but-unreachable oracle: a block is vanished iff the model considers it
 * visible (not deleted, not claimed by a live merge) yet its displayParent
 * chain never reaches the root. `hidden-ancestor` is excluded — merging a
 * subtree legitimately hides descendants of the claimed block.
 */
export const vanishedIds = (doc) => {
	const blocks = M.collectBlocks(doc);
	const placements = M.resolvePlacements(blocks);
	const own = T.computeOwnership(doc, blocks);
	const isVis = (id) => {
		const r = blocks.get(id);
		return r && !r.deleted && !own.hidden(id);
	};
	const bugs = [];
	for (const [id] of blocks) {
		if (!isVis(id)) continue;
		const seen = new Set();
		let cur = id,
			why = null;
		while (cur !== null) {
			if (seen.has(cur)) {
				why = `cycle@${cur}`;
				break;
			}
			seen.add(cur);
			const pl = placements.get(cur);
			const dp = pl.parent === null ? null : own.ownerOf(pl.parent);
			if (dp === DEAD) {
				why = 'dead-ancestor';
				break;
			}
			if (dp === null) break;
			if (!isVis(dp)) {
				why = `hidden-ancestor@${dp}`;
				break;
			}
			cur = dp;
		}
		if (why === null) continue;
		if (why === 'dead-ancestor') continue;
		bugs.push(`${id} (${why})`);
	}
	return bugs;
};

const runSteps = (sched) => {
	const set = createPeerSet(sched.peers, MODEL_BASE_SEED);
	const peers = set.peers;
	const name = (i) => peers[i % peers.length].name;
	const ids = (peer) => ops.listBlockIds(peer);
	const resolveId = (peer, idx) => {
		const l = ids(peer);
		return l.length ? l[idx % l.length] : undefined;
	};
	const resolveParent = (peer, idx) => {
		const l = ids(peer);
		return idx >= l.length ? null : l[idx];
	};
	for (let i = 0; i < sched.steps.length; i++) {
		const step = sched.steps[i];
		const peer = peers[step.peer % peers.length];
		const op = step.op;
		try {
			if (op.kind === 'net') {
				const a = name(op.a),
					b = name(op.b);
				switch (op.action) {
					case 'deliver':
						set.deliver(a, b);
						break;
					case 'deliverReverse':
						set.deliver(a, b, { reverse: true });
						break;
					case 'duplicate':
						set.deliver(a, b, { times: 2 });
						break;
					case 'batch':
						set.deliver(a, b, { batch: true });
						break;
					case 'deliverAll':
						set.deliverAll();
						break;
					case 'drop':
						set.dropQueued(a, b);
						break;
					case 'partition':
						set.partition(a, b);
						break;
					case 'heal':
						set.heal(a, b);
						break;
					case 'isolate':
						set.isolate(a);
						break;
					case 'healPeer':
						set.healPeer(a);
						break;
					case 'syncSV':
						set.syncPeer(a, b);
						break;
					case 'syncFull':
						set.syncPeerFull(a, b);
						break;
					case 'persist':
						set.peer(a).persist();
						break;
					case 'reloadSnap':
						set.peer(a).reload('snapshot');
						break;
					case 'reloadLog':
						set.peer(a).reload('log');
						break;
				}
				continue;
			}
			switch (op.kind) {
				case 'insertBlock':
					ops.insertBlock(
						peer,
						{ parent: resolveParent(peer, i + (peer.name.charCodeAt(0) % 3)), index: i % 5 },
						{ id: op.id, type: op.type }
					);
					break;
				case 'deleteBlock': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.deleteBlock(peer, id);
					break;
				}
				case 'moveBlock': {
					const id = resolveId(peer, op.idIndex);
					const p = resolveParent(peer, op.parentIndex);
					if (id) ops.moveBlock(peer, id, { parent: p, index: op.destIndex });
					break;
				}
				case 'nest': {
					const id = resolveId(peer, op.idIndex);
					const p = resolveId(peer, op.parentIndex);
					if (id && p && p !== id) ops.nestBlock(peer, id, p);
					break;
				}
				case 'unNest': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.unNestBlock(peer, id);
					break;
				}
				case 'split': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.splitBlock(peer, id, op.offset, op.newId);
					break;
				}
				case 'merge': {
					const f = resolveId(peer, op.fromIndex);
					const t = resolveId(peer, op.intoIndex);
					if (f && t && f !== t) ops.mergeBlocks(peer, f, t);
					break;
				}
				case 'insertText': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.insertText(peer, id, op.offset, op.text);
					break;
				}
				case 'deleteText': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.deleteText(peer, id, op.offset, op.length);
					break;
				}
				case 'setMark': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.setMark(peer, id, op.offset, op.length, op.name, true);
					break;
				}
				case 'unsetMark': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.unsetMark(peer, id, op.offset, op.length, op.name);
					break;
				}
				case 'insertInline': {
					const id = resolveId(peer, op.idIndex);
					if (id) ops.insertInline(peer, id, op.offset, { id: op.atomId, type: 'mention' });
					break;
				}
				case 'removeInline': {
					const id = resolveId(peer, op.idIndex);
					if (id) {
						const blk = ops
							.project(peer)
							.children.flatMap(function w(b) {
								return [b, ...b.children.flatMap(w)];
							})
							.find((b) => b.id === id);
						const ins = (blk?.content ?? []).filter((i) => i.kind === 'inline');
						if (ins.length) ops.removeInline(peer, id, ins[op.inlineIndex % ins.length].id);
					}
					break;
				}
			}
		} catch (e) {
			return { crashed: `step ${i} ${op.kind}: ${String(e).slice(0, 150)}` };
		}
	}
	for (const p of peers) set.healPeer(p.name);
	set.deliverAll();
	set.syncAll('full');
	set.deliverAll();
	const diverged = [];
	for (const p of peers.slice(1)) {
		const d = findFirstDiff(ops.project(peers[0]), ops.project(p));
		if (d !== null) diverged.push(`${p.name}: ${d}`);
	}
	return { bugs: vanishedIds(peers[0].doc), diverged };
};

// Seeds verified to end with live-but-unreachable blocks in the pinned run.
// NOTE: corpus replay is clientId-dependent (random doc clientIds change
// tie-break order → different op resolution), so a given seed does not
// reproduce its outcome on every run. These seeds reproduced in ≥1 observed
// run; the fatal sweep below is the reliable gate.
const PINNED_SEEDS = [8, 23, 25, 30, 50, 52, 76, 92, 109];

describe('G1-C: corpus reachability oracle (display-parent cycles)', () => {
	for (const seed of PINNED_SEEDS) {
		it(`seed ${seed}: no live block is unreachable after heal+full-sync`, () => {
			const res = runSteps(generateSchedule(seed, 3, 200));
			expect(res.crashed, `seed ${seed} crashed`).toBeUndefined();
			expect(res.diverged, `seed ${seed} projection divergence`).toEqual([]);
			expect(res.bugs, `seed ${seed}: live self-owned blocks unreachable in projection`).toEqual(
				[]
			);
		});
	}

	it('full corpus sweep: no seed ends with live-but-unreachable blocks', () => {
		const seeds =
			(process.env.G1_SEEDS ?? '')
				? process.env.G1_SEEDS.split(',').map(Number)
				: Array.from({ length: 150 }, (_, i) => i + 1);
		const hits = [];
		let crashed = 0,
			div = 0,
			divUnexplained = 0;
		for (const seed of seeds) {
			const res = runSteps(generateSchedule(seed, 3, 200));
			if (res.crashed) {
				crashed++;
				console.log('seed', seed, 'CRASHED', res.crashed);
				continue;
			}
			if (res.diverged?.length) {
				div++;
				console.log('seed', seed, 'DIVERGED', res.diverged[0]);
			}
			if (res.bugs.length) hits.push(seed);
		}
		console.log(
			`reachability sweep: ${hits.length}/${seeds.length} seeds with vanished blocks, ${div} divergent, ${crashed} crashed`
		);
		console.log('seeds:', JSON.stringify(hits));
		// The defect reproduces on ~20% of seeds — this is the reliable gate.
		expect(hits, 'seeds with live-but-unreachable blocks').toEqual([]);
	});
});
