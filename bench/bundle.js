#!/usr/bin/env node
/**
 * U11 bundle measurement — what a consumer actually pulls.
 *
 *   node bench/bundle.js            # requires `pnpm package` to have run
 *
 * Bundles the packed `dist/` entries with rolldown (the bundler Vite 8 ships)
 * and reports minified + gzip + brotli bytes plus which vendored engine
 * modules survive treeshaking for each entry:
 *
 *   edytor            — dist/index.js (editor + crdt layer; svelte/deps external)
 *   edytor/crdt       — the vendored engine namespace (`import * as Y`)
 *   edytor/crdt/edytor— the engine-injected app CRDT layer (no engine itself)
 *   used-surface      — only the engine symbols src/lib actually calls, to
 *                       quantify the shipped-but-unreferenced engine surface
 *   combined          — edytor + edytor/crdt (a real consumer's full pull)
 *
 * Writes bench/results/bundle-<stamp>.json and refreshes bundle-latest.json.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

// rolldown is the bundler vite 8 ships; resolve it through vite's own tree
// (it is a transitive dep, not a direct one).
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
let rolldown = null;
try {
	const vitePkg = req.resolve('vite/package.json');
	const viteDir = vitePkg.slice(0, vitePkg.lastIndexOf('/'));
	const rdEntry = req.resolve('rolldown', { paths: [viteDir] });
	({ rolldown } = await import(rdEntry));
} catch {
	// fall back to a direct resolution (works if rolldown is ever hoisted)
	({ rolldown } = await import('rolldown').catch(() => ({ rolldown: null })));
}
if (!rolldown) {
	console.error('rolldown not resolvable — run from the repo root with vite installed');
	process.exit(1);
}

if (!existsSync(`${ROOT}dist/index.js`)) {
	console.error('dist/ missing — run `pnpm package` first');
	process.exit(1);
}

const sizes = (code) => ({
	min: code.length,
	gzip: gzipSync(code, { level: 9 }).length,
	brotli: brotliCompressSync(code, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
	}).length
});

// dist ships raw .svelte sources for the consumer's plugin to compile —
// replicate that with svelte/compiler so 'edytor' measures the real pull.
const { compile: compileSvelte } = await import('svelte/compiler');
const sveltePlugin = {
	name: 'measure-svelte',
	// consumer bundles handle CSS outside the JS graph — stub the imports
	resolveId: {
		filter: { id: /\.css$/ },
		handler(id) {
			return { id: `measure:css-stub`, external: false, moduleSideEffects: false };
		}
	},
	load: {
		filter: { id: /^measure:css-stub$/ },
		handler() {
			return { code: 'export default {}' };
		}
	},
	transform: {
		filter: { id: /\.svelte$/ },
		async handler(code, id) {
			const out = compileSvelte(code, {
				filename: id,
				generate: 'client',
				css: 'external',
				dev: false
			});
			return { code: out.js.code, map: out.js.map };
		}
	}
};

const bundle = async (input, { external } = {}) => {
	const b = await rolldown({ input, external, plugins: [sveltePlugin] });
	const out = await b.generate({ format: 'esm', minify: true });
	const code = out.output.map((o) => o.code ?? '').join('\n');
	// module list from an unminified pass for attribution
	const b2 = await rolldown({ input, external, plugins: [sveltePlugin] });
	const out2 = await b2.generate({ format: 'esm' });
	const modules = Object.keys(out2.output[0].modules ?? {});
	return { ...sizes(code), modules };
};

const VENDOR = 'crdt/vendor/yjs/src/';
const vendorModules = (mods) =>
	mods.filter((m) => m.includes(VENDOR)).map((m) => m.slice(m.indexOf(VENDOR) + VENDOR.length));

const EXTERNALS = [
	/^svelte(\/.*)?$/,
	/^esm-env$/,
	/^@tanstack\/highlight/,
	/^@atlaskit\//,
	/^lib0-v14$/ // the engine pulls lib0-v14/* subpaths — those stay bundled below
];

const entries = {
	'edytor/crdt': `${ROOT}dist/crdt/vendor/yjs/src/index.js`,
	'edytor/crdt/edytor': `${ROOT}dist/crdt/index.js`,
	edytor: `${ROOT}dist/index.js`
};

// The exact engine symbols referenced by shipped src/lib (grep-verified):
// Doc, Node, UndoManager, transact, applyUpdate, encodeStateAsUpdate,
// encodeStateVector + the relative-position helpers used by text anchors.
const usedSurfaceEntry = `
import * as Y from '${ROOT}dist/crdt/vendor/yjs/src/index.js';
export const used = [
	Y.Doc, Y.Node, Y.UndoManager, Y.transact,
	Y.applyUpdate, Y.encodeStateAsUpdate, Y.encodeStateVector,
	Y.createRelativePositionFromTypeIndex, Y.createRelativePositionFromJSON,
	Y.createAbsolutePositionFromRelativePosition, Y.relativePositionToJSON
];
`;

const combinedEntry = `
import * as Y from '${ROOT}dist/crdt/vendor/yjs/src/index.js';
import { bindCrdt } from '${ROOT}dist/index.js';
export const app = bindCrdt(Y);
`;

const report = { date: new Date().toISOString(), entries: {} };
mkdirSync(RESULTS_DIR, { recursive: true });

for (const [name, input] of Object.entries(entries)) {
	const r = await bundle(input, { external: EXTERNALS });
	report.entries[name] = {
		min: r.min,
		gzip: r.gzip,
		brotli: r.brotli,
		moduleCount: r.modules.length,
		vendorModules: vendorModules(r.modules)
	};
	console.log(
		`${name.padEnd(22)} min ${r.min}B · gzip ${r.gzip}B · brotli ${r.brotli}B · ${r.modules.length} modules`
	);
}

{
	const tmp = `${RESULTS_DIR}/.used-surface-entry.mjs`;
	writeFileSync(tmp, usedSurfaceEntry);
	const r = await bundle(tmp);
	report.entries['used-surface'] = {
		min: r.min,
		gzip: r.gzip,
		brotli: r.brotli,
		moduleCount: r.modules.length,
		vendorModules: vendorModules(r.modules),
		note: 'only the engine symbols shipped src/lib references — quantifies tree-shakeable dead surface in edytor/crdt'
	};
	console.log(
		`${'used-surface'.padEnd(22)} min ${r.min}B · gzip ${r.gzip}B · brotli ${r.brotli}B · ${r.modules.length} modules`
	);
}

{
	const tmp = `${RESULTS_DIR}/.combined-entry.mjs`;
	writeFileSync(tmp, combinedEntry);
	const r = await bundle(tmp, { external: EXTERNALS });
	report.entries['combined'] = {
		min: r.min,
		gzip: r.gzip,
		brotli: r.brotli,
		moduleCount: r.modules.length,
		vendorModules: vendorModules(r.modules),
		note: 'import * as Y + bindCrdt — the documented consumer construction'
	};
	console.log(
		`${'combined'.padEnd(22)} min ${r.min}B · gzip ${r.gzip}B · brotli ${r.brotli}B · ${r.modules.length} modules`
	);
}

const stamp = report.date.replaceAll(':', '-').replaceAll('.', '-');
const file = `${RESULTS_DIR}/bundle-${stamp}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
writeFileSync(`${RESULTS_DIR}/bundle-latest.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`\nbundle report → ${file}`);
