import { expect, test, type Page } from './editorTest';

import {
	expectedByBrowser,
	skipUnlessProject,
	skipWhenCapabilityMissing
} from './browserExpectations';
import {
	dragSelectionByTextIndex,
	expectSelection,
	getCaretPoint,
	gotoEditorRoute,
	getWordKey,
	getPlaceholderLocators,
	getTextLocators,
	modKey,
	moveEditorIntoShadowRoot,
	readNativeSelectionDirection,
	readSelectedInlineBlockState,
	readSelection,
	readJsonByTestId,
	setSelectionAtInlineElementBoundary,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

const gotoSelectionFixture = async (page: Page, path: string) => {
	await gotoEditorRoute(page, path);
};

const setSelectionInsideShell = async (
	page: Page,
	payload: {
		offset: number;
		shellTestId: string;
		textIndex?: number;
	}
) => {
	await page.evaluate(({ offset, shellTestId, textIndex = 0 }) => {
		const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
		const text = shell?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[textIndex];
		const leaf = text
			? Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE)
			: null;
		if (!text || !leaf) {
			throw new Error(`Missing text ${textIndex} in shell ${shellTestId}`);
		}

		const range = document.createRange();
		range.setStart(leaf, Math.min(offset, leaf.textContent?.length ?? 0));
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		(leaf.parentElement ?? text).focus();
		document.dispatchEvent(new Event('selectionchange'));
	}, payload);
};

const setSelectionAtMarkElement = async (
	page: Page,
	payload: {
		endIndex?: number;
		endOffset?: number;
		markIndex: number;
		startOffset: number;
	}
) => {
	await page.evaluate(
		({ markIndex, startOffset, endIndex = markIndex, endOffset = startOffset }) => {
			const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-mark]'));
			const start = marks[markIndex];
			const end = marks[endIndex];
			if (!start || !end) {
				throw new Error(`Missing mark element at index ${markIndex} or ${endIndex}`);
			}

			const range = document.createRange();
			range.setStart(start, Math.min(startOffset, start.childNodes.length));
			range.setEnd(end, Math.min(endOffset, end.childNodes.length));

			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			start.focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const setPartialOutsideNativeSelection = async (
	page: Page,
	payload: {
		direction?: 'editor-to-outside' | 'outside-to-editor';
		editorTextIndex: number;
		editorOffset: number;
		outsideOffset: number;
	}
) => {
	await page.evaluate(
		({ direction = 'editor-to-outside', editorTextIndex, editorOffset, outsideOffset }) => {
			document.querySelector('[data-testid="outside-selection-target"]')?.remove();
			const editorText = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[
				editorTextIndex
			];
			const editorTextWalker = editorText
				? document.createTreeWalker(editorText, NodeFilter.SHOW_TEXT)
				: null;
			const editorTextNode = editorTextWalker?.nextNode();
			if (!editorText || !editorTextNode) {
				throw new Error(`Missing editor text node at index ${editorTextIndex}`);
			}

			const outsideTarget = document.createElement('span');
			outsideTarget.setAttribute('data-testid', 'outside-selection-target');
			outsideTarget.textContent = 'external content';
			document.body.append(outsideTarget);

			const outsideTextNode = outsideTarget.firstChild;
			if (!outsideTextNode) {
				throw new Error('Missing outside text node');
			}

			const resolvedEditorOffset = Math.min(editorOffset, editorTextNode.textContent?.length ?? 0);
			const resolvedOutsideOffset = Math.min(
				outsideOffset,
				outsideTextNode.textContent?.length ?? 0
			);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			if (selection && typeof selection.setBaseAndExtent === 'function') {
				if (direction === 'outside-to-editor') {
					selection.setBaseAndExtent(
						outsideTextNode,
						resolvedOutsideOffset,
						editorTextNode,
						resolvedEditorOffset
					);
				} else {
					selection.setBaseAndExtent(
						editorTextNode,
						resolvedEditorOffset,
						outsideTextNode,
						resolvedOutsideOffset
					);
				}
			} else {
				const range = document.createRange();
				range.setStart(editorTextNode, resolvedEditorOffset);
				range.setEnd(outsideTextNode, resolvedOutsideOffset);
				selection?.addRange(range);
			}
			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const selectEmptyPlaceholderNativeRange = async (page: Page, textIndex: number) => {
	return page.evaluate((targetTextIndex) => {
		const text = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[
			targetTextIndex
		];
		const placeholder = text?.hasAttribute('data-placeholder') ? text : null;
		if (!text || !placeholder) {
			throw new Error(`Missing empty placeholder for text index ${targetTextIndex}`);
		}

		const range = document.createRange();
		range.setStart(text, 0);
		range.setEndAfter(placeholder);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));

		return {
			isCollapsed: selection?.isCollapsed ?? null,
			rangeCount: selection?.rangeCount ?? 0,
			text: selection?.toString() ?? ''
		};
	}, textIndex);
};

const clickTextOffsetWithPointer = async (
	page: Page,
	payload: {
		offset: number;
		shiftKey?: boolean;
		textIndex: number;
	}
) => {
	const point = await page.evaluate(({ textIndex, offset, shiftKey }) => {
		const text = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[textIndex];
		if (!text) {
			throw new Error(`Missing editor text node at index ${textIndex}`);
		}

		const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
		let current = walker.nextNode();
		let currentOffset = 0;
		while (current) {
			const length = current.textContent?.length ?? 0;
			const nextOffset = currentOffset + length;
			if (offset >= currentOffset && offset <= nextOffset) {
				const range = document.createRange();
				const localOffset = Math.min(offset - currentOffset, length);
				range.setStart(current, localOffset);
				range.setEnd(current, Math.min(localOffset + 1, length));
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) {
					throw new Error('Text offset has no clickable rectangle');
				}
				return {
					x: shiftKey ? rect.left + 1 : rect.left + Math.max(1, rect.width / 2),
					y: rect.top + rect.height / 2
				};
			}
			currentOffset = nextOffset;
			current = walker.nextNode();
		}

		throw new Error(`Offset ${offset} is outside text ${textIndex}`);
	}, payload);

	if (!payload.shiftKey) {
		await page.mouse.click(point.x, point.y);
		return;
	}

	await page.keyboard.down('Shift');
	try {
		await page.mouse.click(point.x, point.y);
	} finally {
		await page.keyboard.up('Shift');
	}
};

const readVoidNavigationSafety = async (page: Page) => {
	const [selection, activeElement] = await Promise.all([
		readSelection(page),
		page.evaluate(() => {
			const active = document.activeElement;
			return {
				tagName: active?.tagName ?? null,
				isInsideFigure: Boolean(active?.closest?.('figure'))
			};
		})
	]);

	const selectedPaths = JSON.stringify(selection.selectedBlockPaths);
	return {
		isSafeImageTarget:
			JSON.stringify(selection.startBlockPath) === '[0]' || selectedPaths === '[[0]]',
		isUnsafeVoidBodyFocus:
			activeElement.isInsideFigure &&
			['BUTTON', 'INPUT', 'IMG'].includes(activeElement.tagName ?? '')
	};
};

const readVoidShiftSelectionSafety = async (page: Page) => {
	const [selection, activeElement] = await Promise.all([
		readSelection(page),
		page.evaluate(() => {
			const active = document.activeElement;
			return {
				tagName: active?.tagName ?? null,
				isInsideFigure: Boolean(active?.closest?.('figure'))
			};
		})
	]);

	const selectedBlockPaths = selection.selectedBlockPaths.map((path) => JSON.stringify(path));
	const startPath = JSON.stringify(selection.startBlockPath);
	const endPath = JSON.stringify(selection.endBlockPath);
	const isUnsafeVoidBodyFocus =
		activeElement.isInsideFigure &&
		['BUTTON', 'INPUT', 'IMG'].includes(activeElement.tagName ?? '');

	return {
		hasModelTarget: Boolean(selection.startBlockPath || selectedBlockPaths.length > 0),
		hasMovedOrExtended:
			!selection.isCollapsed ||
			startPath !== '[1,0]' ||
			endPath !== '[1,0]' ||
			selection.yStart !== 'Nested middle'.length,
		hasVoidOrNextTarget:
			selectedBlockPaths.includes('[2]') ||
			startPath === '[2]' ||
			endPath === '[2]' ||
			endPath === '[3]',
		isUnsafeVoidBodyFocus
	};
};

const setShadowSelectionByTextIndex = async (
	page: Page,
	payload: {
		endIndex?: number;
		endOffset?: number;
		startIndex: number;
		startOffset: number;
	}
) => {
	await page.evaluate(
		({ startIndex, startOffset, endIndex = startIndex, endOffset = startOffset }) => {
			const host = document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]');
			const shadowRoot = host?.shadowRoot;
			if (!shadowRoot) {
				throw new Error('Missing shadow editor root');
			}

			const texts = Array.from(
				shadowRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const start = texts[startIndex];
			const end = texts[endIndex];
			if (!start || !end) {
				throw new Error(`Missing shadow text node at index ${startIndex} or ${endIndex}`);
			}

			const resolveTextPoint = (element: HTMLElement, offset: number) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let current = walker.nextNode();
				let currentOffset = 0;
				while (current) {
					const length = current.textContent?.length ?? 0;
					const endOffset = currentOffset + length;
					if (offset >= currentOffset && offset <= endOffset) {
						return {
							node: current,
							offset: offset - currentOffset
						};
					}
					currentOffset = endOffset;
					current = walker.nextNode();
				}
				return {
					node: element,
					offset: Math.min(offset, element.childNodes.length)
				};
			};

			const startPoint = resolveTextPoint(start, startOffset);
			const endPoint = resolveTextPoint(end, endOffset);
			const selection = shadowRoot.getSelection();
			if (!selection) {
				throw new Error('ShadowRoot.getSelection() returned null');
			}

			const range = document.createRange();
			range.setStart(startPoint.node, startPoint.offset);
			range.setEnd(endPoint.node, endPoint.offset);
			selection.removeAllRanges();
			selection.addRange(range);
			start.focus();

			Object.defineProperty(window, 'getSelection', {
				value: () => null,
				configurable: true
			});
			Object.defineProperty(document, 'getSelection', {
				value: () => null,
				configurable: true
			});

			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const setBuggyCollapsedShadowSelectionByTextIndex = async (
	page: Page,
	payload: {
		endIndex?: number;
		endOffset?: number;
		startIndex: number;
		startOffset: number;
	}
) => {
	await page.evaluate(
		({ startIndex, startOffset, endIndex = startIndex, endOffset = startOffset }) => {
			const host = document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]');
			const shadowRoot = host?.shadowRoot;
			if (!shadowRoot) {
				throw new Error('Missing shadow editor root');
			}

			const texts = Array.from(
				shadowRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const start = texts[startIndex];
			const end = texts[endIndex];
			if (!start || !end) {
				throw new Error(`Missing shadow text node at index ${startIndex} or ${endIndex}`);
			}

			const resolveTextPoint = (element: HTMLElement, offset: number) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let current = walker.nextNode();
				let currentOffset = 0;
				while (current) {
					const length = current.textContent?.length ?? 0;
					const endOffset = currentOffset + length;
					if (offset >= currentOffset && offset <= endOffset) {
						return {
							node: current,
							offset: offset - currentOffset
						};
					}
					currentOffset = endOffset;
					current = walker.nextNode();
				}
				return {
					node: element,
					offset: Math.min(offset, element.childNodes.length)
				};
			};

			const startPoint = resolveTextPoint(start, startOffset);
			const endPoint = resolveTextPoint(end, endOffset);
			const range = document.createRange();
			range.setStart(startPoint.node, startPoint.offset);
			range.setEnd(endPoint.node, endPoint.offset);

			const buggySelection = {
				anchorNode: startPoint.node,
				anchorOffset: startPoint.offset,
				focusNode: endPoint.node,
				focusOffset: endPoint.offset,
				direction: 'forward',
				isCollapsed: true,
				rangeCount: 1,
				getRangeAt: (index: number) => {
					if (index !== 0) {
						throw new Error(`Selection range ${index} is unavailable`);
					}
					return range;
				},
				removeAllRanges: () => {},
				addRange: () => {},
				toString: () => range.toString(),
				type: 'Range'
			} as unknown as Selection;

			Object.defineProperty(shadowRoot, 'getSelection', {
				value: () => buggySelection,
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

			start.focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const setBackwardShadowSelectionByTextIndex = async (
	page: Page,
	payload: {
		endIndex?: number;
		endOffset?: number;
		startIndex: number;
		startOffset: number;
	}
) => {
	await page.evaluate(
		({ startIndex, startOffset, endIndex = startIndex, endOffset = startOffset }) => {
			const host = document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]');
			const shadowRoot = host?.shadowRoot;
			if (!shadowRoot) {
				throw new Error('Missing shadow editor root');
			}

			const texts = Array.from(
				shadowRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const start = texts[startIndex];
			const end = texts[endIndex];
			if (!start || !end) {
				throw new Error(`Missing shadow text node at index ${startIndex} or ${endIndex}`);
			}

			const resolveTextPoint = (element: HTMLElement, offset: number) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let current = walker.nextNode();
				let currentOffset = 0;
				while (current) {
					const length = current.textContent?.length ?? 0;
					const endOffset = currentOffset + length;
					if (offset >= currentOffset && offset <= endOffset) {
						return {
							node: current,
							offset: offset - currentOffset
						};
					}
					currentOffset = endOffset;
					current = walker.nextNode();
				}
				return {
					node: element,
					offset: Math.min(offset, element.childNodes.length)
				};
			};

			const startPoint = resolveTextPoint(start, startOffset);
			const endPoint = resolveTextPoint(end, endOffset);
			const range = document.createRange();
			range.setStart(startPoint.node, startPoint.offset);
			range.setEnd(endPoint.node, endPoint.offset);

			const backwardSelection = {
				anchorNode: endPoint.node,
				anchorOffset: endPoint.offset,
				focusNode: startPoint.node,
				focusOffset: startPoint.offset,
				direction: 'backward',
				isCollapsed: false,
				rangeCount: 1,
				getRangeAt: (index: number) => {
					if (index !== 0) {
						throw new Error(`Selection range ${index} is unavailable`);
					}
					return range;
				},
				removeAllRanges: () => {},
				addRange: () => {},
				toString: () => range.toString(),
				type: 'Range'
			} as unknown as Selection;

			Object.defineProperty(shadowRoot, 'getSelection', {
				value: () => backwardSelection,
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

			start.focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const setComposedShadowSelectionByTextIndex = async (
	page: Page,
	payload: {
		endIndex?: number;
		endOffset?: number;
		startIndex: number;
		startOffset: number;
	}
) => {
	await page.evaluate(
		({ startIndex, startOffset, endIndex = startIndex, endOffset = startOffset }) => {
			const host = document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]');
			const shadowRoot = host?.shadowRoot;
			if (!shadowRoot) {
				throw new Error('Missing shadow editor root');
			}

			Object.defineProperty(shadowRoot, 'getSelection', {
				value: undefined,
				configurable: true
			});

			const texts = Array.from(
				shadowRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const start = texts[startIndex];
			const end = texts[endIndex];
			if (!start || !end) {
				throw new Error(`Missing shadow text node at index ${startIndex} or ${endIndex}`);
			}

			const resolveTextPoint = (element: HTMLElement, offset: number) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let current = walker.nextNode();
				let currentOffset = 0;
				while (current) {
					const length = current.textContent?.length ?? 0;
					const endOffset = currentOffset + length;
					if (offset >= currentOffset && offset <= endOffset) {
						return {
							node: current,
							offset: offset - currentOffset
						};
					}
					currentOffset = endOffset;
					current = walker.nextNode();
				}
				return {
					node: element,
					offset: Math.min(offset, element.childNodes.length)
				};
			};

			const startPoint = resolveTextPoint(start, startOffset);
			const endPoint = resolveTextPoint(end, endOffset);
			const range = document.createRange();
			range.setStart(startPoint.node, startPoint.offset);
			range.setEnd(endPoint.node, endPoint.offset);

			const composedRange =
				typeof StaticRange === 'function'
					? new StaticRange({
							startContainer: startPoint.node,
							startOffset: startPoint.offset,
							endContainer: endPoint.node,
							endOffset: endPoint.offset
						})
					: {
							startContainer: startPoint.node,
							startOffset: startPoint.offset,
							endContainer: endPoint.node,
							endOffset: endPoint.offset
						};
			const fakeSelection = {
				anchorNode: null,
				anchorOffset: 0,
				focusNode: null,
				focusOffset: 0,
				isCollapsed: false,
				rangeCount: 0,
				addRange: () => {},
				getComposedRanges: ({ shadowRoots }: GetComposedRangesOptions = {}) =>
					shadowRoots?.includes(shadowRoot) ? [composedRange] : [],
				removeAllRanges: () => {},
				toString: () => range.toString()
			} as unknown as Selection;

			Object.defineProperty(window, 'getSelection', {
				value: () => fakeSelection,
				configurable: true
			});
			Object.defineProperty(document, 'getSelection', {
				value: () => fakeSelection,
				configurable: true
			});

			start.focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		payload
	);
};

const setNativeMultiRangeSelectionByTextIndex = async (
	page: Page,
	ranges: Array<{
		endIndex: number;
		endOffset: number;
		startIndex: number;
		startOffset: number;
	}>
) =>
	page.evaluate((selectionRanges) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));

		const resolvePoint = (textIndex: number, textOffset: number) => {
			const text = texts[textIndex];
			if (!text) {
				throw new Error(`Missing text node at index ${textIndex}`);
			}

			const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			let currentOffset = 0;
			while (current) {
				const length = current.textContent?.length ?? 0;
				const endOffset = currentOffset + length;
				if (textOffset >= currentOffset && textOffset <= endOffset) {
					return {
						element: text,
						node: current,
						offset: textOffset - currentOffset
					};
				}
				currentOffset = endOffset;
				current = walker.nextNode();
			}

			return {
				element: text,
				node: text,
				offset: Math.min(textOffset, text.childNodes.length)
			};
		};

		const selection = window.getSelection();
		if (!selection) {
			throw new Error('window.getSelection() returned null');
		}

		selection.removeAllRanges();
		let firstElement: HTMLElement | null = null;
		for (const selectionRange of selectionRanges) {
			const start = resolvePoint(selectionRange.startIndex, selectionRange.startOffset);
			const end = resolvePoint(selectionRange.endIndex, selectionRange.endOffset);
			const range = document.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
			selection.addRange(range);
			firstElement ??= start.element;
		}

		const rangeCountBeforeSelectionChange = selection.rangeCount;
		const textBeforeSelectionChange = selection.toString();
		firstElement?.focus();
		document.dispatchEvent(new Event('selectionchange'));

		return {
			rangeCount: rangeCountBeforeSelectionChange,
			text: textBeforeSelectionChange
		};
	}, ranges);

test.describe('browser selection behavior', () => {
	test('keeps inline mention boundaries navigable with native clicks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=inline');
		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(4);

		await texts.nth(1).click();
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0]
		});

		await texts.nth(2).click();
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1]
		});

		issues.assertClean();
	});

	test('normalizes element-node carets around inline block boundaries', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=inline');

		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 0,
			boundary: 'before'
		});
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 0,
			boundary: 'after'
		});
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('focuses empty first, middle, and last paragraphs in the real browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		for (const empty of ['first', 'middle', 'last']) {
			await gotoSelectionFixture(page, `/test/dom?scenario=basic&empty=${empty}`);
			const placeholders = getPlaceholderLocators(page);
			await expect(placeholders).toHaveCount(1);
			await placeholders.first().click();

			const expectedPath = empty === 'middle' ? [1] : empty === 'last' ? [2] : [0];
			await expectSelection(page, {
				startBlockPath: expectedPath,
				endBlockPath: expectedPath,
				yStart: 0,
				yEnd: 0,
				isCollapsed: true
			});
		}

		issues.assertClean();
	});

	test('collapses a native range over empty block contents to the model caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=first');
		await page.evaluate(() => {
			const block = document.querySelector<HTMLElement>('[data-edytor-block="true"]');
			if (!block) throw new Error('Missing empty block');

			const range = document.createRange();
			range.selectNodeContents(block);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			block.focus({ preventScroll: true });
			document.dispatchEvent(new Event('selectionchange'));
		});

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const selection = window.getSelection();
					const anchorElement =
						selection?.anchorNode instanceof Element
							? selection.anchorNode
							: selection?.anchorNode?.parentElement;
					return {
						isCollapsed: selection?.isCollapsed ?? false,
						insideEmptyText: Boolean(
							anchorElement?.closest('[data-edytor-text="true"][data-edytor-text-empty="true"]')
						)
					};
				})
			)
			.toEqual({ isCollapsed: true, insideEmptyText: true });

		issues.assertClean();
	});

	test('clears a native empty-placeholder selection before the next click and edit', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=first');
		const nativeSelection = await selectEmptyPlaceholderNativeRange(page, 0);
		expect(nativeSelection.rangeCount).toBe(1);

		await clickTextOffsetWithPointer(page, {
			textIndex: 1,
			offset: 2
		});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			isCollapsed: true
		});
		const selectionBeforeTyping = await readSelection(page);
		const insertionOffset = selectionBeforeTyping.yStart;

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual([
				'',
				`note`.slice(0, insertionOffset) + 'X' + `note`.slice(insertionOffset),
				'tail'
			]);

		issues.assertClean();
	});

	test('routes typing after native clicks to sibling, nested, deep, and code text targets', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await clickTextOffsetWithPointer(page, {
			textIndex: 1,
			offset: 2
		});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			isCollapsed: true
		});
		const siblingSelection = await readSelection(page);
		await page.keyboard.type('S');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string }> }>;
				}>(page, 'value');
				return value.children.map((child) =>
					(child.content ?? []).map((part) => part.text ?? '').join('')
				);
			})
			.toEqual([
				'lead',
				`note`.slice(0, siblingSelection.yStart) + 'S' + `note`.slice(siblingSelection.yStart),
				''
			]);

		await gotoSelectionFixture(page, '/test/dom?scenario=nested');
		await clickTextOffsetWithPointer(page, {
			textIndex: 1,
			offset: 6
		});
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			startTextPath: [0, 0, 0],
			endTextPath: [0, 0, 0],
			isCollapsed: true
		});
		const nestedSelection = await readSelection(page);
		await page.keyboard.type('N');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text?: string }> }>;
						content?: Array<{ text?: string }>;
					}>;
				}>(page, 'value');
				return {
					parent: value.children[0]?.content?.[0]?.text,
					child: value.children[0]?.children?.[0]?.content?.[0]?.text
				};
			})
			.toEqual({
				parent: 'Hello',
				child:
					`Nested child`.slice(0, nestedSelection.yStart) +
					'N' +
					`Nested child`.slice(nestedSelection.yStart)
			});

		await gotoSelectionFixture(page, '/test/dom?scenario=lists');
		await clickTextOffsetWithPointer(page, {
			textIndex: 2,
			offset: 7
		});
		await expectSelection(page, {
			startBlockPath: [0, 1, 0],
			endBlockPath: [0, 1, 0],
			startTextPath: [0, 1, 0, 0],
			endTextPath: [0, 1, 0, 0],
			isCollapsed: true
		});
		const deepSelection = await readSelection(page);
		await page.keyboard.type('D');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{
							children?: Array<{ content?: Array<{ text?: string }> }>;
							content?: Array<{ text?: string }>;
						}>;
					}>;
				}>(page, 'value');
				return {
					sibling: value.children[0]?.children?.[1]?.content?.[0]?.text,
					deepChild: value.children[0]?.children?.[1]?.children?.[0]?.content?.[0]?.text
				};
			})
			.toEqual({
				sibling: 'Second',
				deepChild:
					`Nested item child`.slice(0, deepSelection.yStart) +
					'D' +
					`Nested item child`.slice(deepSelection.yStart)
			});

		await gotoSelectionFixture(page, '/test/dom?scenario=code');
		await clickTextOffsetWithPointer(page, {
			textIndex: 1,
			offset: 3
		});
		await expectSelection(page, {
			startBlockPath: [0, 1],
			endBlockPath: [0, 1],
			startTextPath: [0, 1, 0],
			endTextPath: [0, 1, 0],
			isCollapsed: true
		});
		const codeSelection = await readSelection(page);
		await page.keyboard.type('C');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text?: string }> }>;
						content?: Array<{ text?: string }>;
					}>;
				}>(page, 'value');
				return {
					caption: value.children[0]?.content?.[0]?.text,
					line: value.children[0]?.children?.[1]?.content?.[0]?.text
				};
			})
			.toEqual({
				caption: 'caption',
				line:
					`return a;`.slice(0, codeSelection.yStart) + 'C' + `return a;`.slice(codeSelection.yStart)
			});

		issues.assertClean();
	});

	test('routes typing from native inline-boundary selection to adjacent text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=inline');
		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 1,
			boundary: 'before'
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
		await page.keyboard.type('B');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return value.children[1]?.content?.map((part) => part.text ?? part.type);
			})
			.toEqual(['lead B', 'mention', ' end']);

		await gotoSelectionFixture(page, '/test/dom?scenario=inline');
		await setSelectionAtInlineElementBoundary(page, {
			blockIndex: 1,
			boundary: 'after'
		});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 2],
			endTextPath: [1, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await page.keyboard.type('A');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return value.children[1]?.content?.map((part) => part.text ?? part.type);
			})
			.toEqual(['lead ', 'mention', 'A end']);

		issues.assertClean();
	});

	test('routes parent element-boundary selection before nested child to the child text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=nested');
		await page.evaluate(() => {
			const childText = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[1];
			const childBlock = childText?.closest('[data-edytor-block]');
			const selectionContainer = childBlock?.parentNode;
			if (!childBlock || !selectionContainer) {
				throw new Error('Missing nested child boundary target');
			}

			const offset = Array.from(selectionContainer.childNodes).indexOf(childBlock);
			const range = document.createRange();
			range.setStart(selectionContainer, offset);
			range.collapse(true);

			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			document.dispatchEvent(new Event('selectionchange'));
		});

		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			startTextPath: [0, 0, 0],
			endTextPath: [0, 0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.getByRole('textbox').press('N');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text?: string }> }>;
						content?: Array<{ text?: string }>;
					}>;
				}>(page, 'value');
				return {
					parent: value.children[0]?.content?.[0]?.text,
					child: value.children[0]?.children?.[0]?.content?.[0]?.text
				};
			})
			.toEqual({
				parent: 'Hello',
				child: 'NNested child'
			});

		issues.assertClean();
	});

	test('routes visible nested text clicks to the clicked child text before input', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=nested');
		await page.getByText('Nested child', { exact: true }).click();
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			startTextPath: [0, 0, 0],
			endTextPath: [0, 0, 0],
			isCollapsed: true
		});

		const selection = await readSelection(page);
		await page.getByRole('textbox').press('N');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text?: string }> }>;
						content?: Array<{ text?: string }>;
					}>;
				}>(page, 'value');
				return {
					parent: value.children[0]?.content?.[0]?.text,
					child: value.children[0]?.children?.[0]?.content?.[0]?.text
				};
			})
			.toEqual({
				parent: 'Hello',
				child:
					`Nested child`.slice(0, selection.yStart) + 'N' + `Nested child`.slice(selection.yStart)
			});

		issues.assertClean();
	});

	test('normalizes Firefox native multi-range selections before the next edit', async ({
		page
	}, testInfo) => {
		const issues = trackPageIssues(page);
		skipUnlessProject(testInfo, ['firefox'], {
			id: 'firefox-native-multirange-selection',
			because: 'Firefox is the target engine that exposes native multi-range selection'
		});

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		const nativeSelection = await setNativeMultiRangeSelectionByTextIndex(page, [
			{ startIndex: 0, startOffset: 2, endIndex: 0, endOffset: 3 },
			{ startIndex: 1, startOffset: 1, endIndex: 1, endOffset: 2 }
		]);
		skipWhenCapabilityMissing(nativeSelection.rangeCount < 2, {
			id: 'native-multirange-selection-unavailable',
			because: 'The browser did not expose multiple native ranges for this run'
		});

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false
		});

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

	test('clicking inside selected block content clears block selection to a caret', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.press(`${modKey}+A`);
		await page.keyboard.press(`${modKey}+A`);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: [[1]]
		});

		await clickTextOffsetWithPointer(page, {
			textIndex: 1,
			offset: 6
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			isCollapsed: true,
			selectedBlockPaths: []
		});

		issues.assertClean();
	});

	test('uses the secondary-click target for the next keyboard edit', async ({
		page,
		browserName
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 1);

		const point = await getCaretPoint(page, 1, 2);
		await page.mouse.click(point.x, point.y, { button: 'right' });
		await page.keyboard.press('Escape');
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string }> }>;
				}>(page, 'value');
				return value.children.map((child) =>
					(child.content ?? []).map((part) => part.text ?? '').join('')
				);
			})
			.toEqual(
				expectedByBrowser(browserName, ['lead', 'noXte', ''], {
					chromium: {
						value: ['lead', 'X', ''],
						quirk: {
							id: 'chromium-secondary-click-word-selection',
							because: 'Chromium selects the secondary-clicked word before keyboard replacement'
						}
					},
					webkit: {
						value: ['lead', 'X', ''],
						quirk: {
							id: 'webkit-secondary-click-word-selection',
							because: 'WebKit selects the secondary-clicked word before keyboard replacement'
						}
					}
				})
			);
		await expectSelection(
			page,
			expectedByBrowser(
				browserName,
				{
					startBlockPath: [1],
					endBlockPath: [1],
					yStart: 3,
					yEnd: 3,
					isCollapsed: true
				},
				{
					chromium: {
						value: {
							startBlockPath: [1],
							endBlockPath: [1],
							yStart: 1,
							yEnd: 1,
							isCollapsed: true
						},
						quirk: {
							id: 'chromium-secondary-click-word-selection-caret',
							because: 'Chromium replacement leaves the caret after the replacement text'
						}
					},
					webkit: {
						value: {
							startBlockPath: [1],
							endBlockPath: [1],
							yStart: 1,
							yEnd: 1,
							isCollapsed: true
						},
						quirk: {
							id: 'webkit-secondary-click-word-selection-caret',
							because: 'WebKit replacement leaves the caret after the replacement text'
						}
					}
				}
			)
		);

		issues.assertClean();
	});

	test('maps Shift-click range extension across marked text and inline atoms before replacement', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await setSelectionByTextIndex(page, 1, 3);

		await clickTextOffsetWithPointer(page, {
			textIndex: 3,
			offset: 3,
			shiftKey: true
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [2],
			startTextPath: [1, 0],
			endTextPath: [2, 2],
			yStart: 3,
			yEnd: 3,
			isCollapsed: false
		});

		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text?: string; type?: string }>;
					}>;
				}>(page, 'value');
				return {
					texts: value.children.map(
						(child) => child.content?.map((part) => part.text ?? '').join('') ?? ''
					),
					inlineCount: value.children
						.flatMap((child) => child.content ?? [])
						.filter((part) => part.type === 'mention').length
				};
			})
			.toEqual({
				texts: ['First block', 'MarXil'],
				inlineCount: 0
			});
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('double-click selects a single word and triple-click selects the whole block text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
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

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await getTextLocators(page).nth(0).click({ clickCount: 3 });
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 11,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('replaces only the clicked block after a browser triple-click selection', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(4);

		await texts.nth(0).click({ clickCount: 3 });
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 11,
			isCollapsed: false
		});

		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text?: string; type?: string }>;
					}>;
				}>(page, 'value');

				return value.children.map(
					(child) => child.content?.map((part) => part.text ?? `[${part.type}]`).join('') ?? ''
				);
			})
			.toEqual(['X', 'Marked middle', 'lead [mention] tail']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('drag-selects forward and reverse across sibling paragraphs in the real browser', async ({
		page
	}, testInfo) => {
		skipUnlessProject(testInfo, ['chromium', 'firefox'], {
			id: 'webkit-contenteditable-pointer-drag',
			because:
				'Playwright WebKit does not extend this headless page.mouse drag across contenteditable paragraphs; WebKit selection mapping is covered by native range tests.'
		});
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');

		await dragSelectionByTextIndex(page, 0, 1, 1, 3);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		await dragSelectionByTextIndex(page, 1, 3, 0, 1);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('drag-selects from parent content into a nested child in the real browser', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=nested');

		await dragSelectionByTextIndex(page, 0, 2, 1, 6);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('ignores an interrupted mouse drag before the next click edit', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=inline');

		const dragStart = await getCaretPoint(page, 2, 1);
		const dragMidpoint = await getCaretPoint(page, 3, 2);
		await page.mouse.move(dragStart.x, dragStart.y);
		await page.mouse.down();
		await page.mouse.move(dragMidpoint.x, dragMidpoint.y, { steps: 6 });
		await page.evaluate(() => {
			document
				.querySelector('[data-edytor-block="true"]')
				?.setAttribute('data-test-during-drag-mutation', 'true');
		});
		await page.mouse.move(-20, -20, { steps: 6 });
		await page.mouse.up();

		const editTarget = await getCaretPoint(page, 3, 2);
		await page.mouse.move(editTarget.x, editTarget.y);
		await page.mouse.click(editTarget.x, editTarget.y);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true,
			selectedBlockPaths: []
		});
		await page.keyboard.type('Z');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text?: string; type?: string }>;
					}>;
				}>(page, 'value');

				return value.children[1]?.content?.map((part) => part.text ?? `[${part.type}]`).join('');
			})
			.toBe('lead [mention] eZnd');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true,
			selectedBlockPaths: []
		});
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({
				deletionTargetType: null,
				selectedCount: 0
			});

		issues.assertClean();
	});

	test('clears stale native editor ranges when focus moves outside the editor', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 1, 1, 3);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		await page.evaluate(() => {
			const button = document.createElement('button');
			button.setAttribute('data-testid', 'outside-button');
			button.textContent = 'outside';
			document.body.append(button);
			button.focus();
		});

		await expect(page.getByTestId('outside-button')).toBeFocused();
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const editor = document.querySelector('[data-edytor]');
					const selection = window.getSelection();
					return Boolean(selection?.anchorNode && editor?.contains(selection.anchorNode));
				})
			)
			.toBe(false);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('ignores native control selectionchange outside the editor', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 1, 1, 3);
		const expectedEditorSelection = {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			focusedBlockPaths: [[0], [1]]
		};
		await expectSelection(page, expectedEditorSelection);

		for (const tagName of ['input', 'textarea']) {
			await page.evaluate((controlTagName) => {
				document.querySelector('[data-testid="outside-native-control"]')?.remove();
				const control = document.createElement(controlTagName) as
					| HTMLInputElement
					| HTMLTextAreaElement;
				control.setAttribute('data-testid', 'outside-native-control');
				control.value = 'external native text';
				document.body.append(control);
				control.focus();
				control.setSelectionRange(2, 10);
				document.dispatchEvent(new Event('selectionchange'));
			}, tagName);

			await expect(page.getByTestId('outside-native-control')).toBeFocused();
			await expect
				.poll(async () =>
					page.evaluate(() => {
						const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
							'[data-testid="outside-native-control"]'
						);
						return {
							start: control?.selectionStart ?? null,
							end: control?.selectionEnd ?? null
						};
					})
				)
				.toEqual({ start: 2, end: 10 });
			await expectSelection(page, expectedEditorSelection);
		}

		issues.assertClean();
	});

	test('isolates document selectionchange and keydown listeners across editor instances', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last&secondary=true');
		await setSelectionInsideShell(page, {
			shellTestId: 'editor-shell',
			textIndex: 1,
			offset: 2
		});
		const primarySelectionBefore = await readSelection(page);

		await setSelectionInsideShell(page, {
			shellTestId: 'secondary-editor-shell',
			offset: 2
		});
		await page.keyboard.type('Z');

		await expect
			.poll(async () => {
				const primary = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				const secondary = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'secondary-value');
				return {
					primaryText: primary.children.map((child) => child.content?.[0]?.text ?? ''),
					secondaryText: secondary.children[0]?.content?.[0]?.text ?? ''
				};
			})
			.toEqual({
				primaryText: ['lead', 'note', ''],
				secondaryText: 'otZher'
			});

		await expect
			.poll(async () => readSelection(page))
			.toMatchObject({
				startBlockPath: primarySelectionBefore.startBlockPath,
				endBlockPath: primarySelectionBefore.endBlockPath,
				yStart: primarySelectionBefore.yStart,
				yEnd: primarySelectionBefore.yEnd,
				isCollapsed: true
			});
		await expect
			.poll(async () => readJsonByTestId<Record<string, unknown>>(page, 'secondary-selection'))
			.toMatchObject({
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 3,
				yEnd: 3,
				isCollapsed: true
			});

		issues.assertClean();
	});

	test('ignores external contenteditable selectionchange before programmatic refocus', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 1, 2);
		const expectedEditorSelection = {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true,
			focusedBlockPaths: [[1]]
		};
		await expectSelection(page, expectedEditorSelection);

		await page.evaluate(() => {
			document.querySelector('[data-testid="outside-contenteditable"]')?.remove();
			const externalEditor = document.createElement('div');
			externalEditor.setAttribute('contenteditable', 'true');
			externalEditor.setAttribute('data-testid', 'outside-contenteditable');
			externalEditor.textContent = 'external editable text';
			document.body.append(externalEditor);

			const textNode = externalEditor.firstChild;
			if (!textNode) {
				throw new Error('Missing external editable text node');
			}

			const selection = window.getSelection();
			const range = document.createRange();
			range.setStart(textNode, 2);
			range.setEnd(textNode, 10);
			selection?.removeAllRanges();
			selection?.addRange(range);
			externalEditor.focus();
			document.dispatchEvent(new Event('selectionchange'));
		});

		await expect(page.getByTestId('outside-contenteditable')).toBeFocused();
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const editor = document.querySelector('[data-edytor]');
					const selection = window.getSelection();
					return {
						containsAnchor: Boolean(
							selection?.anchorNode && editor?.contains(selection.anchorNode)
						),
						selectedText: selection?.toString() ?? ''
					};
				})
			)
			.toEqual({
				containsAnchor: false,
				selectedText: 'ternal e'
			});
		await expectSelection(page, expectedEditorSelection);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: { node?: HTMLElement } }).__EDYTOR__;
			if (!edytor?.node) {
				throw new Error('Missing Edytor runtime');
			}

			edytor.node.focus();
		});
		await page.keyboard.type('X');

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
			isCollapsed: true,
			focusedBlockPaths: [[1]]
		});

		issues.assertClean();
	});

	test('ignores empty native selectionchange after blur before programmatic refocus', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 1, 2);
		const expectedEditorSelection = {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true,
			focusedBlockPaths: [[1]]
		};
		await expectSelection(page, expectedEditorSelection);

		await page.evaluate(() => {
			document.querySelector('[data-testid="outside-empty-selection-button"]')?.remove();
			const button = document.createElement('button');
			button.setAttribute('data-testid', 'outside-empty-selection-button');
			button.textContent = 'outside blur target';
			document.querySelector('[data-testid="editor-shell"]')?.before(button);
			button.focus();
			window.getSelection()?.removeAllRanges();
			document.dispatchEvent(new Event('selectionchange'));
		});

		await expect(page.getByTestId('outside-empty-selection-button')).toBeFocused();
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const selection = window.getSelection();
					return {
						activeTestId:
							document.activeElement instanceof HTMLElement
								? (document.activeElement.dataset.testid ?? null)
								: null,
						rangeCount: selection?.rangeCount ?? null,
						selectedText: selection?.toString() ?? ''
					};
				})
			)
			.toEqual({
				activeTestId: 'outside-empty-selection-button',
				rangeCount: 0,
				selectedText: ''
			});
		await expectSelection(page, expectedEditorSelection);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: { node?: HTMLElement } }).__EDYTOR__;
			if (!edytor?.node) {
				throw new Error('Missing Edytor runtime');
			}

			edytor.node.focus();
		});
		await page.keyboard.type('X');

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
			isCollapsed: true,
			focusedBlockPaths: [[1]]
		});

		issues.assertClean();
	});

	test('ignores native selections that only partially belong to the editor', async ({
		page
	}, testInfo) => {
		skipUnlessProject(testInfo, ['chromium', 'firefox'], {
			id: 'webkit-clamps-synthetic-partial-outside-selection',
			because:
				'WebKit normalizes this synthetic cross-boundary range back inside contenteditable before selectionchange'
		});
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 1, 1, 3);
		const expectedEditorSelection = {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			focusedBlockPaths: [[0], [1]]
		};
		await expectSelection(page, expectedEditorSelection);

		await setPartialOutsideNativeSelection(page, {
			editorTextIndex: 0,
			editorOffset: 2,
			outsideOffset: 8
		});
		await expectSelection(page, expectedEditorSelection);

		issues.assertClean();
	});

	test('ignores outside-to-inside native selections that only partially belong to the editor', async ({
		page
	}, testInfo) => {
		skipUnlessProject(testInfo, ['chromium', 'firefox'], {
			id: 'webkit-clamps-synthetic-outside-to-inside-selection',
			because:
				'WebKit normalizes this synthetic cross-boundary range back inside contenteditable before selectionchange'
		});
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 1, 1, 3);
		const expectedEditorSelection = {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false,
			focusedBlockPaths: [[0], [1]]
		};
		await expectSelection(page, expectedEditorSelection);

		await setPartialOutsideNativeSelection(page, {
			direction: 'outside-to-editor',
			editorTextIndex: 0,
			editorOffset: 2,
			outsideOffset: 8
		});
		await expectSelection(page, expectedEditorSelection);

		issues.assertClean();
	});

	test('restores cached model selection when tabbing into the editor', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 1, 2);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.evaluate(() => {
			const tabTarget = document.createElement('button');
			tabTarget.setAttribute('data-testid', 'before-editor-tab-target');
			tabTarget.textContent = 'before editor';
			document.querySelector('[data-testid="editor-shell"]')?.before(tabTarget);
			tabTarget.focus();
		});
		await expect(page.getByTestId('before-editor-tab-target')).toBeFocused();

		await page.keyboard.press('Tab');
		await page.keyboard.type('X');

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

	test('restores cached model selection when programmatically focusing the editor', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 1, 2);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.evaluate(() => {
			const focusTarget = document.createElement('button');
			focusTarget.setAttribute('data-testid', 'programmatic-focus-target');
			focusTarget.textContent = 'external focus';
			document.querySelector('[data-testid="editor-shell"]')?.before(focusTarget);
			focusTarget.focus();
		});
		await expect(page.getByTestId('programmatic-focus-target')).toBeFocused();

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: { node?: HTMLElement } }).__EDYTOR__;
			if (!edytor?.node) {
				throw new Error('Missing Edytor runtime');
			}

			edytor.node.focus();
		});
		await page.keyboard.type('X');

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

	test('keeps scroll position stable when clear programmatically focuses the editor', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 1, 2);
		await page.evaluate(() => {
			document.querySelector('[data-testid="focus-scroll-spacer"]')?.remove();
			const spacer = document.createElement('div');
			spacer.setAttribute('data-testid', 'focus-scroll-spacer');
			spacer.style.height = '2000px';
			document.querySelector('[data-testid="editor-shell"]')?.before(spacer);
			window.scrollTo(0, 0);
		});
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

		const focusResult = await page.evaluate(async () => {
			const edytor = (window as Window & { __EDYTOR__?: { clear: () => void; node?: HTMLElement } })
				.__EDYTOR__;
			if (!edytor?.node) {
				throw new Error('Missing Edytor runtime');
			}

			edytor.clear();
			await new Promise((resolve) => setTimeout(resolve, 80));

			return {
				activeIsEditor: document.activeElement === edytor.node,
				scrollY: window.scrollY
			};
		});
		expect(focusResult).toEqual({
			activeIsEditor: true,
			scrollY: 0
		});

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['X']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('scrolls the caret into view when typing lands below the fold', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);

		// Push the editor below the fold — the caret element sits ~2000px
		// down while focus stays on the text host.
		await page.evaluate(() => {
			document.querySelector('[data-testid="type-scroll-spacer"]')?.remove();
			const spacer = document.createElement('div');
			spacer.setAttribute('data-testid', 'type-scroll-spacer');
			spacer.style.height = '2000px';
			document.querySelector('[data-testid="editor-shell"]')?.before(spacer);
			window.scrollTo(0, 0);
		});
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

		await page.keyboard.type('X');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toContain('X');

		// The input-driven caret write scrolled the caret back into view —
		// the page must move. (Inverse of the `clear()` case above:
		// programmatic writes never scroll.)
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

		issues.assertClean();
	});

	test('maps selection from the editor shadow root when global selection is stale', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');

		const hasShadowSelection = await moveEditorIntoShadowRoot(page);
		skipWhenCapabilityMissing(!hasShadowSelection, {
			id: 'shadowroot-getselection-unavailable',
			because: 'This test targets browsers that expose ShadowRoot.getSelection()'
		});

		await setShadowSelectionByTextIndex(page, {
			startIndex: 1,
			startOffset: 2,
			endOffset: 6
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('preserves backward ShadowRoot selection direction', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await moveEditorIntoShadowRoot(page);
		await setBackwardShadowSelectionByTextIndex(page, {
			startIndex: 1,
			startOffset: 2,
			endOffset: 6
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false,
			isReversed: true
		});

		await expect
			.poll(async () => readNativeSelectionDirection(page))
			.toMatchObject({
				isBackward: true,
				isCollapsed: false,
				text: 'rked'
			});

		issues.assertClean();
	});

	test('falls back when native reverse-selection restoration throws', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');

		await page.evaluate(async () => {
			const edytor = (
				window as Window & {
					__EDYTOR__?: {
						root?: { children: Array<{ firstText?: unknown }> };
						selection?: {
							setAtRange: (
								startText: unknown,
								startOffset: number,
								endText: unknown,
								endOffset: number,
								options: { isReversed?: boolean }
							) => Promise<void>;
						};
					};
				}
			).__EDYTOR__;
			const text = edytor?.root?.children[1]?.firstText;
			if (!edytor?.selection || !text) {
				throw new Error('Missing Edytor selection runtime');
			}

			const selection = window.getSelection();
			if (!selection) {
				throw new Error('Missing native selection');
			}

			Object.defineProperty(selection, 'setBaseAndExtent', {
				value: () => {
					throw new DOMException('Synthetic setBaseAndExtent failure', 'InvalidStateError');
				},
				configurable: true
			});
			Object.defineProperty(selection, 'extend', {
				value: () => {
					throw new DOMException('Synthetic extend failure', 'InvalidStateError');
				},
				configurable: true
			});

			await edytor.selection.setAtRange(text, 2, text, 6, { isReversed: true });
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('does not trust buggy ShadowRoot selection.isCollapsed for expanded ranges', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await moveEditorIntoShadowRoot(page);
		await setBuggyCollapsedShadowSelectionByTextIndex(page, {
			startIndex: 1,
			startOffset: 2,
			endOffset: 6
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('maps composed shadow-root ranges when the root selection API is unavailable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await moveEditorIntoShadowRoot(page);
		await setComposedShadowSelectionByTextIndex(page, {
			startIndex: 1,
			startOffset: 2,
			endOffset: 6
		});

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test.describe('mark-wrapper selection mapping', () => {
		test('maps element-node selection anchors around rendered mark wrappers', async ({ page }) => {
			const issues = trackPageIssues(page);

			await gotoSelectionFixture(page, '/test/dom?scenario=selection');

			await setSelectionAtMarkElement(page, {
				markIndex: 0,
				startOffset: 1
			});
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: [1, 0],
				endTextPath: [1, 0],
				yStart: 7,
				yEnd: 7,
				isCollapsed: true
			});

			await setSelectionAtMarkElement(page, {
				markIndex: 0,
				startOffset: 0,
				endOffset: 1
			});
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: [1, 0],
				endTextPath: [1, 0],
				yStart: 0,
				yEnd: 7,
				isCollapsed: false
			});

			issues.assertClean();
		});
	});

	test('maps native Home and End navigation through rendered mark wrappers', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=selection');
		await setSelectionByTextIndex(page, 1, 3);

		await page.keyboard.press('End');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 13,
			yEnd: 13,
			isCollapsed: true
		});

		await page.keyboard.press('Home');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 1, 3);
		await page.keyboard.press('Shift+End');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 3,
			yEnd: 13,
			isCollapsed: false
		});

		await setSelectionByTextIndex(page, 1, 3);
		await page.keyboard.press('Shift+Home');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 0,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('maps document-boundary navigation across nested and void content', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=navigation');

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press('PageUp');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press('PageDown');
		await expectSelection(page, {
			startBlockPath: [3],
			endBlockPath: [3],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press(`${modKey}+ArrowUp`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press(`${modKey}+ArrowDown`);
		await expectSelection(page, {
			startBlockPath: [3],
			endBlockPath: [3],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press('Shift+PageUp');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [1, 0],
			yStart: 0,
			yEnd: 6,
			isCollapsed: false
		});

		await setSelectionByTextIndex(page, 2, 6);
		await page.keyboard.press('Shift+PageDown');
		await expectSelection(page, {
			startBlockPath: [1, 0],
			endBlockPath: [3],
			yStart: 6,
			yEnd: 6,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('maps word-boundary navigation across marks, emoji, and inline mentions', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const wordKey = await getWordKey(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=wordNavigation');

		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press(`${wordKey}+ArrowLeft`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 11,
			yEnd: 11,
			isCollapsed: true
		});

		await page.keyboard.press(`${wordKey}+ArrowRight`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 0, 10);
		await page.keyboard.press(`${wordKey}+ArrowLeft`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 1, 15);
		await page.keyboard.press(`${wordKey}+ArrowLeft`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 11,
			yEnd: 11,
			isCollapsed: true
		});

		await page.keyboard.press(`${wordKey}+ArrowLeft`);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await setSelectionByTextIndex(page, 0, 11);
		await page.keyboard.press(`Shift+${wordKey}+ArrowRight`);
		await expect
			.poll(() => readSelectedInlineBlockState(page))
			.toEqual({ selectedCount: 1, deletionTargetType: 'mention' });

		issues.assertClean();
	});

	test('distinguishes image void body focus from caption text focus', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=void');

		await page.locator('figure input').click();
		await expect(page.locator('figure input')).toBeFocused();

		await getTextLocators(page).nth(0).click();
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0]
		});

		issues.assertClean();
	});

	test('keeps vertical arrow navigation around void bodies on editable model targets', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=void');
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('ArrowUp');

		await expect
			.poll(async () => readVoidNavigationSafety(page))
			.toEqual({
				isSafeImageTarget: true,
				isUnsafeVoidBodyFocus: false
			});

		await page.keyboard.press('ArrowDown');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			selectedBlockPaths: []
		});

		issues.assertClean();
	});

	test('keeps code-line selection live after vertical arrow navigation', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=code');
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('ArrowUp');
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: Array<{ content?: Array<{ text: string }> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.children?.map(
					(line) => line.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['Xconst a = 1;', 'return a;']);
		await expectSelection(page, {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps Shift+ArrowDown selection across a void body on editor-owned targets', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=navigation');
		await setSelectionByTextIndex(page, 2, 'Nested middle'.length);
		await page.keyboard.press('Shift+ArrowDown');

		await expect
			.poll(() => readVoidShiftSelectionSafety(page))
			.toEqual({
				hasModelTarget: true,
				hasMovedOrExtended: true,
				hasVoidOrNextTarget: true,
				isUnsafeVoidBodyFocus: false
			});

		issues.assertClean();
	});

	test('triple-clicking a non-editable void body selects the whole void block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoSelectionFixture(page, '/test/dom?scenario=void');
		await page.locator('figure button').click({ clickCount: 3 });

		await expectSelection(page, {
			selectedBlockPaths: [[0]]
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
			.toEqual(['after image']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			selectedBlockPaths: [],
			isCollapsed: true
		});

		issues.assertClean();
	});
});
