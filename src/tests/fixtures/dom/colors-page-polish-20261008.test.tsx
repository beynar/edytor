/** @jsxImportSource ../../jsx */
/**
 * Notion polish after the block colours and the page block:
 *
 * - Colours by name, as in Notion: `/red` in the slash menu offers "Red
 *   text" and "Red background" (a colour is listed once a query names it,
 *   never in the bare `/` list), and picking one paints the caret's block,
 *   the typed `/red` gone, in one undo step that gives `/red` back; the
 *   block menu's search lists the same rows under "Color", painting the
 *   blocks it acts on.
 * - The HTML a copy writes names a block's colours as Notion's export does,
 *   `class="block-color-red"` and `class="block-color-red_background"`, and a
 *   paste reads them back (Notion's `teal` is the palette's green).
 * - A page block opens on a click, in a new tab on a modified or middle
 *   click (`open(pageId, { newTab })`; with an `href` that click stays the
 *   browser's), and on Enter over the page block selected alone.
 *
 * Expected states are hand-authored from Notion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { createPagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { serializeClipboardFragmentToHtml } from '$lib/clipboard/serializeClipboardFragment.js';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

const render = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, text = id, data?: JSONBlock['data']): JSONBlock => ({
	id,
	type: 'paragraph',
	...(data && { data }),
	content: [{ text }]
});
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const element = (id: string) => document.querySelector(`[data-edytor-id="${id}"]`)!;
const dataOf = (view: View, id: string) => view.edytor.facade.blockDataOf(id) ?? {};
const textOf = (view: View, id: string) =>
	(view.edytor.value.children ?? [])
		.find((block) => block.id === id)
		?.content?.map((part) => ('text' in part ? part.text : ''))
		.join('');
const settle = async () => {
	for (let round = 0; round < 4; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await flushDomUpdates();
	}
};
const press = async (target: Element, init: MouseEventInit = {}) => {
	for (const type of ['mousedown', 'click'])
		target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
	await settle();
};
const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const slashRows = () =>
	[...document.querySelectorAll('[data-testid="slash-menu-item"]')].map((row) =>
		row.textContent?.trim()
	);
const slashRow = (label: string) =>
	[...document.querySelectorAll('[data-testid="slash-menu-item"]')].find(
		(row) => row.textContent?.trim() === label
	)!;

describe('Colours by name in the slash menu', () => {
	it('/red offers Red text and Red background; picking one paints the block, /red gone', async () => {
		const view = await render([p('a', 'Hello')], [slashMenuPlugin, blockMenuPlugin]);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 5);
		await type(view.editor, ' /red');
		expect(slashRows()).toEqual(['Red text', 'Red background']);
		await press(slashRow('Red text'));
		expect(dataOf(view, 'a')).toEqual({ color: 'red' });
		expect(textOf(view, 'a')).toBe('Hello ');
		expect(element('a').getAttribute('data-edytor-color')).toBe('red');
		// One undo step: the colour goes, the typed trigger comes back.
		view.edytor.historyUndo();
		await settle();
		expect(dataOf(view, 'a')).toEqual({});
		expect(textOf(view, 'a')).toBe('Hello /red');
	});

	it('/red back narrows to the background; Default background removes it', async () => {
		const view = await render(
			[p('a', 'One', { background: 'blue' })],
			[slashMenuPlugin, blockMenuPlugin]
		);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 3);
		await type(view.editor, ' /red back');
		expect(slashRows()).toEqual(['Red background']);
		await dispatchDomKeyDown(view.editor, { key: 'Escape' });
		await type(view.editor, ' /default back');
		expect(slashRows()).toEqual(['Default background']);
		await press(slashRow('Default background'));
		expect(dataOf(view, 'a')).toEqual({});
	});

	it('the bare / list names no colour', async () => {
		const view = await render([p('a', '')], [slashMenuPlugin, blockMenuPlugin]);
		await setNativeSelection(view.edytor, get(view, 'a').firstText!, 0);
		await type(view.editor, '/');
		expect(slashRows().length).toBeGreaterThan(0);
		expect(slashRows().filter((row) => /text$|background$/.test(row!))).toEqual([]);
	});
});

describe('Colours by name in the block menu search', () => {
	const openMenu = async (view: View, id: string) => {
		const block = get(view, id);
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
	};
	const search = async (query: string) => {
		const field = document.querySelector<HTMLInputElement>('[data-testid="block-menu"] input')!;
		field.value = query;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await flushDomUpdates();
	};
	const rows = () =>
		[...document.querySelectorAll('[data-testid="block-menu"] [role^="menuitem"]')].map((row) =>
			row.textContent?.trim()
		);

	it('"red" lists Red text and Red background under Color; a pick paints the block', async () => {
		const view = await render([p('a'), p('b')], [blockMenuPlugin]);
		await openMenu(view, 'a');
		await search('red');
		expect(rows()).toEqual(['Red text', 'Red background']);
		const headings = [
			...document.querySelectorAll('[data-testid="block-menu"] .block-menu-heading')
		].map((heading) => heading.textContent?.trim());
		expect(headings).toEqual(['Color']);
		await press(
			document.querySelector(
				'[data-testid="block-menu"] [data-testid="block-menu-background.red"]'
			)!
		);
		expect(dataOf(view, 'a')).toEqual({ background: 'red' });
		expect(dataOf(view, 'b')).toEqual({});
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
	});

	it('Enter on a searched colour paints it', async () => {
		const view = await render([p('a')], [blockMenuPlugin]);
		await openMenu(view, 'a');
		await search('red text');
		const field = document.querySelector<HTMLInputElement>('[data-testid="block-menu"] input')!;
		field.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		await flushDomUpdates();
		expect(dataOf(view, 'a')).toEqual({ color: 'red' });
	});

	it('over a divider no colour is listed', async () => {
		const view = await render([{ id: 'd', type: 'divider' }, p('z')], [blockMenuPlugin]);
		await openMenu(view, 'd');
		await search('red');
		expect(rows()).toEqual([]);
	});
});

describe('Block colours in the HTML a copy writes, and back', () => {
	const html = (view: View, blocks: JSONBlock[]) =>
		new DOMParser().parseFromString(
			serializeClipboardFragmentToHtml(
				{ version: 1, source: 'edytor', kind: 'blocks', blocks },
				view.edytor
			),
			'text/html'
		).body;

	it('a block’s colours are Notion’s classes on its element', async () => {
		const view = await render([p('a')]);
		const body = html(view, [
			p('a', 'Red', { color: 'red' }),
			p('b', 'On yellow', { background: 'yellow' }),
			p('c', 'Both', { color: 'blue', background: 'gray' }),
			p('d', 'Plain'),
			p('e', 'Hostile', { color: 'red" onclick="x' })
		]);
		const classes = [...body.querySelectorAll('p')].map((el) => el.getAttribute('class'));
		expect(classes).toEqual([
			'block-color-red',
			'block-color-yellow_background',
			'block-color-blue block-color-gray_background',
			null,
			null
		]);
		expect(body.querySelector('[onclick]')).toBeNull();
	});

	it('a heading and a list item carry them on their own element', async () => {
		const view = await render([p('a')]);
		const body = html(view, [
			{ id: 'h', type: 'heading', data: { level: 'h2', color: 'green' }, content: [{ text: 'T' }] },
			{
				id: 'l',
				type: 'bulleted-list',
				children: [
					{
						id: 'i',
						type: 'bulleted-list-item',
						data: { background: 'pink' },
						content: [{ text: 'item' }]
					}
				]
			}
		]);
		expect(body.querySelector('h2')?.getAttribute('class')).toBe('block-color-green');
		expect(body.querySelector('li')?.getAttribute('class')).toBe('block-color-pink_background');
	});

	it('a paste reads them back, Notion’s teal as green; other classes add nothing', async () => {
		const view = await render([p('a')]);
		const flow = flowOfHtml(
			view.edytor,
			'<p class="block-color-red">a</p><p class="x block-color-teal_background">b</p>' +
				'<p class="block-color-nope">c</p><p class="highlight-red">d</p>'
		)!;
		const data = flow.lines.map((line) => (line as { data?: Record<string, unknown> }).data ?? {});
		expect(data[0]).toMatchObject({ color: 'red' });
		expect(data[1]).toMatchObject({ background: 'green' });
		expect(data[2]).not.toHaveProperty('color');
		expect(data[3]).not.toHaveProperty('color');
	});
});

describe('Opening a page block', () => {
	const page = (id: string, pageId: string): JSONBlock => ({
		id,
		type: 'page',
		data: { pageId, title: 'Roadmap' }
	});
	const link = (id: string) => element(id).querySelector('[data-edytor-page-link]')!;

	it('a click opens it; a modified or middle click opens it in a new tab', async () => {
		const open = vi.fn();
		await render([page('g', 'p-1'), p('z')], [createPagePlugin({ open })]);
		link('g').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(open).toHaveBeenLastCalledWith('p-1', { newTab: false });
		const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
		link('g').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mod }));
		expect(open).toHaveBeenLastCalledWith('p-1', { newTab: true });
		link('g').dispatchEvent(
			new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
		);
		expect(open).toHaveBeenLastCalledWith('p-1', { newTab: true });
		expect(open).toHaveBeenCalledTimes(3);
	});

	it('with an href a modified click stays the browser’s', async () => {
		const open = vi.fn();
		await render([page('g', 'p-1')], [createPagePlugin({ open, href: (id) => `/p/${id}` })]);
		const stay = (event: Event) => event.preventDefault();
		document.addEventListener('click', stay);
		link('g').dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
		);
		link('g').dispatchEvent(
			new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
		);
		document.removeEventListener('click', stay);
		expect(open).not.toHaveBeenCalled();
	});

	it('Enter over the page block selected alone opens it; over several, nothing opens', async () => {
		const open = vi.fn();
		const view = await render([page('g', 'p-1'), p('z')], [createPagePlugin({ open })]);
		view.edytor.selection.selectBlocks(get(view, 'g'));
		await flushDomUpdates();
		await dispatchDomKeyDown(view.editor, { key: 'Enter' });
		expect(open).toHaveBeenCalledWith('p-1', { newTab: false });
		open.mockClear();
		view.edytor.selection.selectBlocks(get(view, 'g'), get(view, 'z'));
		await flushDomUpdates();
		await dispatchDomKeyDown(view.editor, { key: 'Enter' });
		expect(open).not.toHaveBeenCalled();
	});
});
