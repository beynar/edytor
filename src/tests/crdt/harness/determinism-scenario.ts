// @ts-nocheck
/**
 * Shared deterministic schedule for the U3 determinism proof.
 *
 * One fixed program exercising every traced scheduler decision: authored
 * transactions (in and out of the undo capture window), a partition with a
 * withheld delivery, message loss, persist + reload incarnation, heal and
 * resync. No RNG anywhere — every choice is literal, so identical source +
 * configuration must produce an identical event trace and projection.
 *
 * `defect: true` injects one extra authored edit — the canary proving the
 * fingerprint is sensitive to semantic divergence, not just reordered
 * bookkeeping.
 */
import { createPeerSet } from './peer-set.js';
import { createModelOps } from './ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import { traceDigest } from './trace.js';
import { vclock } from './vclock.js';

const ops = createModelOps();

export const runDeterminismScenario = (opts: { defect?: boolean; rngSeed?: number } = {}) => {
	vclock.set(10_000);
	const set = createPeerSet(3, MODEL_BASE_SEED, { rngSeed: opts.rngSeed ?? 7 });
	set.clock = () => vclock.now;
	const { A, B, C } = set;

	A.enableUndo({ scope: A.doc.get('blocks'), captureTimeout: 200 });

	// Two edits inside the capture window → one undo stack item.
	ops.insertText(A, 'b1', 5, '-A1');
	vclock.advance(50);
	ops.insertText(A, 'b1', 8, '-A2');

	// Partition A from C; B keeps authoring.
	set.partition('A', 'C');
	ops.insertText(B, 'b3a', 0, 'B!');
	vclock.advance(300); // past captureTimeout — next A edit is a new stack item
	ops.splitBlock(A, 'b2', 3, 's1');

	// Flush: A→C is partitioned — the explicit attempt is withheld and traced
	// (deliver n:0), everything else lands.
	set.deliver('A', 'C');
	set.deliverAll();

	// B persists, reloads (new incarnation), keeps writing.
	B.persist();
	B.reload();
	ops.insertText(B, 'b3b', 2, 'r');

	// Real message loss on B→A, then heal + resync.
	set.dropQueued('B', 'A');
	set.heal('A', 'C');
	set.deliverAll();
	set.syncAll();

	if (opts.defect) {
		ops.insertText(C, 'b1', 0, 'DEFECT');
		set.deliverAll();
	}

	return {
		set,
		traceDigest: traceDigest(set.trace),
		traceText: set.trace.map((e) => JSON.stringify(e)).join('\n'),
		projections: set.peers.map((p) => JSON.stringify(ops.project(p)))
	};
};
