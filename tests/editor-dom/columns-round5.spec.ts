import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';
import {
	FULL,
	TEXTS,
	clickPlus,
	frames,
	lastStatus,
	openDoc,
	resize,
	textBox,
	texts,
	valueKind
} from './columnsPaths';

/**
 * Columns, Notion parity, the round-5 review (2026-10-04), with a person's
 * mouse: every path moves in 2–12px steps, never a jump. Desktop engines.
 */

/** A click at the end of `id`'s text, then `typed`: it lands there. */
const clickThenType = async (page: Page, id: string, typed: string) => {
	const t = await textBox(page, id);
	await page.mouse.move(t.x + t.width - 12, t.y + t.height / 2 - 6);
	await page.mouse.move(t.x + t.width - 6, t.y + t.height / 2 - 2);
	await page.mouse.click(t.x + t.width - 1, t.y + t.height / 2);
	await page.keyboard.type(typed);
};

test.describe('typing with no caret does nothing, whatever key came before (round 5, issue 1)', () => {
	const paths: [string, (page: Page) => Promise<void>][] = [
		[
			'a resize, Mod+Z',
			async (page) => {
				await resize(page, -50);
				await page.keyboard.press('ControlOrMeta+z');
			}
		],
		[
			'a resize, Mod+Z, Mod+Shift+Z',
			async (page) => {
				await resize(page, -50);
				await page.keyboard.press('ControlOrMeta+z');
				await frames(page);
				await page.keyboard.press('ControlOrMeta+Shift+z');
			}
		],
		[
			'a resize, Escape',
			async (page) => {
				await resize(page, 40);
				await page.keyboard.press('Escape');
			}
		],
		[
			'the + menu, Escape',
			async (page) => {
				await clickPlus(page, 'B2');
				await expect(page.locator('[data-testid="slash-menu-item"]').first()).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(page.locator('[data-testid="slash-menu-item"]')).toHaveCount(0);
			}
		]
	];
	for (const [label, run] of paths)
		test(`fresh page, ${label}, then "j": nothing is written; a click then types`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);
			await openDoc(page, FULL);
			await run(page);
			await frames(page);
			expect(await valueKind(page)).toBe('none');
			for (const key of ['j', 'Enter', 'Backspace', 'Delete']) {
				await page.keyboard.press(key);
				await frames(page);
				expect(await texts(page), key).toEqual(TEXTS);
				expect(await valueKind(page), key).toBe('none');
				expect(await lastStatus(page), key).toBe('refused');
			}
			// A click places the caret: typing goes there.
			await clickThenType(page, 'B', 'k');
			await expect
				.poll(() => texts(page))
				.toEqual(TEXTS.map((t) => (t === 'right one' ? 'right onek' : t)));
			issues.assertClean();
		});
});
