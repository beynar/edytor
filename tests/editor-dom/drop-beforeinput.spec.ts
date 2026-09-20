import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

const dispatchRootDropEvents = async (page: Page, text: string) =>
	page.evaluate((dropText) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing editor root');
		}

		const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
		dataTransfer?.setData('text/plain', dropText);

		const createDropEvent = (type: 'dragover' | 'drop') => {
			if (typeof DragEvent === 'function') {
				try {
					return new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						dataTransfer
					});
				} catch {
					// Firefox-like constructor implementations may reject synthetic dataTransfer.
				}
			}

			const event = new Event(type, {
				bubbles: true,
				cancelable: true
			}) as DragEvent;
			Object.defineProperty(event, 'dataTransfer', {
				value: dataTransfer,
				configurable: true
			});
			return event;
		};

		const dragover = createDropEvent('dragover');
		const drop = createDropEvent('drop');
		editor.dispatchEvent(dragover);
		editor.dispatchEvent(drop);

		return {
			dragoverPrevented: dragover.defaultPrevented,
			dropPrevented: drop.defaultPrevented
		};
	}, text);

test.describe('browser drop behavior', () => {
	test('prevents unsupported insertFromDrop without mutating the editor model', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertFromDrop',
			data: 'DROP',
			text: 'DROP'
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
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('prevents unsupported root dragover and drop events without native insertion', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const result = await dispatchRootDropEvents(page, 'DROP');

		expect(result).toEqual({
			dragoverPrevented: true,
			dropPrevented: true
		});
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
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
