import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default [
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
			// vendored upstream source + its test suite are not held to repo lint rules
			'src/lib/crdt/vendor/**',
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
