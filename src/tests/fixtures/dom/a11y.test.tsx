/** @jsxImportSource ../../jsx */
/**
 * Accessibility (WU-27, F7; WU-29, F14). Expected states come from the
 * WAI-ARIA 1.2 patterns, never from a run:
 *
 * - the root textbox takes its accessible name and id from the view's props
 *   (`aria-label`, `aria-labelledby`, `aria-describedby`, `id`);
 * - while a menu is open, the element that holds the keyboard names it
 *   (`aria-controls`) and its highlighted row (`aria-activedescendant`): the
 *   root for the `/` menu, the menu's own field for the `+` and block menus;
 *   the root names any open popup (`aria-controls`, `aria-haspopup`), and the
 *   control that opened one (a `+`, a grip) says so (`aria-expanded`);
 * - the toolbar is named by the root while it shows, Alt+F10 moves the focus
 *   to it, the arrows walk it (roving tab stop), Escape gives the focus back;
 * - a handle is named after its block's kind (its preset label);
 * - a polite live region announces block moves and deletes;
 * - a block takes the direction of its own text's first strong character
 *   (`dir`, as `dir="auto"` reads it); one holding none keeps its parent's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { englishLabels } from '$lib/labels.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	type RenderDomEdytorOptions
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const h1 = (id: string, text = id): JSONBlock => ({
	id,
	type: 'heading',
	data: { level: 'h1' },
	content: [{ text }]
});

const render = (
	children: JSONBlock[],
	plugins: Plugin[] = [],
	options: RenderDomEdytorOptions = {}
) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], value: { children }, ...options }
	);

const click = async (element: Element, init: MouseEventInit = {}) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
	await flushDomUpdates();
};
const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const key = async (target: Element, init: KeyboardEventInit) => {
	target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
	await flushDomUpdates();
};
/** The element an IDREF names, in the page. */
const named = (id: string | null) => (id ? document.getElementById(id) : null);
const caretIn = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};

describe('the root textbox (F7)', () => {
	it('takes aria-label, aria-labelledby, aria-describedby and id from the view', async () => {
		const { editor } = await render([p('a')], [], {
			label: {
				'aria-label': 'Page body',
				'aria-labelledby': 'title',
				'aria-describedby': 'hint',
				id: 'body'
			}
		});
		expect(editor.getAttribute('role')).toBe('textbox');
		expect(editor.getAttribute('aria-label')).toBe('Page body');
		expect(editor.getAttribute('aria-labelledby')).toBe('title');
		expect(editor.getAttribute('aria-describedby')).toBe('hint');
		expect(editor.id).toBe('body');
	});

	it('names no popup while none is open', async () => {
		const { editor } = await render([p('a')], [slashMenuPlugin, toolbarPlugin]);
		for (const name of ['aria-controls', 'aria-activedescendant', 'aria-haspopup'])
			expect(editor.hasAttribute(name)).toBe(false);
	});
});

describe('the / menu: the root holds the keyboard', () => {
	it('names the listbox and its highlighted option, follows the arrows, forgets them at close', async () => {
		const { edytor, editor } = await render([p('a')], [slashMenuPlugin]);
		await caretIn(edytor, 'a', 1);
		await type(editor, ' /');
		const listbox = named(editor.getAttribute('aria-controls'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(editor.getAttribute('aria-haspopup')).toBe('listbox');
		const options = [...listbox!.querySelectorAll('[role="option"]')];
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[0]);

		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[1]);
		expect(options[1]!.getAttribute('aria-selected')).toBe('true');

		await dispatchDomKeyDown(document, { key: 'Escape' });
		for (const name of ['aria-controls', 'aria-activedescendant', 'aria-haspopup'])
			expect(editor.hasAttribute(name)).toBe(false);
	});
});

describe('the + menu: its field holds the keyboard', () => {
	const plus = (id: string) =>
		document.querySelector(
			`[data-edytor-block-handle-host][data-block-id="${id}"] [data-testid="block-add"]`
		)!;

	it('the + is expanded, the field names the listbox and the highlighted option', async () => {
		const { editor } = await render([p('a'), p('b')], [slashMenuPlugin]);
		expect(plus('a').hasAttribute('aria-expanded')).toBe(false);
		await click(plus('a'));
		const field = document.querySelector<HTMLInputElement>('[data-testid="slash-menu"] input')!;
		expect(document.activeElement).toBe(field);
		const listbox = named(field.getAttribute('aria-controls'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(named(editor.getAttribute('aria-controls'))).toBe(listbox);
		expect(plus('a').getAttribute('aria-expanded')).toBe('true');
		expect(named(plus('a').getAttribute('aria-controls'))).toBe(listbox);
		expect(plus('b').hasAttribute('aria-expanded')).toBe(false);
		const options = [...listbox!.querySelectorAll('[role="option"]')];
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(options[0]);
		await key(field, { key: 'ArrowDown' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(options[1]);
		// The root does not hold the keyboard: it names no option.
		expect(editor.hasAttribute('aria-activedescendant')).toBe(false);

		await key(field, { key: 'Escape' });
		expect(plus('a').hasAttribute('aria-expanded')).toBe(false);
		expect(editor.hasAttribute('aria-controls')).toBe(false);
	});
});

describe('the block menu: its field holds the keyboard', () => {
	const grip = (id: string) =>
		document.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!;

	it('the grip is expanded, the field names the menu and the highlighted item', async () => {
		const { editor } = await render([p('a'), p('b')], [blockMenuPlugin]);
		await click(grip('a'));
		const field = document.querySelector<HTMLInputElement>('[data-testid="block-menu"] input')!;
		expect(document.activeElement).toBe(field);
		const menu = named(field.getAttribute('aria-controls'));
		expect(menu?.getAttribute('role')).toBe('menu');
		expect(named(editor.getAttribute('aria-controls'))).toBe(menu);
		expect(editor.getAttribute('aria-haspopup')).toBe('menu');
		expect(grip('a').getAttribute('aria-expanded')).toBe('true');
		expect(grip('a').getAttribute('aria-haspopup')).toBe('menu');
		expect(grip('b').hasAttribute('aria-expanded')).toBe(false);
		const items = [...menu!.querySelectorAll('[role="menuitem"]')];
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(items[0]);
		await key(field, { key: 'ArrowDown' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(items[1]);

		await key(field, { key: 'Escape' });
		expect(grip('a').hasAttribute('aria-expanded')).toBe(false);
		expect(editor.hasAttribute('aria-controls')).toBe(false);
	});
});

describe('the toolbar: named by the root, reached with Alt+F10', () => {
	it('names the toolbar while it shows; Alt+F10 focuses it, the arrows walk it, Escape returns', async () => {
		const { edytor, editor } = await render([p('a', 'hello')], [toolbarPlugin]);
		const a = edytor.idToBlock.get('a')!;
		edytor.selection.setAtRange(a.firstText!, 0, a.firstText!, 5);
		await flushDomUpdates();
		const toolbar = named(editor.getAttribute('aria-controls'));
		expect(toolbar?.getAttribute('role')).toBe('toolbar');
		expect(editor.getAttribute('aria-keyshortcuts')).toBe('Alt+F10');

		await dispatchDomKeyDown(editor, { key: 'F10', altKey: true });
		const stops = [...toolbar!.querySelectorAll<HTMLElement>('button')];
		expect(document.activeElement).toBe(stops[0]);
		// One tab stop: the focused button.
		expect(stops.filter((b) => b.tabIndex === 0)).toEqual([stops[0]]);
		await key(stops[0]!, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(stops[1]);
		await key(stops[1]!, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(stops[0]);
		await key(stops[0]!, { key: 'End' });
		expect(document.activeElement).toBe(stops.at(-1));

		await key(document.activeElement!, { key: 'Escape' });
		expect(document.activeElement).toBe(editor);
		const { startText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, yEnd]).toEqual(['a', 0, 5]);
	});

	it('names nothing once the selection collapses', async () => {
		const { edytor, editor } = await render([p('a', 'hello')], [toolbarPlugin]);
		const a = edytor.idToBlock.get('a')!;
		edytor.selection.setAtRange(a.firstText!, 0, a.firstText!, 5);
		await flushDomUpdates();
		expect(editor.hasAttribute('aria-controls')).toBe(true);
		await caretIn(edytor, 'a', 2);
		expect(editor.hasAttribute('aria-controls')).toBe(false);
		expect(editor.hasAttribute('aria-keyshortcuts')).toBe(false);
	});

	it('the link field’s label names it, and two views’ fields never share an id', async () => {
		const views = [
			await render([p('a', 'hello')], [toolbarPlugin]),
			await render([p('b', 'world')], [toolbarPlugin])
		];
		const fields: HTMLInputElement[] = [];
		for (const { edytor, container } of views) {
			const text = edytor.root!.children[0]!.firstText!;
			edytor.selection.setAtRange(text, 0, text, 5);
			await flushDomUpdates();
			await click(container.querySelector('[data-testid="toolbar-link"]')!);
			const field = container.querySelector<HTMLInputElement>(
				'[data-testid="toolbar-link-input"]'
			)!;
			expect(document.activeElement).toBe(field);
			expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(
				englishLabels.toolbar.linkUrl
			);
			fields.push(field);
		}
		expect(fields[0]!.id).not.toBe(fields[1]!.id);
	});
});

describe('handles are named after their block (the kind preset label)', () => {
	it('the grip and the + name the block’s kind, not its type id', async () => {
		await render([h1('t'), p('a')]);
		const handle = (id: string) =>
			document.querySelector(`[data-edytor-block-handle-host][data-block-id="${id}"]`)!;
		const grip = (id: string) => handle(id).querySelector('[data-testid="block-handle"]')!;
		const plus = (id: string) => handle(id).querySelector('[data-testid="block-add"]')!;
		expect(grip('t').getAttribute('aria-label')).toBe(
			'Heading 1 block: drag to move, click for actions'
		);
		expect(grip('a').getAttribute('aria-label')).toBe(
			'Text block: drag to move, click for actions'
		);
		expect(plus('t').getAttribute('aria-label')).toBe('Add a block below Heading 1 (Alt: above)');
	});
});

describe('the live region announces block moves and deletes', () => {
	const region = () => document.querySelector('[data-edytor-live]');

	it('is polite, outside the host, and empty at first', async () => {
		const { editor } = await render([p('a')]);
		const live = region()!;
		expect(live.getAttribute('aria-live')).toBe('polite');
		expect(live.getAttribute('role')).toBe('status');
		expect(editor.contains(live)).toBe(false);
		expect(live.textContent).toBe('');
	});

	it('a move says what moved and where', async () => {
		const { edytor } = await render([h1('t'), p('a'), p('b')], [arrowMovePlugin]);
		await caretIn(edytor, 't', 1);
		await dispatchDomKeyDown(document, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });
		expect(edytor.value.children!.map((b) => b.id)).toEqual(['a', 't', 'b']);
		expect(region()!.textContent).toBe('Moved Heading 1 block down');
		// The same move again is announced again (a new node).
		const first = region()!.firstElementChild;
		await dispatchDomKeyDown(document, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });
		expect(region()!.textContent).toBe('Moved Heading 1 block down');
		expect(region()!.firstElementChild).not.toBe(first);
	});

	it('a block delete says how many blocks went', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c')]);
		edytor.selection.selectBlocks(edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(edytor.value.children!.map((b) => b.id)).toEqual(['c']);
		expect(region()!.textContent).toBe('Deleted 2 blocks');
	});

	it('a refused move announces nothing', async () => {
		const { edytor } = await render([p('a'), p('b')], [arrowMovePlugin]);
		await caretIn(edytor, 'a', 1);
		await dispatchDomKeyDown(document, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
		expect(region()!.textContent).toBe('');
	});
});

describe('bidi (F14): each block takes the direction of its own text', () => {
	const dirs = (editor: HTMLElement) =>
		[...editor.querySelectorAll('[data-edytor-block]')].map((block) => block.getAttribute('dir'));

	it('its first strong character decides; a block holding none keeps its parent’s', async () => {
		// An empty or neutral block (digits, punctuation) has no `dir`: `auto`
		// would read it left to right in a right-to-left page.
		const { editor } = await render([
			p('a', 'שלום world'),
			p('b', '12, مرحبا'),
			p('c', 'hello שלום'),
			p('d', ''),
			p('e', '12, 3')
		]);
		expect(dirs(editor)).toEqual(['rtl', 'rtl', 'ltr', null, null]);
		// The text elements carry none: an engine moves the caret by the block's.
		expect(editor.querySelector('[data-edytor-text]')!.hasAttribute('dir')).toBe(false);
	});

	it('follows the text: typing a Hebrew letter into an empty block makes it right to left', async () => {
		const { edytor, editor } = await render([p('a', '')]);
		await caretIn(edytor, 'a', 0);
		await type(editor, 'ש');
		expect(dirs(editor)).toEqual(['rtl']);
	});

	it('foreign damage to it is healed (the attribute table owns it)', async () => {
		const { editor } = await render([p('a', 'שלום'), p('b', '12')]);
		const [hebrew, digits] = [...editor.querySelectorAll('[data-edytor-block]')];
		hebrew!.setAttribute('dir', 'ltr');
		digits!.setAttribute('dir', 'rtl');
		await flushDomUpdates();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await flushDomUpdates();
		expect(dirs(editor)).toEqual(['rtl', null]);
	});
});
