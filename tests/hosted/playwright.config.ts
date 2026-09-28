import { devices, defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm test:hosted` — real browsers editing one document through the room
 * Durable Object (`edytor/cloudflare`, src/lib/cloudflare) hosted by Miniflare on 127.0.0.1:4195,
 * over real WebSockets. The app is the SvelteKit dev server on 4196 serving
 * the `/test/dom?scenario=collab&collabws=…` route (real `WebsocketProvider`
 * + IndexedDB persistence). Run one engine at a time:
 *   pnpm test:hosted --project=chromium --reporter=line
 */
const root = fileURLToPath(new URL('../../', import.meta.url));

export const HOSTED_ORIGIN = 'http://127.0.0.1:4195';
const APP_ORIGIN = 'http://127.0.0.1:4196';

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	workers: 1,
	fullyParallel: false,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	outputDir: '../../.artifacts/hosted/test-results',
	use: { baseURL: APP_ORIGIN, trace: 'retain-on-failure' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	],
	webServer: [
		{
			command: 'node tests/hosted/start.mjs',
			cwd: root,
			url: `${HOSTED_ORIGIN}/health`,
			reuseExistingServer: false,
			timeout: 60_000
		},
		{
			command:
				'env -u FORCE_COLOR -u NO_COLOR pnpm exec vite dev --host 127.0.0.1 --port 4196 --strictPort',
			cwd: root,
			url: `${APP_ORIGIN}/test/dom?scenario=collab`,
			// Surfaces dev-server events (e.g. a dependency re-optimization reload) in the run log.
			stdout: 'pipe',
			reuseExistingServer: false,
			timeout: 120_000
		}
	]
});
