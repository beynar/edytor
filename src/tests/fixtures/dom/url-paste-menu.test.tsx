/** @jsxImportSource ../../jsx */
/**
 * Pasting a bare URL on an empty line offers "Link / Embed /
 * Bookmark" (Notion). The paste writes the URL as a link at once (one
 * undo step) and opens a small menu under the line: "Link" keeps it (the
 * highlighted row: Enter right after a paste never converts), "Embed"
 * turns the line into an embed of the URL when a provider plays it,
 * "Bookmark" into a bookmark (then unfurled). A conversion is one more
 * undo step, which gives the linked URL back. Anything else closes the
 * menu and keeps the link: Escape, a press outside, typing, a move.
 *
 * Elsewhere the paste is unchanged: a line holding text, a Shift+paste,
 * text that is not one http(s) URL, or a view with neither plugin.
 * Expected states are hand-authored from Notion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createEmbedPlugin, embedPlugin } from '$lib/plugins/media/EmbedPlugin.svelte';
import { bookmarkPlugin, createBookmarkPlugin } from '$lib/plugins/media/BookmarkPlugin.svelte';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PAGE = 'https://edytor.dev/docs';

const render = async (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], value: { children } }
	);

const empty = (id = 'p'): JSONBlock => ({ id, type: 'paragraph', content: [] });

/** Put the caret at `offset` in `id`'s text and paste `data`. */
const pasteAt = async (
	view: Awaited<ReturnType<typeof render>>,
	id: string,
	offset: number,
	data: Record<string, string>
) => {
	await setNativeSelection(view.edytor, view.edytor.idToBlock.get(id)!.firstText, offset);
	await dispatchClipboardPaste(view.editor, data);
	await flushDomUpdates();
};

const menu = () => document.querySelector('[data-edytor-url-paste-menu]');
const options = () =>
	[...document.querySelectorAll<HTMLElement>('[data-edytor-url-paste-option]')].map((o) => [
		o.dataset.edytorUrlPasteOption,
		o.getAttribute('aria-selected')
	]);
const choose = async (option: string) => {
	document.querySelector<HTMLElement>(`[data-edytor-url-paste-option="${option}"]`)!.click();
	await flushDomUpdates();
};
const linked = (url: string) => [{ text: url, marks: { link: { href: url } } }];

describe('pasting a URL on an empty line offers Link / Embed / Bookmark (Notion)', () => {
	it('the URL lands as a link and the menu offers Link (highlighted), Embed and Bookmark', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': ` ${YOUTUBE}\n` });
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'paragraph', content: linked(YOUTUBE) }]);
		expect(menu()).not.toBeNull();
		expect(options()).toEqual([
			['link', 'true'],
			['embed', 'false'],
			['bookmark', 'false']
		]);
		const { state } = view.edytor.selection;
		expect([state.isCollapsed, state.yStart]).toEqual([true, YOUTUBE.length]);
	});

	it('Embed turns the line into an embed of the URL; undo gives the link back, undo again the empty line', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		await choose('embed');
		expect(canonicalTree(view.edytor, true)).toEqual([
			{ type: 'embed', id: 'p', data: { url: YOUTUBE } }
		]);
		expect(menu()).toBeNull();
		expect(document.querySelector('[data-edytor-embed] iframe')).not.toBeNull();
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'paragraph', content: linked(YOUTUBE) }]);
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'paragraph' }]);
	});

	it('the keys: ArrowDown moves the highlight, Enter picks it', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		await dispatchDomKeyDown(view.editor, { key: 'ArrowDown' });
		expect(options()[1]).toEqual(['embed', 'true']);
		const { defaultPrevented } = await dispatchDomKeyDown(view.editor, { key: 'Enter' });
		expect(defaultPrevented).toBe(true);
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'embed', data: { url: YOUTUBE } }]);
	});

	it('Enter on the highlighted Link keeps the link and closes the menu, splitting nothing', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		await dispatchDomKeyDown(view.editor, { key: 'Enter' });
		expect(menu()).toBeNull();
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'paragraph', content: linked(YOUTUBE) }]);
	});

	it('Bookmark turns the line into a bookmark and unfurls it', async () => {
		const unfurl = vi.fn(async () => ({ title: 'Docs' }));
		const view = await render([embedPlugin, createBookmarkPlugin({ unfurl })], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': PAGE });
		// No provider plays the page: no Embed row.
		expect(options()).toEqual([
			['link', 'true'],
			['bookmark', 'false']
		]);
		await choose('bookmark');
		expect(unfurl).toHaveBeenCalledWith(PAGE);
		await vi.waitFor(() =>
			expect(canonicalTree(view.edytor)).toEqual([
				{ type: 'bookmark', data: { url: PAGE, title: 'Docs' } }
			])
		);
	});

	it('an unfurl landing after more edits is no undo step: undo takes back the typing, then the conversion', async () => {
		let answer!: (preview: { title: string }) => void;
		const unfurl = vi.fn(() => new Promise<{ title: string }>((resolve) => (answer = resolve)));
		const view = await render([createBookmarkPlugin({ unfurl })], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': PAGE });
		await choose('bookmark');
		view.edytor.idToBlock.get('p')!.firstText!.insertText({ value: 'Read', start: 0 });
		await flushDomUpdates();
		answer({ title: 'Docs' });
		await vi.waitFor(() => expect(view.edytor.facade.blockDataOf('p')?.title).toBe('Docs'));
		view.edytor.historyUndo();
		await flushDomUpdates();
		// The typing goes; the unfurled title stays.
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'bookmark', data: { url: PAGE, title: 'Docs' } }
		]);
		view.edytor.historyUndo();
		await flushDomUpdates();
		const [line] = canonicalTree(view.edytor);
		expect([line!.type, line!.content]).toEqual(['paragraph', linked(PAGE)]);
	});

	it('a media plugin listed twice offers its kind once (first wins)', async () => {
		const view = await render(
			[embedPlugin, createEmbedPlugin(), bookmarkPlugin, bookmarkPlugin],
			[empty()]
		);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		expect(options()).toEqual([
			['link', 'true'],
			['embed', 'false'],
			['bookmark', 'false']
		]);
	});

	it('Escape closes the menu and keeps the link; so does typing', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		const { defaultPrevented } = await dispatchDomKeyDown(view.editor, { key: 'Escape' });
		expect(defaultPrevented).toBe(true);
		expect(menu()).toBeNull();
		expect(canonicalTree(view.edytor)).toEqual([{ type: 'paragraph', content: linked(YOUTUBE) }]);

		const again = await render([embedPlugin, bookmarkPlugin], [empty('q')]);
		await pasteAt(again, 'q', 0, { 'text/plain': PAGE });
		expect(menu()).not.toBeNull();
		again.edytor.idToBlock.get('q')!.firstText!.insertText({ value: ' ', start: PAGE.length });
		await flushDomUpdates();
		expect(menu()).toBeNull();
	});

	it('only bookmarkPlugin listed: the menu offers Link and Bookmark', async () => {
		const view = await render([bookmarkPlugin], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		expect(options()).toEqual([
			['link', 'true'],
			['bookmark', 'false']
		]);
	});

	it('the root holds the keyboard: it names the open listbox and its highlighted option (WAI-ARIA 1.2)', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		const named = (attribute: string) => {
			const id = view.editor.getAttribute(attribute);
			return id ? document.getElementById(id) : null;
		};
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		expect(named('aria-controls')).toBe(menu());
		expect(view.editor.getAttribute('aria-haspopup')).toBe('listbox');
		const rows = [...document.querySelectorAll('[data-edytor-url-paste-option]')];
		expect(named('aria-activedescendant')).toBe(rows[0]);
		await dispatchDomKeyDown(view.editor, { key: 'ArrowDown' });
		expect(named('aria-activedescendant')).toBe(rows[1]);
		await dispatchDomKeyDown(view.editor, { key: 'Escape' });
		for (const attribute of ['aria-controls', 'aria-activedescendant', 'aria-haspopup'])
			expect(view.editor.hasAttribute(attribute)).toBe(false);
	});
});

describe('elsewhere the paste is unchanged', () => {
	// A URL pasted at a caret is linked by the rich text plugin's autolink (`link.*`).
	it('a line holding text: the URL is pasted and linked as before, no menu', async () => {
		const view = await render(
			[embedPlugin, bookmarkPlugin],
			[{ id: 'p', type: 'paragraph', content: [{ text: 'see ' }] }]
		);
		await pasteAt(view, 'p', 4, { 'text/plain': YOUTUBE });
		expect(menu()).toBeNull();
		expect(canonicalTree(view.edytor)).toEqual([
			{
				type: 'paragraph',
				content: [{ text: 'see ' }, { text: YOUTUBE, marks: { link: { href: YOUTUBE } } }]
			}
		]);
	});

	it('text that is not one http(s) URL, or a mailto, pastes as text', async () => {
		for (const text of ['two words', `${PAGE} ${PAGE}`, 'mailto:a@b.c', 'javascript:alert(1)']) {
			const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
			await pasteAt(view, 'p', 0, { 'text/plain': text });
			expect(menu()).toBeNull();
			// A mailto is linked (autolink); the others stay plain.
			expect(canonicalTree(view.edytor)[0]!.content).toEqual([
				text.startsWith('mailto:') ? { text, marks: { link: { href: text } } } : { text }
			]);
			document.body.innerHTML = '';
		}
	});

	it('Shift+paste pastes plain text, no menu', async () => {
		const view = await render([embedPlugin, bookmarkPlugin], [empty()]);
		await setNativeSelection(view.edytor, view.edytor.idToBlock.get('p')!.firstText, 0);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
		await dispatchClipboardPaste(view.editor, { 'text/plain': YOUTUBE });
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: YOUTUBE }] }
		]);
	});

	it('a view with neither plugin keeps the paste (the URL linked), no menu', async () => {
		const view = await render([], [empty()]);
		await pasteAt(view, 'p', 0, { 'text/plain': YOUTUBE });
		expect(menu()).toBeNull();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: YOUTUBE, marks: { link: { href: YOUTUBE } } }] }
		]);
	});
});
