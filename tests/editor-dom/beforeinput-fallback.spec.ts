import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	dispatchDomTextInputMutation,
	expectSelection,
	modKey,
	readJsonByTestId,
	replaceManagedTextWithUnmanagedWrapper,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const readFirstText = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string }> }>;
	}>(page, 'value');
	return value.children[0]?.content?.[0]?.text;
};

const readBlockTexts = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string }> }>;
	}>(page, 'value');
	return value.children.map((block) => block.content?.[0]?.text ?? '');
};

const readBlockPlainTexts = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string }> }>;
	}>(page, 'value');
	return value.children.map(
		(block) => block.content?.map((part) => part.text ?? '').join('') ?? ''
	);
};

const readSecondInlineContentShape = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
	}>(page, 'value');
	return (
		value.children[1]?.content?.map((part) =>
			part.type ? { type: part.type } : { text: part.text ?? '' }
		) ?? []
	);
};

const readTopLevelInlineBlockCount = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(
		() =>
			Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')).filter(
				(element) => !element.parentElement?.closest('[data-edytor-inline-block]')
			).length
	);

const readRootBlocks = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{
			content?: Array<{ text?: string }>;
			children?: Array<{ content?: Array<{ text?: string }> }>;
		}>;
	}>(page, 'value');
	return value.children.map((block) => ({
		text: block.content?.[0]?.text ?? '',
		children: block.children?.map((child) => child.content?.[0]?.text ?? '') ?? []
	}));
};

const dispatchKeydownWithNativeBlockMerge = async (
	page: Parameters<typeof readJsonByTestId>[0],
	key: 'Backspace' | 'Delete',
	inputType: 'deleteContentBackward' | 'deleteContentForward'
) =>
	page.evaluate(
		async ({ key, inputType }) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			const blocks = Array.from(
				document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
			);
			const firstText = blocks[0]?.querySelector<HTMLElement>('[data-edytor-text="true"]');
			const secondText = blocks[1]?.querySelector<HTMLElement>('[data-edytor-text="true"]');
			const secondBlock = blocks[1];
			const firstTextNode =
				firstText &&
				Array.from(firstText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
			const keydownTarget = key === 'Backspace' ? secondText : firstText;
			if (
				!editor ||
				!firstText ||
				!firstTextNode ||
				!secondText ||
				!secondBlock ||
				!keydownTarget
			) {
				throw new Error('Missing editable nodes for native block merge simulation');
			}

			const keydown = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				key,
				code: key
			});
			keydownTarget.dispatchEvent(keydown);

			firstTextNode.textContent = 'leadnote';
			secondBlock.remove();
			const range = document.createRange();
			range.setStart(firstTextNode, 4);
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);

			const input =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType,
							data: null
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			firstText.dispatchEvent(input);

			await new Promise((resolve) => setTimeout(resolve, 0));
			return keydown.defaultPrevented;
		},
		{ key, inputType }
	);

const dispatchKeydownEnterWithNativeTrailingBlock = async (
	page: Parameters<typeof readJsonByTestId>[0]
) =>
	page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const parentBlock = document.querySelector<HTMLElement>('[data-edytor-block="true"]');
		const parentText = parentBlock?.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!editor || !parentBlock || !parentText) {
			throw new Error('Missing editable nodes for native Enter simulation');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Enter',
			code: 'Enter'
		});
		parentText.dispatchEvent(keydown);

		const nativeBlock = document.createElement('div');
		nativeBlock.setAttribute('data-test-native-enter-block', 'true');
		nativeBlock.textContent = '';
		parentBlock.after(nativeBlock);

		const range = document.createRange();
		range.setStart(nativeBlock, 0);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const input =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertParagraph',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		editor.dispatchEvent(input);

		await new Promise((resolve) => setTimeout(resolve, 0));
		return keydown.defaultPrevented;
	});

const dispatchKeydownShiftEnterWithNativeLineBreak = async (
	page: Parameters<typeof readJsonByTestId>[0]
) =>
	page.evaluate(async () => {
		const firstText = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		const firstTextNode =
			firstText &&
			Array.from(firstText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (!firstText || !firstTextNode) {
			throw new Error('Missing editable text node for native soft-break simulation');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Enter',
			code: 'Enter',
			shiftKey: true
		});
		firstText.dispatchEvent(keydown);

		const nativeLineBreak = document.createElement('br');
		nativeLineBreak.setAttribute('data-test-native-soft-break', 'true');
		firstTextNode.parentNode?.insertBefore(nativeLineBreak, firstTextNode.nextSibling);

		const range = document.createRange();
		range.setStartAfter(nativeLineBreak);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const input =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: 'insertLineBreak',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		firstText.dispatchEvent(input);

		await new Promise((resolve) => setTimeout(resolve, 0));
		return keydown.defaultPrevented;
	});

const dispatchModifierBackspaceWordDelete = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(() => {
		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!text) {
			throw new Error('Missing editable text node for native word deletion simulation');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Backspace',
			code: 'Backspace',
			altKey: true
		});
		text.dispatchEvent(keydown);
		return keydown.defaultPrevented;
	});

const dispatchModifierDeleteWordForward = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(() => {
		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!text) {
			throw new Error('Missing editable text node for native forward word deletion simulation');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Delete',
			code: 'Delete',
			altKey: true
		});
		text.dispatchEvent(keydown);
		return keydown.defaultPrevented;
	});

const dispatchModifierLineDelete = async (
	page: Parameters<typeof readJsonByTestId>[0],
	direction: 'backward' | 'forward'
) =>
	page.evaluate((direction) => {
		const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (!text) {
			throw new Error('Missing editable text node for native line deletion simulation');
		}

		const keydown =
			direction === 'backward'
				? new KeyboardEvent('keydown', {
						bubbles: true,
						cancelable: true,
						key: 'Backspace',
						code: 'Backspace',
						metaKey: true
					})
				: new KeyboardEvent('keydown', {
						bubbles: true,
						cancelable: true,
						key: 'k',
						code: 'KeyK',
						ctrlKey: true
					});
		text.dispatchEvent(keydown);
		return keydown.defaultPrevented;
	}, direction);

const dispatchSelectedBlockKeydownWithNativeSurvivorRemoval = async (
	page: Parameters<typeof readJsonByTestId>[0],
	key: 'Backspace' | 'Delete'
) =>
	page.evaluate(async (key) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const selectedBlock = document.querySelector<HTMLElement>('[data-edytor-selected="true"]');
		const survivorBlock = document.querySelector<HTMLElement>('[data-edytor-block="true"]');
		if (!editor || !selectedBlock || !survivorBlock) {
			throw new Error(
				'Missing selected block or survivor block for native deletion drift simulation'
			);
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key,
			code: key
		});
		selectedBlock.dispatchEvent(keydown);

		survivorBlock.remove();

		const input =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		editor.dispatchEvent(input);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return keydown.defaultPrevented;
	}, key);

const dispatchRangeDeleteAcrossInlineWithNativeDrift = async (
	page: Parameters<typeof readJsonByTestId>[0],
	key: 'Backspace' | 'Delete'
) =>
	page.evaluate(async (key) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
		const targetBlock = blocks[1];
		const texts = Array.from(
			targetBlock?.querySelectorAll<HTMLElement>('[data-edytor-text="true"]') ?? []
		);
		const inline = targetBlock?.querySelector<HTMLElement>('[data-edytor-inline-block]');
		const startText = texts[0];
		const endText = texts[1];
		const startTextNode =
			startText &&
			Array.from(startText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		const endTextNode =
			endText && Array.from(endText.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);

		if (
			!editor ||
			!targetBlock ||
			!startText ||
			!endText ||
			!startTextNode ||
			!endTextNode ||
			!inline
		) {
			throw new Error('Missing inline range deletion nodes');
		}

		const keydown = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key,
			code: key
		});
		startText.dispatchEvent(keydown);

		startTextNode.textContent = 'le';
		endTextNode.textContent = 'nd';
		inline.remove();

		const range = document.createRange();
		range.setStart(startTextNode, 2);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const input =
			typeof InputEvent === 'function'
				? new InputEvent('input', {
						bubbles: true,
						inputType: key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
						data: null
					})
				: (new Event('input', { bubbles: true }) as InputEvent);
		startText.dispatchEvent(input);

		await new Promise((resolve) => setTimeout(resolve, 50));
		return keydown.defaultPrevented;
	}, key);

test.describe('browser beforeinput fallback behavior', () => {
	test('reconciles text insertion when beforeinput is missing and only input fires', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5,
			inputType: 'insertText',
			data: '!'
		});

		await expect.poll(() => readFirstText(page)).toBe('lead!');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles full text wrapper replacement when input events are missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 4);

		await replaceManagedTextWithUnmanagedWrapper(page, {
			textIndex: 1,
			value: 'corrected',
			caretOffset: 9
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'corrected', '']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 9,
			yEnd: 9,
			isCollapsed: true
		});
		await expect(page.locator('[data-test-unmanaged-replacement]')).toHaveCount(0);

		issues.assertClean();
	});

	test('routes structural Backspace through the model when beforeinput is missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 0);

		const wasPrevented = await dispatchKeydownWithNativeBlockMerge(
			page,
			'Backspace',
			'deleteContentBackward'
		);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leadnote', '']);
		await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(2);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes structural Delete through the model when beforeinput is missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchKeydownWithNativeBlockMerge(
			page,
			'Delete',
			'deleteContentForward'
		);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readBlockTexts(page)).toEqual(['leadnote', '']);
		await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(2);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes Enter at the end of a parent-with-children through the model when beforeinput is missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		const wasPrevented = await dispatchKeydownEnterWithNativeTrailingBlock(page);
		expect(wasPrevented).toBe(false);

		await expect
			.poll(() => readRootBlocks(page))
			.toEqual([
				{ text: 'Hello', children: [] },
				{ text: '', children: ['Nested child', 'Nested tail'] },
				{ text: 'After', children: [] }
			]);
		await expect(page.locator('[data-test-native-enter-block]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes Shift+Enter soft break through the model when beforeinput is missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchKeydownShiftEnterWithNativeLineBreak(page);
		expect(wasPrevented).toBe(false);

		await expect.poll(() => readFirstText(page)).toBe('lead\n');
		await expect(page.locator('[data-test-native-soft-break]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles browser-native word deletion when beforeinput is missing', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchModifierBackspaceWordDelete(page);
		expect(wasPrevented).toBe(false);
		await expect.poll(() => readFirstText(page)).toBe('lead');

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: '',
			caretOffset: 0,
			inputType: 'deleteWordBackward'
		});

		await expect
			.poll(async () => {
				const texts = await readBlockTexts(page);
				return texts[0];
			})
			.toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles browser-native forward word deletion when beforeinput is missing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=selection');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const wasPrevented = await dispatchModifierDeleteWordForward(page);
		expect(wasPrevented).toBe(false);
		await expect.poll(() => readFirstText(page)).toBe('First block');

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: ' block',
			caretOffset: 0,
			inputType: 'deleteWordForward'
		});

		await expect.poll(() => readFirstText(page)).toBe(' block');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	for (const inputType of ['deleteSoftLineBackward', 'deleteHardLineBackward'] as const) {
		test(`reconciles browser-native ${inputType} when beforeinput is missing`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 5);

			const wasPrevented = await dispatchModifierLineDelete(page, 'backward');
			expect(wasPrevented).toBe(false);
			await expect.poll(() => readFirstText(page)).toBe('First block');

			await dispatchDomTextInputMutation(page, {
				textIndex: 0,
				value: ' block',
				caretOffset: 0,
				inputType
			});

			await expect.poll(() => readFirstText(page)).toBe(' block');
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 0,
				yEnd: 0,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	for (const inputType of ['deleteSoftLineForward', 'deleteHardLineForward'] as const) {
		test(`reconciles browser-native ${inputType} when beforeinput is missing`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=selection');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 0, 5);

			const wasPrevented = await dispatchModifierLineDelete(page, 'forward');
			expect(wasPrevented).toBe(false);
			await expect.poll(() => readFirstText(page)).toBe('First block');

			await dispatchDomTextInputMutation(page, {
				textIndex: 0,
				value: 'First',
				caretOffset: 5,
				inputType
			});

			await expect.poll(() => readFirstText(page)).toBe('First');
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 5,
				yEnd: 5,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	for (const key of ['Backspace', 'Delete'] as const) {
		test(`keeps selected-block ${key} model-owned when beforeinput is missing and DOM drifts`, async ({
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

			const wasPrevented = await dispatchSelectedBlockKeydownWithNativeSurvivorRemoval(page, key);
			expect(wasPrevented).toBe(true);

			await expect.poll(() => readBlockPlainTexts(page)).toEqual(['First block', 'lead  tail']);
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

	for (const key of ['Backspace', 'Delete'] as const) {
		test(`deletes a range across an inline mention with ${key} when beforeinput is missing`, async ({
			page
		}) => {
			const issues = trackPageIssues(page);

			await page.goto('/test/dom?scenario=inline');
			await waitForEditorReady(page);
			await setSelectionByTextIndex(page, 2, 2, 3, 2);
			await expectSelection(page, {
				startBlockPath: [1],
				endBlockPath: [1],
				startTextPath: [1, 0],
				endTextPath: [1, 2],
				yStart: 2,
				yEnd: 2,
				isCollapsed: false
			});

			const wasPrevented = await dispatchRangeDeleteAcrossInlineWithNativeDrift(page, key);
			expect(wasPrevented).toBe(false);

			await expect.poll(() => readSecondInlineContentShape(page)).toEqual([{ text: 'lend' }]);
			await expect.poll(() => readTopLevelInlineBlockCount(page)).toBe(1);
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
		});
	}

	test('lets non-cancelable backward text deletion reconcile through input', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);
		await expect.poll(() => readFirstText(page)).toBe('lead');

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'lea',
			caretOffset: 3,
			inputType: 'deleteContentBackward'
		});

		await expect.poll(() => readFirstText(page)).toBe('lea');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('lets non-cancelable forward text deletion reconcile through input', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentForward',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);
		await expect.poll(() => readFirstText(page)).toBe('lead');

		await dispatchDomTextInputMutation(page, {
			textIndex: 0,
			value: 'ead',
			caretOffset: 0,
			inputType: 'deleteContentForward'
		});

		await expect.poll(() => readFirstText(page)).toBe('ead');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
