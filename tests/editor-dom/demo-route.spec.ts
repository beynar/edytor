import { expect, test, type Page } from './editorTest';
import {
	dispatchBeforeInput,
	getPlaceholderLocators,
	modKey,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const textInBlock = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).first();

const readTextValues = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
			(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
		)
	);

const selectTextInBlock = async (
	page: Page,
	id: string,
	startOffset: number,
	endOffset = startOffset
) => {
	const index = await page
		.locator('[data-edytor-text="true"]')
		.evaluateAll(
			(texts, blockId) =>
				texts.findIndex((text) => Boolean(text.closest(`[data-edytor-id="${blockId}"]`))),
			id
		);
	expect(index).toBeGreaterThanOrEqual(0);
	await setSelectionByTextIndex(page, index, startOffset, index, endOffset);
};

const createTextInEndBlock = async (page: Page, value: string) => {
	await page.locator('[data-edytor-id="page-end"] p').click();
	await page.keyboard.type(value);
	await expect(textInBlock(page, 'page-end')).toHaveText(value);
};

test.describe('demo route editing regressions', () => {
	test('accepts typing in the seeded empty paragraph and hides its placeholder', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await page.locator('[data-edytor-id="page-end"] p').click();
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await page.keyboard.type('A new thought');
		await expect(textInBlock(page, 'page-end')).toHaveText('A new thought');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		issues.assertClean();
	});

	test('routes real clicks to non-first text without changing other blocks', async ({ page }) => {
		const issues = trackPageIssues(page);
		for (const [id, original, inserted] of [
			['page-section-intro', 'Start with a thought. Give it structure when you need it.', 'X'],
			['page-task-one', 'Write down the first rough version', 'Y'],
			['page-quote', 'The best ideas rarely arrive in order.', 'Z']
		]) {
			await page.goto('/');
			await waitForEditorReady(page);
			const before = await readTextValues(page);
			const targetIndex = before.indexOf(original);
			expect(targetIndex).toBeGreaterThan(0);
			await textInBlock(page, id).click();
			await page.keyboard.type(inserted);
			await expect
				.poll(async () => {
					const after = await readTextValues(page);
					return (
						after.length === before.length &&
						after.every((text, index) =>
							index === targetIndex
								? text.includes(inserted) && text.replace(inserted, '') === original
								: text === before[index]
						)
					);
				})
				.toBe(true);
		}
		issues.assertClean();
	});

	test('edits a nested toggle child without duplicating the parent DOM', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await page.locator('[data-edytor-id="page-toggle"] summary').click();
		const childText = 'Turn a block into a heading, list, quote, callout, or code.';
		await textInBlock(page, 'page-toggle-child').click();
		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const changed = await textInBlock(page, 'page-toggle-child').textContent();
				return changed?.includes('X') && changed.replace('X', '') === childText;
			})
			.toBe(true);
		await expect(page.locator('[data-edytor-id="page-toggle"] summary')).toHaveText(
			'A few more ways to work'
		);
		await expect(page.locator('[data-edytor-id="page-toggle-child"]')).toHaveCount(1);
		issues.assertClean();
	});

	test('routes Enter after a nested child click to that child', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await page.locator('[data-edytor-id="page-toggle"] summary').click();
		await textInBlock(page, 'page-toggle-child').click();
		await page.keyboard.press('End');
		const children = page.locator('[data-edytor-id="page-toggle"] [data-edytor-block="true"]');
		const before = await children.count();
		await page.keyboard.press('Enter');
		await expect(children).toHaveCount(before + 1);
		await expect(textInBlock(page, 'page-toggle-child')).toHaveText(
			'Turn a block into a heading, list, quote, callout, or code.'
		);
		await expect(page.locator('[data-edytor-id="page-toggle"] summary')).toHaveText(
			'A few more ways to work'
		);
		issues.assertClean();
	});

	test('inserts a paragraph after marked text on Enter', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		const intro = await textInBlock(page, 'page-intro').textContent();
		if (!intro) throw new Error('Missing demo introduction text');
		await selectTextInBlock(page, 'page-intro', intro.length);
		const blocks = page.locator('[data-edytor] > [data-edytor-block-handle-host]');
		const before = await blocks.count();
		await page.keyboard.press('Enter');
		await expect(blocks).toHaveCount(before + 1);
		await expect(textInBlock(page, 'page-intro')).toHaveText(intro);
		await expect(page.locator('[data-edytor-id="page-intro"] b')).toHaveText('Select text');
		issues.assertClean();
	});

	test('undoes and redoes insertion without losing adjacent marked text', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		const intro = await textInBlock(page, 'page-intro').textContent();
		if (!intro) throw new Error('Missing demo introduction text');
		await selectTextInBlock(page, 'page-intro', 1);
		await page.keyboard.type('U');
		await expect(textInBlock(page, 'page-intro')).toHaveText(`EU${intro.slice(1)}`);
		await page.keyboard.press(`${modKey}+Z`);
		await expect(textInBlock(page, 'page-intro')).toHaveText(intro);
		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect(textInBlock(page, 'page-intro')).toHaveText(`EU${intro.slice(1)}`);
		await expect(page.locator('[data-edytor-id="page-intro"] b')).toHaveText('Select text');
		issues.assertClean();
	});

	test('does not clone text when toggling a mark', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		const value = 'Start with a thought. Give it structure when you need it.';
		await selectTextInBlock(page, 'page-section-intro', 0, 5);
		await page.keyboard.press(`${modKey}+B`);
		await expect(textInBlock(page, 'page-section-intro')).toHaveText(value);
		await expect(page.locator('[data-edytor-id="page-section-intro"] b')).toHaveText('Start');
		issues.assertClean();
	});

	test('keeps existing text for an auto-dot beforeinput payload', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'lead');
		await selectTextInBlock(page, 'page-end', 4);
		const prevented = await dispatchBeforeInput(page, { inputType: 'insertText', data: '. ' });
		expect(prevented).toBe(true);
		await expect(textInBlock(page, 'page-end')).toHaveText('lead. ');
		issues.assertClean();
	});

	test('does not resurrect marked text at a backspace boundary', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'One');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('Two');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.press('Space');
		await page.keyboard.press('Space');
		await page.keyboard.press('Backspace');
		await expect(textInBlock(page, 'page-end')).toHaveText('OneTwo ');
		await expect(page.locator('[data-edytor-id="page-end"] b')).toHaveText('Two');
		issues.assertClean();
	});

	test('keeps marked text after undoing a deletion', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'One');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('Two');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('  ');
		await page.keyboard.press('Backspace');
		await page.keyboard.press(`${modKey}+Z`);
		await page.keyboard.press('Tab');
		await expect(textInBlock(page, 'page-end')).toHaveText('OneTwo  ');
		await expect(page.locator('[data-edytor-id="page-end"] b')).toHaveText('Two');
		issues.assertClean();
	});

	test('splits the empty-end paragraph and restores it with undo', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'One');
		const blocks = page.locator('[data-edytor] > [data-edytor-block-handle-host]');
		const before = await blocks.count();
		await page.keyboard.press('Enter');
		await expect(blocks).toHaveCount(before + 1);
		await expect(textInBlock(page, 'page-end')).toHaveText('One');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await page.keyboard.press(`${modKey}+Z`);
		await expect(blocks).toHaveCount(before);
		await expect(textInBlock(page, 'page-end')).toHaveText('One');
		issues.assertClean();
	});

	test('undoes post-split typing separately from the split', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'Alpha');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Beta');
		await expect
			.poll(async () => (await readTextValues(page)).slice(-2))
			.toEqual(['Alpha', 'Beta']);
		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(async () => (await readTextValues(page)).slice(-2)).toEqual(['Alpha', '']);
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(async () => (await readTextValues(page)).slice(-1)).toEqual(['Alpha']);
		issues.assertClean();
	});

	test('unnests a split soft-break paragraph on Shift+Tab', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'One');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Two');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('Br');
		await page.keyboard.press('Tab');
		const nested = page.locator('[data-edytor-id="page-end"] [data-edytor-block="true"]');
		await expect(nested).toHaveCount(1);
		await page.keyboard.press('Shift+Tab');
		await expect(nested).toHaveCount(0);
		await expect
			.poll(async () => (await readTextValues(page)).slice(-2))
			.toEqual(['One', 'Two\nBr']);
		issues.assertClean();
	});

	test('focuses an added empty block after edit history', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		await createTextInEndBlock(page, 'One');
		await page.keyboard.press('Enter');
		await page.keyboard.press(`${modKey}+Z`);
		await page.locator('[data-testid="block-handle"][data-block-id="page-end"]').click();
		await page.getByRole('menuitem', { name: /Add block below/ }).click();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const blocks = document.querySelectorAll('[data-edytor] > [data-edytor-block="true"]');
					const lastBlock = blocks.item(blocks.length - 1);
					return Boolean(lastBlock?.contains(window.getSelection()?.anchorNode ?? null));
				})
			)
			.toBe(true);
		await page.keyboard.type('After history');
		await expect(textInBlock(page, 'page-end')).toHaveText('One');
		await expect(
			page
				.locator('[data-edytor] > [data-edytor-block="true"]')
				.last()
				.locator('[data-edytor-text="true"]')
		).toHaveText('After history');
		issues.assertClean();
	});
});
