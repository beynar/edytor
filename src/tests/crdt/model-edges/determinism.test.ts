/**
 * Gate-1 regression probe — replay determinism.
 *
 * The corpus contract is that a committed schedule replays byte-identically:
 * every identity a run can mint — item ids, rank keys, client ids — must be a
 * pure function of `(seed, peerIndex[, reloadGeneration])`. Before the fix the
 * seed doc was built with a random `clientID` (it is a writer —
 * `modelSpecSeed` allocates placement ranks through `insertBlock`, so its id
 * lands in rank tiebreaks and item ids) and rank in-gap picks drew
 * `Math.random`, so two runs of the same seed diverged at the byte level.
 *
 * Pinned contract (see `peer-set.ts`):
 * - seed doc clientID = {@link SEED_DOC_CLIENT_ID} (fixed);
 * - peer i clientID = `firstClientId + i`, `firstClientId = 1+(seed mod 2^20)`;
 * - the doc's rank-rand stream (`setDocRand`) = mulberry32 keyed by
 *   `(seed, peerIndex, generation)`.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerSet, SEED_DOC_CLIENT_ID } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { generateSchedule } from '../random/generator.js';
import { runSchedule } from '../random/runner.js';

const M = bindModel(Y);
const ops = createModelOps();

describe('G1-D: replay determinism', () => {
	it('peer ids and seed bytes are pure functions of (seed, peerIndex)', () => {
		const build = (rngSeed: number) => {
			const set = createPeerSet(3, MODEL_BASE_SEED, { rngSeed });
			return {
				// The seed update bytes the peers were built from (entry 0 of the
				// update log) — pins the seed doc's clientID + rank minting.
				seedUpdateHex: Buffer.from(set.A.updateLog[0]).toString('hex'),
				peerIds: set.peers.map((p) => p.doc.clientID)
			};
		};
		const a = build(77);
		const b = build(77);
		const c = build(78);
		expect(a).toEqual(b); // same seed → identical identities + seed bytes
		expect(a.peerIds).not.toEqual(c.peerIds); // different seed → different id space
		expect(b.seedUpdateHex).toBe(a.seedUpdateHex);
	});

	it('rank minting replays identically across peer-set constructions', () => {
		const run = () => {
			const set = createPeerSet(3, MODEL_BASE_SEED, { rngSeed: 11 });
			set.A.transact(() =>
				M.insertBlock(set.A.doc, { parent: null, index: 1 }, { id: 'x1', type: 'paragraph' })
			);
			set.B.transact(() =>
				M.insertBlock(set.B.doc, { parent: 'b3', index: 0 }, { id: 'x2', type: 'paragraph' })
			);
			set.A.transact(() => M.moveBlock(set.A.doc, 'b2', { parent: 'b3', index: 1 }));
			set.deliverAll();
			// Encoded full state: identical bytes ⟺ identical item ids AND rank keys.
			return set.peers.map((p) => Buffer.from(Y.encodeStateAsUpdate(p.doc)).toString('hex'));
		};
		expect(run()).toEqual(run());
	});

	it('a committed schedule produces identical results twice', () => {
		// runSchedule builds its peer set with rngSeed = schedule.seed, so the
		// whole run — clientIDs, rank minting, violation evidence — must be a
		// pure function of the committed seed. (State-byte identity is pinned
		// by the test above; this pins the runner's classification surface.)
		const schedule = generateSchedule(8, 3, 200);
		const r1 = runSchedule(schedule, ops, MODEL_BASE_SEED);
		const r2 = runSchedule(schedule, ops, MODEL_BASE_SEED);
		expect(r2).toEqual(r1);
		expect(r1.ok).toBe(true);
	});

	it('reload generations stay deterministic', () => {
		const run = () => {
			const set = createPeerSet(2, MODEL_BASE_SEED, { rngSeed: 5 });
			set.A.transact(() => M.insertText(set.A.doc, 'b1', 0, 'one'));
			set.A.persist();
			set.A.reload('snapshot');
			set.A.transact(() => M.insertText(set.A.doc, 'b1', 0, 'two'));
			set.deliverAll();
			return Buffer.from(Y.encodeStateAsUpdate(set.A.doc)).toString('hex');
		};
		expect(run()).toEqual(run());
	});
});
