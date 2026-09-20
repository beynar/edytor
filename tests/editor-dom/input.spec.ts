import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	dispatchDomTextInputMutation,
	expectSelection,
	getPlaceholderLocators,
	getTextLocators,
	insertUnmanagedDomNode,
	insertUnmanagedLineBreak,
	moveEditorIntoShadowRoot,
	mutateDomTextWithoutInput,
	readJsonByTestId,
	readSelection,
	removeManagedBlockNode,
	removeManagedTextNode,
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

const readBlockTexts = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string }> }>;
	}>(page, 'value');
	return value.children.map(
		(block) => block.content?.map((part) => part.text ?? '').join('') ?? ''
	);
};

const placeCaretInsideTrailingNewlineMarker = async (page: Page) => {
	await page.evaluate(() => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const marker = document.querySelector<HTMLElement>('[data-edytor-trailing-newline]');
		if (!editor || !marker) {
			throw new Error('Missing editor or trailing newline marker');
		}
		const markerText = marker.firstChild;
		const target = markerText ?? marker;
		const offset =
			target.nodeType === Node.TEXT_NODE
				? (target.textContent?.length ?? 0)
				: marker.childNodes.length;

		editor.focus();
		const range = document.createRange();
		range.setStart(target, offset);
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
};

const dispatchDomTextInputMutationWithSelectionJump = async (
	page: Page,
	payload: {
		sourceTextIndex: number;
		value: string;
		jumpTextIndex: number;
		jumpOffset: number;
		inputType: string;
		data?: string | null;
	}
) => {
	await page.evaluate(({ sourceTextIndex, value, jumpTextIndex, jumpOffset, inputType, data }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const sourceText = texts[sourceTextIndex];
		const jumpedText = texts[jumpTextIndex];
		if (!sourceText || !jumpedText) {
			throw new Error('Missing text nodes for input mutation with selection jump');
		}

		const sourceLeaf =
			Array.from(sourceText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
			sourceText.firstChild;
		if (sourceLeaf?.nodeType === Node.TEXT_NODE) {
			sourceLeaf.textContent = value;
		} else {
			sourceText.textContent = value;
		}

		const jumpedLeaf =
			Array.from(jumpedText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
			jumpedText.firstChild ??
			jumpedText;
		const range = document.createRange();
		if (jumpedLeaf.nodeType === Node.TEXT_NODE) {
			range.setStart(jumpedLeaf, Math.min(jumpOffset, jumpedLeaf.textContent?.length ?? 0));
		} else {
			range.setStart(jumpedText, Math.min(jumpOffset, jumpedText.childNodes.length));
		}
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		jumpedText.focus();
		document.dispatchEvent(new Event('selectionchange'));

		const event =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType,
						data: data ?? null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		Object.defineProperties(event, {
			inputType: {
				value: inputType,
				configurable: true
			},
			data: {
				value: data ?? null,
				configurable: true
			}
		});
		sourceText.dispatchEvent(event);
	}, payload);
};

const dispatchShadowBeforeInputWithUnavailableSelection = async (
	page: Page,
	payload: {
		inputType: string;
		data?: string;
		startIndex: number;
		startOffset: number;
		endIndex?: number;
		endOffset?: number;
	}
) => {
	return page.evaluate(({ inputType, data, startIndex, startOffset, endIndex, endOffset }) => {
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

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: true
		}) as InputEvent;
		Object.defineProperties(event, {
			inputType: {
				value: inputType,
				configurable: true
			},
			data: {
				value: data ?? null,
				configurable: true
			},
			getTargetRanges: {
				value: () => [targetRange],
				configurable: true
			}
		});

		target.dispatchEvent(event);
		return event.defaultPrevented;
	}, payload);
};

const dispatchBeforeInputWithOutsideTargetRange = async (
	page: Page,
	payload: {
		inputType: string;
		data?: string;
	}
) => {
	return page.evaluate(({ inputType, data }) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const outside = document.createElement('div');
		outside.setAttribute('data-testid', 'outside-range-source');
		outside.textContent = 'outside';
		document.body.append(outside);

		const outsideText = outside.firstChild;
		if (!outsideText) {
			throw new Error('Missing outside range text');
		}

		const targetRange =
			typeof StaticRange === 'function'
				? new StaticRange({
						startContainer: outsideText,
						startOffset: 1,
						endContainer: outsideText,
						endOffset: 4
					})
				: {
						startContainer: outsideText,
						startOffset: 1,
						endContainer: outsideText,
						endOffset: 4,
						collapsed: false
					};

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: true
		}) as InputEvent;
		Object.defineProperties(event, {
			inputType: {
				value: inputType,
				configurable: true
			},
			data: {
				value: data ?? null,
				configurable: true
			},
			getTargetRanges: {
				value: () => [targetRange],
				configurable: true
			}
		});

		target.dispatchEvent(event);
		return event.defaultPrevented;
	}, payload);
};

const dispatchBeforeInputWithPartialOutsideTargetRange = async (
	page: Page,
	payload: {
		direction: 'editor-to-outside' | 'outside-to-editor';
		inputType: string;
		data?: string;
		textIndex: number;
		textOffset: number;
		outsideOffset: number;
	}
) => {
	return page.evaluate(({ direction, inputType, data, textIndex, textOffset, outsideOffset }) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const textElement = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[
			textIndex
		];
		if (!textElement) {
			throw new Error(`Missing text node at index ${textIndex}`);
		}

		const walker = document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
		let current = walker.nextNode();
		let currentOffset = 0;
		let editorNode: Node = textElement;
		let editorOffset = Math.min(textOffset, textElement.childNodes.length);
		while (current) {
			const length = current.textContent?.length ?? 0;
			const nextOffset = currentOffset + length;
			if (textOffset >= currentOffset && textOffset <= nextOffset) {
				editorNode = current;
				editorOffset = textOffset - currentOffset;
				break;
			}
			currentOffset = nextOffset;
			current = walker.nextNode();
		}

		document.querySelector('[data-testid="partial-outside-range-source"]')?.remove();
		const outside = document.createElement('span');
		outside.setAttribute('data-testid', 'partial-outside-range-source');
		outside.textContent = 'external content';
		if (direction === 'outside-to-editor') {
			target.before(outside);
		} else {
			target.after(outside);
		}

		const outsideText = outside.firstChild;
		if (!outsideText) {
			throw new Error('Missing outside range text');
		}
		const resolvedOutsideOffset = Math.min(outsideOffset, outsideText.textContent?.length ?? 0);

		const start =
			direction === 'outside-to-editor'
				? { node: outsideText, offset: resolvedOutsideOffset }
				: { node: editorNode, offset: editorOffset };
		const end =
			direction === 'outside-to-editor'
				? { node: editorNode, offset: editorOffset }
				: { node: outsideText, offset: resolvedOutsideOffset };
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
						collapsed: false
					};

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: true
		}) as InputEvent;
		Object.defineProperties(event, {
			inputType: {
				value: inputType,
				configurable: true
			},
			data: {
				value: data ?? null,
				configurable: true
			},
			getTargetRanges: {
				value: () => [targetRange],
				configurable: true
			}
		});

		target.dispatchEvent(event);
		return event.defaultPrevented;
	}, payload);
};

const dispatchConsecutiveBrowserOwnedTextMutations = async (page: Page) => {
	const firstPrevented = await dispatchBeforeInput(page, {
		inputType: 'insertText',
		data: 'X',
		cancelable: false
	});
	await mutateDomTextWithoutInput(page, {
		textIndex: 0,
		value: 'leXad',
		caretOffset: 3
	});
	await page.evaluate(() => {
		document.dispatchEvent(new Event('selectionchange'));
	});

	const secondPrevented = await dispatchBeforeInput(page, {
		inputType: 'insertText',
		data: 'Y',
		cancelable: false
	});
	await dispatchDomTextInputMutation(page, {
		textIndex: 0,
		value: 'leXYad',
		caretOffset: 4,
		inputType: 'insertText',
		data: 'Y'
	});

	return { firstPrevented, secondPrevented };
};

test.describe('browser input behavior', () => {
	test('types into an empty first paragraph with the real browser caret', async ({ page }) => {
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
		await expect(getTextLocators(page).first()).toHaveText('a');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('does not keep browser-cloned mark DOM after typing in marked content', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'Alpha beta'.length);
		await page.keyboard.type('eee');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alpha', marks: { bold: true } }, { text: ' betaeee' }]);
		await expect(getTextLocators(page).first()).toHaveText('Alpha betaeee');

		issues.assertClean();
	});

	test('types at the end of a link anchor without losing link marks or cloning DOM', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=links');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'Link'.length);
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([
				{
					text: 'Link!',
					marks: { link: { href: 'https://example.com', target: '_blank' } }
				},
				{ text: ' tail' }
			]);
		await expect(getTextLocators(page).first()).toHaveText('Link! tail');
		await expect(page.locator('[data-edytor-mark="link"] a')).toHaveText('Link!');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not delete preceding non-space text for auto-dot insertText payloads', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '. '
		});
		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead. ');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses dataTransfer text when Safari insertText reports null data', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 3);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			text: 'XY',
			targetRange: {
				startIndex: 0,
				startOffset: 1,
				endOffset: 3
			}
		});
		expect(prevented).toBe(true);

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lXYd', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses dataTransfer text when Safari replacement beforeinput reports null data', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'lead'.length);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			text: '!'
		});
		expect(prevented).toBe(true);

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes insertText tab payload through paragraph tab semantics', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '\t'
		});
		expect(prevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						data?: Record<string, unknown>;
						content?: Array<{ text: string }>;
						children?: Array<{
							type: string;
							data?: Record<string, unknown>;
							content?: Array<{ text: string }>;
						}>;
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
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes insertText tab payload through code tab semantics', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const '.length);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '\t'
		});
		expect(prevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ children?: Array<{ content?: Array<{ text: string }> }> }>;
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

	test('prevents outside target range beforeinput without mutating stale editor selection', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1);

		const prevented = await dispatchBeforeInputWithOutsideTargetRange(page, {
			inputType: 'insertText',
			data: 'X'
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	for (const direction of ['editor-to-outside', 'outside-to-editor'] as const) {
		test(`prevents partial ${direction} target range beforeinput without mutating stale editor selection`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=basic&empty=last');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 1);

			const prevented = await dispatchBeforeInputWithPartialOutsideTargetRange(page, {
				direction,
				inputType: 'insertText',
				data: 'X',
				textIndex: 1,
				textOffset: 2,
				outsideOffset: 8
			});

			expect(prevented).toBe(true);
			await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 1,
				yEnd: 1,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	test('uses beforeinput target ranges when cached selection is stale', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'X',
			targetRange: {
				startIndex: 1,
				startOffset: 2
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'noXte', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('normalizes element-node beforeinput target ranges around inline mentions', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const dispatchElementBoundaryInsert = async (payload: {
			blockIndex: number;
			boundary: 'before' | 'after';
			data: string;
		}) =>
			page.evaluate(({ blockIndex, boundary, data }) => {
				const target = document.querySelector<HTMLElement>('[data-edytor]');
				const block = document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')[
					blockIndex
				];
				const inline = block?.querySelector<HTMLElement>('[data-edytor-inline-block]');
				const selectionContainer = inline?.closest('p') ?? block;
				if (!target || !block || !inline || !selectionContainer) {
					throw new Error('Missing editor, block, inline mention, or selection container');
				}

				let boundaryNode: Node = inline;
				while (boundaryNode.parentNode && boundaryNode.parentNode !== selectionContainer) {
					boundaryNode = boundaryNode.parentNode;
				}
				if (boundaryNode.parentNode !== selectionContainer) {
					throw new Error('Inline mention is not a direct child of the selection container');
				}

				const childIndex = Array.from(selectionContainer.childNodes).indexOf(boundaryNode);
				const offset = childIndex + (boundary === 'after' ? 1 : 0);
				const targetRange =
					typeof StaticRange === 'function'
						? new StaticRange({
								startContainer: selectionContainer,
								startOffset: offset,
								endContainer: selectionContainer,
								endOffset: offset
							})
						: {
								startContainer: selectionContainer,
								startOffset: offset,
								endContainer: selectionContainer,
								endOffset: offset,
								collapsed: true
							};

				const event = new InputEvent('beforeinput', {
					bubbles: true,
					cancelable: true,
					inputType: 'insertText',
					data
				});
				Object.defineProperty(event, 'getTargetRanges', {
					value: () => [targetRange],
					configurable: true
				});
				target.dispatchEvent(event);
				return event.defaultPrevented;
			}, payload);

		await expect(
			dispatchElementBoundaryInsert({
				blockIndex: 0,
				boundary: 'after',
				data: 'A'
			})
		).resolves.toBe(true);
		await expect(
			dispatchElementBoundaryInsert({
				blockIndex: 1,
				boundary: 'before',
				data: 'B'
			})
		).resolves.toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children.map((child) => child.content ?? []));
			})
			.toEqual([
				[{ type: 'mention', data: {} }, { text: 'Atail' }],
				[{ text: 'lead B' }, { type: 'mention', data: {} }, { text: ' end' }]
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses shadow-root beforeinput target ranges when native selection is unavailable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await moveEditorIntoShadowRoot(page);

		const prevented = await dispatchShadowBeforeInputWithUnavailableSelection(page, {
			inputType: 'insertText',
			data: 'X',
			startIndex: 1,
			startOffset: 2
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'noXte', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses text-local backward delete target ranges when cached selection is stale', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			targetRange: {
				startIndex: 1,
				startOffset: 1,
				endIndex: 1,
				endOffset: 2
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'nte', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('uses collapsed text-local forward delete target ranges when cached selection is stale', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward',
			targetRange: {
				startIndex: 1,
				startOffset: 1
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'nte', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps browser-owned deletion with empty follow-up inputType as a separate undo step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const insertPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '!',
			cancelable: false
		});
		expect(insertPrevented).toBe(false);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5,
			inputType: 'insertText',
			data: '!'
		});
		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		const deletePrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(deletePrevented).toBe(false);

		await dispatchDomTextInputMutationWithSelectionJump(page, {
			sourceTextIndex: 0,
			value: 'lead',
			jumpTextIndex: 1,
			jumpOffset: 2,
			inputType: ''
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		const undoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyUndo'
		});
		expect(undoPrevented).toBe(true);

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		const redoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyRedo'
		});
		expect(redoPrevented).toBe(true);

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes input-only native history undo through editor history', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(async () => readBlockTexts(page)).toEqual(['a', 'note', 'tail']);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: '',
			caretOffset: 0,
			inputType: 'historyUndo'
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
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

		await expect.poll(async () => readBlockTexts(page)).toEqual(['a', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes unfocused input-only native history through editor history', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(async () => readBlockTexts(page)).toEqual(['a', 'note', 'tail']);

		await page.evaluate(() => {
			const input = document.createElement('input');
			input.dataset.testid = 'outside-history-focus';
			input.value = 'outside history focus';
			document.body.append(input);
		});
		await page.getByTestId('outside-history-focus').click();
		await page.getByTestId('outside-history-focus').focus();
		await expect(page.getByTestId('outside-history-focus')).toBeFocused();

		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!text) {
				throw new Error('Missing text wrapper for unfocused native undo');
			}

			const textNode =
				Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				text.firstChild;
			if (textNode?.nodeType === Node.TEXT_NODE) {
				textNode.textContent = '';
			} else {
				text.textContent = '';
			}

			const event =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'historyUndo',
							data: null
						})
					: (new Event('input', { bubbles: true }) as InputEvent);

			if (typeof InputEvent !== 'function' || event.inputType !== 'historyUndo') {
				Object.defineProperty(event, 'inputType', {
					value: 'historyUndo',
					configurable: true
				});
			}

			text.dispatchEvent(event);
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!text) {
				throw new Error('Missing text wrapper for unfocused native redo');
			}

			const textNode =
				Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				text.firstChild;
			if (textNode?.nodeType === Node.TEXT_NODE) {
				textNode.textContent = 'a';
			} else {
				text.textContent = 'a';
			}

			const event =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'historyRedo',
							data: null
						})
					: (new Event('input', { bubbles: true }) as InputEvent);

			if (typeof InputEvent !== 'function' || event.inputType !== 'historyRedo') {
				Object.defineProperty(event, 'inputType', {
					value: 'historyRedo',
					configurable: true
				});
			}

			text.dispatchEvent(event);
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['a', 'note', 'tail']);
		await expect
			.poll(async () => {
				const selection = await readSelection(page);
				return {
					startBlockPath: selection.startBlockPath,
					endBlockPath: selection.endBlockPath,
					isCollapsed: selection.isCollapsed
				};
			})
			.toEqual({
				startBlockPath: [0],
				endBlockPath: [0],
				isCollapsed: true
			});

		issues.assertClean();
	});

	test('ignores cross-text delete target ranges so structural backspace still merges blocks', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			targetRange: {
				startIndex: 0,
				startOffset: 4,
				endIndex: 1,
				endOffset: 0
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leadnote', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('ignores cross-text delete target ranges so structural delete still merges blocks', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 'lead'.length);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward',
			targetRange: {
				startIndex: 0,
				startOffset: 'lead'.length,
				endIndex: 1,
				endOffset: 0
			}
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leadnote', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('lifts parent text above nested children when enter is pressed at parent end', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);
		await page.keyboard.press('Enter');

		const value = await readJsonByTestId<{
			children: Array<{ type: string; content?: Array<{ text: string }>; children?: unknown[] }>;
		}>(page, 'value');
		expect(stripIds(value.children)).toEqual([
			{
				type: 'paragraph',
				data: {},
				content: [{ text: 'Hello' }]
			},
			{
				type: 'paragraph',
				data: {},
				children: [
					{
						type: 'paragraph',
						data: {},
						content: [{ text: 'Nested child' }]
					},
					{
						type: 'paragraph',
						data: {},
						content: [{ text: 'Nested tail' }]
					}
				]
			},
			{
				type: 'paragraph',
				data: {},
				content: [{ text: 'After' }]
			}
		]);

		issues.assertClean();
	});

	test('lifts marked inline parent content above nested children when enter is pressed at parent end', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nestedInline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 'Prout'.length);
		await page.keyboard.press('Enter');

		const value = await readJsonByTestId<{
			children: Array<{
				type: string;
				content?: Array<unknown>;
				children?: unknown[];
				data?: Record<string, unknown>;
			}>;
		}>(page, 'value');
		expect(stripIds(value.children)).toEqual([
			{
				type: 'paragraph',
				data: {},
				content: [
					{ text: 'hello', marks: { bold: true } },
					{ type: 'mention', data: {} },
					{ text: 'World', marks: { bold: true } },
					{ type: 'mention', data: {} },
					{ text: 'Prout', marks: { bold: true } }
				]
			},
			{
				type: 'paragraph',
				data: {},
				children: [
					{
						type: 'paragraph',
						data: {},
						content: [{ text: 'One', marks: { bold: true } }]
					}
				]
			},
			{
				type: 'paragraph',
				data: {},
				content: [{ text: 'After' }]
			}
		]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('splits a paragraph in the middle with the real browser enter key', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await page.keyboard.press('Enter');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['le', 'ad', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps Shift+Enter as a soft break with the real browser key', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await page.keyboard.press('Shift+Enter');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead\n', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('maps native selection inside the trailing soft-break marker to the text end', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await dispatchBeforeInput(page, {
			inputType: 'insertLineBreak'
		});
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(1);

		await placeCaretInsideTrailingNewlineMarker(page);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead\n');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('types at the model text end after a native caret lands in the trailing soft-break marker', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await dispatchBeforeInput(page, {
			inputType: 'insertLineBreak'
		});
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(1);

		await placeCaretInsideTrailingNewlineMarker(page);

		await page.keyboard.type('x');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead\nx', 'note', '']);
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('types at the model text end after consecutive trailing soft breaks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.press('Shift+Enter');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead\n\n', 'note', '']);
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(1);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		await placeCaretInsideTrailingNewlineMarker(page);
		await page.keyboard.type('x');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead\n\nx', 'note', '']);
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('deletes only the trailing soft break when Backspace starts in the marker', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await dispatchBeforeInput(page, {
			inputType: 'insertLineBreak'
		});
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(1);

		await placeCaretInsideTrailingNewlineMarker(page);

		await page.keyboard.press('Backspace');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);
		await expect(page.locator('[data-edytor-trailing-newline]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a native range spanning a soft break when typing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await page.keyboard.press('Shift+Enter');
		await expect.poll(() => readBlockTexts(page)).toEqual(['le\nad', 'note', '']);

		await setSelectionByTextIndex(page, 0, 1, 0, 4);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 4,
			isCollapsed: false
		});

		await page.keyboard.type('X');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lXd', 'note', '']);
		await expect(getTextLocators(page).first()).toHaveText('lXd');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces a cross-block browser selection when typing a single character', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leXte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces only a native double-click word selection when typing', async ({ page }) => {
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

		await page.keyboard.type('X');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'X', '']);
		await expect(texts.nth(0)).toHaveText('lead');
		await expect(texts.nth(1)).toHaveText('X');
		await expect(texts.nth(2)).toHaveText('');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('collapses the caret after replacing selected text with the same character', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1, 1, 2);
		await page.keyboard.type('o');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.keyboard.type('X');

		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'noXte', '']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('accepts accented and emoji text through browser insertText', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.insertText('é🙂');

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

	test('model-owns cancelable multi-character insertText payloads', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'é🙂'
		});

		expect(wasPrevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('leé🙂ad');
		await expect(getTextLocators(page).first()).toHaveText('leé🙂ad');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles consecutive browser-owned text mutations before the first input flush', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const result = await dispatchConsecutiveBrowserOwnedTextMutations(page);

		expect(result).toEqual({
			firstPrevented: false,
			secondPrevented: false
		});
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('leXYad');
		await expect(getTextLocators(page).first()).toHaveText('leXYad');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles browser DOM text mutation delivered only through input', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5,
			inputType: 'insertReplacementText'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead!');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('lets native replacement beforeinput reconcile through the following input event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'lead!'
		});
		expect(wasPrevented).toBe(false);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5,
			inputType: 'insertReplacementText'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead!');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles collapsed native replacement from the beforeinput target when selection jumps before input', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'lead!'
		});
		expect(wasPrevented).toBe(false);

		await page.evaluate(() => {
			const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const sourceText = texts[0];
			const jumpedText = texts[1];
			if (!sourceText || !jumpedText) {
				throw new Error('Missing replacement test text nodes');
			}

			const sourceLeaf =
				Array.from(sourceText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				sourceText.firstChild;
			if (sourceLeaf?.nodeType === Node.TEXT_NODE) {
				sourceLeaf.textContent = 'lead!';
			} else {
				sourceText.textContent = 'lead!';
			}

			const jumpedLeaf =
				Array.from(jumpedText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				jumpedText.firstChild ??
				jumpedText;
			const range = document.createRange();
			if (jumpedLeaf.nodeType === Node.TEXT_NODE) {
				range.setStart(jumpedLeaf, Math.min(2, jumpedLeaf.textContent?.length ?? 0));
			} else {
				range.setStart(jumpedText, Math.min(2, jumpedText.childNodes.length));
			}
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			jumpedText.focus();
			document.dispatchEvent(new Event('selectionchange'));

			const event =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'insertReplacementText',
							data: 'lead!'
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			if (typeof InputEvent !== 'function' || event.inputType !== 'insertReplacementText') {
				Object.defineProperties(event, {
					inputType: {
						value: 'insertReplacementText',
						configurable: true
					},
					data: {
						value: 'lead!',
						configurable: true
					}
				});
			}
			sourceText.dispatchEvent(event);
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles collapsed native replacement when the follow-up input reports insertText', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'lead!'
		});
		expect(wasPrevented).toBe(false);

		await page.evaluate(() => {
			const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const sourceText = texts[0];
			const jumpedText = texts[1];
			if (!sourceText || !jumpedText) {
				throw new Error('Missing replacement test text nodes');
			}

			const sourceLeaf =
				Array.from(sourceText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				sourceText.firstChild;
			if (sourceLeaf?.nodeType === Node.TEXT_NODE) {
				sourceLeaf.textContent = 'lead!';
			} else {
				sourceText.textContent = 'lead!';
			}

			const jumpedLeaf =
				Array.from(jumpedText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				jumpedText.firstChild ??
				jumpedText;
			const range = document.createRange();
			if (jumpedLeaf.nodeType === Node.TEXT_NODE) {
				range.setStart(jumpedLeaf, Math.min(2, jumpedLeaf.textContent?.length ?? 0));
			} else {
				range.setStart(jumpedText, Math.min(2, jumpedText.childNodes.length));
			}
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			jumpedText.focus();
			document.dispatchEvent(new Event('selectionchange'));

			const event =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'insertText',
							data: 'lead!'
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			if (typeof InputEvent !== 'function' || event.inputType !== 'insertText') {
				Object.defineProperties(event, {
					inputType: {
						value: 'insertText',
						configurable: true
					},
					data: {
						value: 'lead!',
						configurable: true
					}
				});
			}
			sourceText.dispatchEvent(event);
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles collapsed native replacement when the follow-up inputType is empty', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'lead!'
		});
		expect(wasPrevented).toBe(false);

		await page.evaluate(() => {
			const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const sourceText = texts[0];
			const jumpedText = texts[1];
			if (!sourceText || !jumpedText) {
				throw new Error('Missing replacement test text nodes');
			}

			const sourceLeaf =
				Array.from(sourceText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				sourceText.firstChild;
			if (sourceLeaf?.nodeType === Node.TEXT_NODE) {
				sourceLeaf.textContent = 'lead!';
			} else {
				sourceText.textContent = 'lead!';
			}

			const jumpedLeaf =
				Array.from(jumpedText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
				jumpedText.firstChild ??
				jumpedText;
			const range = document.createRange();
			if (jumpedLeaf.nodeType === Node.TEXT_NODE) {
				range.setStart(jumpedLeaf, Math.min(2, jumpedLeaf.textContent?.length ?? 0));
			} else {
				range.setStart(jumpedText, Math.min(2, jumpedText.childNodes.length));
			}
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			jumpedText.focus();
			document.dispatchEvent(new Event('selectionchange'));

			const event =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: '',
							data: 'lead!'
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			Object.defineProperties(event, {
				inputType: {
					value: '',
					configurable: true
				},
				data: {
					value: 'lead!',
					configurable: true
				}
			});
			sourceText.dispatchEvent(event);
		});

		await expect.poll(async () => readBlockTexts(page)).toEqual(['lead!', 'note', '']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('model-owns native replacement over marked ranges before DOM wrappers mutate', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'Alfa'
		});
		expect(wasPrevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alfa', marks: { bold: true } }, { text: ' beta' }]);
		await expect(getTextLocators(page).first()).toHaveText('Alfa beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs non-cancelable native replacement drift over marked ranges', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'Alfa',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'Alfa',
			caretOffset: 4,
			inputType: 'insertReplacementText',
			data: 'Alfa'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alfa', marks: { bold: true } }, { text: ' beta' }]);
		await expect(getTextLocators(page).first()).toHaveText('Alfa beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('handles cross-block replacement beforeinput through the model', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'X'
		});
		expect(wasPrevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leXte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('model-owns native replacement target ranges across inline mentions', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertReplacementText',
			data: 'X',
			targetRange: {
				startIndex: 2,
				startOffset: 2,
				endIndex: 3,
				endOffset: 2
			}
		});
		expect(wasPrevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[1]?.content ?? []);
			})
			.toEqual([{ text: 'leXnd' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes insertTranspose target ranges through model text insertion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertTranspose',
			data: 'ae',
			targetRange: {
				startIndex: 0,
				startOffset: 1,
				endOffset: 3
			}
		});
		expect(wasPrevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('laed');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes insertFromYank through controlled model text insertion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertFromYank',
			data: '!'
		});
		expect(wasPrevented).toBe(true);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead!');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('lets non-cancelable plain insertText reconcile through the following input event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '!',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead');

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5,
			inputType: 'insertText',
			data: '!'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead!');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes placeholder after non-cancelable native insertText in an empty block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: 'A',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'A',
			caretOffset: 1,
			inputType: 'insertText',
			data: 'A'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('A');
		await expect(getTextLocators(page).first()).toHaveText('A');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('reconciles browser DOM text mutation when no input event fires', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await mutateDomTextWithoutInput(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead!');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes placeholder after browser DOM text mutation without input event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await mutateDomTextWithoutInput(page, {
			textIndex: 0,
			value: 'A',
			caretOffset: 1
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('A');
		await expect(getTextLocators(page).first()).toHaveText('A');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('removes unmanaged DOM nodes inserted into the editable tree', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await insertUnmanagedDomNode(page, {
			textIndex: 0
		});

		await expect(page.locator('[data-test-unmanaged]')).toHaveCount(0);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes browser-created line breaks inserted inside managed text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await insertUnmanagedLineBreak(page, {
			textIndex: 0
		});

		await expect(page.locator('[data-test-unmanaged-br]')).toHaveCount(0);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores a managed text DOM node removed outside the renderer', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await removeManagedTextNode(page, {
			textIndex: 0
		});

		await expect(page.locator('[data-edytor-text="true"]')).toHaveCount(3);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('lead');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores a managed block DOM node removed outside the renderer', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await removeManagedBlockNode(page, {
			blockIndex: 0
		});

		await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(3);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('merges backward at the start of the second block with the real browser selection', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leadnote', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('merges backward when the previous block ends after an inline mention', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 0);
		await page.keyboard.press('Backspace');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ data?: object; text?: string; type?: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => stripIds(child.content ?? []));
			})
			.toEqual([
				[
					{ type: 'mention', data: {} },
					{ text: 'taillead ' },
					{ type: 'mention', data: {} },
					{ text: ' end' }
				]
			]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 'tail'.length,
			yEnd: 'tail'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('merges forward at the end of a block with the real browser delete key', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);
		await page.keyboard.press('Delete');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leadnote', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('selects and deletes a divider block from a neighboring text caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		const readRootBlocks = async () => {
			const value = await readJsonByTestId<{
				children: Array<{ content?: Array<{ text?: string }>; type: string }>;
			}>(page, 'value');

			return value.children.map((child) => ({
				text: child.content?.map((part) => part.text ?? '').join('') ?? '',
				type: child.type
			}));
		};

		await page.goto('/test/dom?scenario=divider');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});
		await expect.poll(readRootBlocks).toEqual([
			{ type: 'paragraph', text: 'before divider' },
			{ type: 'divider', text: '' },
			{ type: 'paragraph', text: 'after divider' }
		]);

		await page.keyboard.press('Backspace');

		await expect.poll(readRootBlocks).toEqual([
			{ type: 'paragraph', text: 'before divider' },
			{ type: 'paragraph', text: 'after divider' }
		]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'before divider'.length,
			yEnd: 'before divider'.length,
			isCollapsed: true,
			selectedBlockPaths: []
		});

		issues.assertClean();
	});

	test('keeps code island boundaries isolated under real Backspace and Delete keys', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const readCodeState = async () => {
			const value = await readJsonByTestId<{
				children: Array<{
					children?: Array<{ content?: Array<{ text: string }> }>;
					content?: Array<{ text: string }>;
					type: string;
				}>;
			}>(page, 'value');

			return {
				rootTypes: value.children.map((child) => child.type),
				codeLines: value.children[0]?.children?.map((child) => child.content?.[0]?.text ?? ''),
				afterText: value.children[1]?.content?.[0]?.text ?? ''
			};
		};

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Backspace');

		await expect.poll(readCodeState).toEqual({
			rootTypes: ['code', 'paragraph'],
			codeLines: ['const a = 1;', 'return a;'],
			afterText: 'after code'
		});
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 1, 'return a;'.length);
		await page.keyboard.press('Delete');

		await expect.poll(readCodeState).toEqual({
			rootTypes: ['code', 'paragraph'],
			codeLines: ['const a = 1;', 'return a;'],
			afterText: 'after code'
		});
		await expectSelection(page, {
			startBlockPath: [0, 1],
			endBlockPath: [0, 1],
			yStart: 'return a;'.length,
			yEnd: 'return a;'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('pastes multiline text over a live browser selection', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);
		await dispatchBeforeInput(page, {
			inputType: 'insertFromPaste',
			text: 'X\nY'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['leX\nYte', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
