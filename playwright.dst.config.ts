import { defineConfig } from '@playwright/test';

export default defineConfig({
	workers: 1,
	fullyParallel: false,
	testDir: 'tests/editor-dst',
	testMatch: /(.+\.)?(test|spec)\.[jt]s/,
	timeout: 300_000,
	expect: {
		timeout: 10_000
	},
	webServer: {
		command: 'env -u FORCE_COLOR -u NO_COLOR node tests/editor-dst/start-preview.mjs',
		port: 4183,
		reuseExistingServer: false,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 }
	},
	use: {
		baseURL: 'http://127.0.0.1:4183'
	}
});
