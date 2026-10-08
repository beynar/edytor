/** @jsxImportSource ../../jsx */
/**
 * Pasting a link over selected text links the text (Notion): when the
 * selection is a text range where the toolbar offers a link (not in a code
 * block or a void) and the pasted plain text is one URL (`http:`, `https:`
 * or `mailto:`, surrounding whitespace ignored), the paste writes the
 * `link` mark with that URL over the selected text instead of replacing it,
 * as one undo step, and the range stays selected. Anything else pastes as
 * before: text that is not one URL, a script URL, a caret, a code block.
 *
 * Expected states are hand-authored from Notion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchClipboardPaste,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const URL = 'https://edytor.dev/docs';

const render = async (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, codePlugin], value: { children } }
	);

const p = (id: string, text: string): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

const content = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.value.content;

/** Select `from`–`to` in `a`'s text (to `b`'s at `to` when given), then paste `data`. */
const pasteOver = async (
	view: Awaited<ReturnType<typeof render>>,
	a: string,
	from: number,
	to: number,
	data: Record<string, string>,
	b = a
) => {
	const { edytor, editor } = view;
	const text = (id: string) => edytor.idToBlock.get(id)!.firstText;
	await setNativeSelection(edytor, text(a), from, text(b), to);
	await dispatchClipboardPaste(editor, data);
	await flushDomUpdates();
};

describe('pasting a URL over selected text links it (Notion)', () => {
	it('the selected words become a link to the URL; the range stays selected', async () => {
		const view = await render([p('a', 'Read the docs now')]);
		await pasteOver(view, 'a', 9, 13, { 'text/plain': URL });
		expect(content(view.edytor, 'a')).toEqual([
			{ text: 'Read the ' },
			{ text: 'docs', marks: { link: { href: URL } } },
			{ text: ' now' }
		]);
		const { state } = view.edytor.selection;
		expect([state.isCollapsed, state.yStart, state.yEnd]).toEqual([false, 9, 13]);
	});

	it('one undo step gives the plain text back', async () => {
		const view = await render([p('a', 'Read the docs now')]);
		await pasteOver(view, 'a', 9, 13, { 'text/plain': URL });
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(content(view.edytor, 'a')).toEqual([{ text: 'Read the docs now' }]);
	});

	it('whitespace around the URL is ignored; a page link copied with its HTML links too', async () => {
		const view = await render([p('a', 'Read the docs now')]);
		await pasteOver(view, 'a', 0, 4, {
			'text/plain': `  ${URL}\n`,
			'text/html': `<a href="${URL}">${URL}</a>`
		});
		expect(content(view.edytor, 'a')).toEqual([
			{ text: 'Read', marks: { link: { href: URL } } },
			{ text: ' the docs now' }
		]);
	});

	it('mailto: links too', async () => {
		const view = await render([p('a', 'write to us')]);
		await pasteOver(view, 'a', 9, 11, { 'text/plain': 'mailto:hi@edytor.dev' });
		expect(content(view.edytor, 'a')).toEqual([
			{ text: 'write to ' },
			{ text: 'us', marks: { link: { href: 'mailto:hi@edytor.dev' } } }
		]);
	});

	it('a range across two blocks links the selected text of each', async () => {
		const view = await render([p('a', 'first line'), p('b', 'second line')]);
		await pasteOver(view, 'a', 6, 6, { 'text/plain': URL }, 'b');
		expect(content(view.edytor, 'a')).toEqual([
			{ text: 'first ' },
			{ text: 'line', marks: { link: { href: URL } } }
		]);
		expect(content(view.edytor, 'b')).toEqual([
			{ text: 'second', marks: { link: { href: URL } } },
			{ text: ' line' }
		]);
	});

	it('replaces the selection as before: text that is not one URL', async () => {
		for (const pasted of ['hello', `${URL} and more`, 'edytor.dev']) {
			const view = await render([p('a', 'Read the docs now')]);
			await pasteOver(view, 'a', 9, 13, { 'text/plain': pasted });
			expect(content(view.edytor, 'a')).toEqual([{ text: `Read the ${pasted} now` }]);
			document.body.innerHTML = '';
		}
	});

	it('replaces the selection as before: a script URL never becomes a link', async () => {
		const view = await render([p('a', 'Read the docs now')]);
		await pasteOver(view, 'a', 9, 13, { 'text/plain': 'javascript:alert(1)' });
		expect(content(view.edytor, 'a')).toEqual([{ text: 'Read the javascript:alert(1) now' }]);
	});

	it('inserts as before at a caret', async () => {
		const view = await render([p('a', 'Read now')]);
		await pasteOver(view, 'a', 5, 5, { 'text/plain': URL });
		const text = (content(view.edytor, 'a') ?? []).map((part) => ('text' in part ? part.text : ''));
		expect(text.join('')).toBe(`Read ${URL}now`);
	});

	it('replaces as before in a code block (no link there)', async () => {
		const view = await render([
			{
				id: 'c',
				type: 'code',
				children: [{ id: 'l', type: 'codeLine', content: [{ text: 'let a' }] }]
			}
		]);
		await pasteOver(view, 'l', 4, 5, { 'text/plain': URL });
		expect(content(view.edytor, 'l')).toEqual([{ text: `let ${URL}` }]);
	});
});
