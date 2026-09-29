#!/usr/bin/env node
/**
 * Doc examples type check (`pnpm check:docs`).
 *
 * A fenced block in `site/content/docs` whose meta has the bare token
 * `check` after its title is a complete example:
 *
 *     ```svelte title="src/routes/+page.svelte" check
 *     ```ts src/worker.ts check
 *
 * The title is required: Blume promotes the first bare meta token to the
 * block's title, so an untitled `check` fence would be titled "check".
 *
 * Each marked block is written, verbatim, to
 * `src/routes/__docexamples/<app|worker>/<page>/<title>` (a leading
 * `src/routes/` or `src/` is dropped from the title), so SvelteKit
 * generates `./$types` for route files and a page's blocks can import each
 * other. The package's own specifiers resolve to the sources through
 * `paths`: `edytor` → `src/lib/index.ts`, `edytor/cloudflare`,
 * `edytor/crdt/edytor`, `edytor/crdt` and the theme likewise.
 *
 * - `.svelte` and `.ts` blocks are checked by `svelte-check` in the app
 *   program (DOM types, the SvelteKit ambient types).
 * - `.ts` blocks that import `edytor/cloudflare` or `cloudflare:*` are
 *   checked by `tsc` in a Worker program (`@cloudflare/workers-types`).
 *
 * `scripts/doc-examples/{app,worker}.d.ts` declare the few names the docs
 * leave to the reader (`// your storage`, the `Env` that `wrangler types`
 * writes), so the rest of each block is checked as written.
 *
 * Errors are reported at their line in the `.mdx` page. The directory is
 * removed afterwards (`--keep` leaves it for inspection); it is ignored by
 * git, prettier and eslint.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'site/content/docs');
const OUT = path.join(ROOT, 'src/routes/__docexamples');
const DECLARATIONS = path.join(ROOT, 'scripts/doc-examples');
const BIN = path.join(ROOT, 'node_modules/.bin');
const keep = process.argv.includes('--keep');

// The fence-meta grammar Blume uses (a quoted attr, a `{1,3}` range, or a word).
const META_TOKEN = /[\w-]+=(?:"[^"]*"|'[^']*')|\{[^}]*\}|\S+/gu;
const RESERVED = new Set(['lineNumbers', 'ts2js', 'twoslash', 'check']);
const EXTENSION = { ts: '.ts', typescript: '.ts', svelte: '.svelte' };

const pages = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? pages(file) : entry.name.endsWith('.mdx') ? [file] : [];
	});

/** The title Blume shows: `title="…"`, else the first bare word. */
const titleOf = (tokens) => {
	const attr = tokens.find((token) => /^title=/.test(token));
	if (attr) return attr.slice(7, -1);
	const bare = tokens.find((token) => !token.includes('=') && !token.startsWith('{'));
	return bare && !RESERVED.has(bare) ? bare : null;
};

const failures = [];
const examples = [];

for (const page of pages(DOCS)) {
	const lines = readFileSync(page, 'utf8').split('\n');
	const slug = path
		.relative(DOCS, page)
		.replace(/\.mdx$/, '')
		.replaceAll(path.sep, '-');
	const where = path.relative(ROOT, page);
	for (let i = 0; i < lines.length; i++) {
		const open = /^(\s*)(`{3,})(\w*)\s*(.*)$/.exec(lines[i]);
		if (!open) continue;
		const [, indent, fence, lang] = open;
		let end = i + 1;
		while (end < lines.length && lines[end].trim() !== fence) end++;
		const tokens = open[4].match(META_TOKEN) ?? [];
		const start = i;
		i = end;
		if (!tokens.includes('check')) continue;
		const title = titleOf(tokens);
		const extension = EXTENSION[lang];
		if (!extension || !title) {
			failures.push(
				`${where}:${start + 1}: a \`check\` fence needs a ts or svelte language and a title before \`check\``
			);
			continue;
		}
		const code = lines
			.slice(start + 1, end)
			.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
			.join('\n');
		const worker =
			extension === '.ts' && /from\s+['"](?:edytor\/cloudflare|cloudflare:[\w-]+)['"]/.test(code);
		let file = title.replace(/^src\/routes\//, '').replace(/^src\//, '');
		if (!file.endsWith(extension)) file += extension;
		const target = path.join(OUT, worker ? 'worker' : 'app', slug, file);
		if (examples.some((example) => example.target === target)) {
			failures.push(`${where}:${start + 1}: two \`check\` fences on this page are titled ${title}`);
			continue;
		}
		examples.push({ target, page: where, line: start + 1, code, worker });
	}
}

const sourcesOf = new Map(examples.map((example) => [example.target, example]));

/**
 * Map a diagnostic in a generated file back to its page line. Diagnostics in
 * the package's own sources are `pnpm check`'s to report, not this check's.
 */
const report = (file, line, column, message) => {
	const absolute = path.resolve(ROOT, file);
	const example = sourcesOf.get(absolute);
	if (example) failures.push(`${example.page}:${example.line + line}:${column}: ${message}`);
	else if (absolute.startsWith(DECLARATIONS))
		failures.push(`${path.relative(ROOT, absolute)}:${line}:${column}: ${message}`);
};

const run = (command, args) =>
	spawnSync(path.join(BIN, command), args, { cwd: ROOT, encoding: 'utf8' });

const sync = () => {
	const result = run('svelte-kit', ['sync']);
	if (result.status !== 0) throw new Error(`svelte-kit sync failed:\n${result.stderr}`);
};

try {
	rmSync(OUT, { recursive: true, force: true });
	for (const { target, code } of examples) {
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, code.endsWith('\n') ? code : `${code}\n`);
	}
	sync();

	// The package's specifiers → its sources, beside SvelteKit's own paths.
	const kit = JSON.parse(readFileSync(path.join(ROOT, '.svelte-kit/tsconfig.json'), 'utf8'));
	const paths = Object.fromEntries(
		Object.entries(kit.compilerOptions.paths).map(([key, targets]) => [
			key,
			targets.map((target) => path.resolve(ROOT, '.svelte-kit', target))
		])
	);
	Object.assign(paths, {
		edytor: [path.join(ROOT, 'src/lib/index.ts')],
		'edytor/cloudflare': [path.join(ROOT, 'src/lib/cloudflare/index.ts')],
		'edytor/crdt/edytor': [path.join(ROOT, 'src/lib/crdt/index.ts')],
		'edytor/crdt': [path.join(ROOT, 'src/lib/crdt/vendor/yjs/dts/index.d.ts')],
		'edytor/themes/notion.css': [path.join(ROOT, 'src/lib/themes/notion.css')]
	});

	const app = examples.filter((example) => !example.worker);
	if (app.length) {
		writeFileSync(
			path.join(OUT, 'tsconfig.json'),
			JSON.stringify({
				extends: path.join(ROOT, 'tsconfig.json'),
				compilerOptions: { paths },
				include: [
					path.join(ROOT, '.svelte-kit/ambient.d.ts'),
					path.join(ROOT, '.svelte-kit/non-ambient.d.ts'),
					path.join(ROOT, '.svelte-kit/types/**/$types.d.ts'),
					path.join(ROOT, 'src/app.d.ts'),
					path.join(DECLARATIONS, 'app.d.ts'),
					'app/**/*.ts',
					'app/**/*.svelte'
				],
				exclude: []
			})
		);
		const result = run('svelte-check', [
			'--tsconfig',
			path.join(OUT, 'tsconfig.json'),
			'--output',
			'machine',
			'--threshold',
			'error'
		]);
		const errors = [...result.stdout.matchAll(/^\d+ ERROR "([^"]+)" (\d+):(\d+) "(.*)"$/gm)];
		for (const [, file, line, column, message] of errors)
			report(file, Number(line), Number(column), JSON.parse(`"${message}"`));
		if (result.status !== 0 && !errors.length)
			failures.push(`svelte-check exited ${result.status}:\n${result.stdout}${result.stderr}`);
	}

	if (examples.some((example) => example.worker)) {
		writeFileSync(
			path.join(OUT, 'tsconfig.worker.json'),
			JSON.stringify({
				extends: path.join(ROOT, 'tests/do/tsconfig.json'),
				compilerOptions: { paths, types: ['@cloudflare/workers-types'] },
				include: [path.join(DECLARATIONS, 'worker.d.ts'), 'worker/**/*.ts'],
				exclude: []
			})
		);
		const result = run('tsc', ['-p', path.join(OUT, 'tsconfig.worker.json'), '--pretty', 'false']);
		const errors = [...result.stdout.matchAll(/^(.+)\((\d+),(\d+)\): error (TS\d+: .*)$/gm)];
		for (const [, file, line, column, message] of errors)
			report(file, Number(line), Number(column), message);
		if (result.status !== 0 && !errors.length)
			failures.push(`tsc exited ${result.status}:\n${result.stdout}${result.stderr}`);
	}
} finally {
	if (!keep) {
		// `svelte-kit sync` does not prune the types of deleted routes.
		rmSync(OUT, { recursive: true, force: true });
		rmSync(path.join(ROOT, '.svelte-kit/types/src/routes/__docexamples'), {
			recursive: true,
			force: true
		});
		sync();
	}
}

if (failures.length) {
	console.error(failures.join('\n'));
	console.error(`\n${failures.length} error(s) in ${examples.length} checked doc example(s).`);
	process.exit(1);
}
console.log(`${examples.length} doc examples type-check.`);
