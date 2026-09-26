// @ts-nocheck
/**
 * U3 deterministic-replay proof for the headless lane.
 *
 * - In-process repeat: the same pinned schedule produces a byte-identical
 *   event trace; on divergence the FIRST differing event is reported, not
 *   just a digest mismatch.
 * - Sensitivity: one injected authored edit changes trace AND projection
 *   digests — the fingerprint cannot pass on bookkeeping noise.
 * - Trace evidence: events carry update content hashes (`h`) and delivery
 *   parameters (`d`), so same-length different payloads and different
 *   delivery orders/params produce different serialized traces.
 * - Fresh process: two spawned `vitest run` executions of the probe
 *   produce identical fingerprints (new OS process, new module registry),
 *   and a defect run in a third fresh process changes them.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runDeterminismScenario } from './determinism-scenario.js';
import { createPeerPair } from './peer-set.js';
import { createRawNodeOps } from './ops/raw-node-ops.js';
import { serializeTrace, traceDigest } from './trace.js';
import { BASE_SEED } from '../scenarios/seeds.js';

const ops = createRawNodeOps();

const firstDivergence = (a: string, b: string) => {
	const la = a.split('\n');
	const lb = b.split('\n');
	for (let i = 0; i < Math.max(la.length, lb.length); i++) {
		if (la[i] !== lb[i]) return { index: i, a: la[i], b: lb[i] };
	}
	return null;
};

const runProbe = (env: Record<string, string> = {}) => {
	const out = execFileSync(
		'pnpm',
		[
			'exec',
			'vitest',
			'run',
			// Intercepted console output is forwarded to the reporter
			// asynchronously and can be dropped/reformatted depending on
			// stdio mode — disable interception so nothing mangles the
			// channel. (The probe writes digests straight to
			// process.stdout anyway; this is belt-and-suspenders.)
			'--disableConsoleIntercept',
			'--config',
			'vitest.crdt.config.ts',
			'src/tests/crdt/harness/determinism-probe.test.ts'
		],
		{
			env: { ...process.env, CRDT_TRACE_PROBE: '1', ...env },
			encoding: 'utf8',
			timeout: 120_000
		}
	);
	const trace = /TRACE:([0-9a-f]{8})/.exec(out)?.[1];
	const proj = /PROJ:([0-9a-f]{8})/.exec(out)?.[1];
	if (!trace || !proj) throw new Error(`probe output missing digests:\n${out.slice(-800)}`);
	return { trace, proj };
};

describe('headless deterministic replay (U3)', () => {
	it('repeats the pinned schedule byte-identically, reporting first divergence', () => {
		const r1 = runDeterminismScenario();
		const r2 = runDeterminismScenario();
		const div = firstDivergence(r1.traceText, r2.traceText);
		expect(div, `trace diverged at event ${div?.index}`).toBeNull();
		expect(r1.traceDigest).toBe(r2.traceDigest);
		expect(r1.projections).toEqual(r2.projections);
	});

	it('fingerprint is sensitive to one injected authored edit', () => {
		const good = runDeterminismScenario();
		const bad = runDeterminismScenario({ defect: true });
		expect(bad.traceDigest).not.toBe(good.traceDigest);
		expect(bad.projections).not.toEqual(good.projections);
	});

	it('withheld deliveries and no-op transactions are visible in the trace', () => {
		const { set } = runDeterminismScenario();
		// A→C was partitioned: the deliver attempt must appear as applied=0 —
		// a held message cannot silently bypass the queue.
		const withheld = set.trace.find(
			(e) => e.kind === 'deliver' && e.a === 'A' && e.b === 'C' && e.n === 0
		);
		expect(withheld).toBeTruthy();
		// Every transact carries its authored-update evidence.
		const writes = set.trace.filter((e) => e.kind === 'transact' && (e.n ?? 0) > 0);
		expect(writes.length).toBeGreaterThanOrEqual(4);
	});

	it('same-length different payloads produce different traces', () => {
		// 'x' vs 'y': identical byte length, identical schedule — the ONLY
		// difference is update content. Byte-count-only tracing cannot
		// distinguish these runs; content hashes must.
		const s1 = createPeerPair(BASE_SEED);
		ops.insertText(s1.A, 'b1', 0, 'x');
		const s2 = createPeerPair(BASE_SEED);
		ops.insertText(s2.A, 'b1', 0, 'y');
		expect(serializeTrace(s1.trace)).not.toBe(serializeTrace(s2.trace));
		expect(traceDigest(s1.trace)).not.toBe(traceDigest(s2.trace));
		// The content hash lands on BOTH the authoring transact and the
		// enqueue carrying that update.
		const enq = s1.trace.find((e) => e.kind === 'enqueue');
		const tx = s1.trace.find((e) => e.kind === 'transact' && (e.n ?? 0) > 0);
		expect(enq?.h).toMatch(/^[0-9a-f]{8}$/);
		expect(tx?.h).toBe(enq?.h);
		const enq2 = s2.trace.find((e) => e.kind === 'enqueue');
		expect(enq2?.h).toMatch(/^[0-9a-f]{8}$/);
		expect(enq2?.h).not.toBe(enq?.h);
	});

	it('delivery order, repetition and batching are recorded', () => {
		const mk = () => {
			const s = createPeerPair(BASE_SEED);
			ops.insertText(s.A, 'b1', 0, '1');
			ops.insertText(s.A, 'b1', 0, '2');
			ops.insertText(s.A, 'b1', 0, '3');
			return s;
		};
		const fifo = mk();
		fifo.deliver('A', 'B');
		const rev = mk();
		rev.deliver('A', 'B', { reverse: true });
		const dup = mk();
		dup.deliver('A', 'B', { times: 2 });
		const batched = mk();
		batched.deliver('A', 'B', { batch: true });

		// All four flush the same three-update queue — identical n, so only
		// the recorded params + applied-order hashes can tell them apart.
		const serials = [fifo, rev, dup, batched].map((s) => serializeTrace(s.trace));
		const digests = [fifo, rev, dup, batched].map((s) => traceDigest(s.trace));
		expect(new Set(serials).size).toBe(4);
		expect(new Set(digests).size).toBe(4);

		const lastDeliver = (s) => s.trace.filter((e) => e.kind === 'deliver' && e.n > 0).at(-1);
		const dFifo = lastDeliver(fifo);
		const dRev = lastDeliver(rev);
		const dDup = lastDeliver(dup);
		const dBatch = lastDeliver(batched);
		// Delivery parameters are pinned: r<reverse>t<times>b<batch>.
		expect(dFifo.d).toBe('r0t1b0');
		expect(dRev.d).toBe('r1t1b0');
		expect(dDup.d).toBe('r0t2b0');
		expect(dBatch.d).toBe('r0t1b1');
		// h lists the applied updates in execution order.
		expect(dFifo.h?.split(',')).toHaveLength(3);
		// Reversed delivery applies the SAME updates newest-first.
		expect(dRev.h?.split(',')).toEqual(dFifo.h.split(',').slice().reverse());
		// times:2 re-applies each update — doubled hash list.
		expect(dDup.h?.split(',')).toHaveLength(6);
		// Batch applies the merged update once — a single hash of content
		// that is none of the individual queue entries.
		expect(dBatch.h?.split(',')).toHaveLength(1);
		expect(dFifo.h.split(',')).not.toContain(dBatch.h.split(',')[0]);
	});

	it('produces identical fingerprints in fresh processes', { timeout: 300_000 }, () => {
		const p1 = runProbe();
		const p2 = runProbe();
		expect(p1).toEqual(p2);
		// Equality is only evidence if the channel can distinguish runs —
		// a defect in a third fresh process must change the fingerprint.
		const defect = runProbe({ CRDT_TRACE_DEFECT: '1' });
		expect(defect).not.toEqual(p1);
	});
});
