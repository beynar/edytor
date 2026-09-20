import { devices, type PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
	workers: 2,
	webServer: {
		command:
			'env -u FORCE_COLOR -u NO_COLOR pnpm build:app && env -u FORCE_COLOR -u NO_COLOR pnpm preview --host 127.0.0.1 --port 4173',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: {
		baseURL: 'http://127.0.0.1:4173'
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: /mobile-.+\.(test|spec)\.[jt]s/,
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'firefox',
			testIgnore: /mobile-.+\.(test|spec)\.[jt]s/,
			use: { ...devices['Desktop Firefox'] }
		},
		{
			name: 'webkit',
			testIgnore: /mobile-.+\.(test|spec)\.[jt]s/,
			retries: 1,
			use: { ...devices['Desktop Safari'] }
		},
		{
			name: 'mobile-chromium',
			testMatch: /mobile-.+\.(test|spec)\.[jt]s/,
			use: { ...devices['Pixel 5'] }
		},
		{
			name: 'mobile-webkit',
			testMatch: /mobile-.+\.(test|spec)\.[jt]s/,
			use: { ...devices['iPhone 13'] }
		}
	],
	testDir: 'tests',
	testMatch: /(.+\.)?(test|spec)\.[jt]s/
};

export default config;
