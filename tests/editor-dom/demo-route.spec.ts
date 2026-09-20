import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	getBlockLocators,
	getPlaceholderLocators,
	getTextLocators,
	modKey,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const setSelectionInText = async (
	page: Page,
	value: string,
	startOffset: number,
	endOffset: number
) => {
	await page.evaluate(
		({ textValue, startOffset: rangeStart, endOffset: rangeEnd }) => {
			const target = Array.from(
				document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			).find((text) => text.textContent === textValue);
			if (!target) {
				throw new Error(`Missing text node with value "${textValue}"`);
			}

			const resolveLeaf = (offset: number) => {
				const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
				let leaf: Node = target;
				let currentOffset = 0;
				let next = walker.nextNode();
				while (next) {
					const length = next.textContent?.length ?? 0;
					const end = currentOffset + length;
					if (offset >= currentOffset && offset <= end) {
						return {
							leaf: next,
							offset: offset - currentOffset
						};
					}
					leaf = next;
					currentOffset = end;
					next = walker.nextNode();
				}

				return {
					leaf,
					offset: leaf.textContent?.length ?? 0
				};
			};

			const start = resolveLeaf(rangeStart);
			const end = resolveLeaf(rangeEnd);

			const range = document.createRange();
			range.setStart(start.leaf, start.offset);
			range.setEnd(end.leaf, end.offset);

			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			(start.leaf.parentElement ?? target).focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		{ textValue: value, startOffset, endOffset }
	);
};

const setCaretAtEndOfText = async (page: Page, value: string) =>
	setSelectionInText(page, value, value.length, value.length);

const clickTextValueOffset = async (
	page: Page,
	value: string,
	offset: number,
	options: { occurrence?: number } = {}
) => {
	const point = await page.evaluate(
		({ occurrence = 0, offset: targetOffset, textValue }) => {
			const targets = Array.from(
				document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			).filter((text) => text.textContent === textValue);
			const target = targets[occurrence];
			if (!target) {
				throw new Error(`Missing text node "${textValue}" occurrence ${occurrence}`);
			}

			const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			let currentOffset = 0;
			while (current) {
				const length = current.textContent?.length ?? 0;
				const nextOffset = currentOffset + length;
				if (targetOffset >= currentOffset && targetOffset <= nextOffset) {
					const localOffset = Math.min(Math.max(targetOffset - currentOffset, 0), length);
					const range = document.createRange();
					range.setStart(current, Math.max(localOffset - 1, 0));
					range.setEnd(current, localOffset);
					const rect = range.getBoundingClientRect();
					if (rect.width === 0 && rect.height === 0) {
						throw new Error(`Text node "${textValue}" has no clickable rect`);
					}

					return {
						x: rect.right - 1,
						y: rect.top + rect.height / 2
					};
				}

				currentOffset = nextOffset;
				current = walker.nextNode();
			}

			throw new Error(`Offset ${targetOffset} is outside text "${textValue}"`);
		},
		{ occurrence: options.occurrence, offset, textValue: value }
	);

	await page.mouse.click(point.x, point.y);
};

const readTextAndParagraph = async (page: Page, startsWith: string) =>
	page.evaluate((prefix) => {
		const text = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
		).find((node) => node.textContent?.startsWith(prefix));
		return {
			text: text?.textContent ?? null,
			paragraph: text?.closest('p')?.textContent ?? null
		};
	}, startsWith);

const readVisibleTextValues = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
			(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
		)
	);

const readTopLevelInlineBlockCount = (page: Page) =>
	page.evaluate(
		() =>
			Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')).filter(
				(element) => !element.parentElement?.closest('[data-edytor-inline-block]')
			).length
	);

const clickTextLocator = async (page: Page, textValue: string | RegExp) => {
	const locator = page.locator('[data-edytor-text="true"]').filter({ hasText: textValue }).first();
	await expect(locator).toBeVisible();
	await locator.click();
};

const expectOnlyClickedTextChanged = async (
	page: Page,
	options: { inserted: string; targetIndex: number }
) => {
	await expect
		.poll(async () => {
			const textValues = await readVisibleTextValues(page);
			const baseline = ['hello', 'World', 'Prout', 'One', 'Two', '\t\tconsole.log("hello")'];
			return textValues.every((textValue, index) => {
				if (index === options.targetIndex) {
					return (
						textValue.includes(options.inserted) &&
						textValue.replace(options.inserted, '') === baseline[index]
					);
				}

				return textValue === baseline[index];
			});
		})
		.toBe(true);
};

test.describe('demo route smoke behavior', () => {
	test('clears to one editable paragraph and still accepts typing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.waitForTimeout(1000);
		await page.getByRole('button', { name: 'clear' }).click();

		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(1);

		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('Oneee');
		await expect
			.poll(() => readTextAndParagraph(page, 'Oneee'))
			.toEqual({
				text: 'Oneee',
				paragraph: 'Oneee'
			});
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('routes real clicks in non-first demo text to the clicked editable target', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);

		await clickTextLocator(page, /^World$/);
		await page.keyboard.type('C');
		await expectOnlyClickedTextChanged(page, { inserted: 'C', targetIndex: 1 });

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextLocator(page, /^One$/);
		await page.keyboard.type('N');
		await expectOnlyClickedTextChanged(page, { inserted: 'N', targetIndex: 3 });

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextLocator(page, /^Two$/);
		await page.keyboard.type('D');
		await expectOnlyClickedTextChanged(page, { inserted: 'D', targetIndex: 4 });

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextLocator(page, /console\.log\("hello"\)/);
		await page.keyboard.type('K');
		await expectOnlyClickedTextChanged(page, { inserted: 'K', targetIndex: 5 });

		issues.assertClean();
	});

	test('routes enter after a real nested child click to the nested block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextLocator(page, /^One$/);
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');

		await expect
			.poll(() => readVisibleTextValues(page))
			.toEqual(['hello', 'World', 'Prout', 'One', '', 'Two', '\t\tconsole.log("hello")']);

		issues.assertClean();
	});

	test('clicks and types into the default nested child without duplicating parent DOM', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextValueOffset(page, 'One', 'One'.length);
		await page.keyboard.type('eee');

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
						(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
					)
				)
			)
			.toEqual(['hello', 'World', 'Prout', 'Oneeee', 'Two', '\t\tconsole.log("hello")']);

		await expect
			.poll(() => readTextAndParagraph(page, 'One'))
			.toEqual({
				text: 'Oneeee',
				paragraph: 'Oneeee'
			});

		issues.assertClean();
	});

	test('inserts an empty parent paragraph below marked inline parent text on enter', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await setCaretAtEndOfText(page, 'Prout');
		await page.keyboard.press('Enter');

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
						(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
					)
				)
			)
			.toEqual(['hello', 'World', 'Prout', '', 'One', 'Two', '\t\tconsole.log("hello")']);
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		issues.assertClean();
	});

	test('preserves root inline content when undoing and redoing first text insertion', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await clickTextValueOffset(page, 'hello', 1);
		await page.keyboard.type('U');

		await expect
			.poll(() => readVisibleTextValues(page))
			.toEqual(['hUello', 'World', 'Prout', 'One', 'Two', '\t\tconsole.log("hello")']);
		await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(2);

		await page.keyboard.press(`${modKey}+Z`);
		await expect
			.poll(() => readVisibleTextValues(page))
			.toEqual(['hello', 'World', 'Prout', 'One', 'Two', '\t\tconsole.log("hello")']);
		await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(2);

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect
			.poll(() => readVisibleTextValues(page))
			.toEqual(['hUello', 'World', 'Prout', 'One', 'Two', '\t\tconsole.log("hello")']);
		await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(2);

		issues.assertClean();
	});

	test('does not leave stale visible DOM clones when typing in default marked text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await setCaretAtEndOfText(page, 'One');
		await page.keyboard.type('eee');

		await expect
			.poll(() => readTextAndParagraph(page, 'One'))
			.toEqual({
				text: 'Oneeee',
				paragraph: 'Oneeee'
			});

		issues.assertClean();
	});

	test('does not duplicate visible text when toggling a mark on the demo route', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await setSelectionInText(page, 'One', 0, 3);
		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(() => readTextAndParagraph(page, 'One'))
			.toEqual({
				text: 'One',
				paragraph: 'One'
			});

		issues.assertClean();
	});

	test('does not delete existing demo-route text for auto-dot payloads', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
						(block) =>
							block.textContent
								?.replaceAll('\u200B', '')
								.replaceAll('Write something here ... ', '')
								.trimEnd()
					)
				)
			)
			.toEqual(['']);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('lead');
		await setCaretAtEndOfText(page, 'lead');

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '. '
		});
		expect(prevented).toBe(true);

		await expect
			.poll(() => readTextAndParagraph(page, 'lead'))
			.toEqual({
				text: 'lead. ',
				paragraph: 'lead. '
			});

		issues.assertClean();
	});

	test('does not duplicate marked text after undoing a deletion on the demo route', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('One');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('Two');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('  ');
		await page.keyboard.press('Backspace');
		await page.keyboard.press(`${modKey}+Z`);
		await page.keyboard.press('Tab');

		await expect
			.poll(() => readTextAndParagraph(page, 'One'))
			.toEqual({
				text: 'OneTwo  ',
				paragraph: 'OneTwo  '
			});

		issues.assertClean();
	});

	test('does not resurrect marked text immediately after backspace at a mark boundary', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('One');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('Two');
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.press('Space');
		await page.keyboard.press('Space');
		await page.keyboard.press('Backspace');

		await expect
			.poll(() => readTextAndParagraph(page, 'One'))
			.toEqual({
				text: 'OneTwo ',
				paragraph: 'OneTwo '
			});

		issues.assertClean();
	});

	test('splits a cleared paragraph on enter and restores it with undo', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();

		const texts = getTextLocators(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('One');
		await expect(texts.nth(0)).toContainText('One');

		await page.keyboard.press('Enter');

		await expect(getBlockLocators(page)).toHaveCount(2);
		await expect(texts.nth(0)).toContainText('One');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		await page.keyboard.press(`${modKey}+Z`);

		await expect(getBlockLocators(page)).toHaveCount(1);
		await expect(texts.nth(0)).toContainText('One');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('does not coalesce typing after a paragraph split into the split undo step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();

		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('Alpha');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Beta');

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
						(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
					)
				)
			)
			.toEqual(['Alpha', 'Beta']);

		await page.keyboard.press(`${modKey}+Z`);

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
						(block) =>
							Array.from(block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'))
								.map((text) => text.textContent?.replaceAll('\u200B', '') ?? '')
								.join('')
					)
				)
			)
			.toEqual(['Alpha', '']);

		await page.keyboard.press(`${modKey}+Z`);

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
						(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
					)
				)
			)
			.toEqual(['Alpha']);

		issues.assertClean();
	});

	test('unnests a newly split soft-break paragraph on shift+tab', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('One');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Two');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('Br');

		await page.keyboard.press('Tab');
		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
						(block) =>
							block.textContent
								?.replaceAll('\u200B', '')
								.replaceAll('Write something here ... ', '')
								.trimEnd()
					)
				)
			)
			.toEqual(['One Two\nBr', 'Two\nBr']);

		await page.keyboard.press('Shift+Tab');

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
						(block) =>
							block.textContent
								?.replaceAll('\u200B', '')
								.replaceAll('Write something here ... ', '')
								.trimEnd()
					)
				)
			)
			.toEqual(['One', 'Two\nBr']);

		issues.assertClean();
	});

	test('does not duplicate the placeholder after undoing text in a split paragraph', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();

		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('Alpha');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Beta');
		await page.keyboard.press(`${modKey}+Z`);

		await expect(getBlockLocators(page)).toHaveCount(2);
		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
						(block) => ({
							text: Array.from(block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'))
								.map((text) => text.textContent?.replaceAll('\u200B', '') ?? '')
								.join(''),
							totalPlaceholders: block.querySelectorAll('[data-edytor-text-placeholder]').length,
							visiblePlaceholders: Array.from(
								block.querySelectorAll<HTMLElement>('[data-edytor-text-placeholder]')
							).filter((placeholder) => getComputedStyle(placeholder).display !== 'none').length
						})
					)
				)
			)
			.toEqual([
				{ text: 'Alpha', totalPlaceholders: 0, visiblePlaceholders: 0 },
				{ text: '', totalPlaceholders: 1, visiblePlaceholders: 1 }
			]);

		issues.assertClean();
	});

	test('clears after edit history to a focused editable empty paragraph', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/');
		await waitForEditorReady(page);
		await page.getByRole('button', { name: 'clear' }).click();

		const texts = getTextLocators(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('One');
		await page.keyboard.press('Enter');
		await page.keyboard.press(`${modKey}+Z`);

		await page.getByRole('button', { name: 'clear' }).click();

		await expect(getBlockLocators(page)).toHaveCount(1);
		await expect(getPlaceholderLocators(page)).toHaveText('Write something here ...');
		await page.keyboard.type('a');
		await expect(texts.first()).toContainText('a');

		issues.assertClean();
	});
});
