// Execution-LOC counter: drops blank lines, comment-only lines, block comments,
// `import type`/`export type` lines, and whole `interface {}` / `type X = {...}` declarations.
// Rough but deterministic; same script must be used for before/after comparisons.
import fs from 'node:fs';
import path from 'node:path';

function stripComments(src) {
	// remove block comments
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	// remove svelte html comments
	src = src.replace(/<!--[\s\S]*?-->/g, '');
	return src;
}
function countFile(file) {
	let src = stripComments(fs.readFileSync(file, 'utf8'));
	const lines = src.split('\n');
	let n = 0,
		inType = 0,
		depth = 0;
	for (let raw of lines) {
		const l = raw.trim();
		if (!l) continue;
		if (l.startsWith('//')) continue;
		if (/^(export\s+)?(declare\s+)?(import|export)\s+type\b/.test(l)) continue;
		if (/^export\s+\*\s+from/.test(l) || /^export\s+\{[^}]*\}\s+from/.test(l)) continue;
		if (inType) {
			depth += (l.match(/[{(<]/g) || []).length - (l.match(/[})>]/g) || []).length;
			if (depth <= 0) inType = 0;
			continue;
		}
		if (/^(export\s+)?(declare\s+)?(interface|type)\s+[A-Za-z_$][\w$]*/.test(l)) {
			depth = (l.match(/[{(<]/g) || []).length - (l.match(/[})>]/g) || []).length;
			if (depth > 0 || (l.includes('=') && !/[;]$/.test(l))) inType = 1;
			else inType = 0;
			if (depth <= 0 && /[;]$/.test(l)) inType = 0;
			continue;
		}
		if (/^declare\s+/.test(l)) continue;
		n++;
	}
	return n;
}
function walk(dir, exts, skip = []) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (skip.some((s) => p.includes(s))) continue;
		if (e.isDirectory()) out.push(...walk(p, exts, skip));
		else if (exts.some((x) => p.endsWith(x)) && !p.endsWith('.d.ts')) out.push(p);
	}
	return out;
}
const [root, ...rest] = process.argv.slice(2);
const perDir = rest.includes('--dirs');
const perFile = rest.includes('--files');
const skip = rest.includes('--vendor') ? [] : ['vendor', '.test.', '.spec.'];
const files = walk(root, ['.ts', '.svelte', '.js', '.tsx'], skip);
const byDir = {};
let total = 0;
const rows = [];
for (const f of files) {
	const c = countFile(f);
	total += c;
	const d = path.relative(root, path.dirname(f)).split('/')[0] || '.';
	byDir[d] = (byDir[d] || 0) + c;
	rows.push([c, f]);
}
if (perFile)
	rows.sort((a, b) => b[0] - a[0]).forEach(([c, f]) => console.log(String(c).padStart(6), f));
if (perDir)
	Object.entries(byDir)
		.sort((a, b) => b[1] - a[1])
		.forEach(([d, c]) => console.log(String(c).padStart(6), d));
console.log('TOTAL', total, 'files', files.length);
