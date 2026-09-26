import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Bench fixture-app build. `bench/browser-app/node_modules` is a symlink to
 * `tests/packed-consumer/node_modules`, so `edytor` resolves to the packed
 * tarball install and `svelte`/`vite-plugin-svelte` are the consumer's own
 * versions — the same resolution a real downstream consumer gets.
 * `dedupe` keeps a single svelte instance across app + edytor's peer dep.
 */
export default defineConfig({
	plugins: [svelte()],
	resolve: {
		dedupe: ['svelte']
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true
	},
	ssr: {
		noExternal: ['edytor']
	}
});
