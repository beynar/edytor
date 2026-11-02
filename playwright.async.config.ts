import type { PlaywrightTestConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The async lanes: the same projects and rows, the app built with Svelte's
 * async mode (`experimental.async`, `EDYTOR_SVELTE_ASYNC=1` in
 * `svelte.config.js`). An app that turns it on switches the scheduling of
 * every component, the editor's included. `PW_ASYNC_PORT` (default 4174)
 * keeps it beside the default build. The build writes `.svelte-kit-async`;
 * the tsconfig extends `.svelte-kit`, which a plain `svelte-kit sync` writes
 * first (a fresh checkout has none).
 */
const port = Number(process.env.PW_ASYNC_PORT ?? 4174);
const env = 'env -u FORCE_COLOR -u NO_COLOR EDYTOR_SVELTE_ASYNC=1';

const config: PlaywrightTestConfig = {
	...base,
	webServer: {
		command: `pnpm exec svelte-kit sync && ${env} pnpm build:app && ${env} pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
		port,
		reuseExistingServer: !process.env.CI
	},
	use: { ...base.use, baseURL: `http://127.0.0.1:${port}` }
};

export default config;
