#!/usr/bin/env node
/**
 * Worker-safe CRDT boundary — bundle proof (`pnpm check:worker`).
 *
 * The CRDT engine + sync layer also runs server-side in a Cloudflare
 * Durable Object, so `src/lib/crdt/index.ts` (the `edytor/crdt/edytor`
 * entry) must bundle for a Worker target without Svelte, SvelteKit or any
 * editor view layer. This script bundles the entry the way wrangler would
 * resolve it (platform neutral, `workerd`/`worker` conditions first) and
 * fails when:
 *
 * - any bundled module is Svelte/SvelteKit (`svelte`, `@sveltejs/*`,
 *   `$app/*`, `*.svelte`, `*.svelte.ts/js`);
 * - any in-repo module lies outside the Worker-safe set (the same set
 *   `eslint.config.js` lints as `WORKER_SAFE`), e.g. a view layer;
 * - the bundle leaves an import unresolved (a Worker bundle must be
 *   self-contained — no Node builtins, no missing packages).
 *
 * rolldown is resolved through the repo's own node_modules: directly when
 * it is a dependency, else through vite's (vite 8 bundles with rolldown).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src/lib/crdt/index.ts');
const LIB = path.join(ROOT, 'src/lib');

const loadRolldown = async () => {
	const require = createRequire(path.join(ROOT, 'package.json'));
	for (const from of [null, 'vite/package.json']) {
		try {
			const base = from ? createRequire(require.resolve(from)) : require;
			return await import(pathToFileURL(base.resolve('rolldown')).href);
		} catch {
			// try the next resolution root
		}
	}
	throw new Error('check:worker: rolldown is not resolvable (neither directly nor through vite)');
};

/** In-repo modules allowed in the Worker bundle (mirrors WORKER_SAFE in eslint.config.js). */
const WORKER_SAFE = [/^crdt\//, /^utils\/json\.[jt]s$/, /^utils\.[jt]s$/, /^constants\.[jt]s$/];
const SVELTE = /(^|\/)(svelte|@sveltejs)(\/|$)|\.svelte(\.[jt]s)?$|(^|\/)\$app\//;
const VIEW_LAYER =
	/^(components|selection|surface|session|events|block|text|plugins|hotkeys|clipboard|collaboration|dnd)(\/|\.|$)|^edytor[^/]*\.[jt]s$/;

const { rolldown } = await loadRolldown();
// Every module the build LOADS, tree-shaken or not: an import of a view
// module is a boundary breach even when nothing of it survives shaking.
const loaded = new Set();
const bundle = await rolldown({
	input: ENTRY,
	plugins: [
		{
			name: 'worker-boundary-graph',
			transform(_code, id) {
				loaded.add(id);
			}
		}
	],
	cwd: ROOT,
	platform: 'neutral',
	resolve: {
		conditionNames: ['workerd', 'worker', 'browser', 'import', 'default'],
		mainFields: ['module', 'main']
	},
	logLevel: 'silent'
});
const { output } = await bundle.generate({ format: 'esm', minify: false });
await bundle.close();

const chunks = output.filter((o) => o.type === 'chunk');
const bundled = new Set(chunks.flatMap((c) => c.moduleIds));
const ids = [...new Set([...bundled, ...loaded])].filter((id) => !id.startsWith('\0'));
const shaken = ids.filter((id) => !bundled.has(id)).length;
const code = chunks.map((c) => c.code).join('\n');
const externals = [...new Set(chunks.flatMap((c) => c.imports))].filter(
	(i) => !chunks.some((c) => c.fileName === i)
);

const problems = [];
const groups = new Map();
for (const id of ids) {
	const posix = id.split(path.sep).join('/');
	const inRepo = !posix.includes('/node_modules/') && id.startsWith(ROOT);
	const rel = inRepo ? path.relative(LIB, id).split(path.sep).join('/') : posix;
	const group = inRepo
		? rel.startsWith('crdt/vendor/')
			? 'src/lib/crdt/vendor (engine)'
			: rel.startsWith('crdt/')
				? 'src/lib/crdt'
				: `src/lib/${rel}`
		: posix
				.split('/node_modules/')
				.pop()
				.split('/')
				.slice(0, posix.split('/node_modules/').pop().startsWith('@') ? 2 : 1)
				.join('/');
	groups.set(group, (groups.get(group) ?? 0) + 1);
	if (SVELTE.test(posix)) problems.push(`svelte module in the build graph: ${posix}`);
	else if (inRepo && VIEW_LAYER.test(rel))
		problems.push(`view-layer module in the build graph: src/lib/${rel}`);
	else if (inRepo && !WORKER_SAFE.some((re) => re.test(rel)))
		problems.push(
			`module outside the Worker-safe set in the build graph: ${path.relative(ROOT, id)}`
		);
}
for (const ext of externals) problems.push(`unresolved import left in the bundle: ${ext}`);

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const bytes = Buffer.byteLength(code);
const gzip = gzipSync(code).length;
console.log(`check:worker — ${path.relative(ROOT, ENTRY)} bundled for a Worker target`);
console.log(
	`  modules: ${ids.length} loaded (${ids.length - shaken} bundled, ${shaken} tree-shaken)`
);
console.log(`  bytes:   ${bytes} (${kib(bytes)}), gzip ${gzip} (${kib(gzip)})`);
for (const [group, n] of [...groups].sort((a, b) => b[1] - a[1])) {
	console.log(`    ${String(n).padStart(3)}  ${group}`);
}
if (problems.length > 0) {
	console.error(`\ncheck:worker FAILED — the CRDT entry is not Worker-safe:`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log('  OK: no svelte, no view-layer, no unresolved imports');
