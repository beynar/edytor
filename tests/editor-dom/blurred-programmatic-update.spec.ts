import { expect, test, type Page } from './editorTest';

import {
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const readNativeFocusState = (page: Page) =>
	page.evaluate(() => {
		const editor = document.querySelector('[data-edytor]');
		const selection = window.getSelection();
		const anchorInsideEditor = Boolean(
			selection?.anchorNode && editor?.contains(selection.anchorNode)
		);
		const focusInsideEditor = Boolean(
			selection?.focusNode && editor?.contains(selection.focusNode)
		);
		const activeElement = document.activeElement;

		return {
			activeTestId:
				activeElement instanceof HTMLElement ? (activeElement.dataset.testid ?? null) : null,
			selectionInsideEditor: anchorInsideEditor || focusInsideEditor
		};
	});

test.describe('blurred editor programmatic update behavior', () => {
	test('keeps remote text changes from stealing focus and restores cached caret on refocus', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		await page.evaluate(() => {
			const button = document.createElement('button');
			button.dataset.testid = 'outside-focus-target';
			button.textContent = 'outside';
			document.body.append(button);
			button.focus();
		});

		await expect(page.getByTestId('outside-focus-target')).toBeFocused();
		await expect
			.poll(() => readNativeFocusState(page))
			.toEqual({
				activeTestId: 'outside-focus-target',
				selectionInsideEditor: false
			});

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const text = edytor?.root?.children?.[0]?.firstText;
			if (!edytor || !text) {
				throw new Error('Missing Edytor runtime or first text');
			}

			edytor.doc.transact(() => {
				text.insertAt(text.length, '!');
			}, 'remote-programmatic-update');
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				const nativeState = await readNativeFocusState(page);
				const selection = await readJsonByTestId<{
					startBlockPath: number[] | null;
					yStart: number;
					yEnd: number;
					isCollapsed: boolean;
				}>(page, 'selection');

				return {
					activeTestId: nativeState.activeTestId,
					selectionInsideEditor: nativeState.selectionInsideEditor,
					texts: value.children.map((child) => child.content?.[0]?.text ?? ''),
					editorSelection: selection
				};
			})
			.toMatchObject({
				activeTestId: 'outside-focus-target',
				selectionInsideEditor: false,
				texts: ['lead!', 'note', ''],
				editorSelection: {
					startBlockPath: [0],
					yStart: 2,
					yEnd: 2,
					isCollapsed: true
				}
			});

		await page.evaluate(async () => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const text = edytor?.selection?.state?.startText;
			const offset = edytor?.selection?.state?.yStart;
			if (!edytor || !text || typeof offset !== 'number') {
				throw new Error('Missing cached editor selection');
			}

			edytor.node.focus();
			await edytor.selection.setAtTextOffset(text, offset);
		});
		await page.keyboard.type('X');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('leXad!');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
