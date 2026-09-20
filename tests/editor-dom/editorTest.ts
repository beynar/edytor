import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resetNativeEditingState } from './helpers';

export const test = base.extend<{ page: Page }>({
	page: async ({ page }, use) => {
		try {
			await resetNativeEditingState(page);
			await use(page);
		} finally {
			if (!page.isClosed()) {
				await resetNativeEditingState(page);
			}
		}
	}
});

export { expect };
export type { Page };
