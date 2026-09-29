import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady,
	imageLinkField
} from './helpers';

const stripIds = <T>(value: T): T => {
	return JSON.parse(
		JSON.stringify(value, (key, current) => {
			return key === 'id' ? undefined : current;
		})
	) as T;
};

test.describe('browser plugin semantics', () => {
	test('extends link marks when typing inside the trailing anchor edge', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=links');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertText',
			data: '!'
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ marks?: Record<string, unknown>; text: string }> }>;
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
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('does not extend the link when the DOM caret sits after the anchor (F-P15, FP-8)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=links');
		await waitForEditorReady(page);
		// Same model offset as `Link|`, but the DOM point is the start of ` tail`.
		await page.evaluate(() => {
			const text = document.querySelector('[data-edytor-text]')!;
			const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node && node.textContent !== ' tail') node = walker.nextNode();
			const range = document.createRange();
			range.setStart(node!, 0);
			range.collapse(true);
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
		});
		await expectSelection(page, { startBlockPath: [0], yStart: 4, yEnd: 4, isCollapsed: true });
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ marks?: Record<string, unknown>; text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content;
			})
			.toEqual([
				{ text: 'Link', marks: { link: { href: 'https://example.com', target: '_blank' } } },
				{ text: '! tail' }
			]);

		issues.assertClean();
	});

	test('keeps image bodies non-editable while captions stay editable', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);

		const control = await imageLinkField(page);
		await control.click();
		await page.keyboard.type('abc');
		await expect(control).toHaveValue('abc');

		await setSelectionByTextIndex(page, 0, 'caption'.length);
		await page.keyboard.type('!');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }>; type: string }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([
				{ type: 'image', text: 'caption!' },
				{ type: 'paragraph', text: 'after image' }
			]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 'caption!'.length,
			yEnd: 'caption!'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('selects and deletes image void blocks from the non-editable body boundary', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await page.locator('figure button').click({ clickCount: 3 });

		await expectSelection(page, {
			selectedBlockPaths: [[0]]
		});

		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }>; type: string }>;
				}>(page, 'value');
				return value.children.map((child) => ({
					type: child.type,
					text: child.content?.map((part) => part.text).join('') ?? ''
				}));
			})
			.toEqual([{ type: 'paragraph', text: 'after image' }]);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			selectedBlockPaths: [],
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps code island merge guards isolated under real structural keys', async ({ page }) => {
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
				codeLines: value.children[0]?.children?.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				),
				afterText: value.children[1]?.content?.map((part) => part.text).join('') ?? ''
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

	test('moves selected blocks with arrow-move hotkeys and keeps the moved block selected', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const selectFirstBlock = () =>
			page.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				if (!edytor?.root?.children?.[0]) {
					throw new Error('Missing editor block for arrow-move test');
				}

				edytor.selection.selectBlocks(edytor.root.children[0]);
			});
		const readRootTexts = async () => {
			const value = await readJsonByTestId<{
				children: Array<{ content?: Array<{ text: string }>; type: string }>;
			}>(page, 'value');
			return stripIds(value.children).map((child) => ({
				type: child.type,
				text: child.content?.map((part) => part.text).join('') ?? ''
			}));
		};

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page, { requireRuntime: true });
		await selectFirstBlock();

		await page.keyboard.press(`${modKey}+ArrowDown`);
		await expect.poll(readRootTexts).toEqual([
			{ type: 'paragraph', text: 'note' },
			{ type: 'paragraph', text: 'lead' },
			{ type: 'paragraph', text: '' }
		]);
		await expectSelection(page, {
			selectedBlockPaths: [[1]]
		});

		await page.keyboard.press(`${modKey}+ArrowUp`);
		await expect.poll(readRootTexts).toEqual([
			{ type: 'paragraph', text: 'lead' },
			{ type: 'paragraph', text: 'note' },
			{ type: 'paragraph', text: '' }
		]);
		await expectSelection(page, {
			selectedBlockPaths: [[0]]
		});

		issues.assertClean();
	});
});
