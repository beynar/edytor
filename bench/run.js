#!/usr/bin/env node
/**
 * CRDT engine bench harness — U02 §10 deliverable. Dev-only; not shipped.
 *
 *   node bench/run.js
 *
 * Compares npm `yjs@13.6.30` against the vendored, unmodified v14 source
 * (`src/lib/crdt/vendor/yjs/src/index.js`, upstream commit
 * 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64 / @y/y@14.0.0-rc.26).
 *
 * Writes `bench/results/<iso-timestamp>.json` and refreshes
 * `bench/results/latest.json`. Every workload records warmup + sample counts
 * and p50/p95 where the metric is a latency distribution.
 *
 * IMPORTANT — the v13 copy-move numbers are NOT a correctness-equivalent
 * comparison: copy-move re-encodes the payload and silently drops concurrent
 * edits to it. v14 placement-attribute movement is the only semantically
 * honest move here; the v13 number exists to quantify its cost, not to imply
 * equivalence (plan §10 acceptance rules).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import { typing, move, load, delta, textOwnership } from './lib/workloads.js';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

const cpuBrand = () => {
	try {
		return execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
	} catch {
		return os.cpus()[0]?.model ?? 'unknown';
	}
};

const meta = {
	date: new Date().toISOString(),
	node: process.version,
	platform: `${os.platform()} ${os.arch()}`,
	cpu: cpuBrand(),
	engines: {
		v14: 'vendored unmodified @y/y@14.0.0-rc.26 (upstream 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64)',
		v13: 'npm yjs@13.6.30'
	},
	caveats: [
		'v13 copy-move re-encodes the moved payload and loses concurrent edits to it — it is not a correctness-equivalent competitor to placement-attribute movement.',
		'Timings are wall-clock on a single machine; use for comparisons within this report, not as hardware-independent budgets.',
		'v14 "placement-attribute move" measures an attribute-only relocation (the primitive the plan §4 movement design targets); the real model adapter lands in U03+.'
	]
};

const t0 = performance.now();
const results = {
	meta,
	workloads: {
		typing: typing(),
		move: move(),
		load: load(),
		delta: delta(),
		textOwnership: textOwnership()
	}
};
results.meta.durationMs = +(performance.now() - t0).toFixed(1);

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = meta.date.replaceAll(':', '-').replaceAll('.', '-');
const file = `${RESULTS_DIR}/${stamp}.json`;
const json = JSON.stringify(results, null, 2) + '\n';
writeFileSync(file, json);
writeFileSync(`${RESULTS_DIR}/latest.json`, json);

console.log(`bench results → ${file}`);
console.log('headline numbers:');
const m = results.workloads.move['100k-payload'];
console.log(
	`  move 100k payload — v13 copy: ${m.v13.updateBytes} bytes · v14 placement: ${m.v14.updateBytes} bytes`
);
const ty = results.workloads.typing;
console.log(
	`  typing — v14 local p50/p95: ${ty.v14.local.p50}/${ty.v14.local.p95}ms, remote ${ty.v14.remote.p50}/${ty.v14.remote.p95}ms · ` +
		`v13 local ${ty.v13.local.p50}/${ty.v13.local.p95}ms, remote ${ty.v13.remote.p50}/${ty.v13.remote.p95}ms`
);
const ld = results.workloads.load;
console.log(
	`  load 1000 blocks — v14 ${ld.loadMs.v14.p50}ms (${ld.updateBytes.v14}B) · v13 ${ld.loadMs.v13.p50}ms (${ld.updateBytes.v13}B)`
);
const dl = results.workloads.delta;
console.log(`  delta 128 runs — v14 p50 ${dl.v14.p50}ms · v13 p50 ${dl.v13.p50}ms`);
const tx = results.workloads.textOwnership;
console.log(
	`  split 100k payload — v14 ownership records: ${tx['split-100k'].v14model.updateBytes}B · v13 copy: ${tx['split-100k'].v13copy.updateBytes}B`
);
console.log(
	`  merge 100k payload — v14 claim item: ${tx['merge-100k'].v14model.updateBytes}B · v13 copy: ${tx['merge-100k'].v13copy.updateBytes}B`
);
console.log(
	`  split scaling (v14 bytes per payload size): ${tx['split-scaling'].map((r) => `${r.payloadChars}→${r.v14model}B`).join(', ')}`
);
