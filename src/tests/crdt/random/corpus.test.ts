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
 * - Lanes (WU3): `model` and `doc` are the STRICT lane — legal production
 *   schedules fail on any hard violation: actual lost edits
 *   (`lost-edit`), unreachable blocks, crashes (an engine stack frame does
 *   not excuse a crash), divergence. `raw` is the DIAGNOSTIC lane — the
 *   copy adapter's expected evidence (lost edits, duplicate placements,
 *   resurrected deletes, upstream engine crashes) is reported, never
 *   gated. The partition itself lives in {@link runSchedule}:
 *   `result.violations` is always the gate list, `result.evidence` the
 *   legit report — so a legit class can never be promoted to a failure
 *   nor a real one downgraded by this file.
 *
 * - U03: the corpus is adapter-parametric. `CRDT_ADAPTER` selects
 *   `raw` (RawNodeOps copy semantics — diagnostic lane),
 *   `model` / `doc` (production adapters — strict lane),
 *   or `all` (default). Each adapter seeds from its own schema
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
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
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
				evidence: result.evidence,
				lostEdits: result.lostEdits,
				lostIdentities: result.lostIdentities,
				tagVerdicts: result.tagVerdicts,
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

		// Aggregate evidence across the whole corpus — printed once, asserted
		// never to leave the legit classes for this adapter. `result.evidence`
		// holds the classified-legit kinds; `result.violations` the hard ones.
		const evidence = new Map<string, number>();
		// Per-seed oracle classification (WU3 report): seed → non-trivial tag
		// verdicts — printed once at the end so every residual case is on
		// record, not just the totals.
		const perSeedVerdicts = new Map<number, string[]>();

		/**
		 * U5 — pinned REAL model defects found by the corpus (never masked
		 * as harness noise): seed → the exact failure signature the strict
		 * lane must keep reporting. A different failure (or a fixed model)
		 * fails the seed loudly; the minimal repro lives in
		 * `hardening/u5-min-rank-rehome.test.ts`. The placement model is
		 * shared by the `model` and `doc` lanes, so the pin applies to both.
		 *
		 * Currently EMPTY — the seed-96 `rank space exhausted` pin was fixed
		 * in the placement model (`rehomeRankBelow` mints below the root
		 * minimum instead of the un-insertable-above floor sentinel); the
		 * committed repro artifacts self-cleaned on the first green run.
		 * Keep the mechanism: a new corpus defect gets pinned here with its
		 * signature + a hardening repro test.
		 */
		const KNOWN_MODEL_BUGS = new Map<number, RegExp>();

		/**
		 * Committed frozen upstream-crash repros (the diagnostic-lane replay
		 * suite reads these exact files). They are pinned evidence, NOT live
		 * corpus state: the generated schedule for the same seed number may
		 * now pass, which must NOT self-clean the file away.
		 */
		const PINNED_DIAGNOSTIC_ARTIFACTS = new Set(['seed-86', 'seed-140']);

		for (const seed of CORPUS.seeds) {
			it(`seed ${seed}`, () => {
				const schedule = generateSchedule(seed, CORPUS.peers, CORPUS.ops);
				const result = runSchedule(schedule, ops, seedUpdate);
				for (const v of result.evidence) evidence.set(v, (evidence.get(v) ?? 0) + 1);
				const nonTrivial = Object.entries(result.tagVerdicts)
					.filter(([, v]) => !v.startsWith('present') && !v.startsWith('deleted-legit'))
					.map(([tag, v]) => `${tag}:${v}`);
				if (nonTrivial.length > 0) perSeedVerdicts.set(seed, nonTrivial);
				const artifact = `${FAILURE_DIR}/seed-${seed}${suffix}.json`;
				if (
					result.ok &&
					existsSync(artifact) &&
					!PINNED_DIAGNOSTIC_ARTIFACTS.has(`seed-${seed}${suffix}`)
				) {
					// Self-clean: a seed that passes again must not leave a stale
					// repro behind — committed artifacts always reflect the
					// current corpus state. Frozen diagnostic repros are exempt.
					rmSync(artifact);
				}
				const knownBug =
					adapterName === 'model' || adapterName === 'doc' ? KNOWN_MODEL_BUGS.get(seed) : undefined;
				if (knownBug !== undefined) {
					// Pinned defect — persist the fresh repro, then pin the EXACT
					// crash signature: a different violation is a new bug, and a
					// fixed model (`result.ok`) is the signal to drop this branch.
					if (!result.ok) persistFailure(schedule, result, ops, seedUpdate, suffix);
					expect(
						result.ok,
						`seed ${seed}: pinned model defect expected to keep failing (hardening/u5-min-rank-rehome)`
					).toBe(false);
					expect(result.violations).toEqual(['crash']);
					expect(result.failure).toMatch(knownBug);
					return;
				}
				if (!result.ok) {
					// Persist a reproducible artifact for EVERY abnormal outcome.
					const file = persistFailure(schedule, result, ops, seedUpdate, suffix);
					const replay = `replay: CRDT_ADAPTER=${adapterName} CRDT_SEEDS=${seed} pnpm test:crdt`;
					// `violations` is already the hard list (partitioned by the
					// runner) — any entry fails the seed on every lane.
					if (result.violations.length > 0) {
						throw new Error(
							`corpus seed ${seed} [${adapterName}] failed (${result.violations.join(',')}): ${result.failure}\n` +
								`persisted + minimized repro: ${file}\n${replay}`
						);
					}
					// Evidence-class abort (e.g. upstream-engine-crash on the raw
					// diagnostic adapter): the run did not complete, but the
					// cause is a classified upstream finding — the artifact
					// above is the durable repro for U07/the upstream report.
					// Counted in the evidence summary; not a gate failure.
					console.log(
						`seed ${seed} [${adapterName}]: evidence-class abort ` +
							`(${result.evidence.join(',')}) — ` +
							`${result.failure?.split('\n')[0]} — repro: ${file}`
					);
				}
			});
		}

		it('prints the per-seed oracle classification', () => {
			if (perSeedVerdicts.size === 0) {
				console.log(`per-seed verdicts [${adapterName}]: all present/deleted-legit`);
				return;
			}
			for (const [seed, tags] of perSeedVerdicts) {
				console.log(`per-seed verdicts [${adapterName}] seed ${seed}: ${tags.join(' | ')}`);
			}
		});

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

describe('diagnostic lane: persisted upstream crash repros', () => {
	// seed-86/140 are committed artifacts of genuine vendored-engine crashes
	// (lossy reloads + Skip/GC overlap → iterateStructsByIdSet /
	// findIndexSS). They stay DIAGNOSTIC on the raw adapter forever — a
	// replay must classify as upstream-engine-crash EVIDENCE, never as a
	// gate violation, and never silently disappear.
	for (const name of ['seed-86', 'seed-140']) {
		it(`${name} replays as upstream-engine-crash evidence`, () => {
			const artifact = JSON.parse(readFileSync(`${FAILURE_DIR}/${name}.json`, 'utf8')) as {
				seed: number;
				peers: number;
				schedule: Step[];
			};
			const res = runSchedule(
				{ seed: artifact.seed, peers: artifact.peers, steps: artifact.schedule },
				createRawNodeOps(),
				BASE_SEED
			);
			expect(res.ok).toBe(false);
			expect(res.violations).toEqual([]);
			expect(res.evidence).toContain('upstream-engine-crash');
		});
	}
});

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

	it('strict lane (WU3): an injected atom loss cannot silently pass', () => {
		// The strict gate must fail when an adapter drops atoms. Injection is
		// done on the ADAPTER surface (test-only), not in the model: the stub
		// reports every tracked atom uncovered — the runner must surface
		// `lost-edit` as a hard violation, on a schedule with zero lossy net
		// ops so nothing can excuse it as convergent-loss.
		const model = createModelOps();
		const lossless: Schedule = {
			seed: 9901,
			peers: 3,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'ix1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µINJ1', tag: 'µINJ1' } },
				{ peer: 1, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µINJ2', tag: 'µINJ2' } }
			]
		};
		const dropping: CrdtOps = {
			...model,
			classifyTagAtoms: (_peer, _target, atoms) => atoms.map(() => ({ kind: 'uncovered' }) as const)
		};
		const res = runSchedule(lossless, dropping, MODEL_BASE_SEED);
		expect(res.ok).toBe(false);
		expect(res.violations).toContain('lost-edit');
		// And the strict corpus gate itself: violations non-empty ⇒ the seed
		// would throw — the same check the per-seed loop performs.
		expect(res.violations.length).toBeGreaterThan(0);
	});

	it('strict lane (WU3): an injected adapter throw fails as crash', () => {
		const model = createModelOps();
		let calls = 0;
		const flaky: CrdtOps = {
			...model,
			insertText: (peer, id, offset, text, marks) => {
				if (++calls === 2) throw new Error('injected strict-lane throw');
				return model.insertText(peer, id, offset, text, marks);
			}
		};
		const res = runSchedule(generateSchedule(7, 3, 60), flaky, MODEL_BASE_SEED);
		expect(res.ok).toBe(false);
		expect(res.violations).toContain('crash');
	});

	it('strict lane (WU3): an insert reporting success with no findable atoms fails', () => {
		const model = createModelOps();
		const blind: CrdtOps = { ...model, locateTagAtoms: () => null };
		const res = runSchedule(generateSchedule(7, 3, 60), blind, MODEL_BASE_SEED);
		expect(res.ok).toBe(false);
		expect(res.violations).toContain('lost-edit');
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
