import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';

/**
 * The version history panel (site `server/history-panel`) in real browsers,
 * against a stubbed client (`src/routes/test/history`): the list of
 * versions with their editors, the read-only preview of the selected one,
 * the block-level highlight against the live page (added, removed,
 * changed since the version), and Restore / Undo restore.
 *
 * The fixture: the evening version holds `a` "Intro", `b` "Old text",
 * `r` "Removed paragraph", `z` "Tail"; the live page holds `a` "Intro",
 * `b` "New text", `n` "Added paragraph", `z` "Tail". The morning version
 * equals the live page.
 */

const EVENING = 'history/doc/2026-10-06-pm';
const MORNING = 'history/doc/2026-10-06-am';

const open = async (page: Page, query = '') => {
	await page.goto(`/test/history${query ? `?${query}` : ''}`);
	await expect(page.locator(`[data-edytor-history-version="${EVENING}"]`)).toBeVisible();
};

const panel = (page: Page) => page.getByTestId('panel');
const status = (page: Page) => panel(page).locator('[data-edytor-history-status]');
const preview = (page: Page) => panel(page).locator('[data-edytor-history-page]');
const calls = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __HISTORY__: { calls: string[] } }).__HISTORY__.calls
	);
const highlights = (page: Page) =>
	panel(page)
		.locator('[data-edytor-version-change]')
		.evaluateAll((nodes) =>
			nodes
				.map(
					(node) =>
						`${node.getAttribute('data-block-id')}:${node.getAttribute('data-edytor-version-change')}`
				)
				.sort()
		);
const previewLines = (page: Page) =>
	preview(page)
		.locator('[data-edytor-block]')
		.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));

test.describe('version history panel', () => {
	test('lists the versions newest first with their slot and editors, and previews the newest', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const rows = panel(page).locator('[role="option"]');
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText('Oct 6, 2026 · Evening');
		await expect(rows.nth(0)).toContainText('ada, bob +2');
		await expect(rows.nth(1)).toContainText('Oct 6, 2026 · Morning');
		await expect(rows.nth(1)).toContainText('No editors');
		await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
		await expect(panel(page).locator('[data-edytor-history-title]')).toHaveText(
			'Oct 6, 2026 · Evening'
		);
		// The version, with the block added since shown where the live page has it.
		await expect
			.poll(() => previewLines(page))
			.toEqual(['Intro', 'Old text', 'Added paragraph', 'Removed paragraph', 'Tail']);
		// Read-only: the preview takes no edit.
		const root = preview(page).locator('[data-edytor-root], [contenteditable]').first();
		await expect(root).not.toHaveAttribute('contenteditable', 'true');
		expect(await calls(page)).toEqual(['list', `read ${EVENING}`]);
		issues.assertClean();
	});

	test('highlights each block added, removed and changed since the version, over its own row', async ({
		page
	}) => {
		await open(page);
		await expect.poll(() => highlights(page)).toEqual(['b:changed', 'n:added', 'r:removed']);
		const legend = panel(page).locator('[data-edytor-history-legend]');
		await expect(legend).toContainText('1 added since');
		await expect(legend).toContainText('1 removed since');
		await expect(legend).toContainText('1 changed since');
		// Each tint lies over its block's row in the preview.
		for (const id of ['b', 'n', 'r']) {
			const tint = (await panel(page)
				.locator(`[data-edytor-version-change][data-block-id="${id}"]`)
				.boundingBox())!;
			const block = (await preview(page).locator(`[data-edytor-id="${id}"]`).boundingBox())!;
			expect(Math.abs(tint.y - block.y)).toBeLessThan(2);
			expect(Math.abs(tint.height - block.height)).toBeLessThan(2);
			// Its bar a few pixels left of the text, its right edge the block's.
			expect(block.x - tint.x).toBeGreaterThan(2);
			expect(block.x - tint.x).toBeLessThan(10);
			expect(Math.abs(tint.x + tint.width - (block.x + block.width))).toBeLessThan(2);
		}
		// The unchanged blocks carry none.
		await expect(panel(page).locator('[data-block-id="a"], [data-block-id="z"]')).toHaveCount(0);
	});

	test('Highlight changes off shows the version alone, with no tint', async ({ page }) => {
		await open(page);
		await expect.poll(() => highlights(page)).toHaveLength(3);
		await panel(page).getByLabel('Highlight changes').uncheck();
		await expect.poll(() => highlights(page)).toEqual([]);
		await expect
			.poll(() => previewLines(page))
			.toEqual(['Intro', 'Old text', 'Removed paragraph', 'Tail']);
		await panel(page).getByLabel('Highlight changes').check();
		await expect.poll(() => highlights(page)).toHaveLength(3);
	});

	test('the arrow keys move through the versions; a version equal to the page has no change', async ({
		page
	}) => {
		await open(page);
		await panel(page).locator(`[data-edytor-history-version="${EVENING}"]`).focus();
		await page.keyboard.press('ArrowDown');
		const morning = panel(page).locator(`[data-edytor-history-version="${MORNING}"]`);
		await expect(morning).toHaveAttribute('aria-selected', 'true');
		await expect(morning).toBeFocused();
		await expect(panel(page).locator('[data-edytor-history-legend]')).toContainText(
			'Same as the current page'
		);
		await expect.poll(() => highlights(page)).toEqual([]);
		await expect
			.poll(() => previewLines(page))
			.toEqual(['Intro', 'New text', 'Added paragraph', 'Tail']);
		await page.keyboard.press('ArrowUp');
		await expect(panel(page).locator(`[data-edytor-history-version="${EVENING}"]`)).toHaveAttribute(
			'aria-selected',
			'true'
		);
	});

	test('the highlight follows the live page as it changes', async ({ page }) => {
		await open(page);
		await expect.poll(() => highlights(page)).toEqual(['b:changed', 'n:added', 'r:removed']);
		const intro = page
			.getByTestId('live')
			.locator('[data-edytor-id="a"] [data-edytor-text]')
			.first();
		await intro.click();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await expect
			.poll(() => highlights(page))
			.toEqual(['a:changed', 'b:changed', 'n:added', 'r:removed']);
		await expect(panel(page).locator('[data-edytor-history-legend]')).toContainText(
			'2 changed since'
		);
	});

	test('Restore restores the selected version, and Undo restore takes it back', async ({
		page
	}) => {
		await open(page);
		const undo = panel(page).getByRole('button', { name: 'Undo restore' });
		await expect(undo).toHaveCount(0);
		await panel(page).getByRole('button', { name: 'Restore version' }).click();
		await expect(status(page)).toHaveText('Version restored.');
		await expect(undo).toBeVisible();
		await undo.click();
		await expect(status(page)).toHaveText('Restore undone.');
		await expect(undo).toHaveCount(0);
		expect(await calls(page)).toEqual(['list', `read ${EVENING}`, `restore ${EVENING}`, 'undo']);
	});

	test('a reader sees no Restore', async ({ page }) => {
		await open(page, 'readonly=true');
		await expect(panel(page).locator('[data-edytor-history-restore]')).toHaveCount(0);
		await expect.poll(() => highlights(page)).toHaveLength(3);
	});

	test('a refused restore says so and offers no undo', async ({ page }) => {
		await open(page, 'deny=true');
		await panel(page).getByRole('button', { name: 'Restore version' }).click();
		await expect(status(page)).toHaveText('You do not have access to this history.');
		await expect(panel(page).getByRole('button', { name: 'Undo restore' })).toHaveCount(0);
	});

	test('the default client speaks the routeDocumentHistory requests', async ({ page }) => {
		const seen: string[] = [];
		await page.route('**/test-history-api/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			seen.push(`${request.method()} ${url.pathname}?${url.searchParams.toString()}`);
			const key = url.searchParams.get('key');
			if (request.method() === 'POST') {
				return route.fulfill({ json: { status: 'applied', key: url.searchParams.get('restore') } });
			}
			if (key === null) {
				return route.fulfill({
					json: [
						{
							key: EVENING,
							date: '2026-10-06',
							slot: 'pm',
							bytes: 1,
							blocks: 1,
							editors: ['ada'],
							more: 0,
							at: Date.UTC(2026, 9, 6, 22),
							expiresAt: null
						}
					]
				});
			}
			return route.fulfill({
				json: { children: [{ type: 'paragraph', id: 'a', content: [{ text: 'Intro' }] }] }
			});
		});
		await open(page, 'client=http');
		await expect.poll(() => highlights(page)).toEqual(['b:added', 'n:added', 'z:added']);
		await panel(page).getByRole('button', { name: 'Restore version' }).click();
		await expect(status(page)).toHaveText('Version restored.');
		const key = encodeURIComponent(EVENING);
		expect(seen).toEqual([
			'GET /test-history-api/doc?token=secret',
			`GET /test-history-api/doc?token=secret&key=${key}`,
			`POST /test-history-api/doc?token=secret&restore=${key}`
		]);
	});

	test('a narrow panel stacks the versions above the preview', async ({ page }) => {
		await page.setViewportSize({ width: 600, height: 800 });
		await open(page);
		const side = (await panel(page).locator('[data-edytor-history-side]').boundingBox())!;
		const shown = (await panel(page).locator('[data-edytor-history-preview]').boundingBox())!;
		expect(side.y + side.height).toBeLessThanOrEqual(shown.y + 1);
		expect(Math.abs(side.width - shown.width)).toBeLessThan(2);
	});

	test('the panel passes the WCAG 2.2 AA checks axe runs, a refusal shown', async ({ page }) => {
		await open(page, 'deny=true');
		await expect.poll(() => highlights(page)).toHaveLength(3);
		await panel(page).getByRole('button', { name: 'Restore version' }).click();
		await expect(status(page)).toHaveAttribute('data-failed', 'true');
		const { violations } = await new AxeBuilder({ page })
			.include('[data-edytor-history]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze();
		expect(
			violations.map(({ id, nodes }) => `${id}: ${nodes.map((n) => n.target).join(' ')}`)
		).toEqual([]);
	});
});
