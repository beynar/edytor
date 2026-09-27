import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resetNativeEditingState } from './helpers';
import { assertTruth } from '../truthCheck';

export const test = base.extend<{ page: Page }>({
	page: async ({ page }, use, testInfo) => {
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
