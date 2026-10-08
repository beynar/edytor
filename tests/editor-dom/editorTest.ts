import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resetNativeEditingState } from './helpers';
import { assertTruth } from '../truthCheck';

export const test = base.extend<{ page: Page }>({
	page: async ({ page, browserName }, use, testInfo) => {
		// Playwright resolves `ControlOrMeta` (and the specs' `modKey`) by the
		// host's platform, while an emulated Safari or iPhone tells the page it
		// runs on a Mac, whose `mod` is Meta: on a host that is no Mac the page
		// reports the host's platform, so its `mod` is the key a spec presses (a
		// Mac's Safari keeps Meta).
		if (browserName === 'webkit' && process.platform !== 'darwin')
			await page.addInitScript(() =>
				Object.defineProperty(Navigator.prototype, 'platform', {
					get: () => 'Linux x86_64',
					configurable: true
				})
			);
		await resetNativeEditingState(page);
		await use(page);
		// F-O10: a test that passed leaves a host equal to its cells.
		if (
			!page.isClosed() &&
			testInfo.status === testInfo.expectedStatus &&
			testInfo.expectedStatus === 'passed'
		)
			await assertTruth(page, `${testInfo.file.split('/').pop()} › ${testInfo.title}`);
		if (!page.isClosed()) await resetNativeEditingState(page);
	}
});

export { expect };
export type { Page };
