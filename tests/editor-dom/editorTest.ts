import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resetNativeEditingState } from './helpers';
import { collectObserverShadow, installObserverShadow } from '../observerShadow';

export const test = base.extend<{ page: Page }>({
	page: async ({ page }, use, testInfo) => {
		await installObserverShadow(page);
		try {
			await resetNativeEditingState(page);
			await use(page);
		} finally {
			if (!page.isClosed()) {
				await collectObserverShadow(page, `${testInfo.file.split('/').pop()} › ${testInfo.title}`);
				await resetNativeEditingState(page);
			}
		}
	}
});

export { expect };
export type { Page };
