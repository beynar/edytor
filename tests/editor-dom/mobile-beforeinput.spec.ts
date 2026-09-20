import { expect, test } from './editorTest';

import { expectedByBrowser } from './browserExpectations';
import {
	dispatchBeforeInput,
	expectSelection,
	modKey,
	readJsonByTestId,
	setSelectionAtInlineElementBoundary,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type SnapshotBlock = {
	content?: Array<{ text?: string; type?: string; data?: unknown; marks?: unknown }>;
};

type AdvancedDeleteInputType =
	| 'deleteWordBackward'
	| 'deleteWordForward'
	| 'deleteSoftLineBackward'
	| 'deleteSoftLineForward'
	| 'deleteHardLineBackward'
	| 'deleteHardLineForward';

type GenericDeleteInputType = 'deleteContent' | 'deleteEntireSoftLine' | 'deleteByComposition';

const getSnapshotChildren = (value: unknown) =>
	(stripIds(value) as { children?: SnapshotBlock[] }).children ?? [];

const readBlockContent = async (
	page: Parameters<typeof readJsonByTestId>[0],
	blockIndex: number
) => {
	const value = await readJsonByTestId<{
		children: Array<{
			content?: Array<{ text?: string; type?: string; data?: unknown; marks?: unknown }>;
		}>;
	}>(page, 'value');
	return stripIds(value.children[blockIndex]?.content);
};

const readFirstText = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string }> }>;
	}>(page, 'value');
	return value.children[0]?.content?.[0]?.text ?? '';
};

const readFirstBlockContent = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	return readBlockContent(page, 0);
};

const stripIds = <T>(value: T): T => {
	return JSON.parse(
		JSON.stringify(value, (key, current) => {
			return key === 'id' ? undefined : current;
		})
	) as T;
};

const readSecondInlineContent = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string; type?: string; data?: unknown }> }>;
	}>(page, 'value');
	return stripIds(value.children[1]?.content);
};

const readSecondBlockDomText = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(() => {
		const block = document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')[1];
		const text = block?.querySelector<HTMLElement>('[data-edytor-text="true"]');
		return text?.textContent ?? '';
	});

const readDomText = async (page: Parameters<typeof readJsonByTestId>[0], textIndex: number) =>
	page.evaluate((index) => {
		const text = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[index];
		return text?.textContent?.replaceAll('\u200B', '') ?? '';
	}, textIndex);

const readFirstBlockDomText = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	readDomText(page, 0);

const readBlockTexts = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string }> }>;
	}>(page, 'value');
	return value.children.map(
		(block) => block.content?.map((part) => part.text ?? '').join('') ?? ''
	);
};

const readCodeLines = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ children?: Array<{ content?: Array<{ text?: string }> }> }>;
	}>(page, 'value');
	return (
		value.children[0]?.children?.map(
			(block) => block.content?.map((part) => part.text ?? '').join('') ?? ''
		) ?? []
	);
};

const dispatchStructuralDeleteWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	inputType: 'deleteContentBackward' | 'deleteContentForward'
) =>
	page.evaluate(async (deleteInputType) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(event, 'inputType', {
			value: deleteInputType,
			configurable: true
		});

		editor.dispatchEvent(event);
		await Promise.resolve();
		await Promise.resolve();

		const block = document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')[1];
		const text = block?.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const textNode =
			text && Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (!text || !textNode) {
			throw new Error('Missing second block text after structural delete');
		}

		textNode.textContent = 'lead end';
		const range = document.createRange();
		range.setStart(textNode, 5);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: deleteInputType,
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		text.dispatchEvent(inputEvent);

		return event.defaultPrevented;
	}, inputType);

const dispatchBlockMergeWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	inputType: 'deleteContentBackward' | 'deleteContentForward'
) =>
	page.evaluate(async (deleteInputType) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(event, 'inputType', {
			value: deleteInputType,
			configurable: true
		});

		editor.dispatchEvent(event);

		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const textNode =
			text && Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (!text || !textNode) {
			throw new Error('Missing merged block text after structural delete');
		}

		textNode.textContent = 'leadnotenote';
		const range = document.createRange();
		range.setStart(textNode, 4);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: deleteInputType,
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		text.dispatchEvent(inputEvent);

		return event.defaultPrevented;
	}, inputType);

const dispatchCrossParagraphDeleteWithNativeSelectionDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	inputType: 'deleteContentBackward' | 'deleteContentForward'
) =>
	page.evaluate(async (deleteInputType) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const beforeInput = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(beforeInput, 'inputType', {
			value: deleteInputType,
			configurable: true
		});

		editor.dispatchEvent(beforeInput);
		const valueAfterBeforeInput = JSON.parse(
			JSON.stringify(
				(window as Window & { __EDYTOR__?: { value: unknown } }).__EDYTOR__?.value ?? {}
			)
		);

		await Promise.resolve();
		await Promise.resolve();

		const firstText = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const textNode =
			firstText && document.createTreeWalker(firstText, NodeFilter.SHOW_TEXT).nextNode();
		if (!firstText || !textNode) {
			throw new Error('Missing first text after cross-paragraph delete');
		}

		textNode.textContent = 'lete';
		const range = document.createRange();
		range.setStart(textNode, 3);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: deleteInputType,
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		firstText.dispatchEvent(inputEvent);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return {
			defaultPrevented: beforeInput.defaultPrevented,
			valueAfterBeforeInput
		};
	}, inputType);

const dispatchNonCancelableAdvancedDeleteWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	payload: {
		inputType: AdvancedDeleteInputType | GenericDeleteInputType;
		driftValue: string;
		driftCaretOffset: number;
	}
) =>
	page.evaluate(async ({ inputType, driftValue, driftCaretOffset }) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const beforeInput = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperties(beforeInput, {
			inputType: {
				value: inputType,
				configurable: true
			},
			data: {
				value: null,
				configurable: true
			}
		});

		editor.dispatchEvent(beforeInput);
		await Promise.resolve();
		await Promise.resolve();

		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!text) {
			throw new Error('Missing first managed text after advanced delete');
		}

		text.textContent = driftValue;
		const selectionTarget = text.firstChild ?? text;
		const range = document.createRange();
		range.setStart(selectionTarget, Math.min(driftCaretOffset, driftValue.length));
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType,
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		text.dispatchEvent(inputEvent);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return beforeInput.defaultPrevented;
	}, payload);

const dispatchNonCancelableEnterWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0]
) =>
	page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(event, 'inputType', {
			value: 'insertParagraph',
			configurable: true
		});

		editor.dispatchEvent(event);
		await Promise.resolve();
		await Promise.resolve();

		const nativeParagraph = document.createElement('div');
		nativeParagraph.dataset.testNativeParagraph = 'true';
		nativeParagraph.textContent = 'native paragraph drift';
		editor.append(nativeParagraph);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertParagraph',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		editor.dispatchEvent(inputEvent);

		return event.defaultPrevented;
	});

const dispatchBackspaceMisreportedAsParagraphWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0]
) =>
	page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const secondText = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[1];
		if (!editor || !secondText) {
			throw new Error('Missing editor or second text for misreported Backspace simulation');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Backspace',
			code: 'Backspace'
		});
		secondText.dispatchEvent(keydown);

		const beforeInput = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperties(beforeInput, {
			inputType: {
				value: 'insertParagraph',
				configurable: true
			},
			data: {
				value: null,
				configurable: true
			}
		});
		editor.dispatchEvent(beforeInput);

		await Promise.resolve();
		await Promise.resolve();

		const nativeParagraph = document.createElement('div');
		nativeParagraph.dataset.testNativeMisreportedParagraph = 'true';
		nativeParagraph.textContent = 'native paragraph drift';
		editor.append(nativeParagraph);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertParagraph',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		editor.dispatchEvent(inputEvent);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return {
			keydownPrevented: keydown.defaultPrevented,
			beforeInputPrevented: beforeInput.defaultPrevented
		};
	});

const dispatchNonCancelableLineBreakWithNativeBrDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	payload: { textIndex?: number } = {}
) =>
	page.evaluate(async ({ textIndex = 0 }) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(event, 'inputType', {
			value: 'insertLineBreak',
			configurable: true
		});

		editor.dispatchEvent(event);
		await Promise.resolve();
		await Promise.resolve();

		const text = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'))[
			textIndex
		];
		if (!text) {
			throw new Error(`Missing managed text ${textIndex} after insertLineBreak`);
		}

		const nativeBreak = document.createElement('br');
		nativeBreak.dataset.testNativeLineBreak = 'true';
		text.append(nativeBreak);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertLineBreak',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		text.dispatchEvent(inputEvent);

		return event.defaultPrevented;
	}, payload);

const dispatchNonCancelablePasteWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0]
) =>
	page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing [data-edytor] root');
		}

		const dataTransfer = {
			getData: (type: string) => (type === 'text/plain' ? 'PASTE' : '')
		} satisfies Pick<DataTransfer, 'getData'>;
		const event = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperties(event, {
			inputType: {
				value: 'insertFromPaste',
				configurable: true
			},
			data: {
				value: null,
				configurable: true
			},
			dataTransfer: {
				value: dataTransfer,
				configurable: true
			}
		});

		editor.dispatchEvent(event);

		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const textNode =
			text && Array.from(text.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (!text || !textNode) {
			throw new Error('Missing managed text after paste');
		}

		textNode.textContent = 'leadPASTEPASTE';
		const range = document.createRange();
		range.setStart(textNode, 'leadPASTEPASTE'.length);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertFromPaste',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		Object.defineProperty(inputEvent, 'dataTransfer', {
			value: dataTransfer,
			configurable: true
		});
		text.dispatchEvent(inputEvent);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return event.defaultPrevented;
	});

const dispatchSelectedBlockBeforeInputWithNativeSurvivorRemoval = async (
	page: Parameters<typeof readJsonByTestId>[0],
	inputType: 'deleteContentBackward' | 'deleteContentForward'
) =>
	page.evaluate(async (deleteInputType) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const selectedBlock = document.querySelector<HTMLElement>('[data-edytor-selected="true"]');
		const survivorBlock = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
		).find((block) => block !== selectedBlock);
		if (!editor || !selectedBlock || !survivorBlock) {
			throw new Error(
				'Missing selected block or survivor block for mobile selected-block deletion drift'
			);
		}

		const beforeInput = new Event('beforeinput', {
			bubbles: true,
			cancelable: false
		}) as InputEvent;
		Object.defineProperty(beforeInput, 'inputType', {
			value: deleteInputType,
			configurable: true
		});

		editor.dispatchEvent(beforeInput);
		await Promise.resolve();
		await Promise.resolve();

		survivorBlock.remove();

		const inputEvent =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: deleteInputType,
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		editor.dispatchEvent(inputEvent);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return beforeInput.defaultPrevented;
	}, inputType);

const dispatchNonCancelableInsertTextWithNativeDomDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	payload: {
		blockIndex: number;
		textIndex?: number;
		globalTextIndex?: number;
		data: string;
		value: string;
		caretOffset?: number;
		replaceTextElement?: boolean;
		selectionJumpGlobalTextIndex?: number;
		selectionJumpOffset?: number;
	}
) =>
	page.evaluate(
		async ({
			blockIndex,
			textIndex = 0,
			globalTextIndex,
			data,
			value,
			caretOffset,
			replaceTextElement,
			selectionJumpGlobalTextIndex,
			selectionJumpOffset
		}) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) {
				throw new Error('Missing [data-edytor] root');
			}

			const beforeInput = new Event('beforeinput', {
				bubbles: true,
				cancelable: false
			}) as InputEvent;
			Object.defineProperties(beforeInput, {
				inputType: {
					value: 'insertText',
					configurable: true
				},
				data: {
					value: data,
					configurable: true
				}
			});
			editor.dispatchEvent(beforeInput);
			const valueAfterBeforeInput = JSON.parse(
				JSON.stringify(
					(window as Window & { __EDYTOR__?: { value: unknown } }).__EDYTOR__?.value ?? {}
				)
			);

			const text =
				typeof globalTextIndex === 'number'
					? document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[globalTextIndex]
					: Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'))[
							blockIndex
						]?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[textIndex];
			const textNode = text && document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode();
			if (!text || !textNode) {
				throw new Error(
					typeof globalTextIndex === 'number'
						? `Missing text node at index ${globalTextIndex}`
						: `Missing text ${textIndex} in block ${blockIndex}`
				);
			}

			if (replaceTextElement) {
				text.textContent = value;
			} else {
				textNode.textContent = value;
			}
			const selectionTarget = replaceTextElement ? (text.firstChild ?? text) : textNode;
			const range = document.createRange();
			range.setStart(selectionTarget, Math.min(caretOffset ?? value.length, value.length));
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);

			if (typeof selectionJumpGlobalTextIndex === 'number') {
				const jumpText = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[
					selectionJumpGlobalTextIndex
				];
				const jumpTextNode =
					jumpText && document.createTreeWalker(jumpText, NodeFilter.SHOW_TEXT).nextNode();
				if (!jumpText || !jumpTextNode) {
					throw new Error(`Missing selection jump text ${selectionJumpGlobalTextIndex}`);
				}

				const jumpRange = document.createRange();
				jumpRange.setStart(
					jumpTextNode,
					Math.min(selectionJumpOffset ?? 0, jumpTextNode.textContent?.length ?? 0)
				);
				jumpRange.collapse(true);
				selection?.removeAllRanges();
				selection?.addRange(jumpRange);
			}

			const inputEvent =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'insertText',
							data
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			text.dispatchEvent(inputEvent);

			await new Promise((resolve) => setTimeout(resolve, 50));
			return {
				defaultPrevented: beforeInput.defaultPrevented,
				valueAfterBeforeInput
			};
		},
		payload
	);

test.describe('mobile browser beforeinput behavior', () => {
	test('falls back when Android Chrome Backspace beforeinput has no native effect', async ({
		page,
		browserName
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);

		const expectedText = expectedByBrowser(browserName, 'lead', {
			chromium: {
				value: 'lea',
				quirk: {
					id: 'android-chromium-deletecontentbackward-no-native-effect',
					because:
						'Android Chromium may report non-cancelable Backspace without mutating DOM, so Edytor applies the model fallback'
				}
			}
		});

		await expect.poll(() => readFirstText(page)).toBe(expectedText);

		const expectedSelection = expectedByBrowser<Record<string, unknown> | null>(browserName, null, {
			chromium: {
				value: {
					startBlockPath: [0],
					endBlockPath: [0],
					yStart: 3,
					yEnd: 3,
					isCollapsed: true
				},
				quirk: {
					id: 'android-chromium-deletecontentbackward-caret',
					because: 'Only the Android Chromium model fallback moves the caret during this test'
				}
			}
		});

		if (expectedSelection) {
			await expectSelection(page, expectedSelection);
		}

		issues.assertClean();
	});

	for (const inputType of ['deleteContentBackward', 'deleteContentForward'] as const) {
		test(`keeps selected-block ${inputType} model-owned when mobile beforeinput is non-cancelable and DOM drifts`, async ({
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

			const wasPrevented = await dispatchSelectedBlockBeforeInputWithNativeSurvivorRemoval(
				page,
				inputType
			);
			expect(wasPrevented).toBe(false);

			await expect.poll(() => readBlockTexts(page)).toEqual(['First block', 'lead  tail']);
			await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(2);
			await expect(page.locator('[data-edytor-selected="true"]')).toHaveCount(0);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				isCollapsed: true,
				selectedBlockPaths: []
			});

			issues.assertClean();
		});
	}

	for (const inputType of ['deleteContentBackward', 'deleteContentForward'] as const) {
		test(`restores selection after non-cancelable ${inputType} deletes across paragraphs and native selection shifts`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=basic&empty=last');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 2, 1, 2);

			const result = await dispatchCrossParagraphDeleteWithNativeSelectionDrift(page, inputType);

			expect(result.defaultPrevented).toBe(false);
			const snapshotChildren = getSnapshotChildren(result.valueAfterBeforeInput);
			expect(snapshotChildren[0]?.content).toEqual([{ text: 'lete' }]);
			expect(snapshotChildren[1]?.content ?? [{ text: '' }]).toEqual([{ text: '' }]);

			await expect.poll(() => readBlockTexts(page)).toEqual(['lete', '']);
			await expect.poll(() => readFirstBlockDomText(page)).toBe('lete');
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
	}

	const advancedDeleteCases: Array<{
		inputType: AdvancedDeleteInputType;
		offset: number;
		driftValue: string;
		driftCaretOffset: number;
		expectedText: string;
		expectedOffset: number;
	}> = [
		{
			inputType: 'deleteWordBackward',
			offset: 5,
			driftValue: 'block',
			driftCaretOffset: 0,
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteSoftLineBackward',
			offset: 5,
			driftValue: 'block',
			driftCaretOffset: 0,
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteHardLineBackward',
			offset: 5,
			driftValue: 'block',
			driftCaretOffset: 0,
			expectedText: ' block',
			expectedOffset: 0
		},
		{
			inputType: 'deleteWordForward',
			offset: 5,
			driftValue: 'FirstFirst',
			driftCaretOffset: 5,
			expectedText: 'First',
			expectedOffset: 5
		},
		{
			inputType: 'deleteSoftLineForward',
			offset: 5,
			driftValue: 'FirstFirst',
			driftCaretOffset: 5,
			expectedText: 'First',
			expectedOffset: 5
		},
		{
			inputType: 'deleteHardLineForward',
			offset: 5,
			driftValue: 'FirstFirst',
			driftCaretOffset: 5,
			expectedText: 'First',
			expectedOffset: 5
		}
	];

	for (const {
		inputType,
		offset,
		driftValue,
		driftCaretOffset,
		expectedText,
		expectedOffset
	} of advancedDeleteCases) {
		test(`repairs native DOM drift after non-cancelable ${inputType}`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, offset);

			const wasPrevented = await dispatchNonCancelableAdvancedDeleteWithNativeDomDrift(page, {
				inputType,
				driftValue,
				driftCaretOffset
			});
			expect(wasPrevented).toBe(false);

			await expect.poll(() => readFirstText(page)).toBe(expectedText);
			await expect.poll(() => readFirstBlockDomText(page)).toBe(expectedText);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: expectedOffset,
				yEnd: expectedOffset,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	const genericDeleteCases: Array<{
		inputType: GenericDeleteInputType;
		selection: [number, number] | [number, number, number, number];
		driftValue: string;
		driftCaretOffset: number;
		expectedText: string;
		expectedOffset: number;
	}> = [
		{
			inputType: 'deleteContent',
			selection: [0, 2],
			driftValue: 'Fiirst block',
			driftCaretOffset: 3,
			expectedText: 'Fist block',
			expectedOffset: 2
		},
		{
			inputType: 'deleteEntireSoftLine',
			selection: [0, 5],
			driftValue: 'native stale line',
			driftCaretOffset: 0,
			expectedText: '',
			expectedOffset: 0
		},
		{
			inputType: 'deleteByComposition',
			selection: [0, 1, 0, 3],
			driftValue: 'Fiiist block',
			driftCaretOffset: 1,
			expectedText: 'Fst block',
			expectedOffset: 1
		}
	];

	for (const {
		inputType,
		selection,
		driftValue,
		driftCaretOffset,
		expectedText,
		expectedOffset
	} of genericDeleteCases) {
		test(`repairs native DOM drift after non-cancelable ${inputType}`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, ...selection);

			const wasPrevented = await dispatchNonCancelableAdvancedDeleteWithNativeDomDrift(page, {
				inputType,
				driftValue,
				driftCaretOffset
			});
			expect(wasPrevented).toBe(false);

			await expect.poll(() => readFirstText(page)).toBe(expectedText);
			await expect.poll(() => readFirstBlockDomText(page)).toBe(expectedText);
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: expectedOffset,
				yEnd: expectedOffset,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	test('keeps same-text range insertText model-owned when mobile beforeinput is non-cancelable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 3);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 0,
			data: 'X',
			value: 'lXXd',
			caretOffset: 3
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[0]?.content).toEqual([
			{ text: 'lXd' }
		]);

		await expect.poll(() => readFirstText(page)).toBe('lXd');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('lXd');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps inline-spanning insertText model-owned when mobile beforeinput is non-cancelable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 2, 3, 2);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 1,
			data: 'X',
			value: 'leXXnd',
			caretOffset: 4
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[1]?.content).toEqual([
			{ text: 'leXnd' }
		]);

		await expect.poll(() => readSecondInlineContent(page)).toEqual([{ text: 'leXnd' }]);
		await expect.poll(() => readSecondBlockDomText(page)).toBe('leXnd');
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

	test('keeps cross-block insertText model-owned when mobile beforeinput is non-cancelable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2, 1, 2);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 0,
			data: 'X',
			value: 'leXXte',
			caretOffset: 4
		});
		expect(result.defaultPrevented).toBe(false);
		const snapshotChildren = getSnapshotChildren(result.valueAfterBeforeInput);
		expect(snapshotChildren[0]?.content).toEqual([{ text: 'leXte' }]);
		expect(snapshotChildren[1]?.content ?? [{ text: '' }]).toEqual([{ text: '' }]);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leXte', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leXte');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves common marks for all-marked range insertText when mobile beforeinput is non-cancelable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 4);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 0,
			globalTextIndex: 0,
			data: 'X',
			value: 'AXXa',
			caretOffset: 3
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[0]?.content).toEqual([
			{ text: 'AXa', marks: { bold: true } },
			{ text: ' beta' }
		]);

		await expect
			.poll(() => readFirstBlockContent(page))
			.toEqual([{ text: 'AXa', marks: { bold: true } }, { text: ' beta' }]);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('AXa beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps mixed-mark range insertText plain when mobile beforeinput is non-cancelable', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 3, 1, 8);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 1,
			globalTextIndex: 1,
			data: 'X',
			value: 'GamXX',
			caretOffset: 5
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[1]?.content).toEqual([
			{ text: 'Gam', marks: { italic: true } },
			{ text: 'X' },
			{ text: 'lta', marks: { underline: true } }
		]);

		await expect
			.poll(() => readBlockContent(page, 1))
			.toEqual([
				{ text: 'Gam', marks: { italic: true } },
				{ text: 'X' },
				{ text: 'lta', marks: { underline: true } }
			]);
		await expect.poll(() => readDomText(page, 1)).toBe('GamXlta');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores browser-owned text insertion from the beforeinput selection when native selection jumps before input', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 0,
			data: 'X',
			value: 'leXad',
			caretOffset: 3,
			selectionJumpGlobalTextIndex: 1,
			selectionJumpOffset: 1
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[0]?.content).toEqual([
			{ text: 'lead' }
		]);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leXad', 'note', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leXad');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores browser-owned text insertion at the start of a text node when native selection jumps before input', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const result = await dispatchNonCancelableInsertTextWithNativeDomDrift(page, {
			blockIndex: 0,
			data: 'X',
			value: 'Xlead',
			caretOffset: 1,
			selectionJumpGlobalTextIndex: 1,
			selectionJumpOffset: 1
		});
		expect(result.defaultPrevented).toBe(false);
		expect(getSnapshotChildren(result.valueAfterBeforeInput)[0]?.content).toEqual([
			{ text: 'lead' }
		]);

		await expect.poll(() => readBlockTexts(page)).toEqual(['Xlead', 'note', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('Xlead');
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

	test('keeps void image boundaries atomic during non-cancelable structural delete', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);

		const backwardWasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(backwardWasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['caption', 'after image']);
		await expectSelection(page, {
			selectedBlockPaths: [[0]]
		});

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 7);

		const forwardWasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward',
			cancelable: false
		});
		expect(forwardWasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['caption', 'after image']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native DOM drift after non-cancelable block merge deletion', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);

		const backwardWasPrevented = await dispatchBlockMergeWithNativeDomDrift(
			page,
			'deleteContentBackward'
		);
		expect(backwardWasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leadnote', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leadnote');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const forwardWasPrevented = await dispatchBlockMergeWithNativeDomDrift(
			page,
			'deleteContentForward'
		);
		expect(forwardWasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leadnote', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leadnote');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('treats Android Backspace misreported as insertParagraph as backward deletion', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);

		const result = await dispatchBackspaceMisreportedAsParagraphWithNativeDomDrift(page);
		expect(result.keydownPrevented).toBe(false);
		expect(result.beforeInputPrevented).toBe(false);

		await expect(page.locator('[data-test-native-misreported-paragraph]')).toHaveCount(0);
		await expect.poll(() => readBlockTexts(page)).toEqual(['leadnote', '']);
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leadnote');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native paragraph DOM drift after non-cancelable enter at nested parent end', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		const wasPrevented = await dispatchNonCancelableEnterWithNativeDomDrift(page);
		expect(wasPrevented).toBe(false);

		await expect(page.locator('[data-test-native-paragraph]')).toHaveCount(0);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text?: string }>;
						children?: Array<{ content?: Array<{ text?: string }> }>;
					}>;
				}>(page, 'value');
				return stripIds(value.children);
			})
			.toEqual([
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
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native paragraph DOM drift after non-cancelable enter inside a code line', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const '.length);

		const wasPrevented = await dispatchNonCancelableEnterWithNativeDomDrift(page);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readCodeLines(page)).toEqual(['const ', 'a = 1;', 'return a;']);
		await expect.poll(() => page.locator('[data-test-native-paragraph]').count()).toBe(0);
		await expectSelection(page, {
			startBlockPath: [0, 1],
			endBlockPath: [0, 1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native br DOM drift after non-cancelable line break inside a code line', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=code');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'const '.length);

		const wasPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readCodeLines(page)).toEqual(['const ', 'a = 1;', 'return a;']);
		await expect.poll(() => page.locator('[data-test-native-line-break]').count()).toBe(0);
		await expectSelection(page, {
			startBlockPath: [0, 1],
			endBlockPath: [0, 1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native br DOM drift after non-cancelable soft break', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page);
		expect(wasPrevented).toBe(false);

		await expect(page.locator('[data-test-native-line-break]')).toHaveCount(0);
		await expect.poll(() => readFirstText(page)).toBe('lead\n');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs soft-break drift at selection restored by mobile history undo and redo', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');
		await expect.poll(() => readFirstText(page)).toBe('a');

		const undoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyUndo'
		});
		expect(undoPrevented).toBe(true);
		await expect.poll(() => readFirstText(page)).toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		const undoLineBreakPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page);
		expect(undoLineBreakPrevented).toBe(false);
		await expect(page.locator('[data-test-native-line-break]')).toHaveCount(0);
		await expect.poll(() => readFirstText(page)).toBe('\n');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.insertText('a');

		const secondUndoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyUndo'
		});
		expect(secondUndoPrevented).toBe(true);

		const redoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyRedo'
		});
		expect(redoPrevented).toBe(true);
		await expect.poll(() => readFirstText(page)).toBe('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		const redoLineBreakPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page);
		expect(redoLineBreakPrevented).toBe(false);
		await expect(page.locator('[data-test-native-line-break]')).toHaveCount(0);
		await expect.poll(() => readFirstText(page)).toBe('a\n');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves marks when mobile soft break is inserted inside marked text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);

		const wasPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page);
		expect(wasPrevented).toBe(false);

		await expect(page.locator('[data-test-native-line-break]')).toHaveCount(0);
		await expect
			.poll(() => readFirstBlockContent(page))
			.toEqual([{ text: 'Al\npha', marks: { bold: true } }, { text: ' beta' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('maps mobile soft break from an inline boundary to the trailing text', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
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

		const wasPrevented = await dispatchNonCancelableLineBreakWithNativeBrDrift(page, {
			textIndex: 3
		});
		expect(wasPrevented).toBe(false);

		await expect(page.locator('[data-test-native-line-break]')).toHaveCount(0);
		await expect
			.poll(() => readSecondInlineContent(page))
			.toEqual([{ text: 'lead ' }, { type: 'mention', data: {} }, { text: '\n end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 2],
			endTextPath: [1, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native DOM drift after non-cancelable paste', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchNonCancelablePasteWithNativeDomDrift(page);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readFirstText(page)).toBe('leadPASTE');
		await expect.poll(() => readFirstBlockDomText(page)).toBe('leadPASTE');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 9,
			yEnd: 9,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes inline mentions at non-cancelable mobile beforeinput boundaries', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 3, 0);

		const backwardWasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(backwardWasPrevented).toBe(false);

		await expect.poll(() => readSecondInlineContent(page)).toEqual([{ text: 'lead  end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 5);

		const forwardWasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward',
			cancelable: false
		});
		expect(forwardWasPrevented).toBe(false);

		await expect.poll(() => readSecondInlineContent(page)).toEqual([{ text: 'lead  end' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs native DOM drift after non-cancelable structural inline deletion', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 3, 0);

		const backwardWasPrevented = await dispatchStructuralDeleteWithNativeDomDrift(
			page,
			'deleteContentBackward'
		);
		expect(backwardWasPrevented).toBe(false);

		await expect.poll(() => readSecondInlineContent(page)).toEqual([{ text: 'lead  end' }]);
		await expect.poll(() => readSecondBlockDomText(page)).toBe('lead  end');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 2, 5);

		const forwardWasPrevented = await dispatchStructuralDeleteWithNativeDomDrift(
			page,
			'deleteContentForward'
		);
		expect(forwardWasPrevented).toBe(false);

		await expect.poll(() => readSecondInlineContent(page)).toEqual([{ text: 'lead  end' }]);
		await expect.poll(() => readSecondBlockDomText(page)).toBe('lead  end');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
