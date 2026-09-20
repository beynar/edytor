import { expect, test } from './editorTest';

import {
	dispatchPaste,
	expectSelection,
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

test.describe('browser html paste behavior', () => {
	test('prefers text/html over text/plain and maps <strong> to bold marks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<p><strong>Bold</strong></p>',
			text: 'Plain'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children);
			})
			.toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Bold', marks: { bold: true } }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'tail' }]
				}
			]);

		issues.assertClean();
	});

	test('maps pasted inline code to the code mark', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<p><code>const x = 1;</code></p>'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[0]);
			})
			.toEqual({
				type: 'paragraph',
				data: {},
				content: [{ text: 'const x = 1;', marks: { code: true } }]
			});

		issues.assertClean();
	});

	test('maps common semantic html aliases to registered rich text marks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<p><b>Bold</b><i>Italic</i><sup>Sup</sup><sub>Sub</sub><mark>Mark</mark></p>'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[0]);
			})
			.toEqual({
				type: 'paragraph',
				data: {},
				content: [
					{ text: 'Bold', marks: { bold: true } },
					{ text: 'Italic', marks: { italic: true } },
					{ text: 'Sup', marks: { superscript: true } },
					{ text: 'Sub', marks: { subscript: true } },
					{ text: 'Mark', marks: { highlight: 'yellow' } }
				]
			});

		issues.assertClean();
	});

	test('pastes multiple html paragraphs into the current block structure', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 2);
		await dispatchPaste(page, {
			html: '<p>Alpha</p><p>Beta</p>'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children.map(
					(child) => child.content?.map((part) => part.text).join('') ?? ''
				);
			})
			.toEqual(['leAlpha', 'Betaad', 'note', '']);

		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves the first pasted block type when the target block is empty', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<blockquote>Quoted</blockquote>'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children[0]);
			})
			.toEqual({
				type: 'quote',
				data: {},
				content: [{ text: 'Quoted' }]
			});

		issues.assertClean();
	});

	test('maps html lists to editable list item blocks', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '<ul><li>Bullet</li></ul><ol><li>Number</li></ol>'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children.slice(0, 2));
			})
			.toEqual([
				{
					type: 'bulleted-list-item',
					data: {},
					content: [{ text: 'Bullet' }]
				},
				{
					type: 'numbered-list-item',
					data: {},
					content: [{ text: 'Number' }]
				}
			]);

		issues.assertClean();
	});

	test('falls back to plain text when html is missing or empty', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0);
		await dispatchPaste(page, {
			html: '',
			text: 'Plain text'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{ content?: Array<{ text: string }> }>;
				}>(page, 'value');
				return value.children[0]?.content?.[0]?.text;
			})
			.toBe('Plain text');

		issues.assertClean();
	});

	test('degrades malformed html without throwing and preserves the expected caret target', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 1, 1, 2);
		await dispatchPaste(page, {
			html: '<p><strong>oops<p>tail',
			text: 'fallback'
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{ children: Array<{ content?: Array<unknown> }> }>(
					page,
					'value'
				);
				return stripIds(value.children.map((child) => child.content ?? []));
			})
			.toEqual([[{ text: 'l' }, { text: 'oops', marks: { bold: true } }, { text: 'te' }], []]);

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
