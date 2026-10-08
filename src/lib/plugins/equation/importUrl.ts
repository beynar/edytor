/**
 * A module fetched by URL at run time (KaTeX from a CDN), left to the
 * browser: no bundler follows it (`@vite-ignore`, `webpackIgnore`). Its own
 * module, so a test can stand in for the network.
 */
export const importUrl = (url: string): Promise<unknown> =>
	import(/* @vite-ignore */ /* webpackIgnore: true */ url);
