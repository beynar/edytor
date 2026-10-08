#!/usr/bin/env node
/**
 * Ticket ids in `src/lib` comments (`node scripts/ticket-ids.mjs`).
 *
 * A comment says what it means: a contract row (`del.range.whole-doc`,
 * `layout.single`, `room.quota`, …) when one names the rule, else plain
 * prose. Plan, review and checkpoint ids (`U1`, `H7`, `FX-02`, `WU-12`,
 * `DR-props-2`, `§2.4`, …) mean nothing to a reader who was not there, so
 * this script lists every one it finds in a comment of a `src/lib` source
 * file (TypeScript, JavaScript, Svelte, CSS) and exits non-zero when it
 * finds any. `src/tests/maintainability/ticket-ids.test.ts` runs it in the
 * unit lane.
 *
 * The contributor guides are held to the same rule: the prose of
 * `AGENTS.md` and `docs/agents/*.md` (inline code and code blocks aside,
 * where a test's or a function's name may carry one; `guides()`).
 *
 * Allowed: the vendored fork's patch names (`YP1` … `YP14`, see
 * `src/lib/crdt/vendor/yjs/UPSTREAM.md`), the upstream engine's own source
 * (`src/lib/crdt/vendor/`), and the names a comment uses for what they are
 * (`UTF-16`, `ES2022`, `R2 bucket`, `D1 database`, `C0` controls, …:
 * `ALLOWED`).
 *
 * `--json` prints the findings as JSON (`[{ file, line, codes }]`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');

/**
 * A ticket id: letters then digits (`R4`, `O45`, `P11`, `SW16`, `U6b`,
 * `P2.7`), letters, a dash and digits (`D-8`, `UW-22`, `FX-01`, `BI2-5`), a
 * review row (`DR-props-2`, `F-S14`), or a plan section (`§2.4`): the
 * shapes of `CODE` in `scripts/api-report.mjs`, which checks the public
 * JSDoc, and the `F-S14` form.
 */
export const CODE =
	/(?<![\w./+-])(?:[A-Z]{1,3}\d{1,3}(?:\.\d+)*[a-z]?|[A-Z]{1,3}\d?-\d{1,3}[a-z]?|[A-Z]-[A-Z]{1,2}\d{1,3}[a-z]?|[A-Z]{2}\d?-[a-z]+-\d+)(?![\w-])|§\s?\d+(?:\.\d+)*/g;

/**
 * Codes that are not ticket ids: the fork's patches, encodings and
 * standards, products and update encodings. A key in a chord (`Alt+F10`)
 * is not one either: a code right after `+` is never read.
 */
const ALLOWED = [
	/^YP\d+$/, // the vendored fork's patches (UPSTREAM.md)
	/^(?:ES\d{1,4}|V8|IE11|S3|C0|C1|V1|V2)$/, // ECMAScript editions, an engine, a store, control-code sets, update encodings
	/^FNV-1a$/ // a hash
];
/** Context exceptions: the code followed by the word that says what it is. */
const CONTEXT =
	/^(?:R2[\s*]+(?:bucket|binding|custom|takes|expires|lifecycle|store|object)|D1[\s*]+(?:database|binding))\b/;
/** Encodings written with a dash (`UTF-8`, `UTF-16`). */
const ENCODING = /^UTF-\d+$/;

const allowed = (code, after) =>
	ALLOWED.some((rule) => rule.test(code)) || ENCODING.test(code) || CONTEXT.test(code + after);

const SKIP_DIRS = new Set(['vendor']);
const EXTENSIONS = new Set(['.ts', '.js', '.svelte', '.css']);

/** Every source file under `dir` (the vendored engine excluded). */
export const sources = (dir = path.join(ROOT, 'src/lib')) => {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) {
			if (!SKIP_DIRS.has(name)) out.push(...sources(full));
		} else if (EXTENSIONS.has(path.extname(name))) out.push(full);
	}
	return out.sort();
};

/** Comment ranges `[start, end)` of a TypeScript/JavaScript text. */
const scriptComments = (text, file) => {
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const seen = new Map();
	const add = (ranges) => {
		for (const range of ranges ?? []) seen.set(range.pos, range.end);
	};
	const visit = (node) => {
		if (node.kind < ts.SyntaxKind.FirstNode || node.getChildCount(sf) === 0) {
			add(ts.getLeadingCommentRanges(text, node.pos));
			add(ts.getTrailingCommentRanges(text, node.end));
			return;
		}
		for (const child of node.getChildren(sf)) visit(child);
	};
	visit(sf);
	add(ts.getLeadingCommentRanges(text, sf.endOfFileToken.pos));
	return [...seen].map(([start, end]) => [start, end]);
};

const blockComments = (text, offset = 0) =>
	[...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [
		offset + m.index,
		offset + m.index + m[0].length
	]);

/** Comment ranges of a Svelte component: its scripts, its styles and its markup comments. */
const svelteComments = (text, file) => {
	const ranges = [];
	const blocks = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/g;
	let markup = text;
	for (const m of text.matchAll(blocks)) {
		const start = m.index + m[0].indexOf('>') + 1;
		const body = m[2];
		if (m[1] === 'script')
			ranges.push(...scriptComments(body, file + '.ts').map(([a, b]) => [a + start, b + start]));
		else ranges.push(...blockComments(body, start));
		markup =
			markup.slice(0, m.index) + ' '.repeat(m[0].length) + markup.slice(m.index + m[0].length);
	}
	for (const m of markup.matchAll(/<!--[\s\S]*?-->/g))
		ranges.push([m.index, m.index + m[0].length]);
	return ranges;
};

/** The contributor guides: `AGENTS.md` and `docs/agents/*.md`. */
export const guides = () => [
	path.join(ROOT, 'AGENTS.md'),
	...readdirSync(path.join(ROOT, 'docs/agents'))
		.filter((name) => name.endsWith('.md'))
		.sort()
		.map((name) => path.join(ROOT, 'docs/agents', name))
];

/** Prose ranges of a Markdown text: everything outside code blocks and inline code. */
const proseOf = (text) => {
	const ranges = [];
	let at = 0;
	for (const m of text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) {
		if (m.index > at) ranges.push([at, m.index]);
		at = m.index + m[0].length;
	}
	if (at < text.length) ranges.push([at, text.length]);
	return ranges;
};

/** Comment ranges of one file (a Markdown guide: its prose). */
export const commentsOf = (file, text = readFileSync(file, 'utf8')) => {
	const ext = path.extname(file);
	if (ext === '.md') return proseOf(text);
	if (ext === '.svelte') return svelteComments(text, file);
	if (ext === '.css') return blockComments(text);
	return scriptComments(text, file);
};

/** The ticket ids in the comments of one source text: `[{ line, codes }]`. */
export const ticketIdsIn = (file, text) => {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const lineOf = (pos) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	const byLine = new Map();
	for (const [start, end] of commentsOf(file, text)) {
		const comment = text.slice(start, end);
		for (const m of comment.matchAll(CODE)) {
			const after = comment.slice(m.index + m[0].length, m.index + m[0].length + 24);
			if (allowed(m[0], after)) continue;
			const line = lineOf(start + m.index);
			const codes = byLine.get(line) ?? [];
			if (!codes.includes(m[0])) codes.push(m[0]);
			byLine.set(line, codes);
		}
	}
	return [...byLine].sort((a, b) => a[0] - b[0]).map(([line, codes]) => ({ line, codes }));
};

/** Every ticket id in the comments of `files`: `[{ file, line, codes }]`. */
export const findTicketIds = (files = sources()) =>
	files.flatMap((file) =>
		ticketIdsIn(file, readFileSync(file, 'utf8')).map((finding) => ({
			file: path.relative(ROOT, file).split(path.sep).join('/'),
			...finding
		}))
	);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const findings = findTicketIds([...sources(), ...guides()]);
	if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 1));
	else
		for (const { file, line, codes } of findings)
			console.log(`${file}:${line}  ${codes.join(' ')}`);
	if (findings.length) {
		const total = findings.reduce((n, f) => n + f.codes.length, 0);
		console.error(
			`ticket-ids: ${total} ticket ids in ${findings.length} lines of src/lib comments and the guides (name the contract row, or say what is meant)`
		);
		process.exit(1);
	}
}
