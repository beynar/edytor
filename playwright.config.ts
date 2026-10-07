import { devices, type PlaywrightTestConfig } from '@playwright/test';

// The cdp lane (plan §8 "Lanes"): Chromium driven through the DevTools IME
// path (`tests/editor-dom/cdp.ts`). Its specs are `*.cdp.spec.ts`, run only by
// the `cdp` project and excluded from every other project.
const CDP_SPEC = /\.cdp\.(test|spec)\.[jt]s$/;
// Lanes with their own runners: `tests/do` (vitest-pool-workers, `pnpm test:do`)
// and `tests/hosted` (Miniflare-hosted Playwright, `pnpm test:hosted`).
const OWN_LANES = /tests\/(do|hosted)\//;
/** `PW_PORT` lets worktrees run the browser lanes side by side (default 4173). */
const port = Number(process.env.PW_PORT ?? 4173);

const config: PlaywrightTestConfig = {
	workers: 2,
	webServer: {
		command: `env -u FORCE_COLOR -u NO_COLOR pnpm build:app && env -u FORCE_COLOR -u NO_COLOR pnpm preview --host 127.0.0.1 --port ${port}`,
		port,
		reuseExistingServer: !process.env.CI
	},
	testIgnore: [/editor-dst/, OWN_LANES],
	use: {
		baseURL: `http://127.0.0.1:${port}`
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: [/mobile-.+\.(test|spec)\.[jt]s/, /editor-dst/, CDP_SPEC, OWN_LANES],
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'firefox',
			testIgnore: [/mobile-.+\.(test|spec)\.[jt]s/, /editor-dst/, CDP_SPEC, OWN_LANES],
			use: { ...devices['Desktop Firefox'] }
		},
		{
			name: 'webkit',
			testIgnore: [/mobile-.+\.(test|spec)\.[jt]s/, /editor-dst/, CDP_SPEC, OWN_LANES],
			retries: 1,
			use: { ...devices['Desktop Safari'] }
		},
		{
			name: 'mobile-chromium',
			testMatch: /mobile-.+\.(test|spec)\.[jt]s/,
			testIgnore: [CDP_SPEC, OWN_LANES],
			use: { ...devices['Pixel 5'] }
		},
		{
			name: 'mobile-webkit',
			testMatch: /mobile-.+\.(test|spec)\.[jt]s/,
			testIgnore: [CDP_SPEC, OWN_LANES],
			use: { ...devices['iPhone 13'] }
		},
		{
			name: 'cdp',
			testMatch: CDP_SPEC,
			testIgnore: OWN_LANES,
			use: { ...devices['Desktop Chrome'] }
		}
	],
	testDir: 'tests',
	testMatch: /(.+\.)?(test|spec)\.[jt]s/
};

export default config;
