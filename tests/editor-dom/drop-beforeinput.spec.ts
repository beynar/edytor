import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	getCaretPoint,
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

const readBlockTexts = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string; marks?: unknown }> }>;
	}>(page, 'value');
	return value.children.map((child) => child.content?.map((part) => part.text).join('') ?? '');
};

const readBlockContent = async (page: Page, blockIndex: number) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string; marks?: unknown }> }>;
	}>(page, 'value');
	return value.children[blockIndex]?.content ?? [];
};

type EditorDropPayload = {
	data?: Record<string, string>;
	files?: Array<{ name: string; type: string }>;
	point?: { x: number; y: number };
	// Simulate an editor-owned drag: a dragstart sourced inside the editor
	// marks the payload as internal (drag-move is not supported).
	internalDrag?: boolean;
};

const dispatchEditorDrop = async (page: Page, payload: EditorDropPayload) =>
	page.evaluate((drop) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) {
			throw new Error('Missing editor root');
		}

		const entries = drop.data ?? {};
		const files = drop.files ?? [];

		let dataTransfer: DataTransfer | null = null;
		if (typeof DataTransfer === 'function') {
			try {
				dataTransfer = new DataTransfer();
				for (const [type, value] of Object.entries(entries)) {
					dataTransfer.setData(type, value);
				}
				for (const file of files) {
					dataTransfer.items.add(new File(['file'], file.name, { type: file.type }));
				}
			} catch {
				dataTransfer = null;
			}
		}
		if (!dataTransfer) {
			dataTransfer = {
				types: [...Object.keys(entries), ...(files.length ? ['Files'] : [])],
				files: files.map((file) => new File(['file'], file.name, { type: file.type })),
				getData: (type: string) => entries[type] ?? '',
				setData: () => false,
				dropEffect: 'none',
				effectAllowed: 'all'
			} as unknown as DataTransfer;
		}

		const sourceText = editor.querySelector<HTMLElement>('[data-edytor-text="true"]');
		if (drop.internalDrag && sourceText) {
			sourceText.dispatchEvent(
				new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer })
			);
		}

		const createDropEvent = (type: 'dragover' | 'drop') => {
			let event: DragEvent | null = null;
			if (typeof DragEvent === 'function') {
				try {
					event = new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						dataTransfer,
						clientX: drop.point?.x ?? 0,
						clientY: drop.point?.y ?? 0
					});
				} catch {
					event = null;
				}
			}
			if (!event || event.dataTransfer !== dataTransfer) {
				event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
				Object.defineProperties(event, {
					dataTransfer: { value: dataTransfer, configurable: true },
					clientX: { value: drop.point?.x ?? 0, configurable: true },
					clientY: { value: drop.point?.y ?? 0, configurable: true }
				});
			}
			return event;
		};

		const dragover = createDropEvent('dragover');
		const dropEvent = createDropEvent('drop');
		editor.dispatchEvent(dragover);
		editor.dispatchEvent(dropEvent);
		if (drop.internalDrag && sourceText) {
			sourceText.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
		}

		return {
			dragoverPrevented: dragover.defaultPrevented,
			dropPrevented: dropEvent.defaultPrevented
		};
	}, payload);

test.describe('browser drop behavior', () => {
	test('inserts a foreign text/plain drop at the resolved drop point', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			data: { 'text/plain': 'DROP' },
			point
		});

		expect(result).toEqual({ dragoverPrevented: true, dropPrevented: true });
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'noDROPte', '']);

		issues.assertClean();
	});

	test('routes a foreign text/html drop through the html paste pipeline', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			data: {
				'text/html': '<p><strong>Bold</strong></p>',
				'text/plain': 'Bold'
			},
			point
		});

		expect(result).toEqual({ dragoverPrevented: true, dropPrevented: true });
		await expect
			.poll(() => readBlockContent(page, 1))
			.toEqual([{ text: 'no' }, { text: 'Bold', marks: { bold: true } }, { text: 'te' }]);

		issues.assertClean();
	});

	test('accepts a text/uri-list drop as a link, stripping comment lines', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 0);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			data: {
				'text/uri-list': '# dragged link\nhttps://example.com/\nhttps://ignored-second.example/'
			},
			point
		});

		expect(result).toEqual({ dragoverPrevented: true, dropPrevented: true });
		await expect
			.poll(() => readBlockContent(page, 1))
			.toEqual([
				{ text: 'no' },
				{
					text: 'https://example.com/',
					marks: { link: { href: 'https://example.com/' } }
				},
				{ text: 'te' }
			]);

		issues.assertClean();
	});

	test('routes dropped files to paste plugins and inserts nothing when unclaimed', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			files: [{ name: 'dropped.png', type: 'image/png' }],
			point
		});

		expect(result).toEqual({ dragoverPrevented: true, dropPrevented: true });
		// No bundled plugin claims Files yet — the payload must not degrade into
		// silent file-name text.
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('lets a plugin claim dropped files through the paste hook', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.plugins.push({
				onPaste: ({ prevent, e }: { prevent: (cb?: () => void) => void; e: ClipboardEvent }) => {
					const files = e.clipboardData?.files;
					if (files?.length) {
						prevent(() => {
							(window as any).__DROPPED_FILE__ = files[0]?.name;
						});
					}
				}
			});
		});

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			files: [{ name: 'claimed.png', type: 'image/png' }],
			point
		});

		expect(result).toEqual({ dragoverPrevented: true, dropPrevented: true });
		await expect
			.poll(() => page.evaluate(() => (window as any).__DROPPED_FILE__ ?? null))
			.toBe('claimed.png');
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('keeps internal drag-move prevented — a drop inside the editor copies nothing', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			internalDrag: true,
			data: { 'text/plain': 'lead' },
			point
		});

		// Internal drags never enable the drop — dragover stays unprevented and
		// the drop event is swallowed without inserting a copy.
		expect(result).toEqual({ dragoverPrevented: false, dropPrevented: true });
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('keeps block-handle drags prevented at the root', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			data: {
				'application/x-edytor-block-id': 'block-1',
				'text/plain': 'lead'
			},
			point
		});

		expect(result).toEqual({ dragoverPrevented: false, dropPrevented: true });
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('does not enable drops for unsupported payloads', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const point = await getCaretPoint(page, 1, 2);
		const result = await dispatchEditorDrop(page, {
			data: { 'application/x-unsupported-payload': 'value' },
			point
		});

		// dragover is only prevented where a drop is accepted — the unsupported
		// payload keeps the not-allowed cursor; a synthesized drop is still
		// swallowed so nothing can mutate the DOM natively.
		expect(result).toEqual({ dragoverPrevented: false, dropPrevented: true });
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		issues.assertClean();
	});

	test('inserts insertFromDrop beforeinput payloads at the current selection', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertFromDrop',
			data: 'DROP',
			text: 'DROP'
		});

		expect(prevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['leDROPad', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('inserts insertFromDrop beforeinput payloads at the reported target range', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertFromDrop',
			data: 'DROP',
			text: 'DROP',
			targetRange: { startIndex: 1, startOffset: 2 }
		});

		expect(prevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'noDROPte', '']);

		issues.assertClean();
	});

	test('keeps a payload-less insertFromDrop a prevented no-op', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, { inputType: 'insertFromDrop' });

		expect(prevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['lead', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('routes insertFromPasteAsQuotation through the paste path', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
		await setSelectionByTextIndex(page, 0, 2);

		const prevented = await dispatchBeforeInput(page, {
			inputType: 'insertFromPasteAsQuotation',
			data: 'QUOTE',
			text: 'QUOTE'
		});

		expect(prevented).toBe(true);
		await expect.poll(() => readBlockTexts(page)).toEqual(['leQUOTEad', 'note', '']);

		issues.assertClean();
	});
});
