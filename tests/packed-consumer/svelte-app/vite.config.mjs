import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * A consumer's default config: a vite app that imports `edytor` (the packed
 * tarball) with `svelte()` and nothing else. No `resolve.dedupe`, no
 * `ssr.noExternal`, no `optimizeDeps`: vite-plugin-svelte compiles the
 * package's `.svelte` files (its `svelte` export condition) on the client and
 * in the SSR build. A change that needs a setting here fails this smoke.
 */
export default defineConfig({
	plugins: [svelte()],
	build: {
		outDir: 'dist',
		emptyOutDir: true
	}
});
