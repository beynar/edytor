import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
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
