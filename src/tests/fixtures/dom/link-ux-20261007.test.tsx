/** @jsxImportSource ../../jsx */
/**
 * Link UX (WU-25, F11), after Notion:
 *
 * - `link.autolink.typed`: a URL typed before a space (`http:`/`https:`
 *   with a host, or `mailto:`; trailing `.,;:!?` left out) becomes a link
 *   when the space is typed, as its own undo step: undo gives the plain
 *   text back, the space kept. Not in a code block, not over text already
 *   linked or marked `code`, never a script URL.
 * - `link.autolink.pasted`: a URL pasted at a caret is inserted as a link;
 *   the paste and the link are two steps, so undo gives the plain URL back.
 * - `link.mod-k`: Mod+K over a text range opens the toolbar's link panel
 *   with its field focused; at a caret inside a link it selects the link
 *   first. Enter applies, Escape closes; both give the editor its focus back
 *   with the range still selected.
 * - `link.card`: hovering a link shows a card (overlay) with its URL and
 *   Open, Edit and Remove. Open opens it in a new tab, Edit selects the link
 *   and opens the link panel, Remove unlinks it (one undo step).
 * - `link.mod-click`: Mod+click on a link opens it in a new tab.
 *
 * Expected states are hand-authored from Notion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import {
	dispatchClipboardPaste,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

const URL = 'https://edytor.dev/docs';
const link = (href = URL) => ({ link: { href } });

let open: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	open = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

const render = async (children: JSONBlock[], options: { readonly?: boolean } = {}) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, codePlugin, toolbarPlugin],
			value: { children },
			autoSelectFixture: false,
			...options
		}
	);

const p = (id: string, ...content: NonNullable<JSONBlock['content']>): JSONBlock => ({
	id,
	type: 'paragraph',
	content
});

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const content = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.value.content;
const textOf = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.firstText!;

const caret = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(textOf(edytor, id), offset);
	await flushDomUpdates();
};

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};

const undo = async (edytor: Edytor) => {
	edytor.historyUndo();
	await flushDomUpdates();
};

const press = async (element: Element, init: MouseEventInit = {}) => {
	for (const type of ['mousedown', 'mouseup', 'click'])
		element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
	await flushDomUpdates();
};

const hover = async (element: Element, from: Element | null = null) => {
	element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
	await flushDomUpdates();
};

const leave = async (element: Element, to: Element | null) => {
	element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
	await flushDomUpdates();
};

const linkInput = () =>
	document.querySelector<HTMLInputElement>('[data-testid="toolbar-link-input"]');
const card = () => document.querySelector<HTMLElement>('[data-testid="link-card"]');
const anchorIn = (editor: HTMLElement) => editor.querySelector<HTMLAnchorElement>('a[href]')!;

describe('link.autolink.typed: a URL typed before a space becomes a link', () => {
	it('the URL is linked when the space is typed; the space is not', async () => {
		const { edytor, editor } = await render([p('a', { text: 'see ' })]);
		await caret(edytor, 'a', 4);
		await type(editor, `${URL} `);
		expect(content(edytor, 'a')).toEqual([
			{ text: 'see ' },
			{ text: URL, marks: link() },
			{ text: ' ' }
		]);
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart]).toEqual([true, 4 + URL.length + 1]);
	});

	it('typing on after it is plain text', async () => {
		const { edytor, editor } = await render([p('a', { text: '' })]);
		await caret(edytor, 'a', 0);
		await type(editor, `${URL} next`);
		expect(content(edytor, 'a')).toEqual([{ text: URL, marks: link() }, { text: ' next' }]);
	});

	it('undo gives the plain text back, the space kept', async () => {
		const { edytor, editor } = await render([p('a', { text: 'see ' })]);
		await caret(edytor, 'a', 4);
		await type(editor, `${URL} `);
		await undo(edytor);
		expect(content(edytor, 'a')).toEqual([{ text: `see ${URL} ` }]);
	});

	it('mailto: links too', async () => {
		const { edytor, editor } = await render([p('a', { text: '' })]);
		await caret(edytor, 'a', 0);
		await type(editor, 'mailto:hi@edytor.dev ');
		expect(content(edytor, 'a')).toEqual([
			{ text: 'mailto:hi@edytor.dev', marks: link('mailto:hi@edytor.dev') },
			{ text: ' ' }
		]);
	});

	it('trailing punctuation stays out of the link', async () => {
		const { edytor, editor } = await render([p('a', { text: '' })]);
		await caret(edytor, 'a', 0);
		await type(editor, 'https://edytor.dev. ');
		expect(content(edytor, 'a')).toEqual([
			{ text: 'https://edytor.dev', marks: link('https://edytor.dev') },
			{ text: '. ' }
		]);
	});

	it.each(['edytor.dev ', 'javascript:alert(1) ', 'https:// ', 'ftp://edytor.dev '])(
		'%j stays text',
		async (typed) => {
			const { edytor, editor } = await render([p('a', { text: '' })]);
			await caret(edytor, 'a', 0);
			await type(editor, typed);
			expect(content(edytor, 'a')).toEqual([{ text: typed }]);
		}
	);

	it('a URL already linked is left as it is', async () => {
		const other = 'https://other.dev';
		const { edytor, editor } = await render([p('a', { text: URL, marks: link(other) })]);
		await caret(edytor, 'a', URL.length);
		await type(editor, ' ');
		const runs = content(edytor, 'a') as { text: string; marks?: object }[];
		expect(runs.map((run) => run.text).join('')).toBe(`${URL} `);
		expect(runs.filter((run) => run.marks).every((run) => equal(run.marks, link(other)))).toBe(
			true
		);
	});

	it('inline code is not linked', async () => {
		const { edytor, editor } = await render([p('a', { text: URL, marks: { code: true } })]);
		await caret(edytor, 'a', URL.length);
		await type(editor, ' ');
		expect(content(edytor, 'a')).toEqual([{ text: `${URL} `, marks: { code: true } }]);
	});

	it('a code block is not linked', async () => {
		const { edytor, editor } = await render([
			{
				id: 'c',
				type: 'code',
				children: [{ id: 'l', type: 'codeLine', content: [{ text: '' }] }]
			}
		]);
		await caret(edytor, 'l', 0);
		await type(editor, `${URL} `);
		expect(content(edytor, 'l')).toEqual([{ text: `${URL} ` }]);
	});
});

describe('link.autolink.pasted: a URL pasted at a caret is inserted as a link', () => {
	it('the URL lands linked, the caret after it', async () => {
		const { edytor, editor } = await render([p('a', { text: 'Read now' })]);
		await caret(edytor, 'a', 5);
		await dispatchClipboardPaste(editor, { 'text/plain': `  ${URL}\n` });
		expect(content(edytor, 'a')).toEqual([
			{ text: 'Read ' },
			{ text: URL, marks: link() },
			{ text: 'now' }
		]);
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart]).toEqual([true, 5 + URL.length]);
	});

	it('undo gives the plain URL back; a second undo removes it', async () => {
		const { edytor, editor } = await render([p('a', { text: 'Read now' })]);
		await caret(edytor, 'a', 5);
		await dispatchClipboardPaste(editor, { 'text/plain': URL });
		await undo(edytor);
		expect(content(edytor, 'a')).toEqual([{ text: `Read ${URL}now` }]);
		await undo(edytor);
		expect(content(edytor, 'a')).toEqual([{ text: 'Read now' }]);
	});

	it('text that is not one URL pastes as text', async () => {
		const { edytor, editor } = await render([p('a', { text: 'Read now' })]);
		await caret(edytor, 'a', 5);
		await dispatchClipboardPaste(editor, { 'text/plain': `${URL} and more ` });
		expect(content(edytor, 'a')).toEqual([{ text: `Read ${URL} and more now` }]);
	});

	it('a code block takes the URL as text', async () => {
		const { edytor, editor } = await render([
			{
				id: 'c',
				type: 'code',
				children: [{ id: 'l', type: 'codeLine', content: [{ text: 'let a' }] }]
			}
		]);
		await caret(edytor, 'l', 5);
		await dispatchClipboardPaste(editor, { 'text/plain': URL });
		expect(content(edytor, 'l')).toEqual([{ text: `let a${URL}` }]);
	});
});

describe('link.mod-k: Mod+K opens the link panel', () => {
	it('over a range: the panel opens with its field focused', async () => {
		const { edytor } = await render([p('a', { text: 'Read the docs' })]);
		await setNativeSelection(edytor, textOf(edytor, 'a'), 9, textOf(edytor, 'a'), 13);
		const { defaultPrevented } = await dispatchDomKeyDown(document, { key: 'k', ctrlKey: true });
		expect(defaultPrevented).toBe(true);
		expect(linkInput()).not.toBeNull();
		expect(document.activeElement).toBe(linkInput());
	});

	it('Enter applies the link and gives the editor its focus, the range kept', async () => {
		const { edytor, editor } = await render([p('a', { text: 'Read the docs' })]);
		await setNativeSelection(edytor, textOf(edytor, 'a'), 9, textOf(edytor, 'a'), 13);
		await dispatchDomKeyDown(document, { key: 'k', ctrlKey: true });
		const input = linkInput()!;
		input.value = URL;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await flushDomUpdates();
		expect(content(edytor, 'a')).toEqual([{ text: 'Read the ' }, { text: 'docs', marks: link() }]);
		expect(linkInput()).toBeNull();
		expect(editor.contains(document.activeElement)).toBe(true);
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart, state.yEnd]).toEqual([false, 9, 13]);
	});

	it('Escape closes the panel and gives the editor its focus', async () => {
		const { edytor, editor } = await render([p('a', { text: 'Read the docs' })]);
		await setNativeSelection(edytor, textOf(edytor, 'a'), 9, textOf(edytor, 'a'), 13);
		await dispatchDomKeyDown(document, { key: 'k', ctrlKey: true });
		linkInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flushDomUpdates();
		expect(linkInput()).toBeNull();
		expect(editor.contains(document.activeElement)).toBe(true);
		expect(content(edytor, 'a')).toEqual([{ text: 'Read the docs' }]);
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart, state.yEnd]).toEqual([false, 9, 13]);
	});

	it('at a caret inside a link: the link is selected and the panel shows its URL', async () => {
		const { edytor } = await render([
			p('a', { text: 'Read the ' }, { text: 'docs', marks: link() }, { text: ' now' })
		]);
		await caret(edytor, 'a', 11);
		await dispatchDomKeyDown(document, { key: 'k', ctrlKey: true });
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart, state.yEnd]).toEqual([false, 9, 13]);
		expect(linkInput()?.value).toBe(URL);
	});

	it('at a caret outside any link: nothing opens', async () => {
		const { edytor } = await render([p('a', { text: 'Read the docs' })]);
		await caret(edytor, 'a', 2);
		await dispatchDomKeyDown(document, { key: 'k', ctrlKey: true });
		expect(linkInput()).toBeNull();
	});
});

describe('link.card: hovering a link shows its card', () => {
	const linked = () => [
		p('a', { text: 'Read the ' }, { text: 'docs', marks: link() }, { text: ' now' })
	];

	it('shows the URL with Open, Edit and Remove; leaving hides it', async () => {
		const { editor } = await render(linked());
		await hover(anchorIn(editor));
		expect(card()).not.toBeNull();
		expect(card()!.textContent).toContain(URL);
		for (const id of ['link-card-open', 'link-card-edit', 'link-card-remove'])
			expect(card()!.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
		await leave(anchorIn(editor), document.body);
		expect(card()).toBeNull();
	});

	it('moving from the link onto the card keeps it', async () => {
		const { editor } = await render(linked());
		await hover(anchorIn(editor));
		await leave(anchorIn(editor), card());
		expect(card()).not.toBeNull();
	});

	it('Open opens the link in a new tab', async () => {
		const { editor } = await render(linked());
		await hover(anchorIn(editor));
		await press(card()!.querySelector('[data-testid="link-card-open"]')!);
		expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
	});

	it('Edit selects the link and opens the link panel on its URL', async () => {
		const { edytor, editor } = await render(linked());
		await hover(anchorIn(editor));
		await press(card()!.querySelector('[data-testid="link-card-edit"]')!);
		const { state } = edytor.selection;
		expect([state.isCollapsed, state.yStart, state.yEnd]).toEqual([false, 9, 13]);
		expect(linkInput()?.value).toBe(URL);
		expect(card()).toBeNull();
	});

	it('Remove unlinks the whole link as one undo step', async () => {
		const { edytor, editor } = await render(linked());
		await hover(anchorIn(editor));
		await press(card()!.querySelector('[data-testid="link-card-remove"]')!);
		expect(content(edytor, 'a')).toEqual([{ text: 'Read the docs now' }]);
		expect(card()).toBeNull();
		await undo(edytor);
		expect(content(edytor, 'a')).toEqual(linked()[0]!.content);
	});

	it('a readonly view shows no card', async () => {
		const { editor } = await render(linked(), { readonly: true });
		await hover(anchorIn(editor));
		expect(card()).toBeNull();
	});
});

describe('link.mod-click: Mod+click opens a link', () => {
	it('opens it in a new tab', async () => {
		const { editor } = await render([p('a', { text: 'docs', marks: link() })]);
		const anchor = anchorIn(editor);
		const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
		anchor.dispatchEvent(event);
		expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
		expect(event.defaultPrevented).toBe(true);
	});

	it('a plain click does not', async () => {
		const { editor } = await render([p('a', { text: 'docs', marks: link() })]);
		anchorIn(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(open).not.toHaveBeenCalled();
	});
});
