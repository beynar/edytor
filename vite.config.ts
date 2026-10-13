import { sveltekit } from '@sveltejs/kit/vite';
import { edytorAlias } from './edytor-alias';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

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
