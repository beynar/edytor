import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Worker-safe CRDT boundary ─────────────────────────────────────────────
//
// The CRDT engine + sync layer (`src/lib/crdt`, vendored engine included)
// also runs server-side in a Cloudflare Durable Object, so everything the
// `edytor/crdt/edytor` entry pulls in must stay importable WITHOUT Svelte,
// SvelteKit or the editor's view layers. `WORKER_SAFE` is that module set
// (the crdt entry's whole in-repo import closure — `pnpm check:worker`
// re-proves it by bundling the entry for a Worker target). Inside it:
//
// - `no-restricted-imports` names the forbidden specifiers (svelte,
//   `$app/*`, `*.svelte`, `*.svelte.ts/js`, the view layers by `$lib` path);
// - `edytor/worker-safe-imports` resolves every relative/`$lib` specifier
//   (static, re-export and dynamic `import()`) and allows only targets that
//   are themselves in `WORKER_SAFE`, and only the audited bare packages.
//
// Growing the set: add the module to `WORKER_SAFE` (it then falls under
// the same rules) — never import a view module from the engine.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(ROOT, 'src/lib');
const WORKER_SAFE = [
	'src/lib/crdt/**/*.{js,ts}',
	'src/lib/utils/json.ts',
	'src/lib/utils.ts',
	'src/lib/constants.ts'
];
const WORKER_SAFE_FILES = [
	/^crdt\//,
	/^utils\/json\.[jt]s$/,
	/^utils\.[jt]s$/,
	/^constants\.[jt]s$/
];
const WORKER_SAFE_PACKAGES = [/^lib0-v14(\/|$)/, /^esm-env$/];
const VIEW_LAYERS =
	'components|selection|surface|session|events|block|text|plugins|hotkeys|clipboard|collaboration|dnd';
const VIEW_LAYER = new RegExp(`^(${VIEW_LAYERS})(\\/|\\.|$)|^edytor[^/]*\\.[jt]s$`);
const SVELTE_MODULE = /\.svelte(\.[jt]s)?$/;

const workerSafeImports = {
	meta: {
		type: 'problem',
		docs: { description: 'Keep the Worker-safe CRDT boundary free of Svelte/view imports' },
		schema: []
	},
	create(context) {
		const check = (node) => {
			const source = node.source;
			if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
			const spec = source.value;
			const report = (why) =>
				context.report({
					node: source,
					message: `Worker-safe boundary: "${spec}" ${why}. src/lib/crdt runs in a Cloudflare Durable Object — see README "Server coordinator".`
				});
			let target;
			if (spec.startsWith('.')) target = path.resolve(path.dirname(context.filename), spec);
			else if (spec === '$lib' || spec.startsWith('$lib/')) target = path.join(LIB, spec.slice(4));
			else {
				if (!WORKER_SAFE_PACKAGES.some((re) => re.test(spec))) {
					report('is not an audited Worker-safe package (lib0-v14, esm-env)');
				}
				return;
			}
			const rel = path.relative(LIB, target).split(path.sep).join('/');
			if (rel.startsWith('..')) return report('resolves outside src/lib');
			if (SVELTE_MODULE.test(rel)) return report('is a Svelte module');
			if (VIEW_LAYER.test(rel)) return report('is a view-layer module');
			if (!WORKER_SAFE_FILES.some((re) => re.test(rel))) {
				report('is outside the Worker-safe module set (WORKER_SAFE in eslint.config.js)');
			}
		};
		return {
			ImportDeclaration: check,
			ExportNamedDeclaration: check,
			ExportAllDeclaration: check,
			ImportExpression: check
		};
	}
};

const workerSafeRules = {
	'no-restricted-imports': [
		'error',
		{
			paths: [{ name: 'svelte', message: 'src/lib/crdt must stay Worker-safe (no Svelte).' }],
			patterns: [
				{
					group: ['svelte/*', '$app/*', '$env/*', '@sveltejs/*'],
					message: 'src/lib/crdt must stay Worker-safe (no Svelte/SvelteKit).'
				},
				{
					group: ['*.svelte', '*.svelte.ts', '*.svelte.js'],
					message: 'src/lib/crdt must stay Worker-safe (no Svelte modules).'
				},
				{
					regex: `^\\$lib(/(${VIEW_LAYERS})(/|\\.|$)|/edytor[^/]*$|/index(\\.[jt]s)?$|/?$)`,
					message: 'src/lib/crdt must stay Worker-safe (no view-layer imports).'
				}
			]
		}
	],
	'edytor/worker-safe-imports': 'error'
};
const VENDOR = 'src/lib/crdt/vendor/**';

const repoConfig = [
	{
		ignores: [
			'.DS_Store',
			'.codex/**',
			'.playwright-mcp/**',
			'.svelte-kit/**',
			'build/**',
			'dist/**',
			// generated consumer build output (tests/packed-consumer/svelte-app)
			'**/dist/**',
			'**/dist-ssr/**',
			'node_modules/**',
			'package/**',
			'package-lock.json',
			'pnpm-lock.yaml',
			'test-results/**',
			'yarn.lock',
			// the vendored upstream test suite is not held to repo lint rules
			// (the vendored SOURCE is linted by the Worker-safe block only)
			'vendor-tests/**',
			// generated pristine-vendor copy materialized by bench/lib/mk-baseline.sh
			// for differential/interop lanes (gitignored, recreated on demand)
			'bench/vendor-baseline/**'
		]
	},
	js.configs.recommended,
	{
		files: ['**/*.{js,mjs,cjs,ts,tsx}'],
		languageOptions: {
			ecmaVersion: 2022,
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2022
			},
			parser: tsParser,
			parserOptions: {
				sourceType: 'module'
			}
		},
		plugins: {
			'@typescript-eslint': tsPlugin
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-namespace': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'no-empty-pattern': 'off',
			'no-import-assign': 'off',
			'no-undef': 'off',
			'no-unused-expressions': 'off',
			'no-unused-vars': 'off',
			'no-unsafe-optional-chaining': 'off'
		}
	},
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2022
			},
			parser: tsParser,
			parserOptions: {
				sourceType: 'module'
			}
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: tsParser
			}
		},
		rules: {
			'no-undef': 'off',
			'no-unused-vars': 'off',
			'svelte/no-navigation-without-resolve': 'off',
			'svelte/no-useless-mustaches': 'off'
		}
	},
	{
		rules: {
			'@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
			'@typescript-eslint/no-unused-expressions': 'off',
			'no-case-declarations': 'off',
			'no-import-assign': 'off',
			'svelte/prefer-svelte-reactivity': 'off'
		}
	},
	prettier
];

export default [
	// Vendored upstream source is not held to repo lint rules — only to the
	// Worker-safe boundary below.
	...repoConfig.map((config) =>
		Object.keys(config).length === 1 && config.ignores
			? config
			: { ...config, ignores: [...(config.ignores ?? []), VENDOR] }
	),
	{
		files: WORKER_SAFE,
		languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module' } },
		linterOptions: { reportUnusedDisableDirectives: 'off' },
		plugins: { edytor: { rules: { 'worker-safe-imports': workerSafeImports } } },
		rules: workerSafeRules
	}
];
