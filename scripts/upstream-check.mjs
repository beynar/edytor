#!/usr/bin/env node
/**
 * Watch upstream (`.github/workflows/upstream.yml`, weekly; runnable locally).
 *
 * The vendored engine (`src/lib/crdt/vendor/yjs`) is a fork of `@y/y`, pinned
 * in `package.json` (`pnpm.overrides["@y/protocols>@y/y"]`, the version
 * `UPSTREAM.md` records). This script asks the npm registry for a newer
 * `@y/y` and, when there is one:
 *
 * 1. downloads the pinned and the newer tarball, checks each against the
 *    registry's `dist.integrity`, and applies patch P1 (`lib0/` →
 *    `lib0-v14/`) to both;
 * 2. writes `upstream.diff` (pinned → newer: what upstream changed) and
 *    `fork.diff` (newer → this tree; both carry P1, so it shows the other
 *    patches a re-sync re-applies, and upstream's changes the fork lacks)
 *    into the report directory, with a summary that also says whether the
 *    `lib0-v14` this tree installs satisfies the newer engine's `lib0`
 *    range (the differential lanes run the newer engine on it);
 * 3. materializes the newer engine (+ P1) as `bench/vendor-baseline/yjs`,
 *    the baseline the differential lanes read (`bench/lib/interop.mjs`, the
 *    baseline leg of `src/tests/crdt/hardening/r1-p4-format.test.ts`), so
 *    the workflow runs them against it next.
 *
 * "Newer" is by semver within the pin's major line (14.x, pre-releases
 * included: the pin is one), never by publish time.
 *
 * Usage: node scripts/upstream-check.mjs [--version <v>] [--out <dir>]
 *   --version  check this version instead of the newest one
 *   --out      the report directory (default: upstream-report)
 *
 * Writes `newer=<version>` (empty when up to date) to `$GITHUB_OUTPUT`, and
 * the summary to `$GITHUB_STEP_SUMMARY`, when those are set.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** `major.minor.patch[-pre]` (build metadata dropped), or null. */
const parse = (version) => {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
	if (!match) return null;
	return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
};
/** Semver precedence: the core numerically, then a release above its pre-releases, then each identifier. */
const compare = (a, b) => {
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const [p, q] = [x.pre[i], y.pre[i]];
		if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
		const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
		if (m && n && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (m !== n) return m ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
};
/**
 * Whether `version` satisfies `range`: an exact version, `>=v`, `^v` or
 * `~v` (npm's rules, a pre-release only within its own core); null for a
 * range form this script does not read.
 */
const satisfies = (version, range) => {
	const match = /^\s*(\^|~|>=|=)?\s*v?(\S+)\s*$/.exec(range);
	const base = match && parse(match[2]);
	const v = parse(version);
	if (!base || !v) return null;
	const op = match[1] ?? '=';
	if (op === '=') return compare(version, match[2]) === 0;
	if (compare(version, match[2]) < 0) return false;
	if (v.pre.length && v.core.join('.') !== base.core.join('.')) return false;
	if (op === '>=') return true;
	const [major, minor] = base.core;
	if (op === '~') return v.core[0] === major && v.core[1] === minor;
	// `^`: the leftmost non-zero part stays.
	if (major > 0) return v.core[0] === major;
	if (minor > 0) return v.core[0] === 0 && v.core[1] === minor;
	return v.core.join('.') === base.core.join('.');
};

// Newer = above the pin by semver, in the pin's major line.
const line = parse(PIN).core[0];
const wanted = arg('--version');
const newer = wanted
	? wanted
	: Object.keys(meta.versions)
			.filter((v) => parse(v)?.core[0] === line && compare(v, PIN) > 0)
			.sort(compare)
			.at(-1);

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
	const { tarball, integrity } = meta.versions[version].dist;
	const fetched = await fetch(tarball);
	if (!fetched.ok) throw new Error(`upstream-check: ${tarball} answered ${fetched.status}`);
	const bytes = Buffer.from(await fetched.arrayBuffer());
	// The registry's Subresource Integrity string: `sha512-<base64>`.
	const sri = integrity?.split(/\s+/).find((entry) => entry.startsWith('sha512-'));
	if (!sri) throw new Error(`upstream-check: @y/y ${version} has no sha512 integrity`);
	const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
	if (digest !== sri)
		throw new Error(`upstream-check: @y/y ${version}'s tarball does not match its integrity`);
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

// The differential lanes run the newer engine on the `lib0-v14` this tree installs.
const lib0Range = meta.versions[newer].dependencies?.lib0;
const lib0Installed = JSON.parse(
	readFileSync(path.join(ROOT, 'node_modules/lib0-v14/package.json'), 'utf8')
).version;
const lib0Fits = lib0Range === undefined ? true : satisfies(lib0Installed, lib0Range);
const lib0Line =
	lib0Fits === true
		? `- its \`lib0\` range (\`${lib0Range ?? 'none'}\`) holds the installed \`lib0-v14\` ${lib0Installed};`
		: lib0Fits === false
			? `- **lib0 mismatch**: ${newer} asks \`lib0@${lib0Range}\`, this tree installs \`lib0-v14\` ${lib0Installed}; a red interop or differential step may be the older lib0, not the fork (a re-sync bumps \`lib0-v14\` first);`
			: `- its \`lib0\` range \`${lib0Range}\` is a form this script does not read; the installed \`lib0-v14\` is ${lib0Installed};`;

const report = [
	`### @y/y ${newer} is newer than the pin ${PIN}`,
	'',
	`- upstream changed ${changed(upstream)} files between ${PIN} and ${newer} (\`upstream.diff\`);`,
	`- the fork differs from ${newer} in ${changed(fork)} files (\`fork.diff\`: the patches a re-sync re-applies, and upstream's changes the fork does not have yet);`,
	lib0Line,
	`- \`bench/vendor-baseline/yjs\` now holds ${newer} + P1: the interop and differential checks that follow run against it.`,
	'',
	'Re-syncing is a manual step: `src/lib/crdt/vendor/yjs/UPSTREAM.md`, "Re-syncing with upstream".'
].join('\n');
writeFileSync(path.join(OUT, 'summary.md'), `${report}\n`);
summary(report);
output('newer', newer);
output('lib0', lib0Fits === false ? 'mismatch' : 'ok');
if (!existsSync(path.join(BASELINE, 'index.js')))
	throw new Error('upstream-check: the materialized baseline has no index.js');
