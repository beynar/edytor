import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Svelte's async mode (`experimental.async`), which an app may turn on: it
 * switches the scheduling of every component, the editor's included. The
 * async lanes build with it (`EDYTOR_SVELTE_ASYNC=1`, `playwright.async.config.ts`),
 * into their own output so both builds can stand side by side.
 */
const async = process.env.EDYTOR_SVELTE_ASYNC === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),
	...(async ? { compilerOptions: { experimental: { async: true } } } : {}),

	kit: {
		...(async ? { outDir: '.svelte-kit-async' } : {}),
		// The shadcn-svelte registry's source (`registry/`, outside the
		// package). Its `edytor` imports resolve to src/lib in Vite
		// (`vite.config.ts`) and in TypeScript (`registry/edytor.d.ts`): not a
		// kit alias, which svelte-package would rewrite in the package.
		alias: {
			$registry: 'registry'
		},
		adapter: adapter({
			fallback: 'index.html'
		})
	}
};

export default config;
