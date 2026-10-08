import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resetNativeEditingState } from './helpers';
import { assertTruth } from '../truthCheck';

/** The equation plugin's default KaTeX: jsDelivr's copy of the package's `dist`, any version. */
export const KATEX_CDN_ROUTE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^/]+\/dist\/(.+)$/;

const TYPES: Record<string, string> = {
	mjs: 'text/javascript',
	js: 'text/javascript',
	css: 'text/css',
	woff2: 'font/woff2',
	woff: 'font/woff',
	ttf: 'font/ttf'
};

/**
 * The CDN served offline: the installed `katex` package's `dist` files, with
 * the CORS header jsDelivr sends (a module and a font from another origin).
 */
export const serveKatex = async (route: Route) => {
	const path = KATEX_CDN_ROUTE.exec(route.request().url())?.[1] ?? '';
	const body = await readFile(join('node_modules/katex/dist', path)).catch(() => null);
	if (!body || path.includes('..')) return route.fulfill({ status: 404 });
	await route.fulfill({
		status: 200,
		body,
		headers: {
			'content-type': TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream',
			'access-control-allow-origin': '*'
		}
	});
};

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
		// Equations draw with KaTeX from its CDN (the plugin's default), served
		// from the installed package: no row depends on the network.
		await page.route(KATEX_CDN_ROUTE, serveKatex);
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
