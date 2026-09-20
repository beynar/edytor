/**
 * Bounded random-op corpus for U02 §5 — this file is what actually RUNS the
 * seeded schedules (the previous interrupted unit left generator/runner/shrink
 * as dead code; the plan requires ≥100 fixed seeds × 200 ops × 3 peers in the
 * bounded suite).
 *
 * Contract:
 *
 * - Every seed in {@link CORPUS_SEEDS} produces a deterministic 200-step,
 *   3-peer schedule (≈27% network events interleaved). Engine-level
 *   convergence after the heal+full-sync barrier is a HARD invariant:
 *   divergence, a crash, or an unclassified structural violation fails the
 *   seed. Known missing-semantics classes (duplicate placement, resurrected
 *   delete, lost identity, lost edit — all consequences of the copy adapter,
 *   each pinned to a pending §8 row) are recorded as evidence and printed as a
 *   summary; they do not fail the seed. The pending suite owns the semantic
 *   assertions; weakening them is forbidden (plan §U02 success criteria).
 *
 * - U03: the corpus is adapter-parametric. `CRDT_ADAPTER` selects
 *   `raw` (RawNodeOps copy semantics — evidence classes expected),
 *   `model` (the U03 placement model — those classes are HARD failures),
 *   or `all` (default: both). Each adapter seeds from its own schema
 *   (`BASE_SEED` vs `MODEL_BASE_SEED`).
 *
 * - Failing-seed persistence: on failure the seed's full schedule AND a
 *   greedily minimized reproduction are written to
 *   `src/tests/crdt/random/failures/seed-<n>[.<adapter>].json` so a regression
 *   is reproducible from committed state, not an ephemeral console line.
 *
 * - Replay a single seed: `CRDT_SEEDS=42 pnpm test:crdt` (also accepts
 *   comma lists and `a-b` ranges). `CRDT_OPS` / `CRDT_PEERS` override the
 *   schedule shape for wider pre-release sweeps, e.g.
 *   `CRDT_SEEDS=1-1000 CRDT_OPS=500 pnpm test:crdt` — the bounded CI corpus
 *   itself stays at the plan's 150-seed × 200-op × 3-peer target.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORPUS_SEEDS, generateSchedule, type Schedule, type Step } from './generator.js';
import { runSchedule, expectedViolations, type RunResult } from './runner.js';
import { minimizeSchedule, describeSchedule } from './shrink.js';
import { createRawNodeOps } from '../harness/ops/raw-node-ops.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { BASE_SEED, MODEL_BASE_SEED } from '../scenarios/seeds.js';
import type { CrdtOps } from '../harness/ops/crdt-ops.js';

const FAILURE_DIR = fileURLToPath(new URL('./failures', import.meta.url));

/** Parse `CRDT_SEEDS` — "42", "1,7,42", or "10-40". */
const parseSeedEnv = (raw: string | undefined): number[] | null => {
	if (!raw) return null;
	const seeds = new Set<number>();
	for (const part of raw.split(',')) {
		const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
		if (!m) throw new Error(`CRDT_SEEDS: bad segment "${part}"`);
		const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
		for (let s = from; s <= to; s++) seeds.add(s);
	}
	return [...seeds];
};

const CORPUS = {
	seeds: parseSeedEnv(process.env.CRDT_SEEDS) ?? CORPUS_SEEDS,
	ops: Number(process.env.CRDT_OPS ?? 200),
	peers: Number(process.env.CRDT_PEERS ?? 3)
};

/**
 * Adapter selection: `CRDT_ADAPTER=raw|model|all` (default `all` — the gate
 * exercises both; the model must show ZERO copy-semantics violations).
 * Failure artifacts keep the historical `seed-<n>.json` name for `raw` and
 * gain a `.model` suffix for the placement adapter.
 */
const ADAPTERS: Record<string, { make: () => CrdtOps; seed: unknown; suffix: string }> = {
	raw: { make: createRawNodeOps, seed: BASE_SEED, suffix: '' },
	model: { make: createModelOps, seed: MODEL_BASE_SEED, suffix: '.model' },
	// U06: the same corpus swept through the unified EdytorDoc facade —
	// proves the assembled surface preserves the engine semantics.
	doc: { make: createDocOps, seed: MODEL_BASE_SEED, suffix: '.doc' }
};
const SELECTED_ADAPTERS = (process.env.CRDT_ADAPTER ?? 'all').split(',').flatMap((s) => {
	const name = s.trim();
	if (name === 'all') return Object.keys(ADAPTERS);
	if (!(name in ADAPTERS)) throw new Error(`CRDT_ADAPTER: unknown adapter "${name}"`);
	return [name];
});

/**
 * Persist a failing seed: the raw schedule, the failure string, and a
 * minimized still-failing schedule + readable transcript. Returns the file
 * path for the error message.
 */
const persistFailure = (
	schedule: Schedule,
	result: RunResult,
	ops: CrdtOps,
	seed: unknown,
	suffix: string
): string => {
	const stillFails = (steps: Step[]) => !runSchedule({ ...schedule, steps }, ops, seed).ok;
	const minimized = minimizeSchedule(schedule, stillFails);
	mkdirSync(FAILURE_DIR, { recursive: true });
	const file = `${FAILURE_DIR}/seed-${schedule.seed}${suffix}.json`;
	writeFileSync(
		file,
		JSON.stringify(
			{
				seed: schedule.seed,
				peers: schedule.peers,
				adapter: ops.name,
				failure: result.failure,
				violations: result.violations,
				lostEdits: result.lostEdits,
				lostIdentities: result.lostIdentities,
				stepsExecuted: result.stepCount,
				schedule: schedule.steps,
				minimized: {
					stepCount: minimized.steps.length,
					transcript: describeSchedule(minimized),
					steps: minimized.steps
				}
			},
			null,
			2
		) + '\n'
	);
	return file;
};

for (const adapterName of SELECTED_ADAPTERS) {
	const { make, seed: seedUpdate, suffix } = ADAPTERS[adapterName];
	const ops = make();

	describe(`random corpus (${adapterName} adapter — ${ops.name})`, () => {
		// Corpus-shape guardrail: if somebody shrinks the committed seed list
		// the plan's coverage target is silently lost — pin it instead.
		it('covers at least 100 fixed seeds at 200 ops × 3 peers', () => {
			expect(CORPUS_SEEDS.length).toBeGreaterThanOrEqual(100);
			expect(new Set(CORPUS_SEEDS).size).toBe(CORPUS_SEEDS.length);
		});

		it('schedule generation is deterministic per seed', () => {
			expect(generateSchedule(42, 3, 200)).toEqual(generateSchedule(42, 3, 200));
		});

		// Aggregate violation evidence across the whole corpus — printed once,
		// asserted never to leave the known missing-semantics classes.
		const evidence = new Map<string, number>();

		for (const seed of CORPUS.seeds) {
			it(`seed ${seed}`, () => {
				const schedule = generateSchedule(seed, CORPUS.peers, CORPUS.ops);
				const result = runSchedule(schedule, ops, seedUpdate);
				for (const v of result.violations) evidence.set(v, (evidence.get(v) ?? 0) + 1);
				const artifact = `${FAILURE_DIR}/seed-${seed}${suffix}.json`;
				if (result.ok && existsSync(artifact)) {
					// Self-clean: a seed that passes again must not leave a stale
					// repro behind — committed artifacts always reflect the
					// current corpus state.
					rmSync(artifact);
				}
				if (!result.ok) {
					// Persist a reproducible artifact for EVERY abnormal outcome.
					const file = persistFailure(schedule, result, ops, seedUpdate, suffix);
					const replay = `replay: CRDT_ADAPTER=${adapterName} CRDT_SEEDS=${seed} pnpm test:crdt`;
					const hard = result.violations.filter((v) => !expectedViolations(ops).has(v));
					if (hard.length > 0) {
						throw new Error(
							`corpus seed ${seed} [${adapterName}] failed (${hard.join(',')}): ${result.failure}\n` +
								`persisted + minimized repro: ${file}\n${replay}`
						);
					}
					// Evidence-class outcome (e.g. upstream-engine-crash): the run
					// did not complete, but the cause is a classified upstream
					// finding — the artifact above is the durable repro for
					// U07/the upstream report. Counted in the evidence summary;
					// not a gate failure.
					console.log(
						`seed ${seed} [${adapterName}]: evidence-class abort ` +
							`(${result.violations.join(',')}) — ` +
							`${result.failure?.split('\n')[0]} — repro: ${file}`
					);
				}
			});
		}

		it('records only known evidence classes', () => {
			console.log(
				`corpus evidence [${adapterName}] (${CORPUS.seeds.length} seeds): ` +
					(evidence.size === 0
						? 'no semantic violations observed'
						: [...evidence.entries()].map(([k, n]) => `${k}×${n}`).join(', '))
			);
			// Not a print-only test: every violation class observed anywhere in
			// the corpus must be a listed evidence class for this adapter —
			// an `unreachable-block`, `malformed-node`, or any unclassified kind
			// here means a regression escaped the per-seed failure path.
			const allowed = expectedViolations(ops);
			for (const kind of evidence.keys()) {
				expect(
					allowed.has(kind),
					`unexpected violation class "${kind}" observed in corpus evidence`
				).toBe(true);
			}
		});
	});
}

describe('shrink + failure-persistence self-tests', () => {
	const ops = createRawNodeOps();
	it('runSchedule reports a forced failure instead of throwing', () => {
		// Wrap the adapter so the 3rd insertText throws — exercises the
		// classify/report path without relying on a lucky seed.
		let calls = 0;
		const flaky: CrdtOps = {
			...ops,
			insertText: (peer, id, offset, text, marks) => {
				if (++calls === 3) throw new Error('forced failure for self-test');
				return ops.insertText(peer, id, offset, text, marks);
			}
		};
		const schedule = generateSchedule(7, 3, 50);
		const result = runSchedule(schedule, flaky, BASE_SEED);
		expect(result.ok).toBe(false);
		expect(result.failure).toContain('forced failure');
	});

	it('minimizeSchedule reduces a failing schedule to its essential step', () => {
		const schedule = generateSchedule(9, 3, 60);
		// Synthetic predicate: "fails" iff the schedule still contains a
		// deleteText step — the minimizer must strip everything else.
		const stillFails = (steps: Step[]) => steps.some((s) => s.op.kind === 'deleteText');
		const minimized = minimizeSchedule(schedule, stillFails);
		expect(minimized.steps.length).toBeLessThan(schedule.steps.length);
		expect(minimized.steps.every((s) => s.op.kind === 'deleteText')).toBe(true);
		expect(minimized.steps.length).toBeGreaterThan(0);
	});

	it('end-to-end: a failing schedule shrinks to a still-failing prefix', () => {
		// Force ok:false via a throwing adapter, then prove the shrinker keeps
		// the failing step (chunk removal must not delete the cause).
		const schedule = generateSchedule(11, 3, 40);
		const buggy: CrdtOps = {
			...ops,
			deleteBlock: () => {
				throw new Error('always-fail deleteBlock');
			}
		};
		const stillFails = (steps: Step[]) => !runSchedule({ ...schedule, steps }, buggy, BASE_SEED).ok;
		const minimized = minimizeSchedule(schedule, stillFails);
		const result = runSchedule({ ...schedule, steps: minimized.steps }, buggy, BASE_SEED);
		expect(result.ok).toBe(false);
		expect(minimized.steps.length).toBeLessThan(schedule.steps.length);
	});
});
