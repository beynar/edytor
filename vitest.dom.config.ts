import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	resolve: {
		conditions: ['browser']
	},
	test: {
		include: ['src/tests/fixtures/dom/**/*.{test,spec}.{js,ts,tsx}'],
		environment: 'jsdom',
		setupFiles: ['src/tests/dom/setup.ts'],
		css: true,
		testTimeout: 1000000
	}
});
