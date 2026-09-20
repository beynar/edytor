import { expect, test } from './editorTest';

import { expectedByBrowser, skipUnlessBrowser } from './browserExpectations';
import {
	dispatchBeforeInput,
	dispatchComposition,
	expectSelection,
	getPlaceholderLocators,
	readJsonByTestId,
	setSelectionAtInlineElementBoundary,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

test.describe('mobile browser composition behavior', () => {
	const stripIds = <T>(value: T): T => {
		return JSON.parse(
			JSON.stringify(value, (key, current) => {
				return key === 'id' ? undefined : current;
			})
		) as T;
	};

	const readFirstText = async (page: Parameters<typeof readJsonByTestId>[0]) => {
		const value = await readJsonByTestId<{
			children: Array<{ content?: Array<{ text: string }> }>;
		}>(page, 'value');
		return value.children[0]?.content?.[0]?.text ?? '';
	};

	test('types into an empty first paragraph under mobile emulation', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.insertText('é');

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

	test('commits final insertFromComposition under mobile emulation', async ({ page }) => {
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

	test('falls back when Android Chrome Backspace after compositionend has no native effect', async ({
		page,
		browserName
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

		const wasPrevented = await dispatchBeforeInput(page, {
			inputType: 'deleteContentBackward',
			cancelable: false
		});
		expect(wasPrevented).toBe(false);

		const expectedText = expectedByBrowser(browserName, 'に', {
			chromium: {
				value: '',
				quirk: {
					id: 'android-chromium-post-composition-backspace-no-native-effect',
					because:
						'Android Chromium reports non-cancelable Backspace after compositionend without applying native deletion, so Edytor deletes from the model'
				}
			}
		});
		const expectedOffset = expectedByBrowser(browserName, 1, {
			chromium: {
				value: 0,
				quirk: {
					id: 'android-chromium-post-composition-backspace-caret',
					because:
						'The model-owned fallback deletes the committed character and restores the caret to offset 0'
				}
			}
		});
		await expect.poll(() => readFirstText(page)).toBe(expectedText);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: expectedOffset,
			yEnd: expectedOffset,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits composition at the selection restored by mobile history undo', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
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

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect.poll(() => readFirstText(page)).toBe('に');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits composition at the selection restored by mobile history redo', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.insertText('a');

		const undoPrevented = await dispatchBeforeInput(page, {
			inputType: 'historyUndo'
		});
		expect(undoPrevented).toBe(true);
		await expect.poll(() => readFirstText(page)).toBe('');

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

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect.poll(() => readFirstText(page)).toBe('aに');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves marked text semantics during mobile composition', async ({ page }) => {
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
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'Alêpha', marks: { bold: true } }, { text: ' beta' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('commits mobile composition from an element-node caret after an inline mention', async ({
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
					children: Array<{ content?: Array<{ text?: string; type?: string; data?: unknown }> }>;
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

	test('commits mobile composition from an element-node caret before an inline mention', async ({
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
					children: Array<{ content?: Array<{ text?: string; type?: string; data?: unknown }> }>;
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

	test('commits Chromium CDP IME composition under mobile emulation', async ({
		page,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-cdp-ime-only',
			because: 'Input.imeSetComposition is a Chromium DevTools Protocol API'
		});
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const client = await page.context().newCDPSession(page);
		await client.send('Input.imeSetComposition', {
			text: 'ｓ',
			selectionStart: 1,
			selectionEnd: 1
		});
		await client.send('Input.imeSetComposition', {
			text: 'す',
			selectionStart: 1,
			selectionEnd: 1
		});
		await client.send('Input.imeSetComposition', {
			text: 'すし',
			selectionStart: 2,
			selectionEnd: 2
		});
		await client.send('Input.insertText', {
			text: 'すし'
		});
		await client.detach();

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('すし');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps Chromium CDP IME delete-and-reinsert composition to one commit', async ({
		page,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-cdp-ime-only',
			because: 'Input.imeSetComposition is a Chromium DevTools Protocol API'
		});
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const client = await page.context().newCDPSession(page);
		await client.send('Input.imeSetComposition', {
			text: 'ｋ',
			selectionStart: 1,
			selectionEnd: 1
		});
		await client.send('Input.imeSetComposition', {
			text: '',
			selectionStart: 0,
			selectionEnd: 0
		});
		await client.send('Input.imeSetComposition', {
			text: 'か',
			selectionStart: 1,
			selectionEnd: 1
		});
		await client.send('Input.insertText', {
			text: 'か'
		});
		await client.detach();

		await expect.poll(() => readFirstText(page)).toBe('か');
		await expect(page.locator('[data-edytor-text="true"]').first()).toHaveText('か');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('cancels Chromium CDP IME composition without committing preview text', async ({
		page,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-cdp-ime-only',
			because: 'Input.imeSetComposition is a Chromium DevTools Protocol API'
		});
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const client = await page.context().newCDPSession(page);
		await client.send('Input.imeSetComposition', {
			text: 'に',
			selectionStart: 1,
			selectionEnd: 1
		});
		await client.send('Input.imeSetComposition', {
			text: '',
			selectionStart: 0,
			selectionEnd: 0
		});
		await client.send('Input.insertText', {
			text: ''
		});
		await client.detach();

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

		issues.assertClean();
	});
});
