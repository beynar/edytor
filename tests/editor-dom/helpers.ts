import { expect, type Page } from '@playwright/test';

type PageIssues = {
	pageErrors: string[];
	consoleErrors: string[];
	assertClean: () => void;
};

export const trackPageIssues = (page: Page): PageIssues => {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];

	page.on('pageerror', (error) => {
		pageErrors.push(error.stack ?? error.message);
	});

	page.on('console', (message) => {
		if (message.type() === 'error') {
			consoleErrors.push(message.text());
		}
	});

	return {
		pageErrors,
		consoleErrors,
		assertClean: () => {
			expect(pageErrors).toEqual([]);
			expect(consoleErrors).toEqual([]);
		}
	};
};

export const readJsonByTestId = async <T>(page: Page, testId: string): Promise<T> => {
	const raw = await page.getByTestId(testId).textContent();
	if (!raw) {
		throw new Error(`Missing JSON payload for test id "${testId}"`);
	}

	return JSON.parse(raw) as T;
};

export const waitForEditorReady = async (
	page: Page,
	options: { requireRuntime?: boolean } = {}
) => {
	await expect(page.locator('[data-edytor-block="true"]').first()).toBeVisible();
	if (!options.requireRuntime) {
		return;
	}

	await expect
		.poll(() =>
			page.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				return Boolean(edytor?.synced && edytor.root);
			})
		)
		.toBe(true);
};

export const gotoEditorRoute = async (
	page: Page,
	path: string,
	options: { requireRuntime?: boolean } = {}
) => {
	const response = await page.request.get(path);
	const isOk = response.ok();
	const status = response.status();
	const statusText = response.statusText();
	await response.dispose();

	if (!isOk) {
		throw new Error(`Failed to load editor route "${path}": ${status} ${statusText}`);
	}

	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await waitForEditorReady(page, options);
};

export const getTextLocators = (page: Page) => page.locator('[data-edytor-text="true"]');

export const getBlockLocators = (page: Page) => page.locator('[data-edytor-block="true"]');

export const getPlaceholderLocators = (page: Page) =>
	page.locator('[data-edytor-text-placeholder]:visible');

export const readSelection = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		if (!edytor) {
			return {
				startBlockPath: null,
				endBlockPath: null,
				startTextPath: null,
				endTextPath: null,
				yStart: 0,
				yEnd: 0,
				isCollapsed: true,
				isReversed: false,
				selectedBlockPaths: [],
				focusedBlockPaths: []
			};
		}

		const getPartPath = (part: any) => {
			const index = part.parent.content.findIndex((candidate: any) => candidate.id === part.id);
			return [...part.parent.path, index === -1 ? part.index : index];
		};

		return {
			startBlockPath: edytor.selection.state.startBlock?.path ?? null,
			endBlockPath: edytor.selection.state.endBlock?.path ?? null,
			startTextPath: edytor.selection.state.startText
				? getPartPath(edytor.selection.state.startText)
				: null,
			endTextPath: edytor.selection.state.endText
				? getPartPath(edytor.selection.state.endText)
				: null,
			yStart: edytor.selection.state.yStart,
			yEnd: edytor.selection.state.yEnd,
			isCollapsed: edytor.selection.state.isCollapsed,
			isReversed: edytor.selection.state.isReversed,
			selectedBlockPaths: Array.from(edytor.selection.selectedBlocks).map(
				(block: any) => block.path
			),
			focusedBlockPaths: Array.from(edytor.selection.focusedBlocks).map((block: any) => block.path)
		};
	});

export const readSelectedInlineBlockState = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const selected = Array.from(edytor?.selection.selectedInlineBlock ?? []);
		const deletionTarget = edytor?.selection.inlineBlockDeletionTarget ?? null;
		return {
			selectedCount: selected.length,
			deletionTargetType: deletionTarget?.type ?? null
		};
	});

export const expectSelection = async (
	page: Page,
	expected: Record<string, unknown>,
	message?: string
) => {
	await expect.poll(async () => readSelection(page), { message }).toMatchObject(expected);
};

const setSelectionByTextIndexDirection = async (
	page: Page,
	startIndex: number,
	startOffset: number,
	endIndex: number,
	endOffset: number,
	direction: 'forward' | 'backward'
) => {
	await page.evaluate(
		([fromIndex, fromOffset, toIndex, toOffset, selectionDirection]) => {
			const getEditorQueryRoot = () =>
				document.querySelector<HTMLElement>('[data-edytor]')?.getRootNode() ??
				document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]')?.shadowRoot ??
				document;
			const queryRoot = getEditorQueryRoot() as Document | ShadowRoot;
			const texts = Array.from(
				queryRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
			);
			const start = texts[fromIndex];
			const end = texts[toIndex];

			if (!start || !end) {
				throw new Error(`Missing text node at index ${fromIndex} or ${toIndex}`);
			}
			const resolveLeaf = (node: HTMLElement, offset: number) => {
				const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
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
					node,
					offset: Math.min(offset, node.childNodes.length)
				};
			};

			const startLeaf = resolveLeaf(start, fromOffset);
			const endLeaf = resolveLeaf(end, toOffset);
			const selectionRoot = start.getRootNode();
			const shadowSelection =
				selectionRoot instanceof ShadowRoot && typeof selectionRoot.getSelection === 'function'
					? selectionRoot.getSelection()
					: null;
			const range = document.createRange();
			range.setStart(startLeaf.node, startLeaf.offset);
			range.setEnd(endLeaf.node, endLeaf.offset);

			let selection =
				shadowSelection ?? (selectionRoot instanceof ShadowRoot ? null : window.getSelection());
			if (!selection && selectionRoot instanceof ShadowRoot) {
				const composedRange =
					typeof StaticRange === 'function'
						? new StaticRange({
								startContainer: startLeaf.node,
								startOffset: startLeaf.offset,
								endContainer: endLeaf.node,
								endOffset: endLeaf.offset
							})
						: {
								startContainer: startLeaf.node,
								startOffset: startLeaf.offset,
								endContainer: endLeaf.node,
								endOffset: endLeaf.offset
							};
				const fakeSelection = {
					anchorNode: null,
					anchorOffset: 0,
					focusNode: null,
					focusOffset: 0,
					isCollapsed: range.collapsed,
					rangeCount: 0,
					addRange: () => {},
					getComposedRanges: ({ shadowRoots }: GetComposedRangesOptions = {}) =>
						shadowRoots?.includes(selectionRoot) ? [composedRange] : [],
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
				selection = fakeSelection;
			}

			selection?.removeAllRanges();
			if (selectionDirection === 'backward' && selection) {
				if (typeof selection.setBaseAndExtent === 'function') {
					selection.setBaseAndExtent(
						endLeaf.node,
						endLeaf.offset,
						startLeaf.node,
						startLeaf.offset
					);
				} else if (typeof selection.extend === 'function') {
					selection.collapse(endLeaf.node, endLeaf.offset);
					selection.extend(startLeaf.node, startLeaf.offset);
				} else {
					selection.addRange(range);
				}
			} else {
				selection?.addRange(range);
			}
			(startLeaf.node.parentElement ?? start).focus();
			document.dispatchEvent(new Event('selectionchange'));
		},
		[startIndex, startOffset, endIndex, endOffset, direction] as const
	);
};

export const setSelectionByTextIndex = async (
	page: Page,
	startIndex: number,
	startOffset: number,
	endIndex = startIndex,
	endOffset = startOffset
) =>
	setSelectionByTextIndexDirection(page, startIndex, startOffset, endIndex, endOffset, 'forward');

export const setReverseSelectionByTextIndex = async (
	page: Page,
	startIndex: number,
	startOffset: number,
	endIndex = startIndex,
	endOffset = startOffset
) =>
	setSelectionByTextIndexDirection(page, startIndex, startOffset, endIndex, endOffset, 'backward');

export const readNativeSelectionDirection = (page: Page) =>
	page.evaluate(() => {
		const root =
			document.querySelector<HTMLElement>('[data-edytor]')?.getRootNode() ??
			document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]')?.shadowRoot ??
			document;
		const selection =
			root instanceof ShadowRoot && typeof root.getSelection === 'function'
				? root.getSelection()
				: window.getSelection();

		if (!selection?.anchorNode || !selection.focusNode) {
			return {
				isBackward: false,
				isCollapsed: true,
				text: ''
			};
		}

		const isBackward =
			selection.anchorNode === selection.focusNode
				? selection.focusOffset < selection.anchorOffset
				: Boolean(
						selection.anchorNode.compareDocumentPosition(selection.focusNode) &
						Node.DOCUMENT_POSITION_PRECEDING
					);

		return {
			anchorOffset: selection.anchorOffset,
			focusOffset: selection.focusOffset,
			isBackward,
			isCollapsed: selection.isCollapsed,
			text: selection.toString()
		};
	});

export const moveEditorIntoShadowRoot = async (page: Page) => {
	return page.evaluate(() => {
		const shell = document.querySelector<HTMLElement>('[data-testid="editor-shell"]');
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!shell || !editor) {
			throw new Error('Missing editor shell or editor root');
		}

		const host = document.createElement('div');
		host.setAttribute('data-testid', 'shadow-editor-host');
		shell.append(host);

		const shadowRoot = host.attachShadow({ mode: 'open' });
		shadowRoot.append(editor);

		return typeof shadowRoot.getSelection === 'function';
	});
};

export const setSelectionAtInlineElementBoundary = async (
	page: Page,
	payload: {
		boundary: 'before' | 'after';
		blockIndex: number;
		inlineIndex?: number;
	}
) => {
	await page.evaluate(({ blockIndex, boundary, inlineIndex = 0 }) => {
		const blocks = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-type="paragraph"]')
		);
		const block = blocks[blockIndex];
		const inline = block?.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')[inlineIndex];
		if (!block || !inline) {
			throw new Error(`Missing block ${blockIndex} or inline block ${inlineIndex}`);
		}

		const selectionContainer = inline.closest('p') ?? block;
		let boundaryNode: Node = inline;
		while (boundaryNode.parentNode && boundaryNode.parentNode !== selectionContainer) {
			boundaryNode = boundaryNode.parentNode;
		}

		if (boundaryNode.parentNode !== selectionContainer) {
			throw new Error('Inline block is not contained by a direct selection-container child');
		}

		const blockChildren = Array.from(selectionContainer.childNodes);
		const inlineChildIndex = blockChildren.indexOf(boundaryNode);
		const offset = inlineChildIndex + (boundary === 'after' ? 1 : 0);
		const range = document.createRange();
		range.setStart(selectionContainer, offset);
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	}, payload);
};

export const getCaretPoint = async (page: Page, textIndex: number, offset: number) => {
	return page.evaluate(
		([index, targetOffset]) => {
			const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const text = texts[index];

			if (!text) {
				throw new Error(`Missing text node at index ${index}`);
			}

			const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			let currentOffset = 0;
			let targetNode: Node = text;
			let nodeOffset = Math.min(targetOffset, text.childNodes.length);

			while (current) {
				const length = current.textContent?.length ?? 0;
				const endOffset = currentOffset + length;
				if (targetOffset >= currentOffset && targetOffset <= endOffset) {
					targetNode = current;
					nodeOffset = targetOffset - currentOffset;
					break;
				}
				currentOffset = endOffset;
				current = walker.nextNode();
			}

			const getVisibleRect = (range: Range) => {
				const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
				return rect.width || rect.height ? rect : null;
			};

			if (targetNode.nodeType === Node.TEXT_NODE) {
				const textLength = targetNode.textContent?.length ?? 0;
				const characterRange = document.createRange();
				const previousCharacterStart = nodeOffset > 0 ? nodeOffset - 1 : null;
				const nextCharacterEnd = nodeOffset < textLength ? nodeOffset + 1 : null;

				if (previousCharacterStart !== null) {
					characterRange.setStart(targetNode, previousCharacterStart);
					characterRange.setEnd(targetNode, nodeOffset);
					const rect = getVisibleRect(characterRange);
					if (rect) {
						return {
							x: rect.right + 0.5,
							y: rect.top + rect.height / 2
						};
					}
				}

				if (nextCharacterEnd !== null) {
					characterRange.setStart(targetNode, nodeOffset);
					characterRange.setEnd(targetNode, nextCharacterEnd);
					const rect = getVisibleRect(characterRange);
					if (rect) {
						return {
							x: rect.left + 0.5,
							y: rect.top + rect.height / 2
						};
					}
				}
			}

			const range = document.createRange();
			range.setStart(targetNode, nodeOffset);
			range.collapse(true);
			const rect = range.getBoundingClientRect();
			const fallback = text.getBoundingClientRect();

			const x =
				rect.width || rect.height
					? rect.left + rect.width / 2
					: fallback.left +
						Math.min(Math.max(targetOffset * 4, 2), Math.max(fallback.width - 2, 2));
			const y =
				rect.width || rect.height ? rect.top + rect.height / 2 : fallback.top + fallback.height / 2;

			return { x, y };
		},
		[textIndex, offset] as const
	);
};

export const dragSelectionByTextIndex = async (
	page: Page,
	startIndex: number,
	startOffset: number,
	endIndex: number,
	endOffset: number
) => {
	const start = await getCaretPoint(page, startIndex, startOffset);
	const end = await getCaretPoint(page, endIndex, endOffset);

	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.waitForTimeout(30);
	await page.mouse.move(start.x + Math.sign(end.x - start.x || 1), start.y, { steps: 3 });
	await page.mouse.move(end.x, end.y, { steps: 24 });
	await page.waitForTimeout(30);
	await page.mouse.up();
};

export const dispatchBeforeInput = async (
	page: Page,
	payload: {
		inputType: string;
		data?: string;
		text?: string;
		cancelable?: boolean;
		targetRange?: {
			startIndex: number;
			startOffset: number;
			endIndex?: number;
			endOffset?: number;
		};
	}
) => {
	return page.evaluate(({ inputType, data, text, cancelable, targetRange }) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const resolveTextPoint = (textIndex: number, textOffset: number) => {
			const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const textElement = texts[textIndex];
			if (!textElement) {
				throw new Error(`Missing text node at index ${textIndex}`);
			}

			const walker = document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			let currentOffset = 0;
			while (current) {
				const length = current.textContent?.length ?? 0;
				const endOffset = currentOffset + length;
				if (textOffset >= currentOffset && textOffset <= endOffset) {
					return {
						node: current,
						offset: textOffset - currentOffset
					};
				}
				currentOffset = endOffset;
				current = walker.nextNode();
			}

			return {
				node: textElement,
				offset: Math.min(textOffset, textElement.childNodes.length)
			};
		};

		const targetRanges = targetRange
			? (() => {
					const start = resolveTextPoint(targetRange.startIndex, targetRange.startOffset);
					const end = resolveTextPoint(
						targetRange.endIndex ?? targetRange.startIndex,
						targetRange.endOffset ?? targetRange.startOffset
					);
					return [
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
								}
					];
				})()
			: [];

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: cancelable ?? true
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
			dataTransfer: {
				value:
					text === undefined
						? null
						: ({
								getData: (type: string) => (type === 'text/plain' ? text : '')
							} satisfies Pick<DataTransfer, 'getData'>),
				configurable: true
			},
			getTargetRanges: {
				value: () => targetRanges,
				configurable: true
			}
		});
		target.dispatchEvent(event);
		return event.defaultPrevented;
	}, payload);
};

const applyDomTextMutation = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset?: number;
		inputType?: string;
		data?: string | null;
		dispatchInput?: boolean;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset, inputType, data, dispatchInput }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing text node at index ${textIndex}`);
		}
		const textNode =
			Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
			text.firstChild;
		if (textNode?.nodeType === Node.TEXT_NODE) {
			textNode.textContent = value;
		} else {
			text.textContent = value;
		}

		const target = textNode ?? text;
		const offset = Math.min(caretOffset ?? value.length, target.textContent?.length ?? 0);
		const range = document.createRange();
		if (target.nodeType === Node.TEXT_NODE) {
			range.setStart(target, offset);
		} else {
			range.setStart(text, Math.min(offset, text.childNodes.length));
		}
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		(target.parentElement ?? text).focus();
		if (!dispatchInput) {
			return;
		}
		const event =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: inputType ?? 'insertText',
						data: data ?? null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);

		if (typeof InputEvent !== 'function' || event.inputType !== (inputType ?? 'insertText')) {
			Object.defineProperties(event, {
				inputType: {
					value: inputType ?? 'insertText',
					configurable: true
				},
				data: {
					value: data ?? null,
					configurable: true
				}
			});
		}

		text.dispatchEvent(event);
	}, payload);
};

export const mutateDomTextWithoutInput = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset?: number;
	}
) => applyDomTextMutation(page, payload);

export const replaceManagedTextWithUnmanagedWrapper = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset?: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text?.parentNode) {
			throw new Error(`Missing replaceable text node at index ${textIndex}`);
		}

		const wrapper = document.createElement('span');
		wrapper.dataset.testUnmanagedReplacement = 'true';
		wrapper.textContent = value;
		text.parentNode.replaceChild(wrapper, text);

		const replacementText = wrapper.firstChild ?? wrapper;
		const offset = Math.min(caretOffset ?? value.length, replacementText.textContent?.length ?? 0);
		const range = document.createRange();
		if (replacementText.nodeType === Node.TEXT_NODE) {
			range.setStart(replacementText, offset);
		} else {
			range.setStart(wrapper, Math.min(offset, wrapper.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		wrapper.focus();
	}, payload);
};

export const insertUnmanagedDomNode = async (
	page: Page,
	payload: {
		textIndex: number;
		text?: string;
	}
) => {
	await page.evaluate(({ textIndex, text: insertedText }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		const paragraph = text?.closest('p');
		if (!text || !paragraph) {
			throw new Error(`Missing paragraph for text node at index ${textIndex}`);
		}
		const injected = document.createElement('span');
		injected.dataset.testUnmanaged = 'true';
		injected.textContent = insertedText ?? ' injected';
		paragraph.append(injected);
	}, payload);
};

export const insertUnmanagedLineBreak = async (
	page: Page,
	payload: {
		textIndex: number;
	}
) => {
	await page.evaluate(({ textIndex }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing text node at index ${textIndex}`);
		}
		const lineBreak = document.createElement('br');
		lineBreak.dataset.testUnmanagedBr = 'true';
		text.append(lineBreak);
	}, payload);
};

export const removeManagedTextNode = async (
	page: Page,
	payload: {
		textIndex: number;
	}
) => {
	await page.evaluate(({ textIndex }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing text node at index ${textIndex}`);
		}

		text.remove();
	}, payload);
};

export const removeManagedBlockNode = async (
	page: Page,
	payload: {
		blockIndex: number;
	}
) => {
	await page.evaluate(({ blockIndex }) => {
		const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
		const block = blocks[blockIndex];
		if (!block) {
			throw new Error(`Missing block node at index ${blockIndex}`);
		}

		block.remove();
	}, payload);
};

export const dispatchDomTextInputMutation = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset?: number;
		inputType?: string;
		data?: string | null;
	}
) => applyDomTextMutation(page, { ...payload, dispatchInput: true });

export const dispatchPaste = async (
	page: Page,
	payload: {
		text?: string;
		html?: string;
		data?: Record<string, string>;
	}
) => {
	await page.evaluate(({ text, html, data }) => {
		const target =
			document.querySelector<HTMLElement>('[data-edytor]') ??
			document
				.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]')
				?.shadowRoot?.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const event = new Event('paste', {
			bubbles: true,
			cancelable: true
		}) as ClipboardEvent;

		Object.defineProperty(event, 'clipboardData', {
			value: {
				getData: (type: string) => {
					if (data?.[type] !== undefined) {
						return data[type];
					}
					if (type === 'text/html') {
						return html ?? '';
					}
					if (type === 'text/plain') {
						return text ?? '';
					}
					return '';
				}
			} satisfies Pick<DataTransfer, 'getData'>,
			configurable: true
		});

		target.dispatchEvent(event);
	}, payload);
};

export const dispatchClipboardEvent = async (page: Page, type: 'copy' | 'cut') => {
	return page.evaluate((eventType) => {
		const target =
			document.querySelector<HTMLElement>('[data-edytor]') ??
			document
				.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]')
				?.shadowRoot?.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const clipboardData: Record<string, string> = {};
		const event = new Event(eventType, {
			bubbles: true,
			cancelable: true
		}) as ClipboardEvent;

		Object.defineProperty(event, 'clipboardData', {
			value: {
				getData: (type: string) => clipboardData[type] ?? '',
				setData: (type: string, value: string) => {
					clipboardData[type] = value;
					return true;
				}
			},
			configurable: true
		});

		const dispatched = target.dispatchEvent(event);
		return {
			defaultPrevented: event.defaultPrevented || !dispatched,
			clipboardData
		};
	}, type);
};

export const dispatchComposition = async (
	page: Page,
	steps: Array<
		| {
				type: 'compositionstart' | 'compositionupdate' | 'compositionend';
				data?: string;
		  }
		| {
				type: 'beforeinput';
				inputType: string;
				data?: string;
				cancelable?: boolean;
		  }
	>
) => {
	await page.evaluate(async (sequence) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const flushEventTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

		for (const step of sequence) {
			if (step.type === 'beforeinput') {
				const event =
					typeof InputEvent === 'function'
						? new InputEvent('beforeinput', {
								bubbles: true,
								cancelable: step.cancelable ?? true,
								inputType: step.inputType,
								data: step.data ?? ''
							})
						: (new Event('beforeinput', {
								bubbles: true,
								cancelable: step.cancelable ?? true
							}) as InputEvent);

				if (typeof InputEvent !== 'function' || event.inputType !== step.inputType) {
					Object.defineProperties(event, {
						inputType: {
							value: step.inputType,
							configurable: true
						},
						data: {
							value: step.data ?? '',
							configurable: true
						}
					});
				}

				target.dispatchEvent(event);
				await flushEventTurn();
				continue;
			}

			const event =
				typeof CompositionEvent === 'function'
					? new CompositionEvent(step.type, {
							bubbles: true,
							cancelable: true,
							data: step.data ?? ''
						})
					: (new Event(step.type, {
							bubbles: true,
							cancelable: true
						}) as CompositionEvent);

			if (typeof CompositionEvent !== 'function' || event.data !== (step.data ?? '')) {
				Object.defineProperty(event, 'data', {
					value: step.data ?? '',
					configurable: true
				});
			}

			target.dispatchEvent(event);
			await flushEventTurn();
		}
	}, steps);
};

export const blurEditor = async (page: Page) => {
	await page.evaluate(() => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		target?.blur();
	});
};

export const resetNativeEditingState = async (page: Page) => {
	for (const key of [
		'Meta',
		'MetaLeft',
		'MetaRight',
		'Control',
		'ControlLeft',
		'ControlRight',
		'Shift',
		'ShiftLeft',
		'ShiftRight',
		'Alt',
		'AltLeft',
		'AltRight',
		'AltGraph'
	]) {
		try {
			await page.keyboard.up(key);
		} catch {
			// Firefox rejects some physical key aliases when no matching key is pressed.
		}
	}

	await page.evaluate(() => {
		const selections = new Set<Selection>();
		const windowSelection = window.getSelection?.();
		const documentSelection = document.getSelection?.();

		if (windowSelection) {
			selections.add(windowSelection);
		}
		if (documentSelection) {
			selections.add(documentSelection);
		}

		for (const selection of selections) {
			selection.removeAllRanges();
		}

		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}

		document.dispatchEvent(new Event('selectionchange'));
	});
	await page.waitForTimeout(0);
};

export const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

export const getWordKey = (page: Page) =>
	page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(window.navigator.platform) ? 'Alt' : 'Control'));
