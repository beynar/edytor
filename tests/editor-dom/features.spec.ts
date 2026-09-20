import { expect, test } from './editorTest';

import {
	dispatchPaste,
	expectSelection,
	getPlaceholderLocators,
	getTextLocators,
	readJsonByTestId,
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

test.describe('browser feature-route parity', () => {
	test('does not focus the editor or create an editor selection on route load', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await waitForEditorReady(page);

		await expect
			.poll(() =>
				page.evaluate(() => {
					const editor = document.querySelector('[data-edytor]');
					const activeElement = document.activeElement;
					const selection = window.getSelection();
					const hasEditorSelection = Boolean(
						editor &&
						selection?.anchorNode &&
						selection.focusNode &&
						editor.contains(selection.anchorNode) &&
						editor.contains(selection.focusNode)
					);

					return {
						activeIsInsideEditor:
							activeElement instanceof Node && Boolean(editor?.contains(activeElement)),
						hasEditorSelection
					};
				})
			)
			.toEqual({
				activeIsInsideEditor: false,
				hasEditorSelection: false
			});

		const placeholders = getPlaceholderLocators(page);
		await expect(placeholders).toHaveCount(1);
		await placeholders.first().click();
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

	test('sets browser-mutation guard attributes on the editable root', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		const editor = page.locator('[data-edytor]');
		await expect(editor).toHaveAttribute('role', 'textbox');
		await expect(editor).toHaveAttribute('aria-multiline', 'true');
		await expect(editor).toHaveAttribute('aria-readonly', 'false');
		await expect(editor).toHaveAttribute('translate', 'no');
		await expect(editor).toHaveAttribute('spellcheck', 'true');
		await expect(editor).toHaveAttribute('autocorrect', 'off');
		await expect(editor).toHaveAttribute('autocomplete', 'off');
		await expect(editor).toHaveAttribute('autocapitalize', 'none');

		issues.assertClean();
	});

	test('allows browser-mutation guard attributes to be overridden', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto(
			'/test/dom?scenario=basic&translate=yes&spellcheck=false&autocorrect=on&autocomplete=on&autocapitalize=sentences'
		);
		await waitForEditorReady(page);

		const editor = page.locator('[data-edytor]');
		await expect(editor).toHaveAttribute('translate', 'yes');
		await expect(editor).toHaveAttribute('spellcheck', 'false');
		await expect(editor).toHaveAttribute('autocorrect', 'on');
		await expect(editor).toHaveAttribute('autocomplete', 'on');
		await expect(editor).toHaveAttribute('autocapitalize', 'sentences');

		issues.assertClean();
	});

	test('renders a custom placeholder and toggles it as content becomes empty again', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await waitForEditorReady(page);
		await expect(getPlaceholderLocators(page).first()).toContainText('Start writing');
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('A');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await page.keyboard.press('Backspace');
		await expect(getPlaceholderLocators(page).first()).toContainText('Start writing');

		issues.assertClean();
	});

	test('keeps readonly routes immutable under typing and paste while still exposing text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first&readonly=true');
		await waitForEditorReady(page);
		const editor = page.locator('[data-edytor]');
		await expect(editor).toHaveAttribute('contenteditable', 'false');
		await expect(editor).toHaveAttribute('role', 'textbox');
		await expect(editor).toHaveAttribute('aria-multiline', 'true');
		await expect(editor).toHaveAttribute('aria-readonly', 'true');
		await page.keyboard.type('A');
		await dispatchPaste(page, { text: 'plain' });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);

		issues.assertClean();
	});

	test('maps native readonly text selection without allowing keyboard mutation', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&readonly=true');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 1, 1, 3);

		await expect
			.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
			.toBe('ot');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		await page.keyboard.type('X');
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
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		issues.assertClean();
	});

	test('keeps dynamic readonly transitions immutable with stale model selection', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&dynamicReadonly=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 1, 1, 3);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 1,
			yEnd: 3,
			isCollapsed: false
		});

		const editor = page.locator('[data-edytor]');
		const toggleReadonly = page.getByTestId('toggle-readonly');
		await toggleReadonly.click();
		await expect(editor).toHaveAttribute('contenteditable', 'false');
		await expect(editor).toHaveAttribute('aria-readonly', 'true');

		await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) {
				throw new Error('Missing editor root');
			}

			editor.dispatchEvent(
				new InputEvent('beforeinput', {
					bubbles: true,
					cancelable: true,
					data: 'X',
					inputType: 'insertText'
				})
			);
			editor.dispatchEvent(
				new InputEvent('input', {
					bubbles: true,
					cancelable: false,
					data: 'X',
					inputType: 'insertText'
				})
			);
		});
		await page.waitForTimeout(80);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);

		const readonlyKeyResults = await page.evaluate((useMetaKey) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) {
				throw new Error('Missing editor root');
			}

			const backspace = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				key: 'Backspace'
			});
			editor.dispatchEvent(backspace);

			const bold = new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				ctrlKey: !useMetaKey,
				key: 'b',
				metaKey: useMetaKey
			});
			editor.dispatchEvent(bold);

			return {
				backspaceDefaultPrevented: backspace.defaultPrevented,
				boldDefaultPrevented: bold.defaultPrevented
			};
		}, process.platform === 'darwin');

		expect(readonlyKeyResults).toEqual({
			backspaceDefaultPrevented: true,
			boldDefaultPrevented: true
		});
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => child.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);

		await toggleReadonly.click();
		await expect(editor).toHaveAttribute('contenteditable', 'true');
		await expect(editor).toHaveAttribute('aria-readonly', 'false');
		await setSelectionByTextIndex(page, 1, 4);
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ marks?: Record<string, unknown>; text: string }> }>;
				}>(page, 'value');
				return value.children[1]?.content;
			})
			.toEqual([{ text: 'note!' }]);

		issues.assertClean();
	});

	test('inserts mention inline content through the browser typing path', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('@');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
				}>(page, 'value');
				return stripIds(value.children[0]?.content);
			})
			.toEqual([{ type: 'mention', data: {} }]);

		issues.assertClean();
	});

	test('keeps editable captions inside void blocks while leaving the figure body non-textual', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await page.locator('figure input').click();
		await page.locator('figure input').fill('caption updated');
		await setSelectionByTextIndex(page, 0, 7);
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('caption!');

		await expect(getTextLocators(page)).toHaveCount(2);
		issues.assertClean();
	});

	test('lets native controls inside void blocks own typing and structural keys', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 7);

		const control = page.locator('figure input');
		await control.click();
		await page.keyboard.type('abc');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Enter');
		await page.waitForTimeout(80);

		await expect(control).toBeFocused();
		await expect(control).toHaveValue('ab');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'image', text: 'caption' },
				{ type: 'paragraph', text: 'after image' }
			]);

		issues.assertClean();
	});

	test('lets native composition inside void controls stay outside the editor model', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 7);

		const control = page.locator('figure input');
		await control.click();
		await page.evaluate(() => {
			const control = document.querySelector<HTMLInputElement>('figure input');
			if (!control) {
				throw new Error('Missing figure input');
			}

			control.dispatchEvent(
				new CompositionEvent('compositionstart', {
					bubbles: true,
					cancelable: true,
					data: ''
				})
			);
			control.value = 'é';
			control.dispatchEvent(
				new InputEvent('input', {
					bubbles: true,
					cancelable: false,
					data: 'é',
					inputType: 'insertCompositionText'
				})
			);
		});
		await page.waitForTimeout(80);

		await expect(control).toBeFocused();
		await expect(control).toHaveValue('é');
		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: { isComposing: boolean } }).__EDYTOR__;
					return edytor?.isComposing ?? null;
				})
			)
			.toBe(false);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'image', text: 'caption' },
				{ type: 'paragraph', text: 'after image' }
			]);

		await control.blur();
		await setSelectionByTextIndex(page, 1, 5);
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B');
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'image', text: 'caption' },
				{ type: 'paragraph', text: 'after! image' }
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('lets native buttons inside void blocks own activation keys', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 7);

		const button = page.locator('figure button');
		await button.focus();
		await expect(button).toBeFocused();
		await page.keyboard.press('Enter');
		await page.keyboard.press('Space');
		await page.keyboard.press('Backspace');
		await page.waitForTimeout(80);

		await expect(button).toBeFocused();
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'image', text: 'caption' },
				{ type: 'paragraph', text: 'after image' }
			]);
		await expect
			.poll(async () => readJsonByTestId<Record<string, unknown>>(page, 'selection'))
			.toMatchObject({
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 7,
				yEnd: 7,
				isCollapsed: true
			});

		issues.assertClean();
	});

	test('does not delete stale text after clicking a non-native contenteditable=false island', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=callout');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const calloutIcon = page.locator('[data-edytor-type="callout"] span[contenteditable="false"]');
		await expect(calloutIcon).toHaveText('!');
		await calloutIcon.click();
		await page.keyboard.press('Backspace');
		await page.waitForTimeout(80);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ type: string; content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'callout', text: 'task' },
				{ type: 'paragraph', text: 'after callout' }
			]);

		issues.assertClean();
	});

	test('runs external control commands from the preserved model selection', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 1, 2);
		await page.evaluate(() => {
			const toolbarButton = document.createElement('button');
			toolbarButton.type = 'button';
			toolbarButton.dataset.testid = 'external-heading-command';
			toolbarButton.textContent = 'Heading 2';
			toolbarButton.addEventListener('click', () => {
				toolbarButton.dataset.activeBeforeCommand = String(
					document.activeElement === toolbarButton
				);
				const edytor = (
					window as Window & { __EDYTOR__?: { runCommand(id: string): Promise<boolean> } }
				).__EDYTOR__;
				void edytor?.runCommand('block.heading2').then((didRun) => {
					toolbarButton.dataset.didRun = String(didRun);
				});
			});
			document.querySelector('[data-testid="editor-shell"]')?.before(toolbarButton);
		});

		const commandButton = page.getByTestId('external-heading-command');
		await commandButton.focus();
		await commandButton.click();

		await expect(commandButton).toHaveAttribute('data-did-run', 'true');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						type: string;
						data?: Record<string, unknown>;
						content?: Array<{ text: string }>;
					}>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					level: child.data?.level,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ level: undefined, text: 'lead', type: 'paragraph' },
				{ level: 'h2', text: 'note', type: 'heading' },
				{ level: undefined, text: '', type: 'paragraph' }
			]);
		await expect
			.poll(async () => readJsonByTestId<Record<string, unknown>>(page, 'selection'))
			.toMatchObject({
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: 2,
				yEnd: 2,
				isCollapsed: true
			});

		issues.assertClean();
	});
});
