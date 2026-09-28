import { expect, test, type Page } from './editorTest';

import { expectedByBrowser } from './browserExpectations';
import {
	blurEditor,
	dispatchComposition,
	expectSelection,
	getPlaceholderLocators,
	modKey,
	moveEditorIntoShadowRoot,
	readJsonByTestId,
	setSelectionAtInlineElementBoundary,
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

const readFirstBlockDomText = async (page: Page) =>
	page.evaluate(() => {
		const block = document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')[0];
		const text = block?.querySelector<HTMLElement>('[data-edytor-text="true"]');
		return text?.textContent ?? '';
	});

const mutateDomDuringCompositionWithoutBeforeInput = async (page: Page, value: string) =>
	page.evaluate((compositionText) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!editor || !text) {
			throw new Error('Missing editor or managed text node for composition mutation');
		}

		const compositionStart =
			typeof CompositionEvent === 'function'
				? new CompositionEvent('compositionstart', {
						bubbles: true,
						cancelable: true,
						data: ''
					})
				: new Event('compositionstart', { bubbles: true, cancelable: true });
		editor.dispatchEvent(compositionStart);

		const textNode =
			Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
			document.createTextNode('');
		if (!textNode.parentNode) {
			text.append(textNode);
		}
		textNode.textContent = compositionText;

		const range = document.createRange();
		range.setStart(textNode, compositionText.length);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const input =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						cancelable: false,
						data: compositionText,
						inputType: 'insertCompositionText',
						isComposing: true
					})
				: (new Event('input', { bubbles: true, cancelable: false }) as InputEvent);
		if (typeof InputEvent !== 'function' || input.inputType !== 'insertCompositionText') {
			Object.defineProperty(input, 'inputType', {
				value: 'insertCompositionText',
				configurable: true
			});
		}
		if (input.data !== compositionText) {
			Object.defineProperty(input, 'data', {
				value: compositionText,
				configurable: true
			});
		}
		if (!input.isComposing) {
			Object.defineProperty(input, 'isComposing', {
				value: true,
				configurable: true
			});
		}

		text.dispatchEvent(input);
	}, value);

const setCodeLineSuggestion = async (page: Page, suggestion: string) =>
	page.evaluate((suggestionText) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const codeLine = edytor?.root?.children?.[0]?.children?.[0];
		if (!codeLine) {
			throw new Error('Missing code line for suggestion setup');
		}

		codeLine.suggestions = [[{ text: suggestionText }]];
		return codeLine.suggestions !== null;
	}, suggestion);

const readCodeSuggestionState = async (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const codeLine = edytor?.root?.children?.[0]?.children?.[0];
		const suggestion = document.querySelector<HTMLElement>('[data-edytor-text-suggestion]');
		return {
			hasRawSuggestion: codeLine?.suggestions !== null,
			suggestionText: suggestion?.textContent ?? null,
			visibleSuggestionCount: document.querySelectorAll('[data-edytor-text-suggestion]').length
		};
	});

const setCaretAfterMarkWrapper = async (page: Page, markIndex: number) => {
	await page.evaluate((targetMarkIndex) => {
		const mark = document.querySelectorAll<HTMLElement>('[data-edytor-mark]')[targetMarkIndex];
		if (!mark) {
			throw new Error(`Missing mark wrapper at index ${targetMarkIndex}`);
		}

		const range = document.createRange();
		// P2.7: the mark element is the tag itself; past its last child is after its text.
		range.setStart(mark, mark.childNodes.length);
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		mark.focus();
		document.dispatchEvent(new Event('selectionchange'));
	}, markIndex);
};

const dispatchLateCompositionInputWithNativeDomDrift = async (
	page: Page,
	payload: { staleDomText: string; inputType: string; data: string }
) =>
	page.evaluate(async ({ staleDomText, inputType, data }) => {
		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const textNode =
			text && Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (!text || !textNode) {
			throw new Error('Missing managed text for late composition input');
		}

		textNode.textContent = staleDomText;
		const range = document.createRange();
		range.setStart(textNode, staleDomText.length);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType,
						data
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		text.dispatchEvent(inputEvent);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}, payload);

const dispatchShadowCompositionWithTargetRange = async (
	page: Page,
	payload: {
		preview: string;
		final: string;
		startIndex: number;
		startOffset: number;
		endIndex?: number;
		endOffset?: number;
	}
) => {
	await page.evaluate(async ({ preview, final, startIndex, startOffset, endIndex, endOffset }) => {
		const host = document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]');
		const shadowRoot = host?.shadowRoot;
		const target = shadowRoot?.querySelector<HTMLElement>('[data-edytor]');
		if (!shadowRoot || !target) {
			throw new Error('Missing shadow editor root');
		}

		Object.defineProperty(shadowRoot, 'getSelection', {
			value: undefined,
			configurable: true
		});
		Object.defineProperty(window, 'getSelection', {
			value: () => null,
			configurable: true
		});
		Object.defineProperty(document, 'getSelection', {
			value: () => null,
			configurable: true
		});

		const resolveTextPoint = (textIndex: number, textOffset: number) => {
			const texts = Array.from(
				shadowRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const textElement = texts[textIndex];
			if (!textElement) {
				throw new Error(`Missing shadow text node at index ${textIndex}`);
			}

			const walker = document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			let currentOffset = 0;
			while (current) {
				const length = current.textContent?.length ?? 0;
				const nextOffset = currentOffset + length;
				if (textOffset >= currentOffset && textOffset <= nextOffset) {
					return {
						node: current,
						offset: textOffset - currentOffset
					};
				}
				currentOffset = nextOffset;
				current = walker.nextNode();
			}

			return {
				node: textElement,
				offset: Math.min(textOffset, textElement.childNodes.length)
			};
		};
		const flushEventTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

		const start = resolveTextPoint(startIndex, startOffset);
		const end = resolveTextPoint(endIndex ?? startIndex, endOffset ?? startOffset);
		const targetRange =
			typeof StaticRange === 'function'
				? new StaticRange({
						startContainer: start.node,
						startOffset: start.offset,
						endContainer: end.node,
						endOffset: end.offset
					})
				: {
						startContainer: start.node,
						startOffset: start.offset,
						endContainer: end.node,
						endOffset: end.offset,
						collapsed: start.node === end.node && start.offset === end.offset
					};

		target.dispatchEvent(
			new CompositionEvent('compositionstart', {
				bubbles: true,
				cancelable: true,
				data: ''
			})
		);

		const beforeInput = new InputEvent('beforeinput', {
			bubbles: true,
			cancelable: true,
			inputType: 'insertCompositionText',
			data: preview
		});
		Object.defineProperty(beforeInput, 'getTargetRanges', {
			value: () => [targetRange],
			configurable: true
		});
		target.dispatchEvent(beforeInput);
		await flushEventTurn();

		target.dispatchEvent(
			new CompositionEvent('compositionend', {
				bubbles: true,
				cancelable: true,
				data: final
			})
		);
		await flushEventTurn();
	}, payload);
};

test.describe('browser composition and selection resilience', () => {
	test('hides empty-block placeholders while IME composition is active', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		await dispatchComposition(page, [{ type: 'compositionend', data: '' }]);
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('é');

		issues.assertClean();
	});

	test('keeps code suggestions alive during composition at the suggestion boundary', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const a = 1;'.length);
		await expect.poll(() => setCodeLineSuggestion(page, ' // done')).toBe(true);
		await expect
			.poll(() => readCodeSuggestionState(page))
			.toEqual({
				hasRawSuggestion: true,
				suggestionText: ' // done',
				visibleSuggestionCount: 1
			});
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 'const a = 1;'.length,
			yEnd: 'const a = 1;'.length,
			isCollapsed: true
		});
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.[0]?.content?.[0]?.text;
			})
			.toBe('const a = 1;に');
		await expect
			.poll(() => readCodeSuggestionState(page))
			.toEqual({
				hasRawSuggestion: true,
				suggestionText: ' // done',
				visibleSuggestionCount: 1
			});
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 'const a = 1;に'.length,
			yEnd: 'const a = 1;に'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits composition into an empty paragraph', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionupdate', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('é');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('processes hotkeys normally after blur drops compositionend', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		await blurEditor(page);
		await page.waitForTimeout(120);

		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press(`${modKey}+B`);
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.content ?? [];
			})
			.toEqual([{ text: 'X', marks: { bold: true } }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('ignores late compositionend data after blur clears dangling composition', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);

		await page.evaluate(() => {
			document.querySelector('[data-testid="outside-composition-target"]')?.remove();

			const target = document.createElement('button');
			target.type = 'button';
			target.dataset.testid = 'outside-composition-target';
			target.textContent = 'outside composition target';
			document.querySelector('[data-testid="editor-shell"]')?.before(target);
			target.focus();
		});
		await expect(page.getByTestId('outside-composition-target')).toBeFocused();
		await page.waitForTimeout(120);

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);
		await page.waitForTimeout(80);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);
		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (
						window as Window & {
							__EDYTOR__?: { isComposing: boolean };
						}
					).__EDYTOR__;

					return {
						activeTestId:
							document.activeElement instanceof HTMLElement
								? (document.activeElement.dataset.testid ?? null)
								: null,
						isComposing: edytor?.isComposing ?? null
					};
				})
			)
			.toEqual({
				activeTestId: 'outside-composition-target',
				isComposing: false
			});

		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('A');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['A', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits non-cancelable composition beforeinput only at compositionend', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{
				type: 'beforeinput',
				inputType: 'insertCompositionText',
				data: 'é',
				cancelable: false
			},
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('é');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores the caret after a delayed browser selection jump following composition', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		// P1.2: the jump is the browser's, not the user's — a page script moves
		// the DOM caret to 0 20 ms after the commit, with no pointer, key or
		// focus event. The IME post-commit jump rule (V5, projector) displays
		// the committed caret back. (The row used to place the jump with
		// `setSelectionByTextIndex`, which marks a gesture: user intent, adopted.)
		await page.evaluate(() => {
			document.addEventListener(
				'compositionend',
				() =>
					setTimeout(() => {
						const element = document.querySelector('[data-edytor-text="true"]')!;
						const leaf = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
						window.getSelection()!.collapse(leaf ?? element, 0);
					}, 20),
				{ once: true, capture: true }
			);
		});
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);
		await page.waitForTimeout(60);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		// The DOM caret shows it too.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const selection = window.getSelection()!;
					const element = document.querySelector('[data-edytor-text="true"]')!;
					return (
						element.contains(selection.anchorNode) &&
						selection.isCollapsed &&
						selection.anchorNode?.nodeType === Node.TEXT_NODE &&
						selection.anchorOffset
					);
				})
			)
			.toBe(1);

		issues.assertClean();
	});

	test('commits final insertFromComposition beforeinput without dropping text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces intermediate composition text with final insertFromComposition data', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('ends composing state after final insertFromComposition before compositionend', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					return {
						isComposing: edytor?.isComposing ?? null
					};
				})
			)
			.toEqual({
				isComposing: false
			});

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles composition DOM mutation when beforeinput is missing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await mutateDomDuringCompositionWithoutBeforeInput(page, 'に');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('に');
		// The model holds what the IME shows; no timer ends the session (plan
		// D-7, R8): it stays live until its compositionend.
		const isComposing = () =>
			page.evaluate(
				() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__?.isComposing ?? null
			);
		expect(await isComposing()).toBe(true);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);
		expect(await isComposing()).toBe(false);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces intermediate composition text instead of appending updates', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits composition before adjacent identical text without merging or duplicating preview', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=compositionRepeat');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('にに');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('にに');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses compositionend data as the final IME value when no final beforeinput arrives', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs stale late composition input after compositionend', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' },
			{ type: 'compositionend', data: 'に' }
		]);

		await dispatchLateCompositionInputWithNativeDomDrift(page, {
			staleDomText: 'n',
			inputType: 'insertCompositionText',
			data: 'n'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('に');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs Firefox-style duplicated committed input after compositionend', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' },
			{ type: 'compositionend', data: 'に' }
		]);

		await dispatchLateCompositionInputWithNativeDomDrift(page, {
			staleDomText: 'にに',
			inputType: 'insertCompositionText',
			data: 'に'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('に');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits shadow-root composition from target ranges when native selection is unavailable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await moveEditorIntoShadowRoot(page);
		await dispatchShadowCompositionWithTargetRange(page, {
			preview: 't',
			final: '東京',
			startIndex: 1,
			startOffset: 2
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'no東京te', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits compositionend data when beforeinput is missing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('に');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces an existing selection when compositionend is the only committed IME event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 3);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('léd');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not duplicate compositionend data after an insertText event during composition', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertText', data: 'é🙂' },
			{ type: 'compositionend', data: 'é🙂' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('é🙂');

		issues.assertClean();
	});

	test('replaces a same-block selection during composition', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 3);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('léd');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a cross-block selection during composition', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leにte', '']);

		await expect
			.poll(() =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
						(text) => text.textContent?.replaceAll('\u200B', '') ?? ''
					)
				)
			)
			.toEqual(['leにte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a cross-block selection when compositionend is the only committed IME event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leにte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps compositionend-only commits at the composition-start target after selection drift', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		await setSelectionByTextIndex(page, 1, 2);
		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leにad', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps a cross-block composition-start range after selection drift', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		await setSelectionByTextIndex(page, 2, 0);
		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['leにte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a mixed-mark selection during composition without inheriting boundary marks', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 0, 8);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: '한' },
			{ type: 'compositionend', data: '한' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Al', marks: { bold: true } }, { text: '한ta' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('inherits a collapsed pending mark when composition starts after a mark toggle', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press(`${modKey}+B`);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'に', marks: { bold: true } }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('inherits pending marks when compositionend is the only IME commit after a mark toggle', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press(`${modKey}+B`);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'に', marks: { bold: true } }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits composition adjacent to an inline mention block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 3, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content);
			})
			.toEqual([{ text: 'lead ' }, { type: 'mention', data: {} }, { text: 'é end' }]);

		issues.assertClean();
	});

	test('commits composition from an element-node caret after an inline mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 0,
			boundary: 'after'
		});
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([{ type: 'mention', data: {} }, { text: 'étail' }]);

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

	test('commits composition from an element-node caret before an inline mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 0,
			boundary: 'before'
		});
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([{ text: 'é' }, { type: 'mention', data: {} }, { text: 'tail' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits compositionend-only data from an element-node inline boundary', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 0,
			boundary: 'after'
		});
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([{ type: 'mention', data: {} }, { text: 'にtail' }]);

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

	test('ignores only the first Enter keydown immediately after compositionend', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&enterHotkey=true');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['に', 'note', 'tail']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await page.keyboard.press('Enter');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['に!', 'note', 'tail']);

		issues.assertClean();
	});

	test('allows Enter after an intervening command following compositionend', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await page.keyboard.press(`${modKey}+u`);
		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['に', '', 'note', 'tail']);

		issues.assertClean();
	});

	test('ignores only the first WebKit Backspace keydown immediately after compositionend', async ({
		page,
		browserName
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&backspaceHotkey=true');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(
				expectedByBrowser(browserName, ['に?', 'note', 'tail'], {
					webkit: {
						value: ['に', 'note', 'tail'],
						quirk: {
							id: 'webkit-post-composition-backspace-first-key',
							because:
								'WebKit fires a Backspace keydown immediately after compositionend that should be ignored once'
						}
					}
				})
			);

		const expectedSelection = expectedByBrowser<Record<string, unknown> | null>(browserName, null, {
			webkit: {
				value: {
					startBlockPath: [0],
					endBlockPath: [0],
					yStart: 1,
					yEnd: 1,
					isCollapsed: true
				},
				quirk: {
					id: 'webkit-post-composition-backspace-caret',
					because:
						'Ignoring the first post-composition Backspace keeps the caret after the committed character'
				}
			}
		});

		if (expectedSelection) {
			await expectSelection(page, expectedSelection);
		}

		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(
				expectedByBrowser(browserName, ['に??', 'note', 'tail'], {
					webkit: {
						value: ['に?', 'note', 'tail'],
						quirk: {
							id: 'webkit-post-composition-backspace-second-key',
							because:
								'Only the first immediate WebKit Backspace is ignored; the second keydown is model-owned'
						}
					}
				})
			);

		issues.assertClean();
	});

	test('does not ignore Backspace after compositionend when the user selected content', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not ignore Backspace after compositionend when the user selected multiple blocks', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		await expectSelection(page, {
			startBlockPath: [2],
			endBlockPath: [2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		await page.waitForTimeout(60);

		await setSelectionByTextIndex(page, 1, 0, 2, 1);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			yStart: 0,
			yEnd: 1,
			isCollapsed: false
		});

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not ignore Backspace after compositionend when selection spans inline mentions', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 3, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});
		await page.waitForTimeout(60);

		await setSelectionByTextIndex(page, 1, 2, 3, 3);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 3,
			isCollapsed: false
		});

		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children.map((child) => child.content ?? []));
			})
			.toEqual([[{ type: 'mention', data: {} }, { text: 'tadに' }]]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves marked text semantics during accented-character composition', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'ê' },
			{ type: 'compositionend', data: 'ê' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alêpha', marks: { bold: true } }, { text: ' beta' }]);

		issues.assertClean();
	});

	test('preserves mark context for composition from a mark-wrapper boundary', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setCaretAfterMarkWrapper(page, 0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'ê' },
			{ type: 'compositionend', data: 'ê' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alphaê', marks: { bold: true } }, { text: ' beta' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('ignores stale blurred selection and keeps later edits coherent', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await blurEditor(page);
		await setSelectionByTextIndex(page, 2, 0);
		await page.keyboard.type('A');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'note', 'A']);

		issues.assertClean();
	});
});
