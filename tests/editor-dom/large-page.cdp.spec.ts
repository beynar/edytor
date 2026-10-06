/**
 * P8 — IME over a large page whose top-level blocks carry
 * `content-visibility: auto` (`themes/notion.css`), through Chromium's real
 * IME path: the caret goes to a block far down (Cmd/Ctrl+End, so the block
 * was skipped until then), a composition previews and commits there, and
 * the committed text lands in that block, once.
 */
import { openIme } from './cdp';
import { expect, test } from './editorTest';

test.describe('P8 — IME on a large page', () => {
	test.setTimeout(120_000);

	test('a composition in the last of 5,000 blocks commits once, in place', async ({ page }) => {
		await page.goto('/test/large');
		await page.waitForFunction(() => '__large' in window, null, { timeout: 60_000 });
		const last = page.locator(
			'main > [data-edytor] [data-edytor-id="b4999"] [data-edytor-text="true"]'
		);
		const before = await last.textContent();
		await page
			.locator('main > [data-edytor] [data-edytor-id="b1"] [data-edytor-text="true"]')
			.click();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
		// The editor adopts the browser's caret move (its selectionchange) before the IME starts.
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { __edytor: any }).__edytor.selection.value.focus?.b
				)
			)
			.toBe('b4999');
		const ime = await openIme(page);
		try {
			await ime.composeSteps(['に', 'にほ', 'にほん'], 80);
			await expect(last).toHaveText(`${before}にほん`);
			await ime.commit('日本');
			await expect(last).toHaveText(`${before}日本`);
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as unknown as { __edytor: any }).__edytor.value.children
								.at(-1)
								.content.map((c: { text?: string }) => c.text ?? '')
								.join('') as string
					)
				)
				.toBe(`${before}日本`);
			const box = (await last.boundingBox())!;
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
		} finally {
			await ime.detach();
		}
	});
});
