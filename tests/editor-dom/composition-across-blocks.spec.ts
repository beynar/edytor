import { expect, test, type Page } from './editorTest';
import {
	readJsonByTestId,
	setReverseSelectionByTextIndex,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * A composition over a text range across blocks (`Composition.start`): the
 * range is replaced at `compositionstart` and the IME writes at a parked
 * caret in one text, as over a block selection. Firefox's `insertText` is a
 * composition whose own delete across the blocks joins their elements and
 * removes the render's anchors between them before the change renders (the
 * DST's `dom-block-count` and `dom-text-projection` rows): a dead block's
 * element stayed in the host, or the host's text went missing. Chromium and
 * WebKit send a plain `insertText`, the same document. Expected
 * (hand-authored): the blocks the range spans merge around the text, the
 * DOM holds one element per block, the host is its cells' projection (the
 * fixture's truth check).
 */
const open = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?${new URLSearchParams({ scenario: 'dst', dst: JSON.stringify({ children }) })}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};
/** Each block's text, an atom as `@`. */
const readBlockTexts = async (page: Page) =>
	(
		await readJsonByTestId<{
			children: Array<{ content?: Array<{ text?: string; type?: string }> }>;
		}>(page, 'value')
	).children.map((block) => (block.content ?? []).map((part) => part.text ?? '@').join(''));
const blockCounts = (page: Page) =>
	page.evaluate(() => ({
		dom: document.querySelectorAll('[data-edytor] [data-edytor-block="true"]').length,
		model: (window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade.order().length
	}));

const two = [
	{ type: 'paragraph', content: [{ text: 'ab' }] },
	{ type: 'paragraph', content: [{ text: 'cd' }] }
];
const withAtom = [
	{ type: 'paragraph', content: [{ text: 'ab' }] },
	{ type: 'paragraph', content: [{ text: 'cd' }, { type: 'mention', data: {} }, { text: 'ef' }] }
];

const cases = [
	{ name: 'two lines', doc: two, range: [0, 1, 1, 1], reversed: false, texts: ['a漢d'] },
	{ name: 'two lines, backward', doc: two, range: [0, 1, 1, 1], reversed: true, texts: ['a漢d'] },
	{ name: 'over an atom', doc: withAtom, range: [0, 1, 2, 1], reversed: false, texts: ['a漢f'] },
	{
		name: 'before an atom',
		doc: withAtom,
		range: [0, 1, 1, 1],
		reversed: false,
		texts: ['a漢d@ef']
	}
] as const;

test.describe('composition over a range across blocks', () => {
	for (const { name, doc, range, reversed, texts } of cases) {
		test(`insertText: ${name}`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await open(page, [...doc]);
			const [si, so, ei, eo] = range;
			await (reversed ? setReverseSelectionByTextIndex : setSelectionByTextIndex)(
				page,
				si,
				so,
				ei,
				eo
			);
			await page.keyboard.insertText('漢');
			await expect.poll(() => readBlockTexts(page)).toEqual(texts);
			await expect.poll(() => blockCounts(page)).toEqual({ dom: 1, model: 1 });
			issues.assertClean();
		});
	}
});
