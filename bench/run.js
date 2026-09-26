#!/usr/bin/env node
/**
 * CRDT engine bench harness — U02 §10 deliverable + WU5 corrected baseline.
 * Dev-only; not shipped.
 *
 *   node --expose-gc bench/run.js        # `pnpm bench:crdt`
 *
 * Compares npm `yjs@13.6.30` against the vendored v14 source
 * (`src/lib/crdt/vendor/yjs/src/index.js`, upstream commit
 * 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64 / @y/y@14.0.0-rc.26 + the
 * recorded P1/P4 local patches in UPSTREAM.md — NOT unmodified) AND records
 * the WU5 corrected facade baseline (`bench/lib/baseline.js`): per-stage
 * op costs on independent-equivalent fixtures, bytes-as-bytes, full
 * distributions, retained memory, staging fast-path before/after.
 *
 * Writes `bench/results/<iso-timestamp>.json` and refreshes
 * `bench/results/latest.json`.
 *
 * IMPORTANT — the v13 copy-move numbers are NOT a correctness-equivalent
 * comparison: copy-move re-encodes the payload and silently drops concurrent
 * edits to it. v14 placement-attribute movement is the only semantically
 * honest move here; the v13 number exists to quantify its cost, not to imply
 * equivalence (plan §10 acceptance rules).
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import * as os from 'node:os';
import { typing, move, load, delta, textOwnership } from './lib/workloads.js';
import { baseline } from './lib/baseline.js';
import { hashTree, hashFile } from './lib/source-id.js';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const cpuBrand = () => {
	try {
		return execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
	} catch {
		return os.cpus()[0]?.model ?? 'unknown';
	}
};

const git = (cmd) => {
	try {
		return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
};

/**
 * Hash of `git status --porcelain` — a dirty-state fingerprint. NOTE (R7):
 * this hashes the status FILENAMES, not file contents — it only says "the
 * tree was dirty in this pattern". Source identity comes from
 * `meta.sources.*` content hashes, not this field.
 */
const dirtyHash = () => {
	const status = git('status --porcelain=v1');
	if (status === null) return null;
	return {
		dirty: status.length > 0,
		statusSha256: createHash('sha256').update(status).digest('hex').slice(0, 16)
	};
};

const pnpmVersion = () => {
	try {
		return execSync('pnpm --version', { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
};

/**
 * Actual packed Svelte-consumer bundle sizes — the real consumer build's
 * emitted assets, distinct from the entry-level rolldown estimates in
 * bench/bundle.js. Rebuilds `tests/packed-consumer/svelte-app` through the
 * consumer's own vite when its node_modules are installed; otherwise
 * reports `skipped` (never silently measures a stale build).
 */
const packedConsumerSizes = () => {
	const appDir = `${ROOT}tests/packed-consumer/svelte-app`;
	const consumerModules = `${ROOT}tests/packed-consumer/node_modules`;
	if (!existsSync(`${consumerModules}/vite/package.json`)) {
		return {
			skipped: 'consumer node_modules missing — install via tests/packed-consumer/run.sh'
		};
	}
	try {
		execSync(`${process.execPath} ../node_modules/vite/bin/vite.js build --logLevel warn`, {
			cwd: appDir,
			encoding: 'utf8',
			stdio: 'pipe'
		});
	} catch (error) {
		return { skipped: `vite build failed: ${String(error).split('\n')[0]}` };
	}
	const sizes = (code) => ({
		min: code.length,
		gzip: gzipSync(code, { level: 9 }).length,
		brotli: brotliCompressSync(code, {
			params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
		}).length
	});
	const assets = {};
	for (const file of readdirSync(`${appDir}/dist/assets`)) {
		if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
		assets[file] = sizes(readFileSync(`${appDir}/dist/assets/${file}`));
	}
	const indexHtml = readFileSync(`${appDir}/dist/index.html`, 'utf8');
	return {
		built: true,
		entry: 'tests/packed-consumer/svelte-app (vite build, packed edytor.tgz)',
		assets,
		indexHtmlBytes: indexHtml.length,
		note: 'ACTUAL packed-consumer emitted sizes — distinct from the entry-level rolldown estimates in bundle-latest.json. Includes the full edytor component surface the consumer pulls (App.svelte mounts Edytor + richTextPlugin + readonly).'
	};
};

const meta = {
	date: new Date().toISOString(),
	node: process.version,
	pnpm: pnpmVersion(),
	platform: `${os.platform()} ${os.arch()} ${os.release()}`,
	cpu: cpuBrand(),
	cpuCores: os.cpus().length,
	memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
	git: {
		revision: git('rev-parse HEAD'),
		branch: git('rev-parse --abbrev-ref HEAD'),
		...dirtyHash()
	},
	build: 'working-tree sources (facade via jiti-resolved .ts; vendored engine .js)',
	sources: {
		// R7 correction: file-CONTENT hashes, not status filenames.
		srcLibContents: hashTree(`${ROOT}src/lib`),
		vendorYjsSrcContents: hashTree(`${ROOT}src/lib/crdt/vendor/yjs/src`),
		packedTarball: hashFile(`${ROOT}tests/packed-consumer/edytor.tgz`)
	},
	exposeGc: typeof globalThis.gc === 'function',
	fixtures: {
		generator:
			'bench/lib/baseline.js — deterministic E.init specs; every sample builds a fresh doc (independent but equivalent)',
		seeds: { fragmentedChurn: 1234, fixtureIds: 'deterministic (b{i}, d{d}, leaf, dense, inl)' },
		warmup: 'per-lane throwaway fixtures (JIT warm, data-cold samples)'
	},
	engines: {
		v14: 'vendored @y/y@14.0.0-rc.26 (upstream 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64) + recorded local patches — P1 lib0-v14 specifier rewrite, P4 format-aware search-marker checkpoints (WU9); NOT unmodified upstream — see src/lib/crdt/vendor/yjs/UPSTREAM.md',
		v13: 'npm yjs@13.6.30'
	},
	caveats: [
		'v13 copy-move re-encodes the moved payload and loses concurrent edits to it — it is not a correctness-equivalent competitor to placement-attribute movement.',
		'Timings are wall-clock on a single machine; use for comparisons within this report, not as hardware-independent budgets.',
		'baseline.* fields: facade-level measurements on working-tree sources — writeMs (in-transaction model+integrate), commitMs (encode+event dispatch), collectMs/ownMs/placeMs (ownView stages), runsMs (maintained-runs reconcile).',
		'U11 historical numbers were revised — see docs/crdt-v14-benchmarks.md corrections section.'
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
	},
	baseline: await baseline(),
	packedConsumer: packedConsumerSizes()
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
// ── corrected baseline headlines ──
const k1 = results.baseline.keystroke['blocks-1000'];
console.log(
	`  keystroke 1k blocks — facade p50 ${k1.facadeMs.p50}ms (write ${k1.writeMs.p50} + commit ${k1.commitMs.p50}); ` +
		`view re-collect ${k1.collectMs.p50}+${k1.ownMs.p50}+${k1.placeMs.p50}ms; runs ${k1.runsMs.p50}ms; ${k1.updateBytes.p50}B`
);
const st = results.baseline.staging;
console.log(
	`  staging — applyUpdateStaged p50 ${st['applyUpdateStaged-1k'].p50}ms vs manual-scratch ${st['manual-scratch-merge-1k'].p50}ms/update`
);
const sv = results.baseline.seamVsCaret;
console.log(
	`  seam vs caret — seam ${sv.seam.updateBytes.p50}B/${sv.seam.facadeMs.p50}ms · caret ${sv.caret.updateBytes.p50}B/${sv.caret.facadeMs.p50}ms`
);
const pc = results.packedConsumer;
if (pc.built) {
	const main = Object.entries(pc.assets).find(([f]) => f.startsWith('index-'));
	if (main)
		console.log(
			`  packed consumer — ${main[0]}: ${main[1].min}B min / ${main[1].gzip}B gzip / ${main[1].brotli}B brotli`
		);
} else {
	console.log(`  packed consumer — SKIPPED: ${pc.skipped}`);
}
