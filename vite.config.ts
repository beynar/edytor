import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * The registry's source (`registry/`) imports the package by its published
 * name, as the app it is copied into does: here that name is src/lib.
 */
const edytorAlias = [
	{ find: /^edytor$/, replacement: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url)) },
	{
		find: /^edytor\/themes\/(.*)$/,
		replacement: fileURLToPath(new URL('./src/lib/themes/$1', import.meta.url))
	}
];

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	resolve: { alias: edytorAlias },
	// The shadcn-svelte registry's source (`registry/`) the demo and the tests render.
	server: { fs: { allow: ['registry'] } },
	build: {
		rolldownOptions: {
			checks: {
				pluginTimings: false
			}
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
		setupFiles: ['src/tests/setup/engine-reads.ts', 'src/tests/setup/index-checks.ts'],
		exclude: ['src/tests/dom/**/*', 'src/tests/fixtures/dom/**/*'],
		testTimeout: 1000000
	}
});
