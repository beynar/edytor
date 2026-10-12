// The JavaScript an app ships with edytor, measured as a consumer builds it:
// two probe apps (`<Edytor />` with its default plugins, and every plugin)
// compiled by Vite + vite-plugin-svelte against the packaged `dist/`, each
// byte of the output attributed to its source file through the source map.
//
//   node scripts/bundle-size.mjs              # both apps, top 25 sources
//   node scripts/bundle-size.mjs --top 60     # more rows
//   node scripts/bundle-size.mjs --by dir     # grouped by directory
//   node scripts/bundle-size.mjs --json out.json
//   node scripts/bundle-size.mjs --no-package # reuse the current dist/
//
// The numbers are minified bytes (Vite's default esbuild minify), gzip -9
// and brotli -11 of every emitted .js file, entry and lazy chunks apart.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { countFile } from './xloc.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { build } = await import(require.resolve('vite'));
const { svelte } = await import(require.resolve('@sveltejs/vite-plugin-svelte'));
// A dependency of the Svelte toolchain, not of edytor: found in the pnpm store.
const store = join(root, 'node_modules/.pnpm');
const sourceMapJs = readdirSync(store).find((entry) => entry.startsWith('source-map-js@'));
const { SourceMapConsumer } = require(join(store, sourceMapJs, 'node_modules/source-map-js'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at < 0 ? fallback : args[at + 1];
};
const TOP = Number(option('--top', 25));
const BY = option('--by', 'file');

/** The probe apps: what a minimal app and a full app import. */
const APPS = {
	minimal: `<script>
	import { Edytor } from 'edytor';
</script>
<Edytor />`,
	all: `<script>
	import {
		Edytor, createBlockHandlesPlugin, createBlockMenuPlugin, createSlashMenuPlugin, createToolbarPlugin,
		createCodePlugin, createColumnsPlugin, createTablePlugin, createMarkdownShortcutsPlugin, createFindPlugin,
		createTocPlugin, createEquationPlugin, createMentionPlugin, createPageLinkPlugin, createMarqueePlugin,
		createEmbedPlugin, createBookmarkPlugin, createFilePlugin, createVideoPlugin, createAudioPlugin,
		createPagePlugin, createCommentsPlugin, createArrowMovePlugin, createCalloutIconsPlugin,
		createUploadsPlugin, createMediaEmptyPlugin, createImageToolbarPlugin
	} from 'edytor';
	const plugins = [
		createBlockHandlesPlugin(), createBlockMenuPlugin(), createSlashMenuPlugin(), createToolbarPlugin(),
		createCodePlugin(), createColumnsPlugin(), createTablePlugin(), createMarkdownShortcutsPlugin(),
		createFindPlugin(), createTocPlugin(), createEquationPlugin(),
		createMentionPlugin({ search: () => [] }), createPageLinkPlugin({ search: () => [] }),
		createMarqueePlugin(), createEmbedPlugin(), createBookmarkPlugin(), createFilePlugin(),
		createVideoPlugin(), createAudioPlugin(), createPagePlugin(), createCommentsPlugin({}),
		createArrowMovePlugin(), createCalloutIconsPlugin(), createUploadsPlugin({ upload: async () => '' }),
		createMediaEmptyPlugin({ empty }), createImageToolbarPlugin({ toolbar: empty })
	];
</script>
{#snippet empty()}{/snippet}
<Edytor {plugins} />`
};

if (!flag('--no-package')) execSync('pnpm package', { cwd: root, stdio: 'ignore' });

const work = join(root, 'node_modules/.cache/bundle-size');
rmSync(work, { recursive: true, force: true });

/** A source path, shortened: `edytor/<path under src/lib>`, `svelte`, or a package name. */
const nameOf = (source) => {
	if (!source) return '(unmapped)';
	const path = source.replace(/\\/g, '/');
	// A dependency first: some keep their own files under a `dist/` folder.
	const pkg = path.match(
		/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\/(.*)$/
	);
	if (pkg) return pkg[1] === 'svelte' ? `svelte/${pkg[2]}` : `${pkg[1]}/${pkg[2]}`;
	const lib = path.match(/\/dist\/(.*)$/);
	if (lib) return `edytor/${lib[1]}`;
	return path;
};
const groupOf = (name) => {
	if (BY === 'file') return name;
	if (name.startsWith('svelte/')) return 'svelte (runtime)';
	if (name.startsWith('edytor/crdt/vendor/yjs')) return 'edytor/crdt/vendor/yjs';
	if (name.startsWith('edytor/dnd/vendor/pragmatic')) return 'edytor/dnd/vendor/pragmatic';
	const parts = name.split('/');
	if (parts[0] === 'edytor')
		return parts
			.slice(0, ['plugins', 'crdt'].includes(parts[1]) ? 3 : 2)
			.join('/')
			.replace(/\.[^/]*$/, '');
	return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const report = {};

for (const [app, svelteSource] of Object.entries(APPS)) {
	const dir = join(work, app);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'App.svelte'), svelteSource);
	writeFileSync(
		join(dir, 'main.js'),
		"import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n"
	);
	writeFileSync(
		join(dir, 'index.html'),
		'<!doctype html><script type="module" src="./main.js"></script>'
	);
	await build({
		root: dir,
		logLevel: 'error',
		configFile: false,
		plugins: [svelte()],
		resolve: { dedupe: ['svelte'], alias: { edytor: join(root, 'dist/index.js') } },
		build: {
			outDir: join(dir, 'out'),
			emptyOutDir: true,
			sourcemap: true,
			reportCompressedSize: false
		}
	});

	const assets = join(dir, 'out/assets');
	const files = readdirSync(assets).filter((file) => file.endsWith('.js'));
	const html = readFileSync(join(dir, 'out/index.html'), 'utf8');
	const totals = { min: 0, gzip: 0, brotli: 0, entry: 0, lazy: 0, chunks: files.length };
	const sources = {};
	for (const file of files) {
		const code = readFileSync(join(assets, file), 'utf8');
		const bytes = Buffer.byteLength(code);
		totals.min += bytes;
		totals.gzip += gzipSync(code, { level: 9 }).length;
		totals.brotli += brotliCompressSync(code, {
			params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
		}).length;
		totals[html.includes(file) ? 'entry' : 'lazy'] += bytes;
		const map = new SourceMapConsumer(
			JSON.parse(readFileSync(join(assets, `${file}.map`), 'utf8'))
		);
		const lines = code.split('\n');
		const segments = [];
		map.eachMapping((m) => segments.push(m), null, SourceMapConsumer.GENERATED_ORDER);
		for (let i = 0; i < segments.length; i++) {
			const at = segments[i];
			const next = segments[i + 1];
			const length =
				next && next.generatedLine === at.generatedLine
					? next.generatedColumn - at.generatedColumn
					: (lines[at.generatedLine - 1]?.length ?? 0) - at.generatedColumn;
			const name = nameOf(at.source && relative(dir, join(dir, at.source)));
			sources[name] = (sources[name] ?? 0) + Math.max(0, length);
		}
	}
	// The source lines behind the shipped edytor modules (xloc: no blanks, comments or types).
	const loc = { edytor: 0, vendor: 0, files: 0 };
	for (const name of Object.keys(sources)) {
		if (!name.startsWith('edytor/')) continue;
		const rel = name.slice('edytor/'.length);
		const base = join(root, 'src/lib', rel.replace(/\.js$/, ''));
		const file = [`${base}.ts`, `${base}.js`, join(root, 'src/lib', rel)].find(existsSync);
		if (!file) continue;
		loc[/^(crdt|dnd)\/vendor\//.test(rel) ? 'vendor' : 'edytor'] += countFile(file);
		loc.files++;
	}
	totals.loc = loc;
	// The Svelte runtime ships with any Svelte app: edytor's own cost is the rest.
	totals.svelte = Object.entries(sources)
		.filter(([name]) => name.startsWith('svelte/'))
		.reduce((sum, [, bytes]) => sum + bytes, 0);
	totals.own = totals.min - totals.svelte;
	const groups = {};
	for (const [name, bytes] of Object.entries(sources)) {
		const group = groupOf(name);
		groups[group] = (groups[group] ?? 0) + bytes;
	}
	report[app] = { totals, groups };

	console.log(
		`\n${app}: edytor's own ${kb(totals.own)} min (without the Svelte runtime ${kb(totals.svelte)}, which a Svelte app ships anyway); total ${kb(totals.min)} min (${kb(totals.entry)} entry, ${kb(totals.lazy)} lazy in ${totals.chunks - 1} chunks), ${kb(totals.gzip)} gzip, ${kb(totals.brotli)} brotli; source lines shipped: ${loc.edytor} edytor + ${loc.vendor} vendored (${loc.files} files)`
	);
	for (const [group, bytes] of Object.entries(groups)
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP))
		console.log(
			`  ${kb(bytes).padStart(9)}  ${((bytes / totals.min) * 100).toFixed(1).padStart(5)}%  ${group}`
		);
}

const out = option('--json');
if (out) writeFileSync(out, JSON.stringify(report, null, '\t'));
