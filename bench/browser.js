#!/usr/bin/env node
/**
 * Browser-keystroke lane — U0 instrumented baseline on the REAL packed
 * consumer install (vite build of `bench/browser-app`, which resolves
 * `edytor` from `tests/packed-consumer/node_modules` — the repacked tarball).
 *
 *   node bench/browser.js [--scales=small,1k,5k]
 *                         [--lanes=small,1k,5k,1k-churned,shared-100k-50blocks,diag-1k,diag-5k]
 *
 * `--scales` is kept for back-compat (it selects flat timing lanes only);
 * `--lanes` selects any lane by name. Default: every lane.
 *
 * U0 instrumentation repair (supersedes the R7 stage model):
 *  - EVERY engine transaction is its own record (`rec.txs[]`, produced by
 *    `bench/lib/browser-hooks.js` — an in-page `doc.emit`/`doc.transact`
 *    instance wrap): identity, origin category (`view-command` /
 *    `document-command` / `attribution-record` / `undo-manager` /
 *    `remote-apply:*` / `bootstrap` — classified by `transaction.origin`
 *    shape; `Symbol('edytor.attribution')` is matched by description),
 *    `local` flag, per-event begin/end marks, emitted update bytes, and an
 *    explicit parent link.
 *  - Post-U2 there is NO attribution follow-up transaction: a keystroke
 *    commits exactly one engine transaction. `attribution-record` now only
 *    matches the actor-dictionary publishes (`u/`/`c/` writes at attach /
 *    `setProfile`), so the `attribution*` stage fields report `null` for
 *    content ops — they are kept (null-safe) so pre-U2 artifacts remain
 *    comparable.
 *  - The old `writeMs` MIXED both transactions a keystroke used to commit
 *    (pre-U2: content tx + attribution follow-up born inside its
 *    `beforeObserverCalls` emit). It is replaced by per-transaction spans
 *    (`contentBodyMs`/`contentCommitMs` vs `attributionBodyMs`/
 *    `attributionCommitMs`) plus event-level spans. Span containment:
 *
 *      keydown ─dispatchMs→ beforeinput ─inputMs→ tx1.begin
 *        tx1 [contentCommitMs]: bodyMs (the f(tr) write) → boc emit →
 *          observersMs → afterTxMs → gcMergeMs → update emit
 *          [publishMs ⊃ mirrorMs] → tx1.end
 *      ─handlerDone/dom→ flushMs ─dom→ dispatchTailMs ─raf→ rafMs
 *
 *  - Missing endpoints stay `null` — never clamped, never invented.
 *  - rAF marks frame-callback scheduling only — never paint.
 *  - diag lanes (`diag-*`) run on SEPARATE pages: `DIAG_INIT` prototype
 *    wraps (DOM scans / selection reads / geometry reads / MO+timer
 *    executions / per-listener time) + `DIAG_WRAP_WRAPPERS` per-instance
 *    wrapper wraps + CDP `Profiler` sampling (`bench/lib/cpuprofile.js`).
 *    Diag counters NEVER mix into the timing-lane medians.
 *  - Mount decomposition per lane: navigation → DCL → module eval →
 *    `mount()` call (Edytor ctor = document create + facade bind + plugins
 *    + sync render) → first editor DOM → all seeded blocks → bench handle.
 *    `createDocument`/`encode`/`loadDocument` are also measured HEADLESS on
 *    the same page (`headlessDoc`) since in-app creation is not separable
 *    from view construction without product changes. Heap: coarse
 *    `performance.memory` (labeled) + a post-`window.gc()` retained
 *    reading (`--js-flags=--expose-gc`).
 *
 * Fixture control via URL params on the bench app:
 *   ?fixture=flat&blocks=N&chars=C&marks=0|1   — N flat paragraphs
 *   ?fixture=shared&chars=C                    — one C-char formatted
 *     paragraph the driver splitBlocks into siblings (shared backing text)
 *   (&diag=1 marks diagnostic pages in the URL; the actual instrumentation
 *    is the driver-added init script, not the param)
 */
import {
	writeFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	lstatSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import * as os from 'node:os';
import { statsOf } from './lib/stats.js';
import { hashTree, hashFile } from './lib/source-id.js';
import {
	MOUNT_INIT,
	DIAG_INIT,
	INSTALL_HOOKS,
	VERIFY_RENDERED,
	HEADLESS_DOC_RUN,
	DIAG_WRAP_WRAPPERS,
	SEED_REMOTE_PEER
} from './lib/browser-hooks.js';
import { startCpuProfile, stopCpuProfile, summarizeProfile } from './lib/cpuprofile.js';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_DIR = `${ROOT}bench/browser-app`;
const CONSUMER_MODULES = `${ROOT}tests/packed-consumer/node_modules`;
const TGZ = `${ROOT}tests/packed-consumer/edytor.tgz`;
const TRACE_DIR = `${ROOT}.artifacts/u0-traces`;

const lanesArg =
	process.argv.find((a) => a.startsWith('--lanes=')) ??
	process.argv.find((a) => a.startsWith('--scales='));
const LANES = (
	lanesArg?.slice(lanesArg.indexOf('=') + 1).split(',') ?? [
		'small',
		'1k',
		'5k',
		'1k-churned',
		'shared-100k-50blocks',
		'diag-1k',
		'diag-5k'
	]
).map((s) => s.trim());

const SCALE_PARAMS = {
	small: { blocks: 6, chars: 60, marks: 0 },
	'1k': { blocks: 1000, chars: 60, marks: 0 },
	'5k': { blocks: 5000, chars: 60, marks: 0 }
};

/**
 * U8a — full-value consumer lanes: same flat fixture with a real export
 * consumer attached per commit (`?consumer=onchange|derived`). These
 * isolate the `edytor.value` + serialization cost a persistence layer or
 * reactive binding would add to every keystroke — the timing lanes carry
 * no consumer, so the delta vs the matching `1k`/`5k` lane is the
 * consumer's attributable cost.
 */
const CONSUMER_PARAMS = {
	'consumer-onchange-1k': { ...SCALE_PARAMS['1k'], consumer: 'onchange' },
	'consumer-derived-1k': { ...SCALE_PARAMS['1k'], consumer: 'derived' },
	'consumer-onchange-5k': { ...SCALE_PARAMS['5k'], consumer: 'onchange' },
	'consumer-derived-5k': { ...SCALE_PARAMS['5k'], consumer: 'derived' }
};

/**
 * U8a — diagnostic remote-presence lanes: a DIAG page plus ONE synthetic
 * remote peer presence entry (SEED_REMOTE_PEER) so every keystroke
 * re-runs the remote-geometry path. Compare `diag-peer-1k` geom/awareness
 * counters against `diag-1k` to isolate remote-selection cost.
 */
const DIAG_PEER_PARAMS = {
	'diag-peer-1k': { ...SCALE_PARAMS['1k'], peer: true }
};

const KS_SAMPLES = 24;
const OP_SAMPLES = 15;
const OP_TIMEOUT_MS = 6000;
const DIAG_KS_SAMPLES = 30; // sustained keystrokes under the profiler

/** statsOf throws on empty arrays — wrap so empty lanes report honestly. */
const statz = (arr, opts) =>
	arr.length ? statsOf(arr, opts) : { samples: 0, unit: opts?.unit ?? 'ms', note: 'no samples' };

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

const out = {
	meta: {
		date: new Date().toISOString(),
		node: process.version,
		platform: `${os.platform()} ${os.arch()} ${os.release()}`,
		cpu: cpuBrand(),
		cpuCores: os.cpus().length,
		memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
		git: {
			revision: git('rev-parse HEAD'),
			branch: git('rev-parse --abbrev-ref HEAD'),
			dirty: (git('status --porcelain=v1') ?? '').length > 0
		},
		sources: {
			srcLibContents: hashTree(`${ROOT}src/lib`),
			vendorYjsSrcContents: hashTree(`${ROOT}src/lib/crdt/vendor/yjs/src`),
			packedTarball: hashFile(TGZ),
			benchDriver: hashFile(`${ROOT}bench/browser.js`),
			benchHooks: hashFile(`${ROOT}bench/lib/browser-hooks.js`),
			benchAppFiles: hashTree(APP_DIR),
			benchApp:
				'bench/browser-app — edytor resolved from tests/packed-consumer/node_modules (the tarball above)'
		},
		variant: {
			id: 'C',
			scheme:
				'A = retired per-edit text-level attribution (pre-U2 artifacts); B = compact block attribution — the post-U2 model; C = block + editor fixes (adversarial-review-2026-09-23: readiness/onReady, attribution incarnation records, selection ownership + stale-write guards). Variant is an artifact-level dimension — lanes keep their names.'
		},
		engine:
			'vendored @y/y@14.0.0-rc.26 (upstream 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64) + recorded local patches — P1 lib0-v14 specifier rewrite, P4 format-aware search-marker checkpoints; NOT unmodified upstream (see src/lib/crdt/vendor/yjs/UPSTREAM.md)',
		runtime:
			'chromium via playwright (version recorded below); launch args --js-flags=--expose-gc (post-GC heap reads) + --enable-precise-memory-info (unrounded performance.memory — NOT comparable to bucketed-heap numbers from earlier artifacts)',
		instrumentation:
			'bench/lib/browser-hooks.js — consumer-side only, product untouched: doc.emit/doc.transact instance wraps (per-transaction records), document event listeners, MutationObserver, facade.onChange, method-call counters; diag-* lanes additionally run DIAG_INIT prototype wraps + DIAG_WRAP_WRAPPERS + CDP Profiler sampling.',
		note: 'ms = wall-clock milliseconds in-page (performance.now, shared per record); bytes = byteLength of emitted updates / bundle files; counts = deterministic work counters. Spans are inclusive where nested — containment documented per stage field.'
	},
	lanes: {}
};

if (!existsSync(`${CONSUMER_MODULES}/vite/package.json`)) {
	out.skipped = 'consumer node_modules missing — run tests/packed-consumer/run.sh first';
	console.log(`SKIP: ${out.skipped}`);
	writeResult(out);
	process.exit(0);
}
if (!existsSync(TGZ)) {
	out.skipped = 'edytor.tgz missing — repack via tests/packed-consumer/run.sh first';
	console.log(`SKIP: ${out.skipped}`);
	writeResult(out);
	process.exit(0);
}

// Provenance gate (review 2026-09-23, P2-8): a packed tarball older than
// the newest `src/lib` source cannot contain the code this artifact's
// `srcLibContents` hash describes — measuring it would silently report
// an OLDER build as current. Refuse unless --allow-stale (the staleness
// is still recorded in meta.sources.packedVsSrc either way).
const newestMtime = (dir) => {
	let max = 0;
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = `${d}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(p);
			} else {
				const m = lstatSync(p).mtimeMs;
				if (m > max) max = m;
			}
		}
	};
	walk(dir);
	return max;
};
const tgzMtime = lstatSync(TGZ).mtimeMs;
const newestSrcMtime = newestMtime(`${ROOT}src/lib`);
// Content check (stronger than mtime): run.sh stamps the src/lib hash it
// packed into edytor.src-sha256. A sidecar that differs from the CURRENT
// src/lib hash means the tarball was built from different source even if
// its mtime is newer (e.g. packed, then src edited, then re-packed from a
// stale dist). Missing sidecar ⇒ fall back to the mtime gate only.
const SRC_SHA_FILE = `${ROOT}tests/packed-consumer/edytor.src-sha256`;
const stampedSrcSha = existsSync(SRC_SHA_FILE) ? readFileSync(SRC_SHA_FILE, 'utf8').trim() : null;
const currentSrcSha = out.meta.sources.srcLibContents.sha256;
const contentMismatch = stampedSrcSha !== null && stampedSrcSha !== currentSrcSha;
const packedStale = tgzMtime < newestSrcMtime || contentMismatch;
out.meta.sources.packedVsSrc = {
	tgzMtimeIso: new Date(tgzMtime).toISOString(),
	newestSrcLibMtimeIso: new Date(newestSrcMtime).toISOString(),
	stampedSrcLibSha256: stampedSrcSha,
	currentSrcLibSha256: currentSrcSha,
	contentMismatch,
	stale: packedStale
};
if (packedStale && !process.argv.includes('--allow-stale')) {
	out.skipped =
		'edytor.tgz predates src/lib sources (mtime or stamped content hash) — the packed build cannot contain current code. ' +
		'Repack via tests/packed-consumer/run.sh first (or pass --allow-stale to record a known-stale measurement).';
	console.log(`SKIP: ${out.skipped}`);
	writeResult(out);
	process.exit(1);
}

// The bench app resolves `edytor`/`svelte`/vite-plugin-svelte through a
// node_modules symlink into the packed consumer install.
const linkPath = `${APP_DIR}/node_modules`;
let linkOk = false;
try {
	const st = lstatSync(linkPath);
	// symlink or real dir — either is fine as long as vite resolves through it
	linkOk = existsSync(`${linkPath}/vite/package.json`);
	if (!linkOk && !st.isSymbolicLink()) {
		out.skipped = `${linkPath} exists but is not the consumer install`;
		console.log(`SKIP: ${out.skipped}`);
		writeResult(out);
		process.exit(0);
	}
} catch {
	/* linkPath absent — created below */
}
if (!linkOk) {
	try {
		symlinkSync('../../tests/packed-consumer/node_modules', linkPath, 'dir');
	} catch {
		/* already exists */
	}
}

// ── build the bench app through the consumer's own vite ───────────────────
console.log('==> bench browser-app: vite build');
execSync(`${process.execPath} ${CONSUMER_MODULES}/vite/bin/vite.js build --logLevel warn`, {
	cwd: APP_DIR,
	stdio: 'inherit'
});
const sizeOf = (code) => ({
	min: code.length,
	gzip: gzipSync(code, { level: 9 }).length,
	brotli: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
});
const assets = {};
for (const file of readdirSync(`${APP_DIR}/dist/assets`)) {
	if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
	assets[file] = sizeOf(readFileSync(`${APP_DIR}/dist/assets/${file}`));
}
out.bundle = {
	built: true,
	entry: 'bench/browser-app (vite build; edytor = packed tarball via consumer node_modules)',
	assets,
	note: 'ACTUAL emitted bundle of the packed edytor surface the bench app pulls (Edytor + richTextPlugin + crdt/edytor bindings).'
};
console.log('    emitted:', Object.keys(assets).join(', '));

// ── playwright availability ───────────────────────────────────────────────
let chromium;
try {
	const req = createRequire(import.meta.url);
	const pw = await import(req.resolve('@playwright/test', { paths: [ROOT] }));
	chromium = pw.chromium ?? pw.default?.chromium;
	const probe = await chromium.launch();
	await probe.close();
} catch (error) {
	out.skipped = `playwright/chromium unavailable: ${String(error).split('\n')[0]}`;
	console.log(`SKIP: ${out.skipped}`);
	writeResult(out);
	process.exit(0);
}

// ── serve + drive ─────────────────────────────────────────────────────────
const req = createRequire(import.meta.url);
const { preview } = await import(req.resolve('vite', { paths: [CONSUMER_MODULES] }));
const server = await preview({
	root: APP_DIR,
	logLevel: 'warn',
	preview: { host: '127.0.0.1', port: 0 }
});
const port = server.httpServer.address()?.port;
const url = `http://127.0.0.1:${port}/`;
// --expose-gc: post-GC retained-heap reads. --enable-precise-memory-info:
// unbucketed performance.memory (recorded in meta.runtime).
const browser = await chromium.launch({
	args: ['--js-flags=--expose-gc', '--enable-precise-memory-info']
});
out.meta.browser = `chromium ${browser.version()}`;

const seg = (a, b) =>
	typeof a === 'number' && typeof b === 'number' && b >= a ? +(b - a).toFixed(4) : null;

/** Entry mark for a record: real input event, else the op's own t0. */
const entryOf = (r) => r.marks?.beforeinput ?? r.marks?.t0 ?? r.marks?.keydown;

/**
 * Collapse one record's marks + per-transaction rows into stage spans
 * (ms; null when an endpoint is absent or ordering inverts).
 *
 * Span nesting (all inside the record's own clock):
 *   contentCommitMs ⊃ {contentBodyMs, contentBocMs, observersMs,
 *     afterTxMs, gcMergeMs, publishMs ⊃ mirrorMs}
 *   commitTailMs ⊃ any trailing transactions' cleanup (post-U2 a content
 *     op commits ONE transaction — `attribution*` fields report null;
 *     pre-U2 they held the attribution follow-up's own pipeline, which was
 *     born inside tx1.beforeObserverCalls).
 *   totalMs ⊃ everything from input entry to the rAF callback.
 */
const stageSpans = (r) => {
	const m = r.marks ?? {};
	const txs = r.txs ?? [];
	const tx1 = txs[0]; // first transaction seen while the record was active
	const attrTx = txs.find((t) => t.originCat === 'attribution-record') ?? null;
	const tm = (t) => t?.marks ?? {};
	const bodyMs = (t) => t?.bodyMs ?? seg(tm(t).btE, tm(t).bocS);
	const commitEnd = m.commitDone ?? m.published ?? tx1?.end;
	return {
		// keydown → beforeinput: browser input dispatch (trusted keystrokes only)
		dispatchMs: seg(m.keydown, m.beforeinput),
		// beforeinput/t0 → first transaction opens: input handling + selection
		// derivation + op mapping before the engine commit
		inputMs: seg(entryOf(r), tx1?.begin ?? m.tx),
		// CONTENT transaction body — the f(tr) the view/facade ran
		// (preCleanup btE→bocS bound when the body never passed doc.transact)
		contentBodyMs: bodyMs(tx1),
		// content tx begin → its own pipeline end (update/atc/at emit end).
		// Pre-U2 this CONTAINS the attribution follow-up's begin+body.
		contentCommitMs: seg(tx1?.begin, tx1?.end),
		// content tx beforeObserverCalls emit — pre-U2 the attribution
		// follow-up was born INSIDE this span (tx.parent = {event:
		// 'beforeObserverCalls'}); post-U2 nothing nests here.
		contentBocMs: seg(tm(tx1).bocS, tm(tx1).bocE),
		// ATTRIBUTION transaction — post-U2 only the u//c/ dictionary
		// publishes carry this origin; null for content ops.
		attributionBodyMs: bodyMs(attrTx),
		attributionCommitMs: seg(attrTx?.begin, attrTx?.end),
		attributionUpdateBytes: attrTx?.updateBytes ?? null,
		// type observers + deep/delta maintenance on tx1 (boc end → at start)
		observersMs: seg(tm(tx1).bocE, tm(tx1).atS),
		// afterTransaction emit on tx1
		afterTxMs: seg(tm(tx1).atS, tm(tx1).atE),
		// GC + struct merge on tx1 (at end → atc start)
		gcMergeMs: seg(tm(tx1).atE, tm(tx1).atcS),
		// tx1 update emit → facade.onChange last subscriber: update encode +
		// DocChange diff + editor change handler + our marker — the
		// "observer/publication" stage.
		publishMs: seg(tm(tx1).updS, m.published),
		// mirror reconciliation — editor flushMirror inside publishMs
		mirrorMs: seg(m.mirrorS, m.mirrorE),
		// publish → afterAllTransactions: any trailing transactions'
		// cleanup pipeline lives here (pre-U2: the attribution tx's
		// observers/GC/update emit; post-U2: none for content ops).
		commitTailMs: seg(m.published, m.commitDone),
		// whole engine commit pipeline: first tx open → afterAllTransactions
		commitSpanMs: seg(tx1?.begin ?? m.tx, m.commitDone),
		// commit done → first observed DOM mutation (Svelte render+DOM write+MO)
		flushMs: seg(commitEnd ?? entryOf(r), m.dom),
		// first DOM mutation → beforeinput dispatch completion (post-flush
		// residual — microtask checkpoints can flush DOM before dispatch ends)
		dispatchTailMs: seg(m.dom, m.handlerDone),
		// DOM mutation → rAF FRAME timestamp (vsync-aligned; inverts to null
		// when the frame was already in flight at mutation time)
		rafMs: seg(m.dom, m.raf),
		// DOM mutation → rAF callback actually ran — scheduling, NOT paint
		rafCbMs: seg(m.dom, m.rafCb),
		// entry → rAF callback ran — the honest total
		totalMs: seg(entryOf(r), m.rafCb ?? m.raf),
		// entry → DOM mutation observed (input pipeline + flush, no frame wait)
		toDomMs: seg(entryOf(r), m.dom)
	};
};

const STAGE_FIELDS = [
	'dispatchMs',
	'inputMs',
	'contentBodyMs',
	'contentCommitMs',
	'contentBocMs',
	'attributionBodyMs',
	'attributionCommitMs',
	'attributionUpdateBytes',
	'observersMs',
	'afterTxMs',
	'gcMergeMs',
	'publishMs',
	'mirrorMs',
	'commitTailMs',
	'commitSpanMs',
	'flushMs',
	'dispatchTailMs',
	'rafMs',
	'rafCbMs',
	'toDomMs',
	'totalMs'
];

/** Per-origin transaction aggregate across a lane's records. */
const aggregateTxs = (records) => {
	const byOrigin = {};
	const perRecord = [];
	for (const r of records) {
		const txs = r.txs ?? [];
		perRecord.push(r.txCount ?? txs.length);
		for (const t of txs) {
			const g = (byOrigin[t.originCat] ??= {
				count: 0,
				bodyMs: [],
				commitSpanMs: [],
				updateBytes: [],
				parents: {}
			});
			g.count++;
			const body = t.bodyMs ?? seg(t.marks?.btE, t.marks?.bocS);
			if (body !== null) g.bodyMs.push(body);
			const cs = seg(t.begin, t.end);
			if (cs !== null) g.commitSpanMs.push(cs);
			if (typeof t.updateBytes === 'number') g.updateBytes.push(t.updateBytes);
			const p = t.parent ? `${t.parent.event}` : 'root';
			g.parents[p] = (g.parents[p] ?? 0) + 1;
		}
	}
	const by = {};
	for (const [k, g] of Object.entries(byOrigin)) {
		by[k] = {
			transactions: g.count,
			bodyMs: statz(g.bodyMs, { unit: 'ms' }),
			commitSpanMs: statz(g.commitSpanMs, { unit: 'ms' }),
			updateBytes: statz(g.updateBytes, { unit: 'bytes' }),
			parentEventHistogram: g.parents
		};
	}
	return { perRecord: statz(perRecord, { unit: 'count' }), byOrigin: by };
};

/** Method-call counters (wrapCall) aggregated across a lane's records. */
const aggregateWork = (records) => {
	const names = new Set();
	for (const r of records) for (const k of Object.keys(r.counters ?? {})) names.add(k);
	const work = {};
	for (const n of [...names].sort()) {
		const calls = [];
		const ms = [];
		for (const r of records) {
			const c = r.counters?.[n];
			calls.push(c?.n ?? 0);
			ms.push(+(c?.ms ?? 0).toFixed(4));
		}
		work[n] = { calls: statz(calls, { unit: 'count' }), ms: statz(ms, { unit: 'ms' }) };
	}
	return work;
};

/** DIAG_INIT buckets (diag lanes only) flattened to `bucket.name` stats. */
const aggregateDiag = (records) => {
	const flat = {};
	for (const r of records)
		for (const [bucket, names] of Object.entries(r.diag ?? {}))
			for (const [name, e] of Object.entries(names)) {
				const k = `${bucket}.${name}`;
				const f = (flat[k] ??= { calls: [], ms: [] });
				f.calls.push(e.n);
				f.ms.push(+e.ms.toFixed(4));
			}
	const out = {};
	for (const [k, v] of Object.entries(flat).sort())
		out[k] = { calls: statz(v.calls, { unit: 'count' }), ms: statz(v.ms, { unit: 'ms' }) };
	return out;
};

/** Aggregate a lane's records: per-stage stats + txs + bytes + counters. */
const aggregateLane = (records) => {
	const spans = records.map(stageSpans);
	const lane = {
		samples: records.length,
		timedOut: records.filter((r) => r.timedOut !== null).length,
		timeoutDetail: records.filter((r) => r.timedOut !== null).map((r) => r.timedOut),
		txCountDist: statz(
			records.map((r) => r.txCount ?? r.txs?.length ?? 0),
			{ unit: 'count' }
		),
		updateBytes: statz(
			records.map((r) => r.updateBytes ?? 0),
			{ unit: 'bytes' }
		),
		emittedUpdates: statz(
			records.map((r) => r.emittedUpdates ?? 0),
			{ unit: 'count' }
		),
		changeEmits: statz(
			records.map((r) => r.changeEmits ?? 0),
			{ unit: 'count' }
		),
		inputTypes: [...new Set(records.map((r) => r.inputType).filter(Boolean))],
		noTransaction: records.filter((r) => (r.txCount ?? r.txs?.length ?? 0) === 0).length,
		transactions: aggregateTxs(records),
		stages: {},
		// Per-sample spans + raw marks (relative to the record's own entry)
		// + per-transaction rows — the honest audit trail behind every median.
		records: records.map((r, i) => {
			const entry = entryOf(r);
			const rel = (v) =>
				typeof v === 'number' && entry !== undefined ? +(v - entry).toFixed(3) : null;
			const relMarks = {};
			for (const [k, v] of Object.entries(r.marks ?? {}))
				// domMutations is a record COUNT carried on marks — not a timestamp.
				relMarks[k] = typeof v === 'number' && k !== 'domMutations' ? rel(v) : v;
			return {
				i,
				inputType: r.inputType,
				txCount: r.txCount ?? r.txs?.length ?? 0,
				updateBytes: r.updateBytes,
				emittedUpdates: r.emittedUpdates,
				changeEmits: r.changeEmits,
				timedOut: r.timedOut,
				marksRelEntryMs: relMarks,
				spans: spans[i],
				txs: (r.txs ?? []).map((t) => {
					const relTx = {};
					for (const [k, v] of Object.entries(t.marks ?? {})) relTx[k] = rel(v);
					return {
						gid: t.gid,
						id: t.id,
						originCat: t.originCat,
						origin: t.originDesc,
						local: t.local,
						parent: t.parent ?? null,
						beginRelEntryMs: rel(t.begin),
						endRelEntryMs: rel(t.end),
						bodyMs: t.bodyMs,
						bodyCalls: t.bodyCalls,
						updateBytes: t.updateBytes,
						updateEmitted: t.updateEmitted,
						insert: t.insert,
						delete: t.delete,
						changedTypes: t.changedTypes,
						missing: t.missing?.length ? t.missing : undefined,
						marksRelEntryMs: relTx
					};
				}),
				counters: r.counters,
				diag: r.diag,
				debug: r.debug
			};
		})
	};
	for (const f of STAGE_FIELDS) {
		const vals = spans.map((s) => s[f]).filter((v) => typeof v === 'number');
		lane.stages[f] = statz(vals, { unit: f === 'attributionUpdateBytes' ? 'bytes' : 'ms' });
	}
	lane.work = aggregateWork(records);
	const diagRecs = records.filter((r) => r.diag);
	if (diagRecs.length) lane.diag = aggregateDiag(diagRecs);
	const counters = records.map((r) => r.debug).filter(Boolean);
	if (counters.length) {
		const c = (k) =>
			statz(
				counters.map((x) => x[k] ?? 0),
				{ unit: 'count' }
			);
		lane.counters = {
			recomputes: c('recomputes'),
			recomputedBlocks: c('recomputedBlocks'),
			itemsWalked: c('itemsWalked'),
			markersWalked: c('markersWalked'),
			readIndexBuilds: c('readIndexBuilds'),
			commitSeq: c('commitSeq'),
			commitContentBlocks: c('commitContentBlocks'),
			commitMetaKeys: c('commitMetaKeys'),
			commitFast: counters.filter((x) => x.commitFast === 1 || x.commitFast === true).length
		};
	}
	return lane;
};

/** Mount decomposition: init-script marks → honest stage spans. */
const decomposeMount = (M) => {
	if (!M) return null;
	return {
		// performance.now() epoch = navigation start; init script is the
		// first page script that can run.
		navToInitMs: M.t0 ?? null,
		// navigation start → DOMContentLoaded end (navigation-timing clock).
		// Observed value is 0 on every lane — Chromium reports
		// domContentLoadedEventEnd as 0 for this page shape; kept raw.
		navToDclMs: M.dcl ?? null,
		// init script → main.js body — module graph fetch+evaluate (incl.
		// the edytor bundle eval)
		initToMainMs: seg(M.t0, M.mainStart),
		// main.js body → BenchApp instance script — the component <script>
		// runs INSIDE mount(); nested in mountCallMs (not a separate stage)
		mainToAppInitMs: seg(M.mainStart, M.appScript),
		// main.js body → mount() return: Edytor ctor (document create-or-load
		// + facade bind + plugins) + view construction + render scheduling —
		// ctor and view are NOT separable consumer-side; headlessDoc carries
		// the document path measured without a view.
		mountCallMs: seg(M.mainStart, M.mountReturn),
		// mount() return → first observed editor DOM (null when the DOM was
		// already present at mountReturn — see blocksAtMountReturn)
		mountToFirstEdytorMs: seg(M.mountReturn, M.firstEdytor),
		mountToFirstBlockMs: seg(M.mountReturn, M.firstBlock),
		// mount() return → all seeded blocks observed — the deferred flush
		mountToAllBlocksMs: seg(M.mountReturn, M.allBlocksSeen),
		// init script → all blocks — closest thing to "interactive enough to
		// observe the full document"
		initToAllBlocksMs: seg(M.t0, M.allBlocksSeen),
		initToBenchHandleMs: seg(M.t0, M.benchHandle),
		blocksAtMountReturn: M.blocksAtMountReturn ?? null,
		domAtMountReturn: M.domAtMountReturn ?? null,
		moBatches: M.moBatches ?? []
	};
};

/** Collect mount marks + render verification + heap readings. */
const collectMount = async (page, verifyArgs) => {
	const marks = await page.evaluate(() => {
		const M = window.__BENCH_MOUNT__ ?? null;
		M?.stop?.();
		return M;
	});
	const verified = await page.evaluate(VERIFY_RENDERED, verifyArgs);
	const heapBytes = await page.evaluate(() =>
		performance.memory ? performance.memory.usedJSHeapSize : null
	);
	// Post-GC retained heap — window.gc needs --js-flags=--expose-gc.
	const heapBytesPostGC = await page.evaluate(async () => {
		if (typeof window.gc !== 'function') return null;
		window.gc();
		await new Promise((r) => setTimeout(r, 0));
		window.gc();
		await new Promise((r) => setTimeout(r, 60));
		return performance.memory ? performance.memory.usedJSHeapSize : null;
	});
	return {
		marks,
		stages: decomposeMount(marks),
		verified,
		heapBytes,
		heapBytesPostGC,
		heapNote:
			'heapBytes = performance.memory.usedJSHeapSize (Chromium-only, unrounded via --enable-precise-memory-info, still includes uncollected garbage). heapBytesPostGC = same counter after 2× window.gc() + settle — a retained-heap approximation, NOT a heap snapshot.'
	};
};

try {
	const install = async (page) => {
		const r = await page.evaluate(INSTALL_HOOKS);
		if (r !== 'installed') console.log(`    !! install hooks: ${r}`);
		return r;
	};

	/**
	 * Trusted keystroke sample. Two evaluates bracket the press:
	 *   1. arm — synchronous record open (evaluate returns after arming, so
	 *      ordering vs the input event is guaranteed — Runtime.evaluate and
	 *      Input.dispatchKeyEvent travel different queues; awaiting an
	 *      already-pending promise later does NOT order against the press).
	 *   2. press → events stamp the open record.
	 *   3. await the stored promise — resolves at the post-mutation rAF
	 *      callback or timeout.
	 */
	const keystroke = async (page, key) => {
		await page.evaluate((t) => {
			window.__BENCH_H__.pending = window.__BENCH_H__.arm(t);
		}, OP_TIMEOUT_MS);
		await page.keyboard.press(key);
		return await page.evaluate(() => window.__BENCH_H__.pending);
	};

	const runOp = (page, name, args) =>
		page.evaluate(
			([n, a, t]) => window.__BENCH_H__.runOp(() => window.__BENCH_OPS__[n](a), t),
			[name, args, OP_TIMEOUT_MS]
		);

	const clickBlockText = async (page, id) => {
		const sel = `[data-edytor-id="${id}"] [data-edytor-text="true"]`;
		await page.locator(sel).first().click({ timeout: 15000 });
	};

	const heapNow = (page) =>
		page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));

	/** Per-record profiler windows on the page perf clock. */
	const recordWindows = (records, label) =>
		records
			.map((r, i) => {
				const e = entryOf(r);
				const end = r.marks?.rafCb ?? r.marks?.raf ?? r.marks?.handlerDone ?? r.marks?.commitDone;
				return typeof e === 'number' && typeof end === 'number' && end >= e
					? { start: e, end, label: `${label}[${i}]` }
					: null;
			})
			.filter(Boolean);

	/**
	 * Profile with the CDP Profiler, bracketed by page-clock reads.
	 * CDP Profiler timestamps are CLOCK_MONOTONIC µs — NOT the
	 * performance.now() epoch: they differ by the navigation-start tick.
	 * `offsetMs` estimates that constant (profileStart_ms − perfNow at
	 * start) so per-record windows can be shifted onto the sample clock;
	 * `offsetBoundMs` = the bracket width (honest error bound).
	 */
	const profiled = async (page, cdp, phase, { align = true } = {}) => {
		// align only meaningful when the profiled phase stays on ONE document
		// (a pre-goto read would be on the old document's timeOrigin).
		const before = align ? await page.evaluate(() => performance.now()) : null;
		await startCpuProfile(cdp);
		const after = align ? await page.evaluate(() => performance.now()) : null;
		const profile = await phase();
		const stopped = await stopCpuProfile(cdp);
		const offsetMs = align ? stopped.startTime / 1000 - (before + after) / 2 : null;
		return {
			profile: stopped,
			clock: {
				pageNowBracketMs:
					align && before !== null && after !== null
						? [+before.toFixed(2), +after.toFixed(2)]
						: null,
				profileStartMs: +(stopped.startTime / 1000).toFixed(3),
				offsetMs: offsetMs === null ? null : +offsetMs.toFixed(3),
				offsetBoundMs:
					align && after !== null && before !== null ? +(after - before).toFixed(3) : null,
				note: align
					? 'CDP Profiler sample ts = CLOCK_MONOTONIC µs; record marks = performance.now ms. windows were shifted by offsetMs (±offsetBoundMs) before bucketing.'
					: 'profile spans a navigation — CLOCK_MONOTONIC origin is not alignable to this document’s performance.now post-hoc; rollup only, no per-window bucketing.'
			}
		};
	};

	/** The full per-scale lane battery on one mounted page. */
	const runScale = async (name, { blocks, chars, marks, consumer }) => {
		const lane = { params: { fixture: 'flat', blocks, chars, marks, consumer } };
		const page = await browser.newPage();
		await page.addInitScript(MOUNT_INIT);
		const t0 = Date.now();
		await page.goto(
			`${url}?fixture=flat&blocks=${blocks}&chars=${chars}&marks=${marks}` +
				(consumer ? `&consumer=${consumer}` : ''),
			{
				waitUntil: 'domcontentloaded'
			}
		);
		await page.waitForSelector('[data-testid="editable-root"] [data-edytor]');
		// Mount-complete = every seeded block rendered, not just the first.
		await page.waitForFunction(
			(n) => document.querySelectorAll('[data-edytor-block="true"]').length >= n,
			blocks,
			{ timeout: 240000 }
		);
		lane.mountWallMs = Date.now() - t0;
		lane.mount = await collectMount(page, { blocks, chars, fixture: 'flat' });
		lane.mount.note =
			'mountWallMs = driver wall clock goto(domcontentloaded)→all blocks. stages = page-clock decomposition: navigation→init→module eval→mount() (ctor=doc create+facade+view) →first DOM→all blocks. verified joins ALL [data-edytor-text] parts per block (mark/attribution boundaries split logical text).';
		lane.headlessDoc = await page.evaluate(HEADLESS_DOC_RUN);
		lane.headlessDocNote =
			'createDocument({seed})→encode()→loadDocument() measured post-mount on this page — the document create-or-load segment of mount decomposed without a view.';
		await install(page);
		lane.wrapMisses = await page.evaluate(() => window.__BENCH_H__?.wrapMisses ?? []);

		const mid = `b${Math.floor(blocks / 2)}`;

		// ── real keystroke: insertText via trusted CDP keypress ──
		await clickBlockText(page, mid);
		await page.waitForTimeout(80); // let selectionchange/focus settle after the synthetic click
		const ks = [];
		for (let i = 0; i < KS_SAMPLES; i++) ks.push(await keystroke(page, 'x'));
		lane.keystroke = aggregateLane(ks);
		lane.keystroke.cold = stageSpans(ks[0] ?? { marks: {} });
		lane.keystroke.coldNote =
			'first keystroke after mount (JIT-cold editor path); warm stats are all samples including it';
		lane.keystroke.note =
			'trusted CDP keypress "x": keydown→beforeinput→content tx + attribution follow-up tx→DOM mutation→rAF callback. Stages share the keystroke t0; nested spans documented per field. rafMs = frame-callback scheduling, NOT paint. writeMs removed — it mixed both transactions.';

		// ── real keystroke: Backspace (deleteContentBackward) ──
		const del = [];
		for (let i = 0; i < KS_SAMPLES; i++) del.push(await keystroke(page, 'Backspace'));
		lane.delete = aggregateLane(del);
		lane.delete.note =
			'trusted Backspace: beforeinput deleteContentBackward → facade deleteText (+ attribution follow-up) → DOM mutation → rAF.';

		// ── real formatting keystroke: range select + mod+b ──
		const fmt = [];
		for (let i = 0; i < 10; i++) {
			await page.keyboard.down('Shift');
			for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowLeft');
			await page.keyboard.up('Shift');
			await page.waitForTimeout(30); // selectionchange settle
			await page.evaluate((t) => {
				window.__BENCH_H__.pending = window.__BENCH_H__.arm(t);
			}, OP_TIMEOUT_MS);
			await page.keyboard.press('Meta+b');
			fmt.push(await page.evaluate(() => window.__BENCH_H__.pending));
			await page.keyboard.press('ArrowRight'); // collapse selection back to caret
		}
		lane.formatHotkey = aggregateLane(fmt);
		lane.formatHotkey.note =
			'trusted Meta+b after a real Shift+ArrowLeft range selection: keydown → hotkey setMarkAndSelect → formatRange → DOM → rAF. No beforeinput — t0 is keydown.';

		// ── facade lanes (same staged timeline, t0 = op call) ──
		const f2d = [];
		for (let i = 0; i < OP_SAMPLES; i++) f2d.push(await runOp(page, 'insertText', [mid, 7, 'q']));
		lane.facadeToDom = aggregateLane(f2d);
		lane.facadeToDom.note =
			'facade.insertText → DOM mutation + rAF — the model→publication→Svelte→DOM segment. Reported alongside keystroke stages, NEVER subtracted (R7).';

		const paste = [];
		for (let i = 0; i < OP_SAMPLES; i++)
			paste.push(await runOp(page, 'insertText', [mid, 10, 'p'.repeat(500)]));
		lane.pasteText = aggregateLane(paste);
		lane.pasteText.note =
			'facade.insertText of a 500-char string in one op — paste-like bulk insert.';

		const fmtFacade = [];
		for (let i = 0; i < OP_SAMPLES; i++)
			fmtFacade.push(
				await runOp(page, 'formatRange', [mid, 5, 25, { bold: i % 2 === 0 ? true : null }])
			);
		lane.formatFacade = aggregateLane(fmtFacade);
		lane.formatFacade.note = 'facade.formatRange 20 chars alternating bold on/off.';

		// ── undo: one facade insert (setup, unmeasured) then undo measured ──
		const undo = [];
		for (let i = 0; i < OP_SAMPLES; i++) {
			await page.evaluate(([id]) => window.__BENCH__.edytor.facade.insertText(id, 5, 'z'), [mid]);
			undo.push(await runOp(page, 'undo', []));
		}
		lane.undo = aggregateLane(undo);
		lane.undo.note =
			'undoManager.undo() after ONE tracked facade insert — the measured span is the undo step only; the setup insert is unmeasured.';

		// ── remote burst: K peer keystroke updates → applyUpdateStaged → DOM ──
		const K = 30;
		const burst = await page.evaluate(
			async ([k, targetId, t]) => {
				const { edytor: ed, Y, E, S } = window.__BENCH__;
				const doc = ed.doc;
				const peer = new Y.Doc({ guid: doc.guid });
				Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
				const peerEd = E.create(peer);
				const updates = [];
				peer.on('update', (u) => updates.push(u));
				for (let i = 0; i < k; i++) peerEd.insertText(targetId, 5 + i, 'z');
				const rec = { perApplyMs: [], bytes: [], staged: 0, applied: 0 };
				const cap = window.__BENCH_H__.beginCapture(t); // per-tx capture
				const done = new Promise((resolve) => {
					const mo = new MutationObserver(() => {
						mo.disconnect();
						rec.dom = performance.now();
						requestAnimationFrame(() => {
							rec.raf = performance.now();
							resolve();
						});
					});
					mo.observe(document.querySelector('[data-testid="editable-root"] [data-edytor]'), {
						subtree: true,
						childList: true,
						characterData: true
					});
					rec.timer = setTimeout(resolve, t);
				});
				rec.t0 = performance.now();
				for (const u of updates) {
					const t1 = performance.now();
					const r = (Y.applyUpdate(doc, u, 'bench'), { staged: false, applied: true });
					rec.perApplyMs.push(performance.now() - t1);
					rec.bytes.push(u.byteLength);
					if (r.staged) rec.staged++;
					if (r.applied) rec.applied++;
				}
				rec.appliedDone = performance.now();
				window.__BENCH_H__.endCapture(cap);
				rec.txs = cap.txs.map((x) => ({
					originCat: x.originCat,
					local: x.local,
					bodyMs: x.bodyMs,
					updateBytes: x.updateBytes,
					spanMs: x.begin !== null && x.end !== null ? x.end - x.begin : null,
					parent: x.parent
				}));
				await done;
				clearTimeout(rec.timer);
				return rec;
			},
			[K, mid, OP_TIMEOUT_MS]
		);
		lane.remoteBurst = {
			K,
			perApplyMs: statz(burst.perApplyMs ?? [], { unit: 'ms' }),
			updateBytes: statz(burst.bytes ?? [], { unit: 'bytes' }),
			stagedTotal: burst.staged,
			appliedTotal: burst.applied,
			burstApplyMs: +(burst.appliedDone - burst.t0).toFixed(4),
			burstToDomMs: burst.dom !== undefined ? +(burst.dom - burst.t0).toFixed(4) : null,
			burstToRafMs: burst.raf !== undefined ? +(burst.raf - burst.t0).toFixed(4) : null,
			txs: burst.txs,
			note: `${K} remote keystroke updates applied sequentially via applyUpdateStaged (the real provider path); per-apply ms + ONE batched Svelte flush observed via MO/rAF. txs = per-transaction rows captured via beginCapture/endCapture.`
		};

		// ── reconnect: peer offline edits → one diff update → DOM ──
		const recon = [];
		for (let i = 0; i < 8; i++) {
			recon.push(
				await page.evaluate(
					async ([k, targetId, t]) => {
						const { edytor: ed, Y, E, S } = window.__BENCH__;
						const doc = ed.doc;
						const peer = new Y.Doc({ guid: doc.guid });
						Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
						const peerEd = E.create(peer);
						for (let j = 0; j < k; j++) peerEd.insertText(targetId, 5 + j, 'r');
						const diff = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc));
						const rec = { diffBytes: diff.byteLength };
						const done = new Promise((resolve) => {
							const mo = new MutationObserver(() => {
								mo.disconnect();
								rec.dom = performance.now();
								requestAnimationFrame(() => {
									rec.raf = performance.now();
									resolve();
								});
							});
							mo.observe(document.querySelector('[data-testid="editable-root"] [data-edytor]'), {
								subtree: true,
								childList: true,
								characterData: true
							});
							rec.timer = setTimeout(resolve, t);
						});
						rec.t0 = performance.now();
						const r = (Y.applyUpdate(doc, diff, 'bench'), { staged: false, applied: true });
						rec.applyDone = performance.now();
						rec.staged = r.staged ? 1 : 0;
						rec.applied = r.applied ? 1 : 0;
						await done;
						clearTimeout(rec.timer);
						return rec;
					},
					[30, mid, OP_TIMEOUT_MS]
				)
			);
		}
		lane.reconnect = {
			samples: recon.length,
			applyMs: statz(
				recon.map((r) => r.applyDone - r.t0),
				{ unit: 'ms' }
			),
			diffBytes: statz(
				recon.map((r) => r.diffBytes),
				{ unit: 'bytes' }
			),
			toDomMs: statz(
				recon.filter((r) => r.dom !== undefined).map((r) => r.dom - r.t0),
				{ unit: 'ms' }
			),
			toRafMs: statz(
				recon.filter((r) => r.raf !== undefined).map((r) => r.raf - r.t0),
				{ unit: 'ms' }
			),
			stagedTotal: recon.reduce((a, r) => a + (r.staged ?? 0), 0),
			note: '30 offline peer edits → one diff update → applyUpdateStaged → DOM/rAF.'
		};

		// ── full-document export — separate from the baseline op path ──
		const ser = await page.evaluate(() => {
			const t0 = performance.now();
			const v = JSON.stringify(window.__BENCH__.edytor.value);
			return { ms: performance.now() - t0, bytes: v.length };
		});
		lane.serialize = {
			ms: +ser.ms.toFixed(2),
			valueBytes: ser.bytes,
			note: 'explicit full-document export (edytor.value JSON.stringify) — NOT part of the baseline keystroke path.'
		};
		// U8a — confirm the consumer actually consumed each commit.
		if (consumer) {
			lane.consumerObserved = await page.evaluate(() => window.__BENCH_VALUE__ ?? null);
			lane.consumerObservedNote =
				'last value bytes the consumer observed — proves onChange/$derived ran through the lane.';
		}

		lane.heapBytesAfterLanes = await heapNow(page);
		await page.close();
		return lane;
	};

	/**
	 * Diagnostic lane — SEPARATE page from the timing lanes: DIAG_INIT
	 * prototype wraps + DIAG_WRAP_WRAPPERS instance wraps + CDP Profiler
	 * sampling over mount and a sustained keystroke run. Raw profiles go to
	 * .artifacts/u0-traces/; only summaries land in the artifact.
	 */
	const runDiagScale = async (name, params) => {
		const { blocks, chars, marks, peer } = params;
		const lane = {
			params: { fixture: 'flat', blocks, chars, marks, diag: 1, peer: peer ? 1 : 0 },
			diagnostic: true,
			note:
				'DIAG page — prototype wraps + per-instance wrapper wraps + CDP Profiler. Timing here is instrumented-wall — compare COUNTERS, not medians, against the timing lanes.' +
				(peer
					? ' U8a peer lane: one synthetic remote presence entry is seeded before the keystrokes, so every commit re-runs remote-selection geometry.'
					: '')
		};
		const page = await browser.newPage();
		// MOUNT_INIT first: its MutationObserver is built on the NATIVE class;
		// DIAG_INIT then wraps window.MutationObserver for everything after.
		await page.addInitScript(MOUNT_INIT);
		await page.addInitScript(DIAG_INIT);
		const cdp = await page.context().newCDPSession(page);

		// ── profiled mount ──
		const t0 = Date.now();
		const mountCap = await profiled(
			page,
			cdp,
			async () => {
				await page.goto(
					`${url}?fixture=flat&blocks=${blocks}&chars=${chars}&marks=${marks}&diag=1`,
					{ waitUntil: 'domcontentloaded' }
				);
				await page.waitForSelector('[data-testid="editable-root"] [data-edytor]');
				await page.waitForFunction(
					(n) => document.querySelectorAll('[data-edytor-block="true"]').length >= n,
					blocks,
					{ timeout: 240000 }
				);
			},
			{ align: false }
		);
		lane.mountWallMs = Date.now() - t0;
		lane.mount = await collectMount(page, { blocks, chars, fixture: 'flat' });
		mkdirSync(TRACE_DIR, { recursive: true });
		const mountFile = `profile-mount-${name}.json`;
		writeFileSync(`${TRACE_DIR}/${mountFile}`, JSON.stringify(mountCap.profile));
		lane.mountProfile = {
			file: `.artifacts/u0-traces/${mountFile}`,
			sampler: 'CDP Profiler (Profiler.start/stop), 100µs requested interval',
			clock: mountCap.clock,
			...summarizeProfile(mountCap.profile)
		};

		await install(page);
		lane.wrapMisses = await page.evaluate(() => window.__BENCH_H__?.wrapMisses ?? []);
		lane.wrapperWraps = await page.evaluate(DIAG_WRAP_WRAPPERS);

		// ── profiled sustained keystrokes ──
		const mid = `b${Math.floor(blocks / 2)}`;
		await clickBlockText(page, mid);
		await page.waitForTimeout(80);
		if (peer) {
			lane.peerSeed = await page.evaluate(SEED_REMOTE_PEER, { blockId: mid });
		}
		const ks = [];
		const keysCap = await profiled(page, cdp, async () => {
			for (let i = 0; i < DIAG_KS_SAMPLES; i++) ks.push(await keystroke(page, 'x'));
		});
		const keysFile = `profile-keys-${name}.json`;
		writeFileSync(`${TRACE_DIR}/${keysFile}`, JSON.stringify(keysCap.profile));
		lane.keystroke = aggregateLane(ks);
		lane.keystroke.note =
			'trusted CDP "x" on a DIAG-instrumented page — counters/diag buckets are the payload; timing is inflated by the wraps.';
		// Windows are perf-clock — shift by the measured navStart offset onto
		// the profile's CLOCK_MONOTONIC sample clock before bucketing.
		const windows = recordWindows(ks, 'keystroke').map((w) => ({
			...w,
			start: w.start + keysCap.clock.offsetMs,
			end: w.end + keysCap.clock.offsetMs
		}));
		lane.keysProfile = {
			file: `.artifacts/u0-traces/${keysFile}`,
			sampler: 'CDP Profiler (Profiler.start/stop), 100µs requested interval',
			clock: keysCap.clock,
			...summarizeProfile(keysCap.profile, windows)
		};
		lane.diagTotals = await page.evaluate(() => window.__BENCH_DIAG__?.totals ?? null);
		lane.diagTotalsNote =
			'__BENCH_DIAG__.totals — counter traffic with NO active record: mount-time + deferred work that fired after records resolved.';
		lane.heapBytesEnd = await heapNow(page);
		await page.close();
		return lane;
	};

	// ── flat-scale timing lanes (+ U8a consumer variants — same battery) ──
	for (const scale of LANES) {
		const params = SCALE_PARAMS[scale] ?? CONSUMER_PARAMS[scale];
		if (!params) continue; // non-scale lanes handled below
		console.log(
			`==> scale ${scale} (${params.blocks} blocks${params.consumer ? `, consumer=${params.consumer}` : ''})`
		);
		out.lanes[scale] = await runScale(scale, params);
		const k = out.lanes[scale].keystroke;
		console.log(
			`    mount ${out.lanes[scale].mountWallMs}ms · keystroke p50 ${k.stages.totalMs?.p50 ?? 'n/a'}ms (input ${k.stages.inputMs?.p50 ?? '–'} + contentBody ${k.stages.contentBodyMs?.p50 ?? '–'} + attrBody ${k.stages.attributionBodyMs?.p50 ?? '–'} + publish ${k.stages.publishMs?.p50 ?? '–'} + flush ${k.stages.flushMs?.p50 ?? '–'} + dispatchTail ${k.stages.dispatchTailMs?.p50 ?? '–'} + raf ${k.stages.rafMs?.p50 ?? '–'}) · timeouts ${k.timedOut}`
		);
	}

	// ── churned history: 200 insert+delete cycles then re-measure keystrokes ──
	if (LANES.includes('1k-churned')) {
		console.log('==> churned-history keystroke (1k fixture + 200 churn cycles)');
		const page = await browser.newPage();
		await page.addInitScript(MOUNT_INIT);
		const t0 = Date.now();
		await page.goto(`${url}?fixture=flat&blocks=1000&chars=60&marks=0`, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForSelector('[data-testid="editable-root"] [data-edytor]');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-edytor-block="true"]').length >= 1000,
			{ timeout: 240000 }
		);
		const mount = await collectMount(page, { blocks: 1000, chars: 60, fixture: 'flat' });
		await install(page);
		await page.evaluate(() => {
			const ed = window.__BENCH__.edytor;
			for (let c = 0; c < 200; c++) {
				ed.facade.insertText('b500', 0, 'x'.repeat(20));
				ed.facade.deleteText('b500', 0, 20);
				if (c % 4 === 0) {
					ed.facade.insertBlock({ parent: null, index: 0 }, { id: `tmp${c}`, type: 'paragraph' });
					ed.facade.deleteBlock(`tmp${c}`);
				}
			}
		});
		await page.evaluate(
			() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
		);
		await clickBlockText(page, 'b500');
		const ks = [];
		for (let i = 0; i < KS_SAMPLES; i++) ks.push(await keystroke(page, 'x'));
		out.lanes['1k-churned'] = {
			params: {
				fixture: 'flat',
				blocks: 1000,
				chars: 60,
				churn: '200×(insertText 20ch + deleteText 20ch) + 50×(insertBlock+deleteBlock)'
			},
			mountWallMs: Date.now() - t0,
			mount,
			keystrokeAfterChurn: aggregateLane(ks),
			note: 'same staged keystroke on a doc carrying 200 rounds of insert+delete churn (tombstones/fragmented item space).'
		};
		const ck = out.lanes['1k-churned'].keystrokeAfterChurn;
		console.log(
			`    churned keystroke p50 ${ck.stages.totalMs?.p50 ?? 'n/a'}ms · timeouts ${ck.timedOut}`
		);
		await page.close();
	}

	// ── shared backing text: one 100k formatted text split into 50 siblings ──
	if (LANES.includes('shared-100k-50blocks')) {
		console.log('==> shared-backing-text lane (100k chars → 50 siblings)');
		const page = await browser.newPage();
		await page.addInitScript(MOUNT_INIT);
		const t0 = Date.now();
		await page.goto(`${url}?fixture=shared&chars=100000`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-testid="editable-root"] [data-edytor]');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-edytor-block="true"]').length >= 1,
			{ timeout: 240000 }
		);
		const mountMs = Date.now() - t0;
		const mount = await collectMount(page, { blocks: 1, chars: 100000, fixture: 'shared' });
		await install(page);
		const split = await page.evaluate(async () => {
			const ed = window.__BENCH__.edytor;
			const cap = window.__BENCH_H__.beginCapture(0);
			const t0 = performance.now();
			let head = 'b0';
			for (let s = 1; s < 50; s++) {
				ed.facade.splitBlock(head, 2000, `s${s}`);
				head = `s${s}`;
			}
			const ms = performance.now() - t0;
			window.__BENCH_H__.endCapture(cap);
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			return {
				ms,
				txs: cap.txs.map((x) => ({
					originCat: x.originCat,
					local: x.local,
					bodyMs: x.bodyMs,
					updateBytes: x.updateBytes,
					spanMs: x.begin !== null && x.end !== null ? +(x.end - x.begin).toFixed(4) : null,
					parent: x.parent
				}))
			};
		});
		await page.waitForFunction(
			() => document.querySelectorAll('[data-edytor-block="true"]').length >= 50,
			{ timeout: 60000 }
		);
		// keystroke into a mid sibling sharing the backing text
		await clickBlockText(page, 's25');
		const ks = [];
		for (let i = 0; i < KS_SAMPLES; i++) ks.push(await keystroke(page, 'x'));
		const fmt = [];
		for (let i = 0; i < OP_SAMPLES; i++)
			fmt.push(await runOp(page, 'formatRange', ['s10', 5, 25, { bold: i % 2 === 0 }]));
		out.lanes['shared-100k-50blocks'] = {
			params: { fixture: 'shared', chars: 100000, siblings: 50, sliceChars: 2000 },
			mountWallMs: mountMs,
			mount,
			splitSetupMs: +split.ms.toFixed(1),
			splitTxs: split.txs,
			keystroke: aggregateLane(ks),
			formatFacade: aggregateLane(fmt),
			note: '50 sibling blocks each owning a ~2k slice of ONE 100k formatted backing text (facade.splitBlock). keystroke types into s25; formatRange bolds 20 chars of s10. splitTxs = per-transaction rows for the 49 setup splits (beginCapture).'
		};
		const sk = out.lanes['shared-100k-50blocks'].keystroke;
		console.log(
			`    mount ${mountMs}ms · split×49 ${split.ms.toFixed(1)}ms · keystroke p50 ${sk.stages.totalMs?.p50 ?? 'n/a'}ms · timeouts ${sk.timedOut}`
		);
		await page.close();
	}

	// ── diagnostic lanes (separate pages, profiler + counter wraps) ──
	for (const scale of LANES) {
		if (!scale.startsWith('diag-')) continue;
		const params = DIAG_PEER_PARAMS[scale] ?? SCALE_PARAMS[scale.slice('diag-'.length)];
		if (!params) {
			out.lanes[scale] = { skipped: `unknown diag lane '${scale}'` };
			continue;
		}
		console.log(
			`==> diag ${scale} (${params.blocks} blocks, instrumented${params.peer ? ', synthetic remote peer' : ''})`
		);
		out.lanes[scale] = await runDiagScale(scale, params);
		const k = out.lanes[scale].keystroke;
		console.log(
			`    diag keystroke p50 ${k.stages.totalMs?.p50 ?? 'n/a'}ms (instrumented) · profiles → ${TRACE_DIR}`
		);
	}

	for (const scale of LANES) {
		if (
			SCALE_PARAMS[scale] ||
			CONSUMER_PARAMS[scale] ||
			DIAG_PEER_PARAMS[scale] ||
			scale === '1k-churned' ||
			scale === 'shared-100k-50blocks' ||
			scale.startsWith('diag-')
		)
			continue;
		out.lanes[scale] = {
			skipped: `unknown lane '${scale}' — known: ${[...Object.keys(SCALE_PARAMS), '1k-churned', 'shared-100k-50blocks', 'diag-1k', 'diag-5k', ...Object.keys(CONSUMER_PARAMS), ...Object.keys(DIAG_PEER_PARAMS)].join(', ')}`
		};
	}
} finally {
	await browser.close();
	await server.close();
}

writeResult(out);
console.log('browser lane →', `${RESULTS_DIR}/browser-latest.json`);

function writeResult(record) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
	const json = JSON.stringify(record, null, 2) + '\n';
	writeFileSync(`${RESULTS_DIR}/browser-${stamp}.json`, json);
	writeFileSync(`${RESULTS_DIR}/browser-latest.json`, json);
	// U0 frozen instrumented baseline — same artifact, stable name.
	writeFileSync(`${RESULTS_DIR}/browser-U0-instrumented.json`, json);
}
