// Architecture-v2 census (plan §9.1 rules 8 and 10). One command:
//
//   node scripts/census.mjs [root=src/lib]
//
// prints
//   1. xloc per top-level dir under root, and the total — computed by the
//      FROZEN counter `scripts/xloc.mjs` (spawned, never re-implemented; its
//      sha256 is recorded in docs/architecture-v2/execution-ledger.md);
//   2. the vendor delta: xloc of root/crdt/vendor counted with `--vendor`,
//      against the G0 reference value;
//   3. type-body lines: lines inside multi-line `export type X = {...}`
//      bodies that the counter DOES count (it drops the `export type` header
//      line but not the body). Reported separately, never subtracted, so no
//      budget can be met by rewriting types as interfaces;
//   4. mechanism counts the plan's exit census tracks, over the same files
//      the counter reads (vendor, *.test.*, *.spec.*, *.d.ts excluded),
//      with comments stripped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const xloc = path.join(here, 'xloc.mjs');
const root = process.argv[2] ?? 'src/lib';
const vendorDir = path.join(root, 'crdt', 'vendor');

/** Vendor xloc at the G0 reference (arch-v2/ref-g0), `xloc.mjs <vendor> --vendor`. */
const VENDOR_XLOC_AT_G0 = 7125;

const runXloc = (...args) => execFileSync('node', [xloc, ...args], { encoding: 'utf8' });
const totalOf = (out) => Number(/TOTAL (\d+)/.exec(out)[1]);

// ── 1 · xloc per top-level dir ───────────────────────────────────────────
const dirsOut = runXloc(root, '--dirs');
console.log(`== xloc per top-level dir of ${root} (scripts/xloc.mjs --dirs)`);
process.stdout.write(dirsOut);

// ── 2 · vendor delta ─────────────────────────────────────────────────────
if (fs.existsSync(vendorDir)) {
	const vendor = totalOf(runXloc(vendorDir, '--vendor'));
	const delta = vendor - VENDOR_XLOC_AT_G0;
	console.log(`\n== vendor (${vendorDir}, --vendor)`);
	console.log(
		`vendor xloc ${vendor}  (G0 ${VENDOR_XLOC_AT_G0}, delta ${delta >= 0 ? '+' : ''}${delta})`
	);
}

// ── shared file walk (same exclusions as the counter's default mode) ─────
const walk = (dir) => {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (['vendor', '.test.', '.spec.'].some((s) => p.includes(s))) continue;
		if (e.isDirectory()) out.push(...walk(p));
		else if (['.ts', '.svelte', '.js', '.tsx'].some((x) => p.endsWith(x)) && !p.endsWith('.d.ts'))
			out.push(p);
	}
	return out;
};
const files = walk(root);
const stripBlockComments = (src) =>
	src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const stripLineComment = (line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');

// ── 3 · type-body lines ──────────────────────────────────────────────────
const braces = (l) => (l.match(/[{([]/g) || []).length - (l.match(/[})\]]/g) || []).length;
let typeBody = 0;
const typeBodyByDir = {};
for (const f of files) {
	const lines = stripBlockComments(fs.readFileSync(f, 'utf8')).split('\n');
	let inBody = false;
	let depth = 0;
	let n = 0;
	for (const raw of lines) {
		const l = raw.trim();
		if (inBody) {
			if (!l || l.startsWith('//')) continue;
			n++;
			depth += braces(l);
			if (depth <= 0 && (/;$/.test(l) || /^[}\])]/.test(l))) inBody = false;
			continue;
		}
		// Header: the counter drops this line; a body that continues past it
		// (open brackets, or `=` with no terminating `;`) is counted by xloc.
		if (/^export\s+(declare\s+)?type\s+[A-Za-z_$][\w$]*/.test(l)) {
			depth = braces(l);
			inBody = depth > 0 || (l.includes('=') && !/;$/.test(l));
		}
	}
	typeBody += n;
	const d = path.relative(root, path.dirname(f)).split('/')[0] || '.';
	typeBodyByDir[d] = (typeBodyByDir[d] || 0) + n;
}
console.log(
	'\n== type-body lines (continuation lines of multi-line `export type` declarations; counted by xloc, not subtracted)'
);
Object.entries(typeBodyByDir)
	.filter(([, c]) => c > 0)
	.sort((a, b) => b[1] - a[1])
	.forEach(([d, c]) => console.log(String(c).padStart(6), d));
console.log('TYPE-BODY', typeBody);

// ── 4 · mechanism counts ─────────────────────────────────────────────────
const mechanisms = [
	['setTimeout(', /\bsetTimeout\s*\(/g],
	['requestAnimationFrame(', /\brequestAnimationFrame\s*\(/g],
	['await tick()', /\bawait\s+tick\s*\(\s*\)/g],
	['flushMirror( call sites', /\bflushMirror\s*\(/g],
	['stopCapturing() calls', /\bstopCapturing\s*\(\s*\)/g],
	['instanceof PreventionError', /\binstanceof\s+PreventionError\b/g],
	['ignoreNextSelectionChange writes', /\bignoreNextSelectionChange\s*=(?!=)(?!\s*\$state\()/g],
	['new MutationObserver', /\bnew\s+MutationObserver\b/g],
	['flushSync(', /\bflushSync\s*\(/g]
];
const counts = new Map(mechanisms.map(([name]) => [name, 0]));
const perFile = new Map(mechanisms.map(([name]) => [name, new Map()]));
for (const f of files) {
	const code = stripBlockComments(fs.readFileSync(f, 'utf8'))
		.split('\n')
		.map(stripLineComment)
		.join('\n');
	for (const [name, re] of mechanisms) {
		const n = (code.match(re) || []).length;
		if (n === 0) continue;
		counts.set(name, counts.get(name) + n);
		perFile.get(name).set(path.relative(root, f), n);
	}
}
const verbose = process.argv.includes('--files');
console.log('\n== mechanism counts (vendor excluded, comments stripped)');
for (const [name] of mechanisms) {
	console.log(String(counts.get(name)).padStart(6), name);
	if (verbose)
		for (const [f, n] of [...perFile.get(name)].sort((a, b) => b[1] - a[1]))
			console.log(String(n).padStart(12), f);
}
