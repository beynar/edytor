import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Minimal real consumer build config: a vite app that imports `edytor`
 * (the packed tarball — component surface + plugins) and compiles the
 * shipped `.svelte` sources through vite-plugin-svelte, exactly like a
 * downstream Svelte consumer would. `dedupe` keeps a single svelte
 * instance across the consumer and the tarball's peer dependency.
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
	// The SSR bundle must inline `edytor` so its .svelte sources are
	// compiled by this build instead of being import()ed at runtime
	// (plain node cannot load .svelte — the documented boundary).
	ssr: {
		noExternal: ['edytor']
	}
});
