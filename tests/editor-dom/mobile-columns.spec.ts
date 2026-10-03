/**
 * Columns on a phone (docs/columns-plan.md D6, §5 "Resize"; mobile lane):
 * a layout under 480px wide stacks its columns, so it offers no resize
 * strip — a tap in a column (a touch pointer over the layout) shows none —
 * and the beside bands are off with it (the jsdom row `columns-dnd.test.tsx`
 * "no band when the layout would stack"). The desktop rows are
 * `columns-dnd.spec.ts`.
 */
import { expect, test } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

test('a stacked layout on a phone: a tap in a column shows no resize strip', async ({ page }) => {
	const issues = trackPageIssues(page);
	await page.goto('/test/dom?scenario=columns&handles=true');
	await waitForEditorReady(page, { requireRuntime: true });
	// The route's grid grows with its JSON dump: the editor gets the phone's width.
	await page
		.getByTestId('editor-shell')
		.evaluate((shell) => (shell.style.width = `${Math.min(360, innerWidth - 32)}px`));
	const [k1, k2, c] = await Promise.all(
		['K1', 'K2', 'C'].map(
			async (id) => (await page.locator(`[data-edytor-id="${id}"]`).boundingBox())!
		)
	);
	// Stacked: column 2 under column 1, both the layout's width.
	expect(c.width).toBeLessThanOrEqual(480);
	expect(k2.y).toBeGreaterThanOrEqual(k1.y + k1.height - 1);
	expect(Math.round(k2.x)).toBe(Math.round(k1.x));
	await page.locator('[data-edytor-id="B"] [data-edytor-text]').tap();
	await page.waitForTimeout(100);
	await expect(page.locator('[data-edytor-column-resize]')).toHaveCount(0);
	issues.assertClean();
});
