/** @jsxImportSource ../../jsx */
/**
 * The page link plugin's `fromPaste`: a pasted text the app recognizes
 * (its own URL for a page, `page:roadmap`) becomes a `pageLink` atom, an
 * undo step of its own after the paste, so one undo gives the plain text
 * back (as the pasted autolink). A text it does not recognize pastes as
 * usual. An answer at once claims the paste before the rich text link and
 * the URL menu (`pasteFirst`); a promise lets the paste land as it would
 * and swaps it when it answers. Readonly: nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { PageLinkItem } from '$lib/plugins/pageLink/PageLinkPlugin.svelte';
import {
	canonicalTree,
	dispatchClipboardPaste,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import {
	bookmarkPlugin,
	embedPlugin,
	pageLink as createPageLinkPlugin,
	richTextPlugin
} from '../../../routes/chrome/plugins.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROADMAP: PageLinkItem = { id: 'roadmap', title: 'Roadmap', icon: '🗺️' };
const URL = 'https://app.example.com/p/roadmap';
const known = (text: string): PageLinkItem | null =>
	text === 'page:roadmap' || text === URL ? ROADMAP : null;

const render = async (plugins: Plugin[], children: JSONBlock[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins, readonly, value: { children } }
	);

const p = (id: string, text = ''): JSONBlock => ({
	id,
	type: 'paragraph',
	content: text ? [{ text }] : []
});

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

const caretOf = ({ edytor }: Awaited<ReturnType<typeof render>>) => {
	const caret = edytor.selection.caret;
	return caret && { block: caret.block.id, offset: caret.offset };
};

const atom = { type: 'pageLink', data: { id: 'roadmap', title: 'Roadmap', icon: '🗺️' } };
const linkOf = (data: object) => ({ ...atom, data: { ...atom.data, ...data } });

describe('page link fromPaste', () => {
	it('a matching paste becomes a page link atom, the caret after it', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render([pages, richTextPlugin], [p('a', 'see ')]);
		await pasteAt(view, 'a', 4, { 'text/plain': ' page:roadmap\n' });
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see ' }, atom] }
		]);
		expect(document.querySelector('[data-edytor-page-link]')?.getAttribute('data-page-id')).toBe(
			'roadmap'
		);
		expect(caretOf(view)).toEqual({ block: 'a', offset: 5 });
	});

	it('one undo gives the plain pasted text back, another the line before', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render([pages, richTextPlugin], [p('a', 'see ')]);
		await pasteAt(view, 'a', 4, { 'text/plain': 'page:roadmap' });
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see page:roadmap' }] }
		]);
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see ' }] }
		]);
	});

	it('a paste it does not recognize, or of several lines, stays text', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render([pages, richTextPlugin], [p('a')]);
		await pasteAt(view, 'a', 0, { 'text/plain': 'page:other' });
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'page:other' }] }
		]);
		const lines = await render([pages, richTextPlugin], [p('b')]);
		await pasteAt(lines, 'b', 0, { 'text/plain': 'page:roadmap\npage:roadmap' });
		expect(JSON.stringify(canonicalTree(lines.edytor))).not.toContain('pageLink');
	});

	it('a promise: the text lands at once, then becomes the link; undo gives the text', async () => {
		let answer!: (page: PageLinkItem | null) => void;
		const pages = createPageLinkPlugin({
			search: () => [],
			fromPaste: () => new Promise<PageLinkItem | null>((resolve) => (answer = resolve))
		});
		const view = await render([pages, richTextPlugin], [p('a', 'see ')]);
		await pasteAt(view, 'a', 4, { 'text/plain': 'page:roadmap' });
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see page:roadmap' }] }
		]);
		answer(ROADMAP);
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see ' }, atom] }
		]);
		expect(caretOf(view)).toEqual({ block: 'a', offset: 5 });
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see page:roadmap' }] }
		]);
	});

	it('a promise answering none, or after the text changed, leaves the paste', async () => {
		const answers: ((page: PageLinkItem | null) => void)[] = [];
		const pages = createPageLinkPlugin({
			search: () => [],
			fromPaste: () => new Promise<PageLinkItem | null>((resolve) => answers.push(resolve))
		});
		const view = await render([pages, richTextPlugin], [p('a'), p('b')]);
		await pasteAt(view, 'a', 0, { 'text/plain': 'page:roadmap' });
		answers[0](null);
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)[0]).toEqual({
			type: 'paragraph',
			content: [{ text: 'page:roadmap' }]
		});
		await pasteAt(view, 'b', 0, { 'text/plain': 'page:roadmap' });
		view.edytor.deleteText('b', 0, 2);
		await flushDomUpdates();
		answers[1](ROADMAP);
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)[1]).toEqual({
			type: 'paragraph',
			content: [{ text: 'ge:roadmap' }]
		});
	});

	it('readonly: nothing happens', async () => {
		let asked = 0;
		const pages = createPageLinkPlugin({
			search: () => [],
			fromPaste: (text) => (asked++, known(text))
		});
		const view = await render([pages, richTextPlugin], [p('a', 'see ')], true);
		await pasteAt(view, 'a', 4, { 'text/plain': 'page:roadmap' });
		expect(asked).toBe(0);
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see ' }] }
		]);
	});

	it('a URL it recognizes wins over the rich text autolink, whatever the list order', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render([richTextPlugin, pages], [p('a', 'see ')]);
		await pasteAt(view, 'a', 4, { 'text/plain': URL });
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'see ' }, atom] }
		]);
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: `see ${URL}` }] }
		]);
	});

	it('a URL it does not recognize is still linked by the rich text autolink', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render([richTextPlugin, pages], [p('a', 'see ')]);
		const other = 'https://example.com/x';
		await pasteAt(view, 'a', 4, { 'text/plain': other });
		expect(canonicalTree(view.edytor)).toEqual([
			{
				type: 'paragraph',
				content: [{ text: 'see ' }, { text: other, marks: { link: { href: other } } }]
			}
		]);
	});

	it('on an empty line, a recognized URL is a page link and opens no URL menu; another opens it', async () => {
		const pages = createPageLinkPlugin({ search: () => [], fromPaste: known });
		const view = await render(
			[embedPlugin, bookmarkPlugin, richTextPlugin, pages],
			[p('a'), p('b')]
		);
		await pasteAt(view, 'a', 0, { 'text/plain': URL });
		expect(canonicalTree(view.edytor)[0]).toEqual({ type: 'paragraph', content: [atom] });
		expect(document.querySelector('[data-edytor-url-paste-menu]')).toBeNull();
		await pasteAt(view, 'b', 0, { 'text/plain': 'https://example.com/x' });
		expect(document.querySelector('[data-edytor-url-paste-menu]')).not.toBeNull();
	});

	it("the href comes from the page or from the plugin's href", async () => {
		const pages = createPageLinkPlugin({
			search: () => [],
			href: (page) => `/pages/${page.id}`,
			fromPaste: known
		});
		const view = await render([pages, richTextPlugin], [p('a')]);
		await pasteAt(view, 'a', 0, { 'text/plain': 'page:roadmap' });
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [linkOf({ href: '/pages/roadmap' })] }
		]);
	});
});
