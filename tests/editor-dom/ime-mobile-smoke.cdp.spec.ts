import { devices } from '@playwright/test';

import { openIme, readBlockText } from './cdp';
import { expect, test } from './editorTest';
import {
	expectSelection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * The three Chromium CDP IME smoke tests that used to live in
 * `mobile-composition.spec.ts` (mobile-chromium project), ported onto the cdp
 * harness unchanged in intent and assertions. They keep the Pixel 5 emulation
 * they were written under; `defaultBrowserType` is a worker option and the cdp
 * project is Chromium already.
 */
const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];

test.describe('cdp IME smoke under mobile emulation', () => {
	test.use(pixel5);

	test('commits Chromium CDP IME composition under mobile emulation', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const ime = await openIme(page);
		await ime.compose('ｓ', { selectionStart: 1 });
		await ime.compose('す', { selectionStart: 1 });
		await ime.compose('すし', { selectionStart: 2 });
		await ime.commit('すし');
		await ime.detach();

		await expect.poll(() => readBlockText(page, 0)).toBe('すし');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps Chromium CDP IME delete-and-reinsert composition to one commit', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const ime = await openIme(page);
		await ime.compose('ｋ', { selectionStart: 1 });
		await ime.compose('', { selectionStart: 0 });
		await ime.compose('か', { selectionStart: 1 });
		await ime.commit('か');
		await ime.detach();

		await expect.poll(() => readBlockText(page, 0)).toBe('か');
		await expect(page.locator('[data-edytor-text="true"]').first()).toHaveText('か');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('cancels Chromium CDP IME composition without committing preview text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const ime = await openIme(page);
		await ime.compose('に', { selectionStart: 1 });
		await ime.cancel();
		await ime.detach();

		await expect.poll(() => readBlockText(page, 0)).toBe('');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
