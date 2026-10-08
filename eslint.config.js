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
// the same rules) — never import a view module from the engine. The
// `edytor/cloudflare` room (`src/lib/cloudflare`) is in the set, and is the
// only place `cloudflare:workers` may be imported.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(ROOT, 'src/lib');
const WORKER_SAFE = [
	'src/lib/crdt/**/*.{js,ts}',
	'src/lib/cloudflare/**/*.ts',
	'src/lib/utils/json.ts',
	'src/lib/utils.ts',
	'src/lib/constants.ts'
];
const WORKER_SAFE_FILES = [
	/^crdt\//,
	/^cloudflare\//,
	/^utils\/json\.[jt]s$/,
	/^utils\.[jt]s$/,
	/^constants\.[jt]s$/
];
const WORKER_SAFE_PACKAGES = [/^lib0-v14(\/|$)/, /^esm-env$/];
const VIEW_LAYERS =
	'components|selection|surface|session|events|block|text|plugins|hotkeys|clipboard|collaboration|dnd';
const VIEW_LAYER = new RegExp(`^(${VIEW_LAYERS})(\\/|\\.|$)|^edytor[^/]*\\.[jt]s$`);
const SVELTE_MODULE = /\.svelte(\.[jt]s)?$/;

const fileRel = (context) => path.relative(LIB, context.filename).split(path.sep).join('/');

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
				const room = spec === 'cloudflare:workers' && /^cloudflare\//.test(fileRel(context));
				if (!room && !WORKER_SAFE_PACKAGES.some((re) => re.test(spec))) {
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

// ── Host writers (plan §12.5 BI2-5, R1, R11) ─────────────────────────────
//
// The contenteditable host is written by the renderer only: Svelte template
// effects and the core's attachment bodies (`components/`, the handles'
// `attach`/`void`). Chrome writes its own layer outside the host (overlay,
// plugin UI). The observer (`surface/observer`, `surface/attributes`) inverts
// foreign damage: restoring what the cells render is the renderer's write.
const HOST_MUTATION =
	'appendChild|insertBefore|removeChild|replaceChild|replaceWith|setAttribute|removeAttribute|toggleAttribute|prepend|append|remove';
const HOST_WRITERS = [
	'src/lib/components/**',
	'src/lib/text/text.svelte.ts',
	'src/lib/block/block.svelte.ts',
	'src/lib/block/inlineBlock.svelte.ts',
	'src/lib/surface/observer.svelte.ts',
	'src/lib/surface/attributes.ts',
	'src/lib/surface/overlay.ts',
	'src/lib/plugins/**',
	'src/lib/collaboration/**'
];
const hostWriterRules = {
	'no-restricted-syntax': [
		'error',
		{
			selector: `CallExpression[callee.property.name=/^(${HOST_MUTATION})$/][arguments.length<3]`,
			message:
				'Only template effects and attachment bodies write the host (BI2-5): render it from cells or declared view state.'
		},
		{
			selector:
				'AssignmentExpression[left.property.name=/^(textContent|nodeValue|innerHTML|contentEditable)$/]',
			message:
				'Only template effects and attachment bodies write the host (BI2-5): render it from cells or declared view state.'
		}
	]
};

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
			'**/dist-code/**',
			// the docs site is its own package (Blume)
			'site/**',
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
			'bench/vendor-baseline/**',
			// agent worktrees (each lints itself) and the upstream watch's report
			'.claude/**',
			'upstream-report/**'
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
		files: ['src/lib/**/*.{ts,js,svelte}'],
		ignores: [...HOST_WRITERS, 'src/lib/crdt/**', 'src/lib/cloudflare/**'],
		rules: hostWriterRules
	},
	{
		files: WORKER_SAFE,
		languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module' } },
		linterOptions: { reportUnusedDisableDirectives: 'off' },
		plugins: { edytor: { rules: { 'worker-safe-imports': workerSafeImports } } },
		rules: workerSafeRules
	},
	// ── Unused code (CC-09) ──────────────────────────────────────────────
	//
	// The library's own sources hold no unused import, variable or
	// parameter: an intentional one is named `_…` (a positional parameter
	// a callback signature requires, a destructured rest's sibling).
	{
		files: ['src/lib/**/*.{ts,js,svelte}'],
		ignores: [VENDOR],
		plugins: { '@typescript-eslint': tsPlugin },
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					args: 'after-used',
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrors: 'none',
					destructuredArrayIgnorePattern: '^_',
					ignoreRestSiblings: true
				}
			]
		}
	},
	// ── Typed rules for the transports (CC-09) ───────────────────────────
	//
	// The providers and the room live on promises (IndexedDB, sockets,
	// Durable Object storage, alarms): a promise nobody awaits or catches
	// loses its rejection, and an async function handed where a void
	// callback is expected (an event listener, `forEach`) drops it too.
	// These two rules need type information, so they run on these
	// directories only (the type-aware program costs seconds per file set).
	{
		files: ['src/lib/crdt/providers/**/*.ts', 'src/lib/cloudflare/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { sourceType: 'module', projectService: true, tsconfigRootDir: ROOT }
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			// A provider's `destroy()` overrides the observable's with a promise
			// that settles once its store closed (and never rejects): callers of
			// the base signature may drop it.
			'@typescript-eslint/no-misused-promises': [
				'error',
				{ checksVoidReturn: { inheritedMethods: false } }
			]
		}
	}
];
