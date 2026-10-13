import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
	resolve: {
		alias: edytorAlias,
		conditions: ['browser']
	},
	test: {
		include: ['src/tests/fixtures/dom/**/*.{test,spec}.{js,ts,tsx}'],
		environment: 'jsdom',
		setupFiles: [
			'src/tests/setup/engine-reads.ts',
			'src/tests/setup/index-checks.ts',
			'src/tests/dom/setup.ts'
		],
		css: true,
		testTimeout: 1000000
	}
});
