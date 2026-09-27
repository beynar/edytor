import { expect, test } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

// Commands the editor intentionally prevents without routing into the
// model. `insertOrderedList`/`insertUnorderedList`/`insertHorizontalRule`/
// `insertLink`/`formatFontColor`/`formatBackColor` were promoted to routed
// commands — see format-beforeinput.spec.ts.
const unsupportedNativeCommands = [
	'indent',
	'outdent',
	'formatBlock',
	'formatJustifyCenter',
	'formatForeColor',
	'formatFontName',
	'formatSetBlockTextDirection',
	'formatSetInlineTextDirection'
] as const;

const getUnsupportedCommandData = (inputType: (typeof unsupportedNativeCommands)[number]) => {
	if (inputType === 'formatBlock') {
		return 'h1';
	}
	if (
		inputType === 'formatForeColor' ||
		inputType === 'formatBackColor' ||
		inputType === 'formatFontColor'
	) {
		return 'rgb(255, 0, 0)';
	}
	if (inputType === 'formatFontName') {
		return 'serif';
	}
	if (inputType === 'insertLink') {
		return 'https://example.com';
	}
	if (inputType === 'formatSetBlockTextDirection' || inputType === 'formatSetInlineTextDirection') {
		return 'rtl';
	}
	return undefined;
};

const readDocumentShape = async (page: Parameters<typeof readJsonByTestId>[0]) => {
	const value = await readJsonByTestId<{
		children: Array<{ type: string; content?: Array<{ text: string }> }>;
	}>(page, 'value');

	return value.children.map((block) => ({
		type: block.type,
		text: block.content?.map((part) => part.text).join('') ?? ''
	}));
};

const readEditorDomShape = async (page: Parameters<typeof readJsonByTestId>[0]) =>
	page.evaluate(() => ({
		blockTexts: Array.from(document.querySelectorAll('[data-edytor-block="true"]')).map(
			(block) => block.textContent?.replaceAll('\u200B', '') ?? ''
		),
		nativeStructuralNodes: document.querySelectorAll(
			'[data-edytor] ol, [data-edytor] ul, [data-edytor] li, [data-edytor] h1, [data-edytor] h2, [data-edytor] h3, [data-edytor] blockquote'
		).length,
		nativeStyleNodes: document.querySelectorAll(
			'[data-edytor] font, [data-edytor] span[style*="color"], [data-edytor] span[style*="font-family"]'
		).length,
		nativeLinkNodes: document.querySelectorAll('[data-edytor] a[href]').length,
		nativeHorizontalRuleNodes: document.querySelectorAll('[data-edytor] hr').length,
		nativeDirectionNodes: document.querySelectorAll('[data-edytor] [dir]').length
	}));

test.describe('unsupported native beforeinput commands', () => {
	for (const inputType of unsupportedNativeCommands) {
		test(`prevents collapsed ${inputType} without changing the model or DOM`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
			await setSelectionByTextIndex(page, 0, 2);

			const prevented = await dispatchBeforeInput(page, {
				inputType,
				data: getUnsupportedCommandData(inputType)
			});
			expect(prevented).toBe(true);

			await expect
				.poll(() => readDocumentShape(page))
				.toEqual([
					{ type: 'paragraph', text: 'lead' },
					{ type: 'paragraph', text: 'note' },
					{ type: 'paragraph', text: '' }
				]);
			await expect
				.poll(() => readEditorDomShape(page))
				.toEqual({
					blockTexts: ['lead ', 'note ', ' '],
					nativeStructuralNodes: 0,
					nativeStyleNodes: 0,
					nativeLinkNodes: 0,
					nativeHorizontalRuleNodes: 0,
					nativeDirectionNodes: 0
				});
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 2,
				yEnd: 2,
				isCollapsed: true
			});

			issues.assertClean();
		});
	}

	for (const inputType of unsupportedNativeCommands) {
		test(`prevents ranged ${inputType} without changing the model or DOM`, async ({ page }) => {
			const issues = trackPageIssues(page);

			await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=last');
			await setSelectionByTextIndex(page, 0, 1, 1, 2);

			const prevented = await dispatchBeforeInput(page, {
				inputType,
				data: getUnsupportedCommandData(inputType)
			});
			expect(prevented).toBe(true);

			await expect
				.poll(() => readDocumentShape(page))
				.toEqual([
					{ type: 'paragraph', text: 'lead' },
					{ type: 'paragraph', text: 'note' },
					{ type: 'paragraph', text: '' }
				]);
			await expect
				.poll(() => readEditorDomShape(page))
				.toEqual({
					blockTexts: ['lead ', 'note ', ' '],
					nativeStructuralNodes: 0,
					nativeStyleNodes: 0,
					nativeLinkNodes: 0,
					nativeHorizontalRuleNodes: 0,
					nativeDirectionNodes: 0
				});
			await expectSelection(page, {
				startBlockPath: [0],
				endBlockPath: [1],
				yStart: 1,
				yEnd: 2,
				isCollapsed: false
			});

			issues.assertClean();
		});
	}
});
