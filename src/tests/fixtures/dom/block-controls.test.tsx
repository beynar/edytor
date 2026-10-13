/** @jsxImportSource ../../jsx */
/**
 * The controls inside blocks take the app's markup: each plugin option
 * (`createRichTextPlugin({ checkbox, calloutIcon, emptyBody })`,
 * `createEquationPlugin({ placeholder, error })`, `createBookmarkPlugin({ card })`,
 * `createFilePlugin({ row })`, `createEmbedPlugin({ fallback })`,
 * `createTocPlugin({ entry, empty })`, `createPagePlugin({ link })`) replaces
 * the package's default markup, and the payload's attributes keep the
 * control's marker, its ARIA and its action, which still writes through
 * the document (a to-do checked, a callout's icon picked, a body started)
 * or reaches the app (a page opened). Expected states are hand-authored
 * from the default markup's behaviour (the rows of `container-bodies`,
 * `embeds`, `equation`, `page-toc`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { createTocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
import { createPagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import * as custom from '../../dom/CustomBlockControls.svelte';
import {
	bookmark as createBookmarkPlugin,
	calloutIconsPlugin,
	embed as createEmbedPlugin,
	equation as createEquationPlugin,
	file as createFilePlugin,
	richText as createRichTextPlugin
} from '../../../lib/starter/chrome/plugins.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

const richText = createRichTextPlugin({
	checkbox: custom.checkbox,
	calloutIcon: custom.calloutIcon,
	emptyBody: custom.emptyBody
});

const render = (children: JSONBlock[], plugins: Plugin[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richText], value: { children }, readonly }
	);

const nodeOf = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.node as HTMLElement;
const testId = (root: ParentNode, id: string) =>
	root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** A press and its click, as a pointer gives them. */
const press = async (element: Element) => {
	for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
		element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

describe('rich text: the to-do checkbox', () => {
	const todo = [
		{ id: 't', type: 'todo-item', data: { checked: false }, content: [{ text: 'Do' }] }
	];

	it('the `checkbox` snippet replaces the native box; a button gets the checkbox role and state', async () => {
		const { edytor } = await render(todo, []);
		const box = testId(nodeOf(edytor, 't'), 'custom-checkbox')!;
		expect(nodeOf(edytor, 't').querySelector('input[type="checkbox"]')).toBeNull();
		expect(box.hasAttribute('data-edytor-todo-checkbox')).toBe(true);
		expect(box.getAttribute('contenteditable')).toBe('false');
		expect(box.getAttribute('role')).toBe('checkbox');
		expect(box.getAttribute('aria-checked')).toBe('false');
		expect(box.getAttribute('aria-label')).toBe('Done');
		expect(box.textContent).toBe('☐');
	});

	it('its click checks the to-do through the document, one undo step; the press keeps the caret', async () => {
		const { edytor } = await render(todo, []);
		const box = () => testId(nodeOf(edytor, 't'), 'custom-checkbox')!;
		const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		box().dispatchEvent(mousedown);
		expect(mousedown.defaultPrevented).toBe(true);
		await press(box());
		expect(edytor.idToBlock.get('t')!.data.checked).toBe(true);
		expect(box().getAttribute('aria-checked')).toBe('true');
		expect(box().textContent).toBe('☑');
		await undo();
		await flushDomUpdates();
		expect(edytor.idToBlock.get('t')!.data.checked).toBe(false);
		expect(box().getAttribute('aria-checked')).toBe('false');
	});

	it('a control with a role of its own keeps it; the attachment keeps its state in step', async () => {
		const { edytor } = await render(todo, [createRichTextPlugin({ checkbox: custom.switchBox })]);
		const box = () => testId(nodeOf(edytor, 't'), 'custom-switch')!;
		expect(box().getAttribute('role')).toBe('switch');
		expect(box().getAttribute('aria-checked')).toBe('false');
		await press(box());
		expect(edytor.idToBlock.get('t')!.data.checked).toBe(true);
		expect(box().getAttribute('role')).toBe('switch');
		expect(box().getAttribute('aria-checked')).toBe('true');
	});

	it('a readonly view refuses the write: the box stays unchecked', async () => {
		const { edytor } = await render(todo, [], true);
		await press(testId(nodeOf(edytor, 't'), 'custom-checkbox')!);
		expect(edytor.idToBlock.get('t')!.data.checked).toBe(false);
	});
});

describe("rich text: a callout's icon and an empty body's hint", () => {
	const callout = (data: Record<string, string> = { icon: '💡' }): JSONBlock[] => [
		{ id: 'c', type: 'callout', data, content: [{ text: 'note' }] },
		p('after')
	];

	it('the `calloutIcon` snippet opens the view’s picker; a pick writes data.icon', async () => {
		const { edytor } = await render(callout(), [calloutIconsPlugin]);
		const icon = testId(nodeOf(edytor, 'c'), 'custom-callout-icon')!;
		expect(icon.localName).toBe('button');
		expect(icon.textContent).toBe('[💡]');
		expect(icon.hasAttribute('data-edytor-callout-icon')).toBe(true);
		expect(icon.getAttribute('aria-label')).toBe('Change icon');
		expect(icon.getAttribute('aria-haspopup')).toBe('menu');
		expect(icon.getAttribute('aria-expanded')).toBe('false');
		await press(icon);
		expect(icon.getAttribute('aria-expanded')).toBe('true');
		const list = document.getElementById(icon.getAttribute('aria-controls')!)!;
		expect(list.closest('[data-edytor-callout-icons]')).not.toBeNull();
		await dispatchDomKeyDown(list, { key: 'ArrowRight' });
		await dispatchDomKeyDown(list, { key: 'Enter' });
		const picked = edytor.idToBlock.get('c')!.data.icon;
		expect(picked).not.toBe('💡');
		expect(testId(nodeOf(edytor, 'c'), 'custom-callout-icon')!.textContent).toBe(`[${picked}]`);
	});

	it('without a picker or in a readonly view it is the icon alone, hidden from assistive technology', async () => {
		const { edytor } = await render(callout(), [calloutIconsPlugin], true);
		const icon = testId(nodeOf(edytor, 'c'), 'custom-callout-icon')!;
		expect(icon.localName).toBe('i');
		expect(icon.getAttribute('aria-hidden')).toBe('true');
		expect(icon.hasAttribute('aria-haspopup')).toBe(false);
	});

	it('the `emptyBody` snippet starts the body: a first child, the caret in it, one undo step', async () => {
		const { edytor } = await render(callout(), []);
		const hint = testId(nodeOf(edytor, 'c'), 'custom-empty-body')!;
		expect(hint.getAttribute('data-edytor-empty-body')).toBe('callout');
		expect(hint.getAttribute('aria-hidden')).toBe('true');
		expect(hint.textContent).toBe('+ Empty callout. Click or drop blocks inside.');
		expect(nodeOf(edytor, 'c').querySelectorAll('[data-edytor-empty-body]')).toHaveLength(1);
		await press(hint);
		const block = edytor.idToBlock.get('c')!;
		expect(block.children.map((child) => child.type)).toEqual(['paragraph']);
		expect(edytor.selection.textRange().startText?.parent).toBe(block.children[0]);
		expect(testId(nodeOf(edytor, 'c'), 'custom-empty-body')).toBeNull();
		await undo();
		await flushDomUpdates();
		expect(edytor.idToBlock.get('c')!.children).toHaveLength(0);
	});
});

describe('equation: the placeholder and the error', () => {
	const katex = () => import('katex');

	it('the `placeholder` snippet shows an empty equation; a click on it opens the editor', async () => {
		const { edytor } = await render(
			[{ id: 'e', type: 'equation', data: { expression: '' } }, p('after')],
			[createEquationPlugin({ katex, placeholder: custom.equationPlaceholder })]
		);
		const placeholder = testId(nodeOf(edytor, 'e'), 'custom-equation-placeholder')!;
		expect(placeholder.textContent).toBe('Add a TeX equation');
		expect(placeholder.getAttribute('data-display')).toBe('true');
		expect(nodeOf(edytor, 'e').querySelector('[data-edytor-equation-placeholder]')).toBeNull();
		await press(placeholder);
		const equation = nodeOf(edytor, 'e').querySelector('[data-edytor-equation]');
		expect(equation?.getAttribute('data-editing')).toBe('true');
	});

	it('the `error` snippet shows an equation KaTeX cannot read, with its message', async () => {
		const { edytor } = await render(
			[{ id: 'e', type: 'equation', data: { expression: '\\frac{' } }, p('after')],
			[createEquationPlugin({ katex, error: custom.equationError })]
		);
		await vi.waitFor(() => {
			if (!testId(nodeOf(edytor, 'e'), 'custom-equation-error')) throw new Error('not drawn yet');
		});
		await flushDomUpdates();
		const error = testId(nodeOf(edytor, 'e'), 'custom-equation-error')!;
		expect(error.textContent).toBe('Invalid equation: \\frac{');
		expect(error.title).toMatch(/KaTeX parse error/);
		expect(nodeOf(edytor, 'e').querySelector('[data-edytor-equation-error]')).toBeNull();
	});
});

describe('media: the bookmark card, the file row, the embed fallback', () => {
	it('the `card` snippet draws a bookmark with its link, in the void wrapper', async () => {
		const { edytor } = await render(
			[
				{
					id: 'b',
					type: 'bookmark',
					data: { url: 'https://example.com/a', title: 'A page', description: 'About it' },
					content: []
				}
			],
			[createBookmarkPlugin({ card: custom.bookmarkCard })]
		);
		const card = testId(nodeOf(edytor, 'b'), 'custom-bookmark')!;
		expect(card.parentElement!.hasAttribute('data-edytor-bookmark')).toBe(true);
		expect(card.parentElement!.getAttribute('contenteditable')).toBe('false');
		expect(card.textContent).toBe('A page About it');
		expect(card.getAttribute('href')).toBe('https://example.com/a');
		expect(card.getAttribute('target')).toBe('_blank');
		expect(card.getAttribute('rel')).toBe('noopener noreferrer nofollow');
		expect(card.getAttribute('draggable')).toBe('false');
		expect(nodeOf(edytor, 'b').querySelector('[data-edytor-bookmark-title]')).toBeNull();
	});

	it('the `row` snippet draws a file, its size in the view’s words, its link downloading it', async () => {
		const { edytor } = await render(
			[
				{
					id: 'f',
					type: 'file',
					data: { src: 'https://example.com/report.pdf', name: 'report.pdf', size: 2048 },
					content: []
				}
			],
			[createFilePlugin({ row: custom.fileRow })]
		);
		const row = testId(nodeOf(edytor, 'f'), 'custom-file')!;
		expect(row.parentElement!.hasAttribute('data-edytor-file')).toBe(true);
		expect(row.textContent).toBe('report.pdf (2.0 KB)');
		expect(row.getAttribute('href')).toBe('https://example.com/report.pdf');
		expect(row.getAttribute('download')).toBe('report.pdf');
		expect(row.getAttribute('rel')).toBe('noopener noreferrer nofollow');
	});

	it('the `fallback` snippet draws a link no provider plays, never a frame', async () => {
		const { edytor } = await render(
			[{ id: 'e', type: 'embed', data: { url: 'https://example.com/page' }, content: [] }],
			[createEmbedPlugin({ fallback: custom.embedFallback })]
		);
		const link = testId(nodeOf(edytor, 'e'), 'custom-embed-fallback')!;
		expect(link.parentElement!.hasAttribute('data-edytor-embed-unsupported')).toBe(true);
		expect(link.textContent).toBe('Open https://example.com/page');
		expect(link.getAttribute('href')).toBe('https://example.com/page');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(document.querySelector('iframe')).toBeNull();
	});
});

describe('table of contents: the entries and the empty text', () => {
	const toc = createTocPlugin({ entry: custom.tocEntry, empty: custom.tocEmpty });
	const h = (id: string, level: string, text: string, children?: JSONBlock[]): JSONBlock => ({
		id,
		type: 'heading',
		data: { level },
		content: [{ text }],
		...(children && { children })
	});

	it('the `entry` snippet lists the headings; its click reveals and scrolls to one, the selection stays', async () => {
		const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
		const { edytor } = await render(
			[
				{ id: 't', type: 'toc' },
				h('a', 'h1', 'Intro'),
				{
					id: 'g',
					type: 'toggle',
					content: [{ text: 'More' }],
					children: [h('b', 'h2', '')]
				}
			],
			[toc]
		);
		const entries = [...nodeOf(edytor, 't').querySelectorAll('[data-testid="custom-toc-entry"]')];
		expect(entries.map((entry) => [entry.textContent, entry.getAttribute('data-depth')])).toEqual([
			['1. Intro', '0'],
			['2. Untitled', '1']
		]);
		// The attachment gives the marker; the markup renders the rest from the payload's values.
		expect(entries[1]!.hasAttribute('data-edytor-toc-entry')).toBe(true);
		(nodeOf(edytor, 'g') as HTMLDetailsElement).open = false;
		const before = edytor.selection.value;
		await press(entries[1]!);
		expect((nodeOf(edytor, 'g') as HTMLDetailsElement).open).toBe(true);
		expect(scroll.mock.contexts).toEqual([nodeOf(edytor, 'b')]);
		expect(edytor.selection.value).toEqual(before);
	});

	it('the `empty` snippet shows while there is no heading', async () => {
		const { edytor } = await render([{ id: 't', type: 'toc' }, p('x')], [toc]);
		expect(testId(nodeOf(edytor, 't'), 'custom-toc-empty')!.textContent).toBe(
			'Add headings to create a table of contents.'
		);
		expect(nodeOf(edytor, 't').querySelector('[data-edytor-toc-empty]')).toBeNull();
	});
});

describe('page: the link to the page', () => {
	it('the `link` snippet opens the page on a click, a new tab on a modified one', async () => {
		const open = vi.fn();
		const { edytor } = await render(
			[{ id: 'a', type: 'page', data: { pageId: 'p-1', title: 'Roadmap' } }, p('z')],
			[createPagePlugin({ open, link: custom.pageLink })]
		);
		const link = testId(nodeOf(edytor, 'a'), 'custom-page-link')!;
		expect(link.localName).toBe('button');
		expect(link.textContent).toBe('→ Roadmap');
		expect(link.hasAttribute('data-edytor-page-link')).toBe(true);
		expect((link as HTMLButtonElement).disabled).toBe(false);
		await press(link);
		expect(open).toHaveBeenLastCalledWith('p-1', { newTab: false });
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
		expect(open).toHaveBeenLastCalledWith('p-1', { newTab: true });
	});

	it('with `href` it is a link to the page', async () => {
		const { edytor } = await render(
			[{ id: 'a', type: 'page', data: { pageId: 'p-1' } }, p('z')],
			[createPagePlugin({ href: (id) => `/p/${id}`, link: custom.pageLink })]
		);
		const link = testId(nodeOf(edytor, 'a'), 'custom-page-link')!;
		expect(link.localName).toBe('a');
		expect(link.getAttribute('href')).toBe('/p/p-1');
		expect(link.getAttribute('draggable')).toBe('false');
		expect(link.textContent).toBe('→ Untitled');
	});
});
