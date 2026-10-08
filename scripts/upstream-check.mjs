#!/usr/bin/env node
/**
 * Watch upstream (`.github/workflows/upstream.yml`, weekly; runnable locally).
 *
 * The vendored engine (`src/lib/crdt/vendor/yjs`) is a fork of `@y/y`, pinned
 * in `package.json` (`pnpm.overrides["@y/protocols>@y/y"]`, the version
 * `UPSTREAM.md` records). This script asks the npm registry for a newer
 * `@y/y` and, when there is one:
 *
 * 1. downloads the pinned and the newer tarball and applies patch P1
 *    (`lib0/` → `lib0-v14/`) to both;
 * 2. writes `upstream.diff` (pinned → newer: what upstream changed) and
 *    `fork.diff` (newer → this tree with P1 undone: the patches a re-sync
 *    re-applies) into the report directory, with a summary;
 * 3. materializes the newer engine (+ P1) as `bench/vendor-baseline/yjs`,
 *    the baseline the differential lanes read (`bench/lib/interop.mjs`, the
 *    baseline leg of `src/tests/crdt/hardening/r1-p4-format.test.ts`), so
 *    the workflow runs them against it next.
 *
 * Usage: node scripts/upstream-check.mjs [--version <v>] [--out <dir>]
 *   --version  check this version instead of the newest one
 *   --out      the report directory (default: upstream-report)
 *
 * Writes `newer=<version>` (empty when up to date) to `$GITHUB_OUTPUT`, and
 * the summary to `$GITHUB_STEP_SUMMARY`, when those are set.
 */
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'src/lib/crdt/vendor/yjs');
const BASELINE = path.join(ROOT, 'bench/vendor-baseline/yjs');

const arg = (name) => {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
};
const OUT = path.resolve(ROOT, arg('--out') ?? 'upstream-report');

const output = (key, value) => {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const summary = (text) => {
	console.log(text);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PIN = pkg.pnpm?.overrides?.['@y/protocols>@y/y'];
if (!PIN) throw new Error('upstream-check: no @y/y pin in package.json pnpm.overrides');

const response = await fetch('https://registry.npmjs.org/@y%2fy');
if (!response.ok) throw new Error(`upstream-check: registry answered ${response.status}`);
const meta = await response.json();
if (!meta.versions?.[PIN]) throw new Error(`upstream-check: the pin ${PIN} is not published`);

// Newer = published after the pin (pre-releases included: the pin is one).
const pinnedAt = Date.parse(meta.time[PIN]);
const wanted = arg('--version');
const newer = wanted
	? wanted
	: Object.keys(meta.versions)
			.filter((v) => Date.parse(meta.time[v]) > pinnedAt)
			.sort((a, b) => Date.parse(meta.time[b]) - Date.parse(meta.time[a]))[0];

if (!newer) {
	summary(`### @y/y: up to date\n\nThe pin \`${PIN}\` is the newest published version.`);
	output('newer', '');
	process.exit(0);
}
if (!meta.versions[newer]) throw new Error(`upstream-check: @y/y ${newer} is not published`);

const work = mkdtempSync(path.join(tmpdir(), 'edytor-upstream-'));
const run = (cmd, args, options = {}) => {
	const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
	if (result.error) throw result.error;
	return result;
};

/** The `src/` of `@y/y@version`, with P1 applied, at `<work>/<name>/src`. */
const fetchSource = async (version, name) => {
	const tarball = meta.versions[version].dist.tarball;
	const bytes = Buffer.from(await (await fetch(tarball)).arrayBuffer());
	const dir = path.join(work, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'package.tgz'), bytes);
	const untar = run('tar', ['-xzf', 'package.tgz'], { cwd: dir });
	if (untar.status !== 0) throw new Error(`upstream-check: tar failed: ${untar.stderr}`);
	const src = path.join(dir, 'package/src');
	p1(src);
	return src;
};

/** Patch P1 over every `.js` under `dir` (UPSTREAM.md). */
const p1 = (dir, from = 'lib0/', to = 'lib0-v14/') => {
	for (const entry of readdirSync(dir)) {
		const file = path.join(dir, entry);
		if (statSync(file).isDirectory()) p1(file, from, to);
		else if (file.endsWith('.js'))
			writeFileSync(file, readFileSync(file, 'utf8').replaceAll(from, to));
	}
};

const pinned = await fetchSource(PIN, 'pinned');
const candidate = await fetchSource(newer, 'candidate');
// This tree in the same (P1) form: the vendored source as it is.
const ours = path.join(work, 'ours/src');
cpSync(path.join(VENDOR, 'src'), ours, { recursive: true });

mkdirSync(OUT, { recursive: true });
const diff = (from, to, file) => {
	const result = run('diff', ['-ruN', from, to]);
	const text = result.stdout.replaceAll(work, '');
	writeFileSync(path.join(OUT, file), text);
	return text;
};
const changed = (text) => text.split('\n').filter((line) => line.startsWith('diff ')).length;
const upstream = diff(pinned, candidate, 'upstream.diff');
const fork = diff(candidate, ours, 'fork.diff');

// The differential lanes read this baseline (bench/lib/mk-baseline.sh makes the pinned one).
rmSync(BASELINE, { recursive: true, force: true });
mkdirSync(BASELINE, { recursive: true });
cpSync(candidate, BASELINE, { recursive: true });
rmSync(work, { recursive: true, force: true });

const report = [
	`### @y/y ${newer} is newer than the pin ${PIN}`,
	'',
	`- upstream changed ${changed(upstream)} files between ${PIN} and ${newer} (\`upstream.diff\`);`,
	`- the fork differs from ${newer} in ${changed(fork)} files (\`fork.diff\`: the patches a re-sync re-applies, and upstream's changes the fork does not have yet);`,
	`- \`bench/vendor-baseline/yjs\` now holds ${newer} + P1: the interop and differential checks that follow run against it.`,
	'',
	'Re-syncing is a manual step: `src/lib/crdt/vendor/yjs/UPSTREAM.md`, "Re-syncing with upstream".'
].join('\n');
writeFileSync(path.join(OUT, 'summary.md'), `${report}\n`);
summary(report);
output('newer', newer);
if (!existsSync(path.join(BASELINE, 'index.js')))
	throw new Error('upstream-check: the materialized baseline has no index.js');
