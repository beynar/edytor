import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type FormatCase = {
	inputType: string;
	mark: string;
};

const nativeFormatCases: FormatCase[] = [
	{ inputType: 'formatItalic', mark: 'italic' },
	{ inputType: 'formatUnderline', mark: 'underline' },
	{ inputType: 'formatStrikeThrough', mark: 'strike' },
	{ inputType: 'formatSuperscript', mark: 'superscript' },
	{ inputType: 'formatSubscript', mark: 'subscript' }
];

test.describe('native format beforeinput behavior', () => {
	for (const { inputType, mark } of nativeFormatCases) {
		test(`routes native format inputTypes through model marks: ${inputType}`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=basic&empty=last');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 0, 1, 4);

			const prevented = await dispatchBeforeInput(page, { inputType });

			expect(prevented).toBe(true);
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ marks?: Record<string, unknown> }> }>;
					}>(page, 'value');
					return [value.children[0]?.content?.[0]?.marks, value.children[1]?.content?.[0]?.marks];
				})
				.toEqual([{ [mark]: true }, { [mark]: true }]);

			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [1],
				yStart: 0,
				yEnd: 4,
				isCollapsed: false
			});

			issues.assertClean();
		});
	}

	test('routes native format inputTypes to pending marks at a collapsed caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const formatPrevented = await dispatchBeforeInput(page, {
			inputType: 'formatUnderline'
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(formatPrevented).toBe(true);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'le' }, { text: 'x', marks: { underline: true } }, { text: 'ad' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('clears pending marks for future text when native formatRemove fires at a collapsed caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const formatPrevented = await dispatchBeforeInput(page, {
			inputType: 'formatUnderline'
		});
		const removePrevented = await dispatchBeforeInput(page, {
			inputType: 'formatRemove'
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(formatPrevented).toBe(true);
		expect(removePrevented).toBe(true);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'lexad' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses formatRemove target ranges across mixed marks and inline atoms', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'formatRemove',
			targetRange: {
				startIndex: 1,
				startOffset: 0,
				endIndex: 3,
				endOffset: 3
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ marks?: Record<string, unknown>; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return {
					markedBlock: value.children[1]?.content,
					inlineBlock: value.children[2]?.content
				};
			})
			.toEqual({
				markedBlock: [{ text: 'Marked middle' }],
				inlineBlock: [
					{ text: 'lead ' },
					expect.objectContaining({ type: 'mention' }),
					{ text: ' tail' }
				]
			});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const editor = document.querySelector('[data-edytor]');
					const inlineAtoms = Array.from(
						editor?.querySelectorAll<HTMLElement>('[data-edytor-inline-block]') ?? []
					).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
					return {
						boldCount: editor?.querySelectorAll('[data-edytor-mark="bold"]').length ?? 0,
						italicCount: editor?.querySelectorAll('[data-edytor-mark="italic"]').length ?? 0,
						mentionCount: inlineAtoms.length
					};
				})
			)
			.toEqual({
				boldCount: 0,
				italicCount: 0,
				mentionCount: 1
			});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			startTextPath: [1, 0],
			endTextPath: [2, 2],
			yStart: 0,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('routes native insertLink to the link mark with the URL payload', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertLink',
			data: 'https://example.com'
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.marks;
			})
			.toEqual({ link: { href: 'https://example.com' } });

		issues.assertClean();
	});

	test('routes native list commands to list-item block conversion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		for (const [inputType, type] of [
			['insertOrderedList', 'numbered-list-item'],
			['insertUnorderedList', 'bulleted-list-item']
		] as const) {
			const prevented = await dispatchBeforeInput(page, { inputType });
			expect(prevented).toBe(true);
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{ children: Array<{ type: string }> }>(
						page,
						'value'
					);
					return value.children[0]?.type;
				})
				.toBe(type);
		}

		issues.assertClean();
	});

	test('routes native insertHorizontalRule to a divider block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, { inputType: 'insertHorizontalRule' });
		expect(prevented).toBe(true);
		// Divider insertion is non-destructive: the current paragraph is
		// split around a new divider and its content is preserved.
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ type: string }> }>(page, 'value');
				return value.children.slice(0, 3).map((block) => block.type);
			})
			.toEqual(['paragraph', 'divider', 'paragraph']);

		issues.assertClean();
	});

	test('routes native color commands to valued marks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);

		for (const [inputType, mark, value] of [
			['formatFontColor', 'color', 'rgb(255, 0, 0)'],
			['formatBackColor', 'highlight', 'rgb(0, 255, 0)']
		] as const) {
			const prevented = await dispatchBeforeInput(page, { inputType, data: value });
			expect(prevented).toBe(true);
			await expect
				.poll(async () => {
					const doc = await readJsonByTestId<{
						children: Array<{ content?: Array<{ marks?: Record<string, unknown> }> }>;
					}>(page, 'value');
					return doc.children[0]?.content?.[0]?.marks?.[mark];
				})
				.toBe(value);
		}

		issues.assertClean();
	});

	test('does not leave stale DOM clones when native format removes an existing mark', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'formatBold'
		});
		expect(prevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alpha beta' }]);
		await expect
			.poll(() => page.locator('[data-edytor-type="paragraph"]').first().locator('p').textContent())
			.toBe('Alpha beta');

		issues.assertClean();
	});
});

/**
 * A commit that replaces a text's runs renders once: the old runs' text
 * nodes give way to the new ones before the observer compares (Svelte's
 * async mode writes a flush's structure before any `$effect.pre`; the async
 * lanes, `playwright.async.config.ts`, run these rows there too).
 */
test.describe("a commit that replaces a text's runs renders once", () => {
	type Page = import('@playwright/test').Page;
	const open = async (page: Page, text: string) => {
		const doc = { children: [{ id: 'p', type: 'paragraph', content: [{ text }] }] };
		await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify(doc))}`);
		await waitForEditorReady(page, { requireRuntime: true });
	};
	const content = async (page: Page) =>
		(await readJsonByTestId<{ children: Array<{ content?: unknown }> }>(page, 'value')).children[0]
			?.content;
	const shown = (page: Page) => page.locator('[data-edytor-text]').first();

	test('Mod+B over the selected last word bolds it once', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'hello world');
		await setSelectionByTextIndex(page, 0, 6, 0, 11);
		await page.keyboard.press(`${modKey}+b`);
		await expect
			.poll(() => content(page))
			.toEqual([{ text: 'hello ' }, { text: 'world', marks: { bold: true } }]);
		await expect(shown(page)).toHaveText('hello world');
		issues.assertClean();
	});

	test('Shift+Arrow from the end selects the word, then Mod+B bolds it once', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'hello world');
		await setSelectionByTextIndex(page, 0, 11);
		for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
		await expectSelection(page, { yStart: 6, yEnd: 11, isCollapsed: false });
		await page.keyboard.press(`${modKey}+b`);
		await expect
			.poll(() => content(page))
			.toEqual([{ text: 'hello ' }, { text: 'world', marks: { bold: true } }]);
		await expect(shown(page)).toHaveText('hello world');
		issues.assertClean();
	});

	test('Mod+B over a middle word bolds it once; the rest of the line stays', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'hello world again');
		await setSelectionByTextIndex(page, 0, 6, 0, 11);
		await page.keyboard.press(`${modKey}+b`);
		await expect
			.poll(() => content(page))
			.toEqual([{ text: 'hello ' }, { text: 'world', marks: { bold: true } }, { text: ' again' }]);
		await expect(shown(page)).toHaveText('hello world again');
		issues.assertClean();
	});

	test('a link over a middle range renders once', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, 'see docs here');
		await page.evaluate(() =>
			(
				window as unknown as {
					__EDYTOR__: { formatRange: (...args: unknown[]) => unknown };
				}
			).__EDYTOR__.formatRange('p', 4, 4, { link: { href: 'https://example.com' } })
		);
		await expect
			.poll(() => content(page))
			.toEqual([
				{ text: 'see ' },
				{ text: 'docs', marks: { link: { href: 'https://example.com' } } },
				{ text: ' here' }
			]);
		await expect(shown(page)).toHaveText('see docs here');
		issues.assertClean();
	});

	test('insertFlow of one line of several runs after a text keeps their order', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, 'Start: ');
		await page.evaluate(() =>
			(
				window as unknown as {
					__EDYTOR__: { insertFlow: (...args: unknown[]) => unknown };
				}
			).__EDYTOR__.insertFlow(
				{ block: 'p', offset: 7 },
				{
					lines: [
						{
							id: 'flow-line',
							content: [
								{ kind: 'text', text: 'bold', marks: { bold: true } },
								{ kind: 'text', text: ' and ' },
								{ kind: 'inline', id: 'flow-atom', type: 'mention', data: {} }
							]
						}
					]
				}
			)
		);
		await expect
			.poll(async () =>
				((await content(page)) as Array<{ text?: string; type?: string }>).map(
					(part) => part.text ?? `@${part.type}`
				)
			)
			.toEqual(['Start: ', 'bold', ' and ', '@mention']);
		await expect(page.locator('[data-edytor-block]').first()).toContainText('Start: bold and');
		issues.assertClean();
	});
});
