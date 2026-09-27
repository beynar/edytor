import { expect, test, type Page } from './editorTest';

import {
	dragSelectionByTextIndex,
	expectSelection,
	getPlaceholderLocators,
	modKey,
	readJsonByTestId,
	readSelectedInlineBlockState,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const stripIds = <T>(value: T): T => {
	return JSON.parse(
		JSON.stringify(value, (key, current) => {
			return key === 'id' ? undefined : current;
		})
	) as T;
};

const selectInlineBlockByIndex = async (page: Page, index: number) => {
	await page.evaluate((inlineIndex) => {
		const inlineBlocks = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const target = inlineBlocks[inlineIndex];
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target || !editor) {
			throw new Error(`Missing inline block at index ${inlineIndex}`);
		}

		editor.focus();
		const range = document.createRange();
		range.selectNode(target);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
		(
			window as Window & { __EDYTOR__?: { selection?: { onSelectionChange?: () => void } } }
		).__EDYTOR__?.selection?.onSelectionChange?.();
		editor.focus();
	}, index);
};

const insertBogusLineBreakAroundInlineBlock = async (page: Page, placement: 'before' | 'after') => {
	await page.evaluate((lineBreakPlacement) => {
		const inlineBlocks = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const target = inlineBlocks[1];
		const parent = target?.parentNode;
		if (!target || !parent) {
			throw new Error('Missing inline mention target');
		}

		const lineBreak = document.createElement('br');
		lineBreak.setAttribute('data-test-inline-bogus-br', lineBreakPlacement);
		parent.insertBefore(lineBreak, lineBreakPlacement === 'before' ? target : target.nextSibling);
	}, placement);
};

const readTopLevelInlineBlockCount = (page: Page) =>
	page.evaluate(
		() =>
			Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')).filter(
				(element) => !element.parentElement?.closest('[data-edytor-inline-block]')
			).length
	);

const installInlineTypingStabilityProbe = async (page: Page) => {
	await page.evaluate(() => {
		const targetText = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
		).find((text) => text.textContent === 'lead ');
		const parent = targetText?.closest('[data-edytor-type="paragraph"]');
		const inlineBlock = parent?.querySelector<HTMLElement>('[data-edytor-inline-block]');
		const trailingText = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		).find((text) => text.textContent === ' end');
		if (!targetText || !parent || !inlineBlock || !trailingText) {
			throw new Error('Missing inline stability probe targets');
		}

		const removedTargets: string[] = [];
		const isTargetRemoved = (removedNode: Node, target: Node) =>
			removedNode === target || (removedNode instanceof Element && removedNode.contains(target));
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const removedNode of record.removedNodes) {
					if (isTargetRemoved(removedNode, targetText)) {
						removedTargets.push('leading-text');
					}
					if (isTargetRemoved(removedNode, inlineBlock)) {
						removedTargets.push('inline-block');
					}
					if (isTargetRemoved(removedNode, trailingText)) {
						removedTargets.push('trailing-text');
					}
				}
			}
		});

		observer.observe(parent, { childList: true, subtree: true });
		(
			window as Window & {
				__INLINE_TYPING_STABILITY_PROBE__?: {
					targetText: HTMLElement;
					inlineBlock: HTMLElement;
					trailingText: HTMLElement;
					observer: MutationObserver;
					removedTargets: string[];
				};
			}
		).__INLINE_TYPING_STABILITY_PROBE__ = {
			targetText,
			inlineBlock,
			trailingText,
			observer,
			removedTargets
		};
	});
};

const readInlineTypingStabilityProbe = (page: Page) =>
	page.evaluate(() => {
		const probe = (
			window as Window & {
				__INLINE_TYPING_STABILITY_PROBE__?: {
					targetText: HTMLElement;
					inlineBlock: HTMLElement;
					trailingText: HTMLElement;
					removedTargets: string[];
				};
			}
		).__INLINE_TYPING_STABILITY_PROBE__;
		if (!probe) {
			throw new Error('Missing inline stability probe');
		}

		const parent = probe.inlineBlock.closest('[data-edytor-type="paragraph"]');
		const currentLeadingText = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		).find((text) => text.textContent === 'lead X');
		const currentTrailingText = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		).find((text) => text.textContent === ' end');
		const currentInlineBlock = parent?.querySelector<HTMLElement>('[data-edytor-inline-block]');

		return {
			removedTargets: probe.removedTargets,
			sameLeadingText: currentLeadingText === probe.targetText,
			sameInlineBlock: currentInlineBlock === probe.inlineBlock,
			sameTrailingText: currentTrailingText === probe.trailingText
		};
	});

const installMarkedInlineTypingStabilityProbe = async (page: Page) => {
	await page.evaluate(() => {
		const parent = document.querySelector<HTMLElement>('[data-edytor-type="paragraph"]');
		const inlineBlocks = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-inline-block]') ?? []
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const secondInlineBlock = inlineBlocks[1];
		const textParts = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		);
		const worldText = textParts.find((text) => text.textContent?.startsWith('World'));
		const proutText = textParts.find((text) => text.textContent === 'Prout');
		if (!parent || !worldText || !secondInlineBlock || !proutText) {
			throw new Error('Missing marked inline stability probe targets');
		}

		const removedTargets: string[] = [];
		const isTargetRemoved = (removedNode: Node, target: Node) =>
			removedNode === target || (removedNode instanceof Element && removedNode.contains(target));
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const removedNode of record.removedNodes) {
					if (isTargetRemoved(removedNode, worldText)) {
						removedTargets.push('world-text');
					}
					if (isTargetRemoved(removedNode, secondInlineBlock)) {
						removedTargets.push('inline-block');
					}
					if (isTargetRemoved(removedNode, proutText)) {
						removedTargets.push('prout-text');
					}
				}
			}
		});

		observer.observe(parent, { childList: true, subtree: true });
		(
			window as Window & {
				__MARKED_INLINE_TYPING_STABILITY_PROBE__?: {
					inlineBlock: HTMLElement;
					observer: MutationObserver;
					proutText: HTMLElement;
					removedTargets: string[];
					worldText: HTMLElement;
				};
			}
		).__MARKED_INLINE_TYPING_STABILITY_PROBE__ = {
			inlineBlock: secondInlineBlock,
			observer,
			proutText,
			removedTargets,
			worldText
		};
	});
};

const readMarkedInlineTypingStabilityProbe = (page: Page) =>
	page.evaluate(() => {
		const probe = (
			window as Window & {
				__MARKED_INLINE_TYPING_STABILITY_PROBE__?: {
					inlineBlock: HTMLElement;
					proutText: HTMLElement;
					removedTargets: string[];
					worldText: HTMLElement;
				};
			}
		).__MARKED_INLINE_TYPING_STABILITY_PROBE__;
		if (!probe) {
			throw new Error('Missing marked inline stability probe');
		}

		const parent = document.querySelector<HTMLElement>('[data-edytor-type="paragraph"]');
		const inlineBlocks = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-inline-block]') ?? []
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const textParts = Array.from(
			parent?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		);

		return {
			removedTargets: probe.removedTargets,
			sameInlineBlock: inlineBlocks[1] === probe.inlineBlock,
			sameProutText: textParts.includes(probe.proutText),
			sameWorldText: textParts.includes(probe.worldText)
		};
	});

const clickJustAfterInlineBlock = async (page: Page, inlineIndex: number) => {
	const point = await page.evaluate((targetIndex) => {
		const inlineBlocks = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const inlineBlock = inlineBlocks[targetIndex];
		if (!inlineBlock) {
			throw new Error(`Missing inline block at index ${targetIndex}`);
		}

		const rect = inlineBlock.getBoundingClientRect();
		return {
			x: rect.right + 1,
			y: rect.top + Math.max(1, rect.height / 3)
		};
	}, inlineIndex);

	await page.mouse.click(point.x, point.y);
};

const clickJustBeforeInlineBlock = async (page: Page, inlineIndex: number) => {
	const point = await page.evaluate((targetIndex) => {
		const inlineBlocks = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
		).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
		const inlineBlock = inlineBlocks[targetIndex];
		if (!inlineBlock) {
			throw new Error(`Missing inline block at index ${targetIndex}`);
		}

		const rect = inlineBlock.getBoundingClientRect();
		return {
			x: rect.left - 1,
			y: rect.top + Math.max(1, rect.height / 3)
		};
	}, inlineIndex);

	await page.mouse.click(point.x, point.y);
};

test.describe('browser inline atomic behavior', () => {
	test('routes placeholder hotkey pending mention insertion through inline atomic path', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&phase=5-retest');
		await waitForEditorReady(page);
		const placeholders = getPlaceholderLocators(page);
		await expect(placeholders).toHaveCount(1);
		await placeholders.first().click();
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('@x');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ data?: object; marks?: object; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([
				{ type: 'mention', data: {} },
				{ text: 'x', marks: { bold: true } }
			]);
		await expect(page.locator('[data-edytor-inline-block]')).not.toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps inline-boundary DOM stable while typing before an inline mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 'lead '.length);
		await installInlineTypingStabilityProbe(page);

		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead X' }, { type: 'mention', data: {} }, { text: ' end' }]);
		await expect
			.poll(() => readInlineTypingStabilityProbe(page))
			.toEqual({
				removedTargets: [],
				sameLeadingText: true,
				sameInlineBlock: true,
				sameTrailingText: true
			});

		issues.assertClean();
	});

	test('keeps marked inline-boundary content after undo redo before typing again', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nestedInline');
		await waitForEditorReady(page);
		await clickJustBeforeInlineBlock(page, 1);
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 'World'.length,
			yEnd: 'World'.length,
			isCollapsed: true
		});
		await page.keyboard.type('eza ');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ data?: object; marks?: object; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([
				{ text: 'hello', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Worldeza ', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Prout', marks: { bold: true } }
			]);

		await page.keyboard.press(`${modKey}+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ data?: object; marks?: object; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([
				{ text: 'hello', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'World', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Prout', marks: { bold: true } }
			]);

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ data?: object; marks?: object; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([
				{ text: 'hello', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Worldeza ', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Prout', marks: { bold: true } }
			]);

		await installMarkedInlineTypingStabilityProbe(page);
		await page.keyboard.type('ez ');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ data?: object; marks?: object; text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([
				{ text: 'hello', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Worldeza ez ', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: 'Prout', marks: { bold: true } }
			]);
		await expect
			.poll(() => readMarkedInlineTypingStabilityProbe(page))
			.toEqual({
				removedTargets: [],
				sameInlineBlock: true,
				sameProutText: true,
				sameWorldText: true
			});

		issues.assertClean();
	});

	test('moves the caret horizontally across inline mentions without entering atomic DOM', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 5);

		await page.keyboard.press('ArrowRight');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 2],
			endTextPath: [1, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		await page.keyboard.press('ArrowLeft');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		issues.assertClean();
	});

	test('moves the caret visually across inline mentions in RTL paragraphs', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=rtlInline&dir=rtl');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'שלום '.length);

		await page.keyboard.press('ArrowLeft');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		await page.keyboard.press('ArrowRight');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 'שלום '.length,
			yEnd: 'שלום '.length,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		issues.assertClean();
	});

	test('selects inline mentions atomically with shift-horizontal arrows', async ({ page }) => {
		for (const { key, textIndex, offset } of [
			{ key: 'Shift+ArrowRight', textIndex: 2, offset: 5 },
			{ key: 'Shift+ArrowLeft', textIndex: 3, offset: 0 }
		]) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, textIndex, offset);
			// Let the model derive settle before the key press — under load a
			// stray selectionchange can still be in flight and the shift+arrow
			// would extend from a stale anchor instead of the placed caret.
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: offset,
				yEnd: offset,
				isCollapsed: true
			});

			await page.keyboard.press(key);
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 1,
					deletionTargetType: 'mention'
				});

			await page.keyboard.press(key === 'Shift+ArrowRight' ? 'Backspace' : 'Delete');
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
					}>(page, 'value');
					return stripIds(value.children[1]?.content);
				})
				.toEqual([{ text: 'lead  end' }]);

			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: 5,
				yEnd: 5,
				isCollapsed: true
			});

			issues.assertClean();
		}
	});

	test('collapses selected inline mentions to either side with horizontal arrows', async ({
		page
	}) => {
		for (const { selectKey, collapseKey, expectedTextPath, expectedOffset } of [
			{
				selectKey: 'Shift+ArrowRight',
				collapseKey: 'ArrowRight',
				expectedTextPath: [1, 2],
				expectedOffset: 0
			},
			{
				selectKey: 'Shift+ArrowRight',
				collapseKey: 'ArrowLeft',
				expectedTextPath: [1, 0],
				expectedOffset: 'lead '.length
			},
			{
				selectKey: 'Shift+ArrowLeft',
				collapseKey: 'ArrowLeft',
				expectedTextPath: [1, 0],
				expectedOffset: 'lead '.length
			},
			{
				selectKey: 'Shift+ArrowLeft',
				collapseKey: 'ArrowRight',
				expectedTextPath: [1, 2],
				expectedOffset: 0
			}
		]) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(
				page,
				selectKey === 'Shift+ArrowRight' ? 2 : 3,
				selectKey === 'Shift+ArrowRight' ? 'lead '.length : 0
			);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: selectKey === 'Shift+ArrowRight' ? 'lead '.length : 0,
				yEnd: selectKey === 'Shift+ArrowRight' ? 'lead '.length : 0,
				isCollapsed: true
			});

			await page.keyboard.press(selectKey);
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 1,
					deletionTargetType: 'mention'
				});

			await page.keyboard.press(collapseKey);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: expectedTextPath,
				endTextPath: expectedTextPath,
				yStart: expectedOffset,
				yEnd: expectedOffset,
				isCollapsed: true
			});
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 0,
					deletionTargetType: null
				});

			issues.assertClean();
		}
	});

	test('selects inline mentions atomically with shift-horizontal arrows in RTL paragraphs', async ({
		page
	}) => {
		for (const { key, textIndex, offset } of [
			{ key: 'Shift+ArrowLeft', textIndex: 0, offset: 'שלום '.length },
			{ key: 'Shift+ArrowRight', textIndex: 1, offset: 0 }
		]) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=rtlInline&dir=rtl');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, textIndex, offset);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: offset,
				yEnd: offset,
				isCollapsed: true
			});

			await page.keyboard.press(key);
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 1,
					deletionTargetType: 'mention'
				});

			await page.keyboard.press(key === 'Shift+ArrowLeft' ? 'Backspace' : 'Delete');
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
					}>(page, 'value');
					return stripIds(value.children[0]?.content);
				})
				.toEqual([{ text: 'שלום  סוף' }]);

			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 'שלום '.length,
				yEnd: 'שלום '.length,
				isCollapsed: true
			});

			issues.assertClean();
		}
	});

	test('collapses selected inline mentions visually in RTL paragraphs', async ({ page }) => {
		for (const { selectKey, collapseKey, expectedTextPath, expectedOffset } of [
			{
				selectKey: 'Shift+ArrowLeft',
				collapseKey: 'ArrowLeft',
				expectedTextPath: [0, 2],
				expectedOffset: 0
			},
			{
				selectKey: 'Shift+ArrowLeft',
				collapseKey: 'ArrowRight',
				expectedTextPath: [0, 0],
				expectedOffset: 'שלום '.length
			},
			{
				selectKey: 'Shift+ArrowRight',
				collapseKey: 'ArrowRight',
				expectedTextPath: [0, 0],
				expectedOffset: 'שלום '.length
			},
			{
				selectKey: 'Shift+ArrowRight',
				collapseKey: 'ArrowLeft',
				expectedTextPath: [0, 2],
				expectedOffset: 0
			}
		]) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=rtlInline&dir=rtl');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(
				page,
				selectKey === 'Shift+ArrowLeft' ? 0 : 1,
				selectKey === 'Shift+ArrowLeft' ? 'שלום '.length : 0
			);

			await page.keyboard.press(selectKey);
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 1,
					deletionTargetType: 'mention'
				});

			await page.keyboard.press(collapseKey);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				startTextPath: expectedTextPath,
				endTextPath: expectedTextPath,
				yStart: expectedOffset,
				yEnd: expectedOffset,
				isCollapsed: true
			});
			await expect
				.poll(() => readSelectedInlineBlockState(page))
				.toEqual({
					selectedCount: 0,
					deletionTargetType: null
				});

			issues.assertClean();
		}
	});

	test('selects inline mentions atomically with a real pointer click', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);

		await page
			.locator('[data-edytor-type="paragraph"]')
			.nth(1)
			.locator('[data-edytor-inline-block]')
			.first()
			.click();
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 1,
				deletionTargetType: 'mention'
			});

		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead  end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a selected inline mention with typed text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);

		await page
			.locator('[data-edytor-type="paragraph"]')
			.nth(1)
			.locator('[data-edytor-inline-block]')
			.first()
			.click();
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 1,
				deletionTargetType: 'mention'
			});

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead X end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		issues.assertClean();
	});

	test('maps off-edge clicks after inline mentions to trailing editable text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);

		await clickJustAfterInlineBlock(page, 1);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 2],
			endTextPath: [1, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead ' }, { type: 'mention', data: {} }, { text: 'X end' }]);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 2],
			endTextPath: [1, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});

		issues.assertClean();
	});

	test('clears selected inline mentions when clicking directly before them', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);

		await page
			.locator('[data-edytor-type="paragraph"]')
			.nth(1)
			.locator('[data-edytor-inline-block]')
			.first()
			.click();
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 1,
				deletionTargetType: 'mention'
			});

		await clickJustBeforeInlineBlock(page, 1);
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				selectedCount: 0,
				deletionTargetType: null
			});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 'lead '.length,
			yEnd: 'lead '.length,
			isCollapsed: true
		});

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead X' }, { type: 'mention', data: {} }, { text: ' end' }]);

		issues.assertClean();
	});

	test('replaces only an inline-containing paragraph after a triple-click before an inline atom', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		const texts = page.locator('[data-edytor-text="true"]');
		await expect(texts).toHaveCount(4);

		await texts.nth(2).click({ clickCount: 3 });
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => stripIds(child.content ?? []));
			})
			.toEqual([[{ type: 'mention', data: {} }, { text: 'tail' }], [{ text: 'X' }]]);

		await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(1);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes a native-selected inline mention without relying on beforeinput', async ({
		page
	}) => {
		for (const key of ['Backspace', 'Delete']) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await selectInlineBlockByIndex(page, 1);
			await expect
				.poll(async () =>
					page.evaluate(() => {
						const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
						return edytor?.selection.selectedInlineBlock.size ?? 0;
					})
				)
				.toBe(1);

			await page.keyboard.press(key);

			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
					}>(page, 'value');
					return stripIds(value.children[1]?.content);
				})
				.toEqual([{ text: 'lead  end' }]);

			await expect
				.poll(async () =>
					page.evaluate(() => {
						const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
						const inlineBlocks = Array.from(
							document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
						).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
						return {
							inlineDomNodes: inlineBlocks.length,
							// (R4: atoms are handles by id; only elements are registered.)
							inlineNodeMappings: edytor?.nodeToInlineBlock.size ?? 0
						};
					})
				)
				.toEqual({
					inlineDomNodes: 1,
					inlineNodeMappings: 2
				});

			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: 5,
				yEnd: 5,
				isCollapsed: true
			});

			issues.assertClean();
		}
	});

	test('deletes browser drag-selected ranges across inline mentions atomically', async ({
		page
	}) => {
		for (const { key, startIndex, startOffset, endIndex, endOffset } of [
			{ key: 'Backspace', startIndex: 2, startOffset: 2, endIndex: 3, endOffset: 2 },
			{ key: 'Delete', startIndex: 3, startOffset: 2, endIndex: 2, endOffset: 2 }
		] as const) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await dragSelectionByTextIndex(page, startIndex, startOffset, endIndex, endOffset);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: [1, 0],
				endTextPath: [1, 2],
				yStart: 2,
				yEnd: 2,
				isCollapsed: false
			});

			await page.keyboard.press(key);
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
					}>(page, 'value');
					return stripIds(value.children[1]?.content);
				})
				.toEqual([{ text: 'lend' }]);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: [1, 0],
				endTextPath: [1, 0],
				yStart: 2,
				yEnd: 2,
				isCollapsed: true
			});

			issues.assertClean();
		}
	});

	test('drag-selected inline mention range can be mark-formatted', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await dragSelectionByTextIndex(page, 2, 2, 3, 2);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 2],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false
		});

		await page.keyboard.press(`${modKey}+B`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							data?: object;
							marks?: Record<string, unknown>;
							text?: string;
							type?: string;
						}>;
					}>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([
				{ text: 'le' },
				{ text: 'ad ', marks: { bold: true } },
				{ type: 'mention', data: {} },
				{ text: ' e', marks: { bold: true } },
				{ text: 'nd' }
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 2],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false
		});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const block = document.querySelectorAll<HTMLElement>('[data-edytor-type="paragraph"]')[1];
					if (!block) {
						throw new Error('Missing inline paragraph');
					}

					const inlineAtoms = Array.from(
						block.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
					).filter((element) => !element.parentElement?.closest('[data-edytor-inline-block]'));
					return {
						boldText: Array.from(block.querySelectorAll<HTMLElement>('[data-edytor-mark="bold"]'))
							.map((element) => element.textContent)
							.join('|'),
						inlineCount: inlineAtoms.length,
						textLeaves: Array.from(
							block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
						).map((element) => element.textContent)
					};
				})
			)
			.toEqual({
				boldText: 'ad | e',
				inlineCount: 1,
				textLeaves: ['lead ', ' end']
			});

		issues.assertClean();
	});

	test('removes bogus browser line breaks adjacent to inline mentions', async ({ page }) => {
		for (const { placement, textIndex, offset } of [
			{ placement: 'before', textIndex: 2, offset: 5 },
			{ placement: 'after', textIndex: 3, offset: 0 }
		] as const) {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, textIndex, offset);
			await insertBogusLineBreakAroundInlineBlock(page, placement);

			await expect(page.locator('[data-test-inline-bogus-br]')).toHaveCount(0);
			await expect
				.poll(async () => {
					const value = await readJsonByTestId<{
						children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
					}>(page, 'value');
					return stripIds(value.children[1]?.content);
				})
				.toEqual([{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' end' }]);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: placement === 'before' ? [1, 0] : [1, 2],
				endTextPath: placement === 'before' ? [1, 0] : [1, 2],
				yStart: offset,
				yEnd: offset,
				isCollapsed: true
			});

			issues.assertClean();
		}
	});

	test('does not leave browser-created line breaks when backspacing text before an inline mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 'lead '.length);

		for (let index = 0; index < 'lead '.length; index += 1) {
			await page.keyboard.press('Backspace');
		}

		await expect(page.locator('[data-edytor] br')).toHaveCount(0);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ type: 'mention', data: {} }, { text: ' end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(2);

		issues.assertClean();
	});
});
