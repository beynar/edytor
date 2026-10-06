import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	build: {
		rolldownOptions: {
			checks: {
				pluginTimings: false
			}
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
		setupFiles: ['src/tests/setup/index-checks.ts'],
		exclude: ['src/tests/dom/**/*', 'src/tests/fixtures/dom/**/*'],
		testTimeout: 1000000
	}
});
