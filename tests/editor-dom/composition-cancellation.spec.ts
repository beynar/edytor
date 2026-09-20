import { expect, test, type Page } from './editorTest';

import {
	dispatchComposition,
	expectSelection,
	getPlaceholderLocators,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const dispatchComposingKeydowns = async (
	page: Page,
	events: Array<{
		key: string;
		code?: string;
		ctrlKey?: boolean;
		metaKey?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
	}>
) =>
	page.evaluate(async (keydowns) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) {
			throw new Error('Missing [data-edytor] root');
		}

		const flushEventTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
		const results: Array<{ key: string; defaultPrevented: boolean; dispatched: boolean }> = [];

		for (const init of keydowns) {
			const event = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				key: init.key,
				code: init.code ?? init.key,
				ctrlKey: init.ctrlKey ?? false,
				metaKey: init.metaKey ?? false,
				shiftKey: init.shiftKey ?? false,
				altKey: init.altKey ?? false
			});
			Object.defineProperty(event, 'isComposing', {
				value: true,
				configurable: true
			});

			const dispatched = target.dispatchEvent(event);
			results.push({
				key: init.key,
				defaultPrevented: event.defaultPrevented,
				dispatched
			});
			await flushEventTurn();
		}

		return results;
	}, events);

test.describe('browser composition cancellation behavior', () => {
	test('cancels a composition preview when compositionend data is empty', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: '' }
		]);

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

	test('keeps deleteCompositionText browser-owned until the final IME commit', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'かな' },
			{ type: 'compositionupdate', data: 'かな' },
			{ type: 'beforeinput', inputType: 'deleteCompositionText', data: '' },
			{ type: 'compositionupdate', data: 'か' },
			{ type: 'compositionend', data: 'か' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('か');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('replaces preview text when insertParagraph interrupts composition before compositionend', async ({
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
			{ type: 'beforeinput', inputType: 'insertParagraph', data: '' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['に', '', 'note', 'tail']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps deleteContentBackward during composition from corrupting the final IME commit', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'かな' },
			{ type: 'compositionupdate', data: 'かな' },
			{ type: 'beforeinput', inputType: 'deleteContentBackward', data: '' },
			{ type: 'compositionupdate', data: 'か' },
			{ type: 'compositionend', data: 'か' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('か');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps deleteContentForward during composition from corrupting the final IME commit', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'かな' },
			{ type: 'compositionupdate', data: 'かな' },
			{ type: 'beforeinput', inputType: 'deleteContentForward', data: '' },
			{ type: 'compositionupdate', data: 'か' },
			{ type: 'compositionend', data: 'か' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('か');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps formatUnderline during composition from leaking into the final IME commit', async ({
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
			{ type: 'beforeinput', inputType: 'formatUnderline', data: '' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([{ text: 'に' }]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('ignores editor hotkeys and candidate-navigation keydowns while composition is active', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionupdate', data: 'n' }
		]);

		const keydowns = await dispatchComposingKeydowns(page, [
			{ key: 'b', code: 'KeyB', metaKey: true },
			{ key: 'Enter', code: 'Enter' },
			{ key: 'Tab', code: 'Tab' },
			{ key: 'z', code: 'KeyZ', metaKey: true },
			{ key: 'ArrowLeft', code: 'ArrowLeft' },
			{ key: 'ArrowRight', code: 'ArrowRight' },
			{ key: 'ArrowUp', code: 'ArrowUp' },
			{ key: 'ArrowDown', code: 'ArrowDown' },
			{ key: 'Escape', code: 'Escape' }
		]);
		expect(keydowns).toEqual([
			{ key: 'b', defaultPrevented: false, dispatched: true },
			{ key: 'Enter', defaultPrevented: false, dispatched: true },
			{ key: 'Tab', defaultPrevented: false, dispatched: true },
			{ key: 'z', defaultPrevented: false, dispatched: true },
			{ key: 'ArrowLeft', defaultPrevented: false, dispatched: true },
			{ key: 'ArrowRight', defaultPrevented: false, dispatched: true },
			{ key: 'ArrowUp', defaultPrevented: false, dispatched: true },
			{ key: 'ArrowDown', defaultPrevented: false, dispatched: true },
			{ key: 'Escape', defaultPrevented: false, dispatched: true }
		]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						children?: unknown[];
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				return value.children.map((child) => ({
					content: child.content ?? [],
					childCount: child.children?.length ?? 0
				}));
			})
			.toEqual([
				{ content: [{ text: 'に' }], childCount: 0 },
				{ content: [{ text: 'note' }], childCount: 0 },
				{ content: [{ text: 'tail' }], childCount: 0 }
			]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not push a noisy undo entry when composition preview is canceled', async ({
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
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('a');

		await page.waitForTimeout(650);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionupdate', data: 'に' },
			{ type: 'compositionend', data: '' }
		]);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text ?? '';
			})
			.toBe('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

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
				return value.children[0]?.content?.[0]?.text ?? '';
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
});
