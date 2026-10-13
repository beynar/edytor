import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { edytorAlias } from './edytor-alias';
import { defineConfig } from 'vitest/config';

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
