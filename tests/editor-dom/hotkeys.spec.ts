import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	getPlaceholderLocators,
	getTextLocators,
	modKey,
	readNativeSelectionDirection,
	readJsonByTestId,
	readSelection,
	setReverseSelectionByTextIndex,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const readSerializedTopLevelBlockTexts = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string }> }>;
	}>(page, 'value');
	return value.children.map(
		(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
	);
};

const readVisibleTopLevelBlockTexts = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(() => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing editor root');
		}

		return Array.from(editor.children)
			.filter((child): child is HTMLElement => child instanceof HTMLElement)
			.filter((child) => child.matches('[data-edytor-block="true"]'))
			.map((block) =>
				Array.from(block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'))
					.map((text) => text.textContent?.replaceAll('\u200B', '') ?? '')
					.join('')
			);
	});

const expectVisibleOrderToMatchSerializedOrder = async (
	page: Parameters<typeof readJsonByTestId>[0],
	expectedTexts: string[]
) => {
	await expect.poll(() => readSerializedTopLevelBlockTexts(page)).toEqual(expectedTexts);
	await expect.poll(() => readVisibleTopLevelBlockTexts(page)).toEqual(expectedTexts);
};

const stripIds = <T>(value: T): T => {
	return JSON.parse(
		JSON.stringify(value, (key, current) => {
			return key === 'id' ? undefined : current;
		})
	) as T;
};

test.describe('browser hotkey behavior', () => {
	test('expands mod+a from a native caret to the current block range', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 3);

		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('cycles mod+a to document block selection and deletes to an editable fallback', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);

		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await expect
			.poll(async () => {
				const selection = await readSelection(page);
				return selection.selectedBlockPaths.toSorted((left, right) => left[0] - right[0]);
			})
			.toEqual([[0], [1], [2]]);

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
				);
			})
			.toEqual(['']);
		await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(1);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true,
			selectedBlockPaths: []
		});

		issues.assertClean();
	});

	test('collapses selected-block state with escape before the next edit', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});

		await page.keyboard.press('Escape');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'Marked middle'.length,
			yEnd: 'Marked middle'.length,
			isCollapsed: true,
			selectedBlockPaths: []
		});

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['First block', 'Marked middleX', 'lead  tail']);

		issues.assertClean();
	});

	test('toggles bold across a browser-created multi-block selection', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 1, 4);
		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return [value.children[0]?.content?.[0]?.marks, value.children[1]?.content?.[0]?.marks];
			})
			.toEqual([{ bold: true }, { bold: true }]);

		issues.assertClean();
	});

	test('treats AltGraph printable keydown as text input, not a mod+alt hotkey', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&altGraphHotkey=true');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const keydownPrevented = await page.evaluate(() => {
			const target = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!target) {
				throw new Error('Missing editable text node');
			}

			const event = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				key: 'b',
				code: 'KeyB',
				ctrlKey: true,
				altKey: true
			});
			Object.defineProperty(event, 'getModifierState', {
				value: (key: string) => key === 'AltGraph',
				configurable: true
			});
			target.dispatchEvent(event);
			return event.defaultPrevented;
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'β'
		});

		expect(keydownPrevented).toBe(false);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'β' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('treats dead-key keydown as accent composition input, not a hotkey', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&deadKeyHotkey=true');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const keydownPrevented = await page.evaluate(() => {
			const target = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!target) {
				throw new Error('Missing editable text node');
			}

			const event = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				key: 'Dead',
				code: 'Quote',
				ctrlKey: true,
				altKey: true
			});
			target.dispatchEvent(event);
			return event.defaultPrevented;
		});
		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'é'
		});

		expect(keydownPrevented).toBe(false);
		expect(insertPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'é' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('toggles bold only on a native double-click word selection', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(3);

		await texts.nth(1).dblclick();
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});

		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return value.children.map((child) =>
					child.content?.map((part) => [part.text, part.marks] as const)
				);
			})
			.toEqual([[['lead', undefined]], [['note', { bold: true }]], undefined]);
		await expect(texts.nth(0)).toHaveText('lead');
		await expect(texts.nth(1)).toHaveText('note');
		await expect(texts.nth(2)).toHaveText('');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('preserves a reverse native selection when toggling a mark', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setReverseSelectionByTextIndex(page, 0, 1, 1, 3);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return [
					value.children[0]?.content?.map((part) => [part.text, part.marks] as const),
					value.children[1]?.content?.map((part) => [part.text, part.marks] as const)
				];
			})
			.toEqual([
				[
					['l', undefined],
					['ead', { bold: true }]
				],
				[
					['not', { bold: true }],
					['e', undefined]
				]
			]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		issues.assertClean();
	});

	test('preserves a reverse native selection across a soft break when toggling a mark', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await page.keyboard.press('Shift+Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'le\nad' }]);

		await setReverseSelectionByTextIndex(page, 0, 1, 0, 4);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 4,
			isCollapsed: false,
			isReversed: true
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'l' }, { text: 'e\na', marks: { bold: true } }, { text: 'd' }]);
		await expect(getTextLocators(page).first()).toHaveText('le\nad');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 4,
			isCollapsed: false,
			isReversed: true
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		issues.assertClean();
	});

	test('does not leave stale DOM clones when toggling a mark off', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);
		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alpha beta' }]);
		await expect(getTextLocators(page).first()).toHaveText('Alpha beta');
		await expect
			.poll(() => page.locator('[data-edytor-type="paragraph"]').first().locator('p').textContent())
			.toBe('Alpha beta');

		issues.assertClean();
	});

	test('routes native format beforeinput events through editor marks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 1, 4);

		const boldPrevented = await dispatchBeforeInput(page, {
			inputType: 'formatBold'
		});
		expect(boldPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return [value.children[0]?.content?.[0]?.marks, value.children[1]?.content?.[0]?.marks];
			})
			.toEqual([{ bold: true }, { bold: true }]);

		const removePrevented = await dispatchBeforeInput(page, {
			inputType: 'formatRemove'
		});
		expect(removePrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return [value.children[0]?.content?.[0]?.marks, value.children[1]?.content?.[0]?.marks];
			})
			.toEqual([undefined, undefined]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('nests the current block with tab in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1);
		await page.keyboard.press('Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						content?: Array<{ text: string }>;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'lead' }],
					children: [
						{
							type: 'paragraph',
							data: {},
							content: [{ text: 'note' }]
						}
					]
				},
				{
					type: 'paragraph',
					data: {}
				}
			]);

		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('unnests the current block with shift+tab in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1);
		await page.keyboard.press('Tab');
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await page.keyboard.press('Shift+Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						content?: Array<{ text: string }>;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'lead' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {}
				}
			]);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					Boolean(document.activeElement?.closest?.('[data-edytor], [contenteditable="true"]'))
				)
			)
			.toBe(true);

		issues.assertClean();
	});

	test('unnests a newly split soft-break block with shift+tab in the real browser', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		for (const key of ['O', 'n', 'e']) {
			await page.keyboard.press(key);
		}
		await page.keyboard.press('Enter');
		for (const key of ['T', 'w', 'o']) {
			await page.keyboard.press(key);
		}
		await page.keyboard.press('Shift+Enter');
		for (const key of ['B', 'r']) {
			await page.keyboard.press(key);
		}

		await page.keyboard.press('Tab');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						content?: Array<{ text: string }>;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'One' }],
					children: [
						{
							type: 'paragraph',
							data: {},
							content: [{ text: 'Two\nBr' }]
						}
					]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'tail' }]
				}
			]);

		await page.keyboard.press('Shift+Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'One' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Two\nBr' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'tail' }]
				}
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'Two\nBr'.length,
			yEnd: 'Two\nBr'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('treats browser reverse-tab key aliases as shift+tab', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1);
		await page.keyboard.press('Tab');
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		const defaultPrevented = await page.evaluate(() => {
			const event = new KeyboardEvent('keydown', {
				key: 'ISO_Left_Tab',
				code: 'Tab',
				bubbles: true,
				cancelable: true
			});
			document.dispatchEvent(event);
			return event.defaultPrevented;
		});

		expect(defaultPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						content?: Array<{ text: string }>;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'lead' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {}
				}
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('unnests after clearing a previously nested document', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page, { requireRuntime: true });
		await page.evaluate(() => {
			(window as Window & { __EDYTOR__?: { clear: () => void } }).__EDYTOR__?.clear();
		});
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: unknown[] }>(page, 'value');
				return value.children.length;
			})
			.toBe(1);
		await setSelectionByTextIndex(page, 0, 0);
		for (const key of ['O', 'n', 'e']) {
			await page.keyboard.press(key);
		}
		await page.keyboard.press('Enter');
		for (const key of ['T', 'w', 'o']) {
			await page.keyboard.press(key);
		}
		await page.keyboard.press('Shift+Enter');
		for (const key of ['B', 'r']) {
			await page.keyboard.press(key);
		}
		await page.keyboard.press('Tab');
		await page.keyboard.press('Shift+Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'One' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Two\nBr' }]
				}
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'Two\nBr'.length,
			yEnd: 'Two\nBr'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('unnests a selected block with shift+tab in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1);
		await page.keyboard.press('Tab');
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			selectedBlockPaths: [[0, 0]]
		});

		await page.keyboard.press('Shift+Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						content?: Array<{ text: string }>;
						children?: Array<{ type: string; content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'lead' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {}
				}
			]);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});

		issues.assertClean();
	});

	test('deletes a selected block with backspace in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			isCollapsed: false,
			selectedBlockPaths: []
		});
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});
		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['First block', 'lead  tail']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			isCollapsed: true,
			selectedBlockPaths: []
		});

		issues.assertClean();
	});

	test('ignores stale editor selection when keydown targets an outside control', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});

		await page.evaluate(() => {
			const input = document.createElement('input');
			input.setAttribute('data-testid', 'outside-input');
			input.value = 'outside';
			document.body.append(input);
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		});
		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['First block', 'Marked middle', 'lead  tail']);
		await expect(page.getByTestId('outside-input')).toHaveValue('outsid');

		issues.assertClean();
	});

	test('undoes and redoes a browser text insertion with selection restoration', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('a');

		await page.keyboard.press(`${modKey}+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('undoes and redoes a reverse-selection mark toggle with native direction restored', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setReverseSelectionByTextIndex(page, 0, 1, 1, 3);
		await page.keyboard.press(`${modKey}+B`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return [
					value.children[0]?.content?.map((part) => [part.text, part.marks] as const),
					value.children[1]?.content?.map((part) => [part.text, part.marks] as const)
				];
			})
			.toEqual([
				[
					['l', undefined],
					['ead', { bold: true }]
				],
				[
					['not', { bold: true }],
					['e', undefined]
				]
			]);

		await page.keyboard.press(`${modKey}+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return [
					value.children[0]?.content?.map((part) => [part.text, part.marks] as const),
					value.children[1]?.content?.map((part) => [part.text, part.marks] as const)
				];
			})
			.toEqual([[['lead', undefined]], [['note', undefined]]]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			isReversed: true
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return [
					value.children[0]?.content?.map((part) => [part.text, part.marks] as const),
					value.children[1]?.content?.map((part) => [part.text, part.marks] as const)
				];
			})
			.toEqual([
				[
					['l', undefined],
					['ead', { bold: true }]
				],
				[
					['not', { bold: true }],
					['e', undefined]
				]
			]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			isReversed: true
		});
		await expect
			.poll(() => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false
			});

		issues.assertClean();
	});

	test('undoes and redoes a paragraph split with selection restoration', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('xy');
		await page.keyboard.press('Enter');

		await expectVisibleOrderToMatchSerializedOrder(page, ['xy', '', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.press(`${modKey}+Z`);
		await expectVisibleOrderToMatchSerializedOrder(page, ['xy', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expectVisibleOrderToMatchSerializedOrder(page, ['xy', '', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('splits at the restored caret after undoing a paragraph split', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('xy');
		await page.keyboard.press('Enter');
		await page.keyboard.press(`${modKey}+Z`);

		await expectVisibleOrderToMatchSerializedOrder(page, ['xy', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.keyboard.press('Enter');

		await expectVisibleOrderToMatchSerializedOrder(page, ['xy', '', 'note', 'tail']);

		issues.assertClean();
	});

	test('routes native history beforeinput undo and redo through editor history', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');

		const undoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyUndo'
		});
		expect(undoPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		const redoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyRedo'
		});
		expect(redoPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes an internally selected nested block with backspace', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nestedInline');
		await waitForEditorReady(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const nestedBlock = edytor?.root?.children?.[0]?.children?.[0];
			if (!edytor?.node || !nestedBlock) {
				throw new Error('Missing nested block');
			}

			edytor.node.focus();
			edytor.selection.selectBlocks(nestedBlock);
		});
		await expectSelection(page, {
			selectedBlockPaths: [[0, 0]]
		});

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ children?: unknown[]; content?: Array<{ text?: string }> }>;
				}>(page, 'value');
				return {
					parentChildren: value.children[0]?.children ?? [],
					topLevelTexts: value.children.map(
						(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
					)
				};
			})
			.toEqual({
				parentChildren: [],
				topLevelTexts: ['helloWorldProut', 'After']
			});
		await expectSelection(page, {
			selectedBlockPaths: [],
			startBlockPath: [0],
			endBlockPath: [0],
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes multiple internally selected nested blocks with backspace', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const parent = edytor?.root?.children?.[0];
			const nestedBlocks = parent?.children ?? [];
			if (!edytor?.node || nestedBlocks.length < 2) {
				throw new Error('Missing nested sibling blocks');
			}

			edytor.node.focus();
			edytor.selection.selectBlocks(...nestedBlocks);
		});
		await expectSelection(page, {
			selectedBlockPaths: [
				[0, 0],
				[0, 1]
			]
		});

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ children?: unknown[]; content?: Array<{ text?: string }> }>;
				}>(page, 'value');
				return {
					parentChildren: value.children[0]?.children ?? [],
					topLevelTexts: value.children.map(
						(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
					)
				};
			})
			.toEqual({
				parentChildren: [],
				topLevelTexts: ['Hello', 'After']
			});
		await expectSelection(page, {
			selectedBlockPaths: [],
			startBlockPath: [0],
			endBlockPath: [0],
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('undoes and redoes selected-block deletion content in the real browser', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			isCollapsed: false,
			selectedBlockPaths: []
		});
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});
		await page.keyboard.press('Backspace');

		await expectVisibleOrderToMatchSerializedOrder(page, ['First block', 'lead  tail']);

		await page.keyboard.press(`${modKey}+Z`);
		await expectVisibleOrderToMatchSerializedOrder(page, [
			'First block',
			'Marked middle',
			'lead  tail'
		]);

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expectVisibleOrderToMatchSerializedOrder(page, ['First block', 'lead  tail']);

		issues.assertClean();
	});

	test('inserts a tab character inside a code line in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const '.length);
		await page.keyboard.press('Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.[0]?.content?.[0]?.text;
			})
			.toBe('const \ta = 1;');
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 'const \t'.length,
			yEnd: 'const \t'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps typing after a code-line tab model-owned in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const '.length);
		await page.keyboard.press('Tab');
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.[0]?.content?.[0]?.text;
			})
			.toBe('const \tXa = 1;');
		await expect
			.poll(() =>
				page.evaluate(() => {
					const codeLine = document.querySelector<HTMLElement>('[data-edytor-type="codeLine"]');
					const text = codeLine?.querySelector<HTMLElement>('[data-edytor-text="true"]');
					return {
						codeLineText: codeLine?.textContent?.replaceAll('\u200B', '') ?? null,
						textNodeCount: codeLine?.querySelectorAll('[data-edytor-text="true"]').length ?? 0,
						textWrapperText: text?.textContent?.replaceAll('\u200B', '') ?? null
					};
				})
			)
			.toEqual({
				codeLineText: 'const \tXa = 1;',
				textNodeCount: 1,
				textWrapperText: 'const \tXa = 1;'
			});
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 'const \tX'.length,
			yEnd: 'const \tX'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('accepts code suggestions with tab in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const a = 1;'.length);
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const codeLine = edytor?.selection?.state?.startBlock;
					if (!edytor || !codeLine) {
						return false;
					}
					codeLine.suggestions = [[{ text: ' // done' }]];
					return codeLine.rawSuggestions !== null;
				})
			)
			.toBe(true);

		await page.keyboard.press('Tab');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.[0]?.content?.[0]?.text;
			})
			.toBe('const a = 1; // done');
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const codeLine = edytor?.root?.children?.[0]?.children?.[0];
					return codeLine?.rawSuggestions === null;
				})
			)
			.toBe(true);
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 'const a = 1; // done'.length,
			yEnd: 'const a = 1; // done'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('clears code suggestions on escape in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 3);
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const codeLine = edytor?.selection?.state?.startBlock;
					if (!edytor || !codeLine) {
						return false;
					}
					codeLine.suggestions = [[{ text: "const b = 'world';" }]];
					return codeLine.rawSuggestions !== null;
				})
			)
			.toBe(true);
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const codeLine = edytor?.root?.children?.[0]?.children?.[0];
					return codeLine?.rawSuggestions !== null;
				})
			)
			.toBe(true);
		await page.keyboard.press('Escape');
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const codeLine = edytor?.root?.children?.[0]?.children?.[0];
					return codeLine?.rawSuggestions === null;
				})
			)
			.toBe(true);

		issues.assertClean();
	});
});
