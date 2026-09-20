import { expect, test } from './editorTest';
import type { Page } from './editorTest';

import { skipUnlessBrowser } from './browserExpectations';
import {
	dispatchClipboardEvent,
	dispatchPaste,
	expectSelection,
	modKey,
	moveEditorIntoShadowRoot,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const stripIds = <T>(value: T): T => {
	return JSON.parse(
		JSON.stringify(value, (key, current) => (key === 'id' ? undefined : current))
	) as T;
};

const readTopLevelInlineBlockCount = (page: Page, blockIndex: number) =>
	page.evaluate((index) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const block = edytor?.root?.children[index];
		const blockNode = block?.node as HTMLElement | undefined;
		if (!blockNode) {
			throw new Error(`Missing mounted block at index ${index}`);
		}

		return Array.from(blockNode.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')).filter(
			(element) => !element.parentElement?.closest('[data-edytor-inline-block]')
		).length;
	}, blockIndex);

test.describe('browser clipboard behavior', () => {
	// These specs validate editor clipboard semantics with deterministic ClipboardEvent payloads.
	// Native OS clipboard permissions are browser-specific, so the real clipboard smoke below is
	// intentionally narrow and browser-gated.
	test('round trips plain text through real Chromium clipboard shortcuts', async ({
		page,
		context,
		browserName
	}) => {
		skipUnlessBrowser(browserName, ['chromium'], {
			id: 'chromium-stable-native-clipboard-permissions',
			because: 'Playwright clipboard-read/write permissions are stable only in Chromium here'
		});
		const issues = trackPageIssues(page);

		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+C`);

		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('lead');

		await page.evaluate(() => navigator.clipboard.writeText('Native'));
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press(`${modKey}+V`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'Nativenote', '']);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('copies and pastes marked text through the internal fragment format', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);
		const copyResult = await dispatchClipboardEvent(page, 'copy');

		expect(copyResult.defaultPrevented).toBe(true);
		expect(copyResult.clipboardData['application/x-edytor-fragment']).toBeTruthy();
		expect(copyResult.clipboardData['text/html']).toContain('data-edytor-fragment');
		expect(copyResult.clipboardData['text/plain']).toBe('Alpha');

		await setSelectionByTextIndex(page, 1, 0);
		await dispatchPaste(page, {
			data: {
				...copyResult.clipboardData,
				'text/html': '<p>External</p>',
				'text/plain': 'Plain'
			}
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[1].content ?? []);
			})
			.toEqual([
				{ text: 'Alpha', marks: { bold: true } },
				{ text: 'Gamma', marks: { italic: true } },
				{ text: ' delta', marks: { underline: true } }
			]);

		issues.assertClean();
	});

	test('copies and pastes an internal fragment after ShadowRoot embedding', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await moveEditorIntoShadowRoot(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 5);

		const copyResult = await dispatchClipboardEvent(page, 'copy');
		expect(copyResult.defaultPrevented).toBe(true);
		expect(copyResult.clipboardData['application/x-edytor-fragment']).toBeTruthy();
		expect(copyResult.clipboardData['text/plain']).toBe('Alpha');

		await setSelectionByTextIndex(page, 1, 0);
		await dispatchPaste(page, { data: copyResult.clipboardData });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[1].content ?? []);
			})
			.toEqual([
				{ text: 'Alpha', marks: { bold: true } },
				{ text: 'Gamma', marks: { italic: true } },
				{ text: ' delta', marks: { underline: true } }
			]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('copies and pastes a nested selected block with regenerated ids', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested');
		await waitForEditorReady(page);
		const originalIds = await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[0];
			edytor.selection.selectBlocks(block);
			return [block.id, block.children[0].id];
		});
		const copyResult = await dispatchClipboardEvent(page, 'copy');
		await setSelectionByTextIndex(page, 3, 5);
		await dispatchPaste(page, { data: copyResult.clipboardData });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ id?: string; children?: Array<{ id?: string }> }>;
				}>(page, 'value');
				return value.children.length;
			})
			.toBe(3);

		const pastedIds = await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const pasted = edytor.root.children[2];
			return [pasted.id, pasted.children[0].id];
		});
		expect(originalIds).not.toContain(pastedIds[0]);
		expect(originalIds).not.toContain(pastedIds[1]);

		issues.assertClean();
	});

	test('cuts a selected block and undo/redo restores the clipboard mutation boundary', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(edytor.root.children[1]);
		});
		const cutResult = await dispatchClipboardEvent(page, 'cut');
		expect(cutResult.defaultPrevented).toBe(true);
		expect(cutResult.clipboardData['text/plain']).toBe('note');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'tail']);

		await page.keyboard.press(`${modKey}+Z`);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'note', 'tail']);

		await page.keyboard.press(`${modKey}+Shift+Z`);
		await page.keyboard.up('Shift');
		await page.keyboard.up(modKey);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['', 'tail']);

		issues.assertClean();
	});

	test('malformed internal html payload falls through to external html paste', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<span data-edytor-fragment="bad"></span><p><strong>Fallback</strong></p>',
			text: 'Plain'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[0].content ?? []);
			})
			.toEqual([{ text: 'Fallback', marks: { bold: true } }]);

		issues.assertClean();
	});

	test('pastes internal content over a selected block as one replacement block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 2);
		const copyResult = await dispatchClipboardEvent(page, 'copy');
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(edytor.root.children[1]);
		});
		await dispatchPaste(page, { data: copyResult.clipboardData });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map((block) => block.content?.[0]?.text ?? '');
			})
			.toEqual(['lead', 'le', '']);

		issues.assertClean();
	});

	test('plain paste into an editable void caption does not target the void body', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=void');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 7);
		await dispatchPaste(page, { text: ' text' });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0].content?.[0]?.text;
			})
			.toBe('caption text');

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 12,
			yEnd: 12,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('keeps inline mentions rendered after paste before and after the mention', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.type('@');
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);

				return stripIds(value.children[0].content ?? []);
			})
			.toEqual([{ type: 'mention', data: {} }]);

		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Shift+Enter');
		await dispatchPaste(page, { text: 'X' });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				const renderedInlineCount = await readTopLevelInlineBlockCount(page, 0);

				return {
					content: stripIds(value.children[0].content ?? []),
					renderedInlineCount
				};
			})
			.toEqual({
				content: [{ text: '\nX' }, { type: 'mention', data: {} }],
				renderedInlineCount: 1
			});

		await setSelectionByTextIndex(page, 1, 0);
		await dispatchPaste(page, { text: 'Y' });

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				const renderedInlineCount = await readTopLevelInlineBlockCount(page, 0);

				return {
					content: stripIds(value.children[0].content ?? []),
					renderedInlineCount
				};
			})
			.toEqual({
				content: [{ text: '\nX' }, { type: 'mention', data: {} }, { text: 'Y' }],
				renderedInlineCount: 1
			});

		issues.assertClean();
	});
});
