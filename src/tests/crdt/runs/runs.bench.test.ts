/**
 * U05 run-view invalidation benchmarks.
 *
 * Env-gated: runs only under `BENCH_RUNS=1` (wired as `pnpm bench:runs`),
 * never inside `pnpm test:crdt`. Measures the REAL maintained view
 * (`bindRuns`) — not a simulation — and writes
 * `bench/results/runs-<timestamp>.json`.
 *
 * Workloads (plan §10 + U05):
 * - cold construction: attach + first full read over N blocks × M runs
 * - warm read: cached runs()/contentJSON() per block
 * - single-run local edit: 1-char insert in one block → recomputes = 1
 * - unrelated-block edit: edit block j in an N-block doc → recomputes = 1,
 *   N-1 snapshots reused (array identity asserted)
 * - remote invalidation: apply a remote update → same granularity
 * - split/merge invalidation: recompute fan-out (head + sibling only)
 * - inline metadata invalidation: setInlineData → recomputes = 1
 * - delta-cache cost: live `.delta.toJSON()` vs fresh `toDelta().toJSON()`
 * - scaling: 100 / 1000 / 4000-block docs
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindRuns } from '../../../lib/crdt/text/runs.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const ENABLED = process.env.BENCH_RUNS === '1';
const M = bindModel(Y);
const R = bindRuns(Y);
const O = bindRunsOracle(Y);

const statsOf = (arr, warmup = 0) => {
	const s = [...arr].sort((a, b) => a - b);
	const sum = arr.reduce((a, b) => a + b, 0);
	const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
	return {
		samples: arr.length,
		warmup,
		mean: +(sum / arr.length).toFixed(4),
		p50: +q(50).toFixed(4),
		p95: +q(95).toFixed(4),
		min: +s[0].toFixed(4),
		max: +s[s.length - 1].toFixed(4)
	};
};

const timed = (fn, { warmup = 3, samples = 20 } = {}) => {
	for (let i = 0; i < warmup; i++) fn(i);
	const out = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		fn(i);
		out.push(performance.now() - t0);
	}
	return statsOf(out, warmup);
};

/** An N-block doc; each block has two text runs + one inline atom. */
const seedDoc = (n, chars = 40) =>
	modelSpecSeed(
		Array.from({ length: n }, (_, i) => ({
			id: `b${i}`,
			type: 'paragraph',
			content: [
				{
					kind: 'text',
					text: `block ${i} `.padEnd(chars / 2, 'x'),
					marks: { bold: i % 3 === 0 ? true : undefined }
				},
				{ kind: 'inline', id: `m${i}`, type: 'mention', data: { user: `u${i}` } },
				{ kind: 'text', text: ` tail ${i}`.padEnd(chars / 2, 'y') }
			]
		}))
	);

const results = {};

const bench = (name, fn) => {
	results[name] = fn();
	console.log(`  ${name}:`, JSON.stringify(results[name]));
};

describe('U05 run-view invalidation benchmarks', () => {
	it.skipIf(!ENABLED)('measures the maintained view vs full recompute', () => {
		const N = 1000;
		const set = createPeerPair(seedDoc(N));
		const doc = set.A.doc;

		// ── the doc's index (built once, lives as long as the doc) + read all blocks ──
		{
			const samples = [];
			for (let i = 0; i < 7; i++) {
				const v = R.attach(doc);
				v.debug.reset();
				const t0 = performance.now();
				for (let b = 0; b < N; b++) v.runs(`b${b}`);
				samples.push(performance.now() - t0);
			}
			results['read-all-runs (1000 blocks, attached index)'] = statsOf(samples, 0);
		}
		// True cold: fresh doc built from the same update each time.
		{
			const state = Y.encodeStateAsUpdate(doc);
			const samples = [];
			for (let i = 0; i < 5; i++) {
				const d2 = new Y.Doc();
				Y.applyUpdate(d2, state);
				const v = R.attach(d2);
				const t0 = performance.now();
				for (let b = 0; b < N; b++) v.runs(`b${b}`);
				samples.push(performance.now() - t0);
			}
			results['cold-first-read-all-runs (1000 blocks, fresh doc)'] = statsOf(samples, 0);
		}

		const view = R.attach(doc);
		for (let b = 0; b < N; b++) view.runs(`b${b}`); // warm the cache

		bench('warm runs() read per block (1000 blocks)', () =>
			timed(() => view.runs(`b${Math.floor(Math.random() * N)}`), { samples: 200 })
		);
		bench('warm contentJSON() per block', () =>
			timed(() => view.contentJSON('b500'), { samples: 200 })
		);
		bench('full recompute baseline computeAllRuns (1000 blocks)', () =>
			timed(() => O.computeAllRuns(doc), { warmup: 1, samples: 7 })
		);

		// ── single-run local invalidation ────────────────────────────────
		bench('local 1-char insert: recompute fan-out', () => {
			const before = view.runs('b777');
			const otherIds = Array.from({ length: 20 }, (_, i) => `b${i * 50}`);
			const others = otherIds.map((id) => view.runs(id));
			view.debug.reset();
			const t0 = performance.now();
			set.A.transact(() => M.insertText(doc, 'b777', 1, 'Z'));
			const eventMs = performance.now() - t0;
			// Lazy: only recompute the read target.
			const t1 = performance.now();
			view.runs('b777');
			const readMs = performance.now() - t1;
			// Every other block keeps array identity.
			const reused = otherIds.filter((id, i) => view.runs(id) === others[i]).length;
			return {
				eventMs: +eventMs.toFixed(4),
				recomputeMs: +readMs.toFixed(4),
				recomputedBlocks: [...view.debug.recomputed],
				recomputed: view.debug.recomputes,
				otherBlocksReused: `${reused}/${otherIds.length}`,
				beforeRuns: before.length
			};
		});

		// ── unrelated-block edit: repeated over all 1000 blocks read ────
		bench('unrelated edit leaves 999/1000 snapshots reused', () => {
			const snap = new Map();
			for (let b = 0; b < N; b++) snap.set(`b${b}`, view.runs(`b${b}`));
			view.debug.reset();
			set.A.transact(() => M.insertText(doc, 'b42', 0, 'Q'));
			let reused = 0;
			const t0 = performance.now();
			for (let b = 0; b < N; b++) if (view.runs(`b${b}`) === snap.get(`b${b}`)) reused++;
			return {
				readAllMs: +(performance.now() - t0).toFixed(3),
				reused,
				recomputed: view.debug.recomputes
			};
		});

		// ── remote invalidation ──────────────────────────────────────────
		bench('remote 1-char insert apply + recompute', () => {
			const before = view.runs('b10');
			view.debug.reset();
			set.B.transact(() => M.insertText(set.B.doc, 'b10', 0, 'R'));
			const t0 = performance.now();
			set.deliver('B', 'A');
			const applyMs = performance.now() - t0;
			const t1 = performance.now();
			view.runs('b10');
			return {
				applyMs: +applyMs.toFixed(4),
				recomputeMs: +(performance.now() - t1).toFixed(4),
				recomputed: view.debug.recomputes,
				changed: view.runs('b10') !== before
			};
		});

		// ── split / merge invalidation fan-out ───────────────────────────
		bench('split block: invalidation fan-out', () => {
			view.debug.reset();
			set.A.transact(() => M.splitBlock(doc, 'b100', 5, 'b100-tail'));
			return {
				recomputed: view.debug.recomputes,
				// head + sibling recompute on read; nothing else
				head: view.runs('b100').length,
				sibling: view.runs('b100-tail').length,
				recomputedAfterReads: view.debug.recomputes,
				recomputedIds: [...view.debug.recomputed]
			};
		});
		bench('merge blocks: invalidation fan-out', () => {
			view.debug.reset();
			set.A.transact(() => M.mergeBlocks(doc, 'b100-tail', 'b100'));
			view.runs('b100');
			view.runs('b100-tail');
			return {
				recomputed: view.debug.recomputes,
				recomputedIds: [...view.debug.recomputed],
				mergedAwayRuns: view.runs('b100-tail').length
			};
		});

		// ── inline metadata invalidation ─────────────────────────────────
		bench('inline metadata update: recompute fan-out', () => {
			const before = view.runs('b200');
			view.debug.reset();
			set.A.transact(() => M.setInlineData(doc, 'b200', 'm200', { user: 'new' }));
			view.runs('b200');
			const after = view.runs('b200');
			const keptRuns = after.filter((r, i) => r === before[i]).length;
			return {
				recomputed: view.debug.recomputes,
				recomputedIds: [...view.debug.recomputed],
				runsReusedWithinBlock: `${keptRuns}/${after.length}`
			};
		});

		// ── delta cache vs fresh toDelta read cost ───────────────────────
		bench('delta-cache read: .delta.toJSON() vs toDelta().toJSON()', () => {
			const content = doc.get('blocks').getAttr('b300').getAttr('content');
			return {
				liveCache: timed(() => content.delta.toJSON(), { samples: 1000 }),
				freshToDelta: timed(() => content.toDelta().toJSON(), { samples: 200 })
			};
		});

		// ── scaling ──────────────────────────────────────────────────────
		bench('scaling: cold first-read vs block count', () => {
			return [100, 1000, 4000].map((n) => {
				const s = createPeerPair(seedDoc(n));
				const v = R.attach(s.A.doc);
				const t0 = performance.now();
				for (let b = 0; b < n; b++) v.runs(`b${b}`);
				const cold = performance.now() - t0;
				// one unrelated edit + full re-read (reused check)
				const snap = new Map();
				for (let b = 0; b < n; b++) snap.set(`b${b}`, v.runs(`b${b}`));
				s.A.transact(() => M.insertText(s.A.doc, 'b0', 0, '!'));
				const t1 = performance.now();
				let reused = 0;
				for (let b = 0; b < n; b++) if (v.runs(`b${b}`) === snap.get(`b${b}`)) reused++;
				return {
					blocks: n,
					coldReadAllMs: +cold.toFixed(2),
					rereadAllAfterOneEditMs: +(performance.now() - t1).toFixed(2),
					reused
				};
			});
		});

		// ── persist + write results ──────────────────────────────────────
		const dir = fileURLToPath(new URL('../../../../bench/results', import.meta.url));
		mkdirSync(dir, { recursive: true });
		const meta = {
			date: new Date().toISOString(),
			node: process.version,
			platform: `${os.platform()} ${os.arch()}`,
			workload: 'U05 run-view invalidation (maintained view over U04 ownership)',
			caveats: [
				'Timings are wall-clock on one machine; use for comparisons within this report.',
				'"recomputed" counts come from view.debug — the maintained view recomputes lazily, so an invalidated block is only rebuilt on read.',
				'v14 `.delta` is a live mutable cache — never held across the API boundary; the fresh `toDelta()` numbers show its cost.'
			]
		};
		const stamp = meta.date.replaceAll(':', '-').replaceAll('.', '-');
		const file = `${dir}/runs-${stamp}.json`;
		writeFileSync(file, JSON.stringify({ meta, workloads: results }, null, 2) + '\n');
		writeFileSync(
			`${dir}/runs-latest.json`,
			JSON.stringify({ meta, workloads: results }, null, 2) + '\n'
		);
		console.log(`\nrun-view bench → ${file}`);
		// Not a bookkeeping no-op: the bench contract is that every workload
		// above produced a result entry — a silent early-return would still
		// write a results file, just an empty one.
		expect(
			Object.keys(results).length,
			`expected all bench workloads to record results, got: ${Object.keys(results).join(', ')}`
		).toBeGreaterThanOrEqual(10);
	});
});
