import { expect, test } from './editorTest';
import type { Page } from './editorTest';

import { skipUnlessBrowser } from './browserExpectations';
import {
	dispatchClipboardEvent,
	dispatchComposition,
	dispatchPaste,
	expectSelection,
	modKey,
	moveEditorIntoShadowRoot,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady,
	dispatchPasteAtCaret
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
		// The readable HTML flavour: the mark's export form from its record (S6).
		expect(copyResult.clipboardData['text/html']).toContain('<p><strong>Alpha</strong></p>');
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

	// D-24 G-a: the HTML import plugin is retired, so external HTML falls back to text/plain.
	test('malformed internal html payload falls through to plain text', async ({ page }) => {
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
			.toEqual([{ text: 'Plain' }]);

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

		// The model value reaches `[{mention}]` before the DOM re-renders
		// the leading+trailing separator texts around the inline atom.
		// `setSelectionByTextIndex` indexes DOM text elements, so placing
		// the caret before the separators exist can land it AFTER the
		// mention (observed on slower-rendering engines).
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					const blockNode = edytor?.root?.children[0]?.node as HTMLElement | undefined;
					return blockNode?.querySelectorAll('[data-edytor-text="true"]').length ?? 0;
				})
			)
			.toBeGreaterThanOrEqual(2);

		// Seed the leading separator with a line break via the model —
		// a native Shift+Enter depends on a caret that resolves through
		// ZWSP placeholder spans and lands in the wrong separator under
		// load (observed on Gecko/WebKit). The test's contract is where
		// the paste lands, not break insertion.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const leading = edytor.root.children[0].content[0];
			edytor.transact(() => leading.insertAt(0, '\n'));
		});
		// Pin the model caret and paste in one synchronous task: the paste
		// pipeline reads `selection.state`, and a queued selectionchange
		// can revert the model caret to the browser's last native position
		// between a selection wait and the dispatch (Gecko/WebKit relocate
		// a caret at the end of a '\n' text into the next text's ZWSP —
		// across the mention).
		await dispatchPasteAtCaret(page, { blockIndex: 0, contentIndex: 0, yStart: 1, text: 'X' });

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

		await dispatchPasteAtCaret(page, { blockIndex: 0, contentIndex: 2, yStart: 0, text: 'Y' });

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

test.describe('browser paste payload coverage', () => {
	// `dispatchPaste` only models text/html + text/plain; this dispatch also
	// carries Files and text/uri-list and reports defaultPrevented.
	const dispatchRichPaste = async (
		page: Page,
		payload: {
			text?: string;
			html?: string;
			uriList?: string;
			files?: Array<{ name: string; type: string }>;
		}
	) =>
		page.evaluate((paste) => {
			const target = document.querySelector<HTMLElement>('[data-edytor]');
			if (!target) {
				throw new Error('Missing [data-edytor] root');
			}

			const files = (paste.files ?? []).map(
				(file) => new File(['file'], file.name, { type: file.type })
			);
			const event = new Event('paste', {
				bubbles: true,
				cancelable: true
			}) as ClipboardEvent;

			Object.defineProperty(event, 'clipboardData', {
				value: {
					files,
					getData: (type: string) => {
						if (type === 'text/plain') return paste.text ?? '';
						if (type === 'text/html') return paste.html ?? '';
						if (type === 'text/uri-list') return paste.uriList ?? '';
						return '';
					}
				} satisfies Pick<DataTransfer, 'files' | 'getData'>,
				configurable: true
			});

			target.dispatchEvent(event);
			return event.defaultPrevented;
		}, payload);

	const readBlockTexts = async (page: Page) => {
		const value = await readJsonByTestId<{
			children: Array<{ content?: Array<{ text: string; marks?: unknown }> }>;
		}>(page, 'value');
		return value.children.map((child) => child.content?.map((part) => part.text).join('') ?? '');
	};

	test('routes clipboard files to paste plugins — unclaimed files insert nothing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const prevented = await dispatchRichPaste(page, {
			files: [{ name: 'pasted.png', type: 'image/png' }]
		});

		expect(prevented).toBe(true);
		// No bundled plugin claims Files yet — the payload must not degrade into
		// silent file-name text.
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);

		issues.assertClean();
	});

	test('lets a plugin claim clipboard files through the paste hook', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.plugins.push({
				onPaste: ({ prevent, e }: { prevent: (cb?: () => void) => void; e: ClipboardEvent }) => {
					const files = e.clipboardData?.files;
					if (files?.length) {
						prevent(() => {
							(window as any).__PASTED_FILE__ = files[0]?.name;
						});
					}
				}
			});
		});

		const prevented = await dispatchRichPaste(page, {
			files: [{ name: 'claimed.png', type: 'image/png' }]
		});

		expect(prevented).toBe(true);
		await expect
			.poll(() => page.evaluate(() => (window as any).__PASTED_FILE__ ?? null))
			.toBe('claimed.png');
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);

		issues.assertClean();
	});

	test('pastes text/uri-list as a link, stripping comment lines', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		const prevented = await dispatchRichPaste(page, {
			uriList: '# clipboard comment\nhttps://example.com/'
		});

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: unknown }> }>;
				}>(page, 'value');
				return value.children[0]?.content ?? [];
			})
			.toEqual([
				{
					text: 'https://example.com/',
					marks: { link: { href: 'https://example.com/' } }
				}
			]);

		issues.assertClean();
	});

	test('prefers plain text over html on shift-paste', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await page.keyboard.down('Shift');
		const prevented = await dispatchRichPaste(page, {
			html: '<p><strong>Bold</strong></p>',
			text: 'Plain'
		});
		await page.keyboard.up('Shift');

		expect(prevented).toBe(true);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string; marks?: unknown }> }>;
				}>(page, 'value');
				return value.children[0]?.content ?? [];
			})
			.toEqual([{ text: 'Plain' }]);

		issues.assertClean();
	});

	test('defers to the native paste while a composition is in progress', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'ん' }
		]);
		const midCompositionTexts = await readBlockTexts(page);

		const prevented = await dispatchRichPaste(page, { text: 'PASTED' });

		// PM semantics (input.ts:656-660): mid-composition paste is left to the
		// browser — the composition preview owns the write path and the
		// deferred observer reconciles after compositionend.
		expect(prevented).toBe(false);
		await expect.poll(() => readBlockTexts(page)).toEqual(midCompositionTexts);

		await dispatchComposition(page, [{ type: 'compositionend', data: 'ん' }]);

		issues.assertClean();
	});
});
