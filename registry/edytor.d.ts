/**
 * In this repository the registry's `edytor` imports are the package's
 * source (`src/lib`), as `vite.config.ts` resolves them; in an app they are
 * the installed package.
 */
declare module 'edytor' {
	export * from '$lib/index.js';
}
declare module 'edytor/themes/notion.css';
