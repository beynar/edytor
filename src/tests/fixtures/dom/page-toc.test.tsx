/** @jsxImportSource ../../jsx */
/**
 * WU-32, the page block and the table of contents (Notion).
 *
 * Page: a void `page` block links to another document (`data.pageId`) and
 * shows its title — your `title(pageId)` lookup's answer, else the title
 * it stores (`data.title`), else "Untitled". A click opens it (`open`);
 * with `href` it is a link (a modified click is the browser's). A lookup
 * answer that differs from the stored title is stored outside the undo
 * history, by a view that may write. With `create`, the "Page" command
 * makes an empty line a page block (or inserts one after a line holding
 * text) and opens the new page.
 *
 * Table of contents: a void `toc` block lists the headings and toggle
 * headings in reading order, live, each indented by its level under the
 * shallowest; a click scrolls to the heading, opening the closed toggles it
 * sits in; no heading, Notion's hint. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createPagePlugin, pagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
import { createTocPlugin, tocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
import { defaultSemantics } from '$lib/crdt/semantics.js';
import { convertToKind } from '$lib/kinds.js';
import { serializeClipboardFragmentToHtml } from '$lib/clipboard/serializeClipboardFragment.js';
import {
	dispatchClipboardPaste,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

const render = (children: JSONBlock[], plugins: Plugin[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], readonly, value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const element = (id: string) => document.querySelector(`[data-edytor-id="${id}"]`)!;
const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const h = (id: string, level: string, text: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'heading',
	data: { level },
	content: [{ text }],
	...(children && { children })
});
const page = (id: string, data: JSONBlock['data']): JSONBlock => ({ id, type: 'page', data });
const click = async (target: Element, init: MouseEventInit = {}) => {
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
	await flushDomUpdates();
};
const link = (id: string) => element(id).querySelector('[data-edytor-page-link]')!;
const titleOf = (id: string) => element(id).querySelector('[data-edytor-page-title]')!.textContent;

describe('Roles: page and toc are voids showing no text, on every replica', () => {
	it('defaultSemantics holds them', () => {
		expect(defaultSemantics.roles.page).toEqual({ void: true });
		expect(defaultSemantics.rendersContent.page).toBe(false);
		expect(defaultSemantics.roles.toc).toEqual({ void: true });
		expect(defaultSemantics.rendersContent.toc).toBe(false);
	});
});

describe('The page block', () => {
	it('shows the stored title, else "Untitled"; a click opens the page', async () => {
		const open = vi.fn();
		await render(
			[page('a', { pageId: 'p-1', title: 'Roadmap' }), page('b', { pageId: 'p-2' }), p('z')],
			[createPagePlugin({ open })]
		);
		expect(titleOf('a')).toBe('Roadmap');
		expect(titleOf('b')).toBe('Untitled');
		expect(element('a').getAttribute('data-edytor-void')).toBe('true');
		await click(link('a'));
		expect(open).toHaveBeenCalledWith('p-1', { newTab: false });
	});

	it('the lookup’s title shows and is stored outside the history', async () => {
		const view = await render(
			[page('a', { pageId: 'p-1', title: 'Old' })],
			[createPagePlugin({ title: (id) => (id === 'p-1' ? 'New name' : undefined) })]
		);
		await flushDomUpdates();
		expect(titleOf('a')).toBe('New name');
		expect(view.edytor.facade.blockDataOf('a')).toEqual({ pageId: 'p-1', title: 'New name' });
		// No undo step: an undo never brings back a stale title.
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(view.edytor.dispatcher.last?.status).toBe('noop');
		expect(view.edytor.facade.blockDataOf('a')?.title).toBe('New name');
	});

	it('stores each answer once: a peer’s other title is not written over (no ping-pong)', async () => {
		const view = await render(
			[page('a', { pageId: 'p-1', title: 'Old' })],
			[createPagePlugin({ title: () => 'Mine' })]
		);
		await flushDomUpdates();
		expect(view.edytor.facade.blockDataOf('a')?.title).toBe('Mine');
		// A peer whose lookup answers otherwise stores its title.
		view.edytor.facade.apply(
			view.edytor.facade.prepare.patchData('a', [{ path: ['title'], value: 'Theirs' }])
		);
		await flushDomUpdates();
		await flushDomUpdates();
		expect(view.edytor.facade.blockDataOf('a')?.title).toBe('Theirs');
		// This view still shows its own lookup's answer.
		expect(titleOf('a')).toBe('Mine');
	});

	it('an async lookup shows its answer once it settles', async () => {
		let resolve!: (title: string) => void;
		const answer = new Promise<string>((r) => (resolve = r));
		await render(
			[page('a', { pageId: 'p-1', title: 'Cached' })],
			[createPagePlugin({ title: () => answer })]
		);
		expect(titleOf('a')).toBe('Cached');
		resolve('Fresh');
		await answer;
		await flushDomUpdates();
		expect(titleOf('a')).toBe('Fresh');
	});

	it('a readonly view shows the lookup but stores nothing, and still opens', async () => {
		const open = vi.fn();
		const view = await render(
			[page('a', { pageId: 'p-1', title: 'Old' })],
			[createPagePlugin({ open, title: () => 'New' })],
			true
		);
		await flushDomUpdates();
		expect(titleOf('a')).toBe('New');
		expect(view.edytor.facade.blockDataOf('a')?.title).toBe('Old');
		await click(link('a'));
		expect(open).toHaveBeenCalledWith('p-1', { newTab: false });
	});

	it('with href it is a link; a plain click opens, a modified one is the browser’s', async () => {
		const open = vi.fn();
		await render(
			[page('a', { pageId: 'p-1', title: 'T' })],
			[createPagePlugin({ open, href: (id) => `/p/${id}` })]
		);
		const anchor = link('a');
		// jsdom navigates on an unprevented link click: the page stays (after our handler).
		const stay = (event: Event) => event.preventDefault();
		document.addEventListener('click', stay);
		expect(anchor.localName).toBe('a');
		expect(anchor.getAttribute('href')).toBe('/p/p-1');
		await click(anchor, { metaKey: true });
		expect(open).not.toHaveBeenCalled();
		await click(anchor);
		expect(open).toHaveBeenCalledWith('p-1', { newTab: false });
		document.removeEventListener('click', stay);
	});

	it('a script href and a missing page id are inert', async () => {
		const open = vi.fn();
		await render(
			[page('a', { pageId: 'p-1' }), page('b', { pageId: '' })],
			[createPagePlugin({ open, href: () => 'javascript:alert(1)' })]
		);
		expect(link('a').localName).toBe('button');
		await click(link('b'));
		expect(open).not.toHaveBeenCalled();
	});

	it('without options the block shows its title and opens nothing', async () => {
		await render([page('a', { pageId: 'p-1', title: 'T' })], [pagePlugin]);
		expect(titleOf('a')).toBe('T');
		expect((link('a') as HTMLButtonElement).disabled).toBe(true);
	});

	it('"Page" (with create) turns an empty line into a page block and opens it', async () => {
		const open = vi.fn();
		const view = await render(
			[{ id: 'a', type: 'paragraph', content: [] }, p('z')],
			[createPagePlugin({ open, create: () => ({ pageId: 'new-1', title: 'Draft' }) })]
		);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 0);
		const command = view.edytor.commands.get('page.new')!;
		expect(command.label).toBe('Page');
		expect(command.isEnabled?.(view.edytor)).toBe(true);
		await command.run(view.edytor);
		await flushDomUpdates();
		const [first] = view.edytor.value.children!;
		expect(first!.type).toBe('page');
		expect(first!.data).toEqual({ pageId: 'new-1', title: 'Draft' });
		expect(open).toHaveBeenCalledWith('new-1', { newTab: false });
		// One undo step takes it back.
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(view.edytor.value.children![0]!.type).toBe('paragraph');
	});

	it('after a line holding text, "Page" inserts the block below it', async () => {
		const view = await render([p('a', 'notes')], [createPagePlugin({ create: () => 'new-2' })]);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 5);
		await view.edytor.commands.get('page.new')!.run(view.edytor);
		await flushDomUpdates();
		expect(view.edytor.value.children!.map((b) => [b.type, b.data ?? {}])).toEqual([
			['paragraph', {}],
			['page', { pageId: 'new-2' }],
			['paragraph', {}]
		]);
	});

	it('no create, no "Page" command', async () => {
		const view = await render([p('a')], [pagePlugin]);
		expect(view.edytor.commands.has('page.new')).toBe(false);
	});

	it('HTML: a paragraph naming the page, linked by href; imported back as a page block', async () => {
		const plugin = createPagePlugin({ href: (id) => `https://app.example/p/${id}` });
		const view = await render([{ id: 'a', type: 'paragraph', content: [] }], [plugin]);
		const html = serializeClipboardFragmentToHtml(
			{
				version: 1,
				source: 'edytor',
				kind: 'blocks',
				blocks: [{ type: 'page', data: { pageId: 'p-1', title: 'A & B' } }]
			},
			view.edytor
		);
		expect(html).toContain(
			'<p data-edytor-page="p-1"><a href="https://app.example/p/p-1">A &amp; B</a></p>'
		);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 0);
		await dispatchClipboardPaste(view.editor, {
			'text/html': html.replace(/<span data-edytor-fragment[^>]*><\/span>/, ''),
			'text/plain': 'x'
		});
		expect(view.edytor.value.children!.filter((b) => b.type === 'page').map((b) => b.data)).toEqual(
			[{ pageId: 'p-1', title: 'A & B' }]
		);
	});
});

describe('The table of contents', () => {
	const entries = (id: string) =>
		[...element(id).querySelectorAll('[data-edytor-toc-entry]')].map((entry) => [
			entry.textContent,
			entry.getAttribute('data-level')
		]);

	it('lists the headings and toggle headings in reading order, nested ones too', async () => {
		await render(
			[
				{ id: 't', type: 'toc' },
				h('h1', 'h1', 'Intro'),
				p('x'),
				h('h2', 'h2', 'Details', [h('h3', 'h3', 'Deep')]),
				{
					id: 'th',
					type: 'toggle-heading',
					data: { level: 'h2' },
					content: [{ text: 'FAQ' }]
				}
			],
			[tocPlugin]
		);
		expect(element('t').localName).toBe('nav');
		expect(element('t').getAttribute('aria-label')).toBe('Table of contents');
		expect(entries('t')).toEqual([
			['Intro', '1'],
			['Details', '2'],
			['Deep', '3'],
			['FAQ', '2']
		]);
	});

	it('follows the document live: a typed heading, a new one, a removed one', async () => {
		const view = await render([{ id: 't', type: 'toc' }, h('a', 'h2', 'One'), p('x')], [tocPlugin]);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 3);
		get(view, 'a').firstText!.insertText({ value: '!' });
		await flushDomUpdates();
		expect(entries('t')).toEqual([['One!', '2']]);
		expect(
			convertToKind(
				view.edytor,
				get(view, 'x'),
				view.edytor.kinds.find((kind) => kind.label === 'Heading 1')!
			)
		).toBe(true);
		await flushDomUpdates();
		expect(entries('t')).toEqual([
			['One!', '2'],
			['x', '1']
		]);
		get(view, 'a').removeBlock();
		await flushDomUpdates();
		expect(entries('t')).toEqual([['x', '1']]);
	});

	it('indents by level under the shallowest shown', async () => {
		await render(
			[{ id: 't', type: 'toc' }, h('a', 'h2', 'A'), h('b', 'h3', 'B'), h('c', 'h2', 'C')],
			[tocPlugin]
		);
		const depths = [...element('t').querySelectorAll<HTMLElement>('[data-edytor-toc-entry]')].map(
			(entry) => entry.style.getPropertyValue('--edytor-toc-depth')
		);
		expect(depths).toEqual(['0', '1', '0']);
	});

	it('a click scrolls to the heading and opens the closed toggle holding it', async () => {
		const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
		const view = await render(
			[
				{ id: 't', type: 'toc' },
				{
					id: 'g',
					type: 'toggle',
					content: [{ text: 'More' }],
					children: [h('a', 'h2', 'Hidden')]
				}
			],
			[tocPlugin]
		);
		(element('g') as HTMLDetailsElement).open = false;
		const before = view.edytor.selection.value;
		await click(element('t').querySelector('[data-edytor-toc-entry]')!);
		expect((element('g') as HTMLDetailsElement).open).toBe(true);
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(scroll.mock.contexts[0]).toBe(element('a'));
		expect(view.edytor.selection.value).toEqual(before);
	});

	it('no heading: Notion’s hint', async () => {
		await render([{ id: 't', type: 'toc' }, p('x')], [tocPlugin]);
		expect(element('t').querySelector('[data-edytor-toc-empty]')?.textContent).toBe(
			'Add headings to create a table of contents.'
		);
	});

	it('the preset replaces an empty line, and goes after a line with text', async () => {
		const view = await render([p('a', 'text')], [tocPlugin]);
		const row = view.edytor.kinds.find((kind) => kind.label === 'Table of contents')!;
		expect(row.replaces).toBe(true);
		expect(convertToKind(view.edytor, get(view, 'a'), row)).toBe(true);
		await flushDomUpdates();
		expect(view.edytor.value.children!.map((b) => b.type)).toEqual([
			'paragraph',
			'toc',
			'paragraph'
		]);
	});

	it('headingLevel picks which blocks it lists', async () => {
		await render(
			[{ id: 't', type: 'toc' }, h('a', 'h1', 'A'), p('b', 'Para')],
			[createTocPlugin({ headingLevel: ({ type }) => (type === 'paragraph' ? 1 : null) })]
		);
		expect(entries('t')).toEqual([['Para', '1']]);
	});
});
