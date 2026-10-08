import { KATEX_CDN_ROUTE, expect, test, type Page } from './editorTest';

import {
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

type Value = {
	children: Array<{
		type: string;
		data?: Record<string, unknown>;
		content?: Array<{ text?: string; type?: string; data?: Record<string, unknown> }>;
	}>;
};
const value = (page: Page) => readJsonByTestId<Value>(page, 'value');

/**
 * WU-23 — equations drawn by KaTeX, loaded lazily (Notion): a click on one
 * opens its TeX source under it, each keystroke redraws it, Enter closes
 * it; `$$…$$` typed in text is an inline equation. The model rows are
 * `equation.test.tsx`.
 */
test.describe('equations', () => {
	test('KaTeX draws them; a click edits the source live; Enter closes', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=equation&equation=1');
		await expect.poll(async () => (await value(page)).children[1]?.type).toBe('equation');
		const block = page.locator('[data-edytor-equation]');
		await expect(block.locator('.katex-display')).toBeVisible();
		await expect(page.locator('[data-edytor-inline-equation] .katex')).toBeVisible();

		await block.click();
		const field = page.locator('[data-edytor-equation-editor] textarea');
		await expect(field).toBeFocused();
		await expect(field).toHaveValue('a+b');
		await page.keyboard.type('+c');
		await expect(block.locator('annotation')).toHaveText('a+b+c');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor-equation-editor]')).toHaveCount(0);
		await expect
			.poll(async () => (await value(page)).children[1]?.data)
			.toEqual({ expression: 'a+b+c' });
		issues.assertClean();
	});

	test('an inline equation opens on a click; $$…$$ typed in text makes one', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=equation&equation=1');
		await page.locator('[data-edytor-inline-equation]').click();
		const field = page.locator('[data-edytor-equation-editor] textarea');
		await expect(field).toHaveValue('x^2');
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-edytor-equation-editor]')).toHaveCount(0);

		// "tail": the last text.
		await setSelectionByTextIndex(page, 2, 4);
		await page.keyboard.type(' $$y_1$$');
		await expect
			.poll(async () => (await value(page)).children[2]?.content)
			.toEqual([
				{ text: 'tail ' },
				expect.objectContaining({ type: 'inlineEquation', data: { expression: 'y_1' } })
			]);
		await expect(page.locator('[data-edytor-inline-equation] .katex')).toHaveCount(2);
		issues.assertClean();
	});
});

/**
 * `katex.cdn` — KaTeX from jsDelivr, the plugin's default: the first
 * equation drawn imports KaTeX's module and adds its stylesheet once to the
 * page's head; the app bundles neither. The fixture serves the CDN from the
 * installed package (`serveKatex`); a CDN that fails leaves the source.
 */
test.describe('equations: KaTeX from the CDN', () => {
	test('the demo draws with KaTeX from jsDelivr: one module, one stylesheet, styled', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const fetched: string[] = [];
		page.on('request', (request) => {
			if (KATEX_CDN_ROUTE.test(request.url())) fetched.push(request.url().split('/dist/')[1]!);
		});
		await page.goto('/');
		const equation = page.locator('[data-edytor-id="page-equation"] [data-edytor-equation]');
		await expect(equation.locator('.katex-display')).toBeVisible();
		await expect(page.locator('[data-edytor-id="page-math"] .katex')).toBeVisible();
		await expect(page.locator('head link[data-edytor-katex]')).toHaveCount(1);
		expect(fetched.filter((path) => path === 'katex.mjs')).toHaveLength(1);
		expect(fetched.filter((path) => path === 'katex.min.css')).toHaveLength(1);
		// Its stylesheet applies: KaTeX's own font, the MathML kept for readers only.
		await expect
			.poll(() =>
				equation
					.locator('.katex')
					.first()
					.evaluate((node) => getComputedStyle(node).fontFamily)
			)
			.toContain('KaTeX_Main');
		await expect(equation.locator('.katex-mathml').first()).toHaveCSS('position', 'absolute');
		issues.assertClean();
	});

	test('a CDN that fails leaves each equation showing its TeX source', async ({ page }) => {
		const issues = trackPageIssues(page, {
			// The engine's own report of the refused fetch, and the plugin's.
			ignoreConsoleErrors: [
				/KaTeX failed to load/,
				/Failed to load resource|net::ERR_FAILED|Cross-Origin Request Blocked/
			]
		});
		await page.route(KATEX_CDN_ROUTE, (route) => route.abort());
		const failed = page.waitForEvent('console', (message) =>
			message.text().includes('KaTeX failed to load')
		);
		await gotoEditorRoute(page, '/test/dom?scenario=equation&equation=1');
		await failed;
		const block = page.locator('[data-edytor-equation]');
		await expect(block.locator('[data-edytor-equation-source]')).toHaveText('a+b');
		await expect(page.locator('.katex')).toHaveCount(0);
		issues.assertClean();
	});
});
