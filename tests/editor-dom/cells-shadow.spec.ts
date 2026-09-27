import { expect, type Page } from '@playwright/test';

import { test } from './editorTest';
import {
	getTextLocators,
	gotoEditorRoute,
	modKey,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

/**
 * arch-v2 R1 — render cells next to the mirror in a real browser (plan §9.3
 * R1, §9.1 rule 3). The route keeps a cell tree patched only from change
 * reports (`/test/dom?cells=shadow`); after every settled step the render
 * model the cells give is compared with what the mirror renders, and the
 * cells with a from-scratch build. Every difference must match a §8 class
 * (`src/tests/oracles/cells-render-model.ts`).
 */

type Verdict = { differences: number; byClass: Record<string, number>; unexplained: unknown[] };

const settle = (page: Page) =>
	page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
	);

const compareCells = async (page: Page, step: string, census: Record<string, number>) => {
	await settle(page);
	const verdict = await page.evaluate(
		() => (window as Window & { __EDYTOR_CELLS__?: () => Verdict }).__EDYTOR_CELLS__?.() ?? null
	);
	expect(verdict, `cells shadow is mounted (${step})`).not.toBeNull();
	expect(verdict!.unexplained, `unexplained differences after "${step}"`).toEqual([]);
	for (const [name, n] of Object.entries(verdict!.byClass)) census[name] = (census[name] ?? 0) + n;
};

const open = async (page: Page, scenario: string) =>
	gotoEditorRoute(page, `/test/dom?scenario=${scenario}&cells=shadow`, { requireRuntime: true });

const caretAtEnd = async (page: Page, index: number) => {
	const length = await getTextLocators(page)
		.nth(index)
		.evaluate((el) => (el.textContent ?? '').replaceAll('​', '').length);
	await setSelectionByTextIndex(page, index, length);
};

test.describe('R1 render cells beside the mirror', () => {
	test('typing, Enter, Backspace, Tab, marks, undo and redo', async ({ page }) => {
		const issues = trackPageIssues(page);
		const census: Record<string, number> = {};
		await open(page, 'basic');
		await compareCells(page, 'mount', census);

		await caretAtEnd(page, 1);
		await page.keyboard.type('book');
		await compareCells(page, 'type', census);
		await page.keyboard.press('Enter');
		await compareCells(page, 'Enter at end', census);
		await page.keyboard.type('fresh line');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Enter');
		await compareCells(page, 'Enter in the middle', census);
		await page.keyboard.press('Home');
		await page.keyboard.press('Backspace');
		await compareCells(page, 'Backspace merge', census);
		await page.keyboard.press('Tab');
		await compareCells(page, 'Tab nest', census);
		await page.keyboard.press('Shift+Tab');
		await compareCells(page, 'Shift+Tab unnest', census);
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.press(`${modKey}+b`);
		await compareCells(page, 'bold', census);
		await page.keyboard.press(`${modKey}+z`);
		await compareCells(page, 'undo', census);
		await page.keyboard.press(`${modKey}+Shift+z`);
		await compareCells(page, 'redo', census);
		await page.keyboard.press(`${modKey}+a`);
		await page.keyboard.press(`${modKey}+a`);
		await page.keyboard.press('Backspace');
		await compareCells(page, 'select all, delete', census);
		await page.keyboard.type('again');
		await compareCells(page, 'type after delete', census);

		expect(census).toEqual({});
		issues.assertClean();
	});

	test('marks, inline atoms, lists and code', async ({ page }) => {
		const issues = trackPageIssues(page);
		const census: Record<string, number> = {};

		await open(page, 'marks');
		await compareCells(page, 'marks mount', census);
		await setSelectionByTextIndex(page, 0, 3);
		await page.keyboard.type('xy');
		await page.keyboard.press('Enter');
		await compareCells(page, 'type and split inside a mark', census);
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await compareCells(page, 'merge back and delete', census);

		await open(page, 'inline');
		await compareCells(page, 'inline mount', census);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.type('ab');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await compareCells(page, 'delete across the atom', census);
		await page.keyboard.press('Enter');
		await compareCells(page, 'split after the atom', census);

		await open(page, 'lists');
		await compareCells(page, 'lists mount', census);
		await caretAtEnd(page, 0);
		await page.keyboard.press('Enter');
		await page.keyboard.type('Inserted');
		await page.keyboard.press('Tab');
		await compareCells(page, 'list item split and nest', census);

		await open(page, 'code');
		await compareCells(page, 'code mount', census);
		await setSelectionByTextIndex(page, 0, 5);
		await page.keyboard.press('Enter');
		await page.keyboard.type('let x = 2;');
		await compareCells(page, 'code line split and type (transformText)', census);

		expect(census).toEqual({});
		issues.assertClean();
	});
});
