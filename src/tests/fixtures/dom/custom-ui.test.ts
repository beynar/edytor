/**
 * Default plugins, and the UI plugins' snippets: a slash row, the toolbar,
 * the block handle and the block menu each render your markup while the
 * plugins keep the behavior (commands, marks, grips, block actions).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import CustomUi from '../../dom/CustomUi.svelte';
import CustomChrome from '../../dom/CustomChrome.svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { englishLabels } from '$lib/labels.js';
import {
	dispatchClipboardPaste,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	setNativeSelection
} from '../../dom/test.utils.js';

const setup = async (children = [{ id: 'a', type: 'paragraph', content: [{ text: 'hello' }] }]) => {
	let edytor: Edytor | undefined;
	render(CustomUi, {
		props: {
			value: { children },
			get edytor() {
				return edytor;
			},
			set edytor(value) {
				edytor = value;
			}
		}
	});
	await flushDomUpdates();
	return { edytor: edytor!, editor: document.querySelector<HTMLElement>('[data-edytor]')! };
};

const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

describe('default plugins', () => {
	it('rich text, images and block moves come without listing them', async () => {
		const { edytor } = await setup();
		expect(edytor.blocks.has('heading')).toBe(true);
		expect(edytor.blocks.has('image')).toBe(true);
		expect(edytor.commands.has('block.image')).toBe(true);
	});
});

describe('UI snippets', () => {
	it('a slash row snippet renders the commands and runs them', async () => {
		const { edytor, editor } = await setup([
			{ id: 'a', type: 'paragraph', content: [{ text: '' }] }
		]);
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 0);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '/' });
		const rows = all('custom-slash');
		expect(rows.map((r) => r.textContent)).toContain('Heading 1');
		expect(rows[0]!.dataset.selected).toBe('true');
		await click(rows.find((r) => r.textContent === 'Heading 1')!);
		expect(edytor.value.children?.[0]).toMatchObject({ type: 'heading', data: { level: 'h1' } });
	});

	it('a toolbar snippet shows over a selection and formats it', async () => {
		const { edytor } = await setup();
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 5);
		await flushDomUpdates();
		await click(all('custom-toolbar')[0]!.querySelector('button')!);
		expect(edytor.value.children?.[0]?.content).toEqual([{ text: 'hello', marks: { bold: true } }]);
	});

	it('a handle snippet grips its block: the click opens the block menu snippet', async () => {
		const { edytor } = await setup([
			{ id: 'a', type: 'paragraph', content: [{ text: 'one' }] },
			{ id: 'b', type: 'quote', content: [{ text: 'two' }] }
		]);
		await click(all('custom-grip').find((g) => g.dataset.id === 'b')!);
		const menu = all('custom-block-menu')[0]!;
		expect(menu.textContent).toContain('quote');
		await click(menu.querySelector('button')!);
		expect(edytor.value.children?.map((b) => b.id)).toEqual(['a']);
	});

	it("the handle snippet's add opens the slash menu; a picked row adds the block", async () => {
		const { edytor } = await setup();
		await click(all('custom-add')[0]!);
		await flushDomUpdates();
		expect(edytor.value.children).toHaveLength(1);
		const row = all('custom-slash').find((button) => button.textContent === 'Heading 1')!;
		await click(row);
		expect(edytor.value.children?.map((block) => block.type)).toEqual(['paragraph', 'heading']);
	});
});

/**
 * A custom snippet that uses the controllers' attachments keeps the
 * built-in keyboard and ARIA (WAI-ARIA 1.2, site `editor/accessibility`):
 * the element holding the keyboard names the open popup (`aria-controls`)
 * and its highlighted row (`aria-activedescendant`): the root for the `/`
 * menu, a trigger menu and the URL paste menu, the menu's own field for the
 * `+` and block menus; the root names any open popup (`aria-controls`,
 * `aria-haspopup`), the control that opened one says so (`aria-expanded`);
 * the toolbar is reached with Alt+F10, one tab stop, Escape gives the focus
 * back. Expected states are the default markup's (`a11y.test.tsx`), never
 * read from a run of the custom one.
 */
describe('custom snippets with the attachments', () => {
	const chrome = async (children: JSONBlock[]) => {
		let edytor: Edytor | undefined;
		render(CustomChrome, {
			props: {
				value: { children },
				get edytor() {
					return edytor;
				},
				set edytor(value) {
					edytor = value;
				}
			}
		});
		await flushDomUpdates();
		return { edytor: edytor!, editor: document.querySelector<HTMLElement>('[data-edytor]')! };
	};
	const p = (id: string, text = id): JSONBlock => ({
		id,
		type: 'paragraph',
		content: [{ text }]
	});
	const named = (id: string | null) => (id ? document.getElementById(id) : null);
	const key = async (target: Element, init: KeyboardEventInit) => {
		target.dispatchEvent(
			new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
		);
		await flushDomUpdates();
	};
	const type = async (editor: HTMLElement, value: string) => {
		for (const data of value)
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
	};
	const caretIn = async (edytor: Edytor, id: string, offset: number) => {
		edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
		await flushDomUpdates();
	};
	/** The overlay measures in its next frame. */
	const frame = async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flushDomUpdates();
	};
	const one = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	const fill = async (field: HTMLInputElement, value: string) => {
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await flushDomUpdates();
	};
	const noPopup = (editor: HTMLElement) =>
		['aria-controls', 'aria-activedescendant', 'aria-haspopup'].filter((name) =>
			editor.hasAttribute(name)
		);
	/** The fixture's own handle (`handle` snippet): its `+` and grip carry the payload's ARIA. */
	const plus = (id: string) =>
		document.querySelector<HTMLElement>(`[data-testid="custom-add"][data-block-id="${id}"]`)!;
	const grip = (id: string) =>
		document.querySelector<HTMLElement>(`[data-testid="custom-grip"][data-block-id="${id}"]`)!;

	it('a `/` menu: the root names the listbox and its highlighted option, follows the arrows', async () => {
		const { edytor, editor } = await chrome([p('a')]);
		await caretIn(edytor, 'a', 1);
		await type(editor, ' /');
		const listbox = named(editor.getAttribute('aria-controls'));
		expect(listbox?.closest('[data-testid="custom-slash-menu"]')).not.toBeNull();
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(listbox?.getAttribute('aria-label')).toBe(englishLabels.slashMenu.list);
		expect(editor.getAttribute('aria-haspopup')).toBe('listbox');
		const options = all('custom-slash-row');
		expect(options.every((option) => option.getAttribute('role') === 'option')).toBe(true);
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[0]);
		expect(options[0]!.getAttribute('aria-selected')).toBe('true');

		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[1]);
		expect(options[1]!.getAttribute('aria-selected')).toBe('true');
		expect(options[1]!.dataset.selected).toBe('true');

		await dispatchDomKeyDown(document, { key: 'Escape' });
		expect(noPopup(editor)).toEqual([]);
	});

	it('a `+` menu: its own field holds the keyboard, names the list and the highlighted option', async () => {
		const { edytor, editor } = await chrome([p('a'), p('b')]);
		await click(plus('a'));
		const field = one('custom-slash-field') as HTMLInputElement;
		expect(document.activeElement).toBe(field);
		const listbox = named(field.getAttribute('aria-controls'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(named(editor.getAttribute('aria-controls'))).toBe(listbox);
		expect(plus('a').getAttribute('aria-expanded')).toBe('true');
		const options = () => all('custom-slash-row');
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(options()[0]);
		await key(field, { key: 'ArrowDown' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(options()[1]);
		// The root does not hold the keyboard: it names no option.
		expect(editor.hasAttribute('aria-activedescendant')).toBe(false);

		// The field filters; Enter runs the highlighted row in the block it adds.
		await fill(field, 'heading 1');
		expect(options()[0]?.textContent?.trim()).toBe('Heading 1');
		await key(field, { key: 'Enter' });
		expect(edytor.value.children?.map((block) => block.type)).toEqual([
			'paragraph',
			'heading',
			'paragraph'
		]);
		expect(plus('a').hasAttribute('aria-expanded')).toBe(false);
		expect(noPopup(editor)).toEqual([]);
	});

	it('a `+` menu: Escape closes it and adds nothing', async () => {
		const { edytor, editor } = await chrome([p('a'), p('b')]);
		await click(plus('a'));
		await key(one('custom-slash-field')!, { key: 'Escape' });
		expect(one('custom-slash-menu')).toBeNull();
		expect(edytor.value.children).toHaveLength(2);
		expect(noPopup(editor)).toEqual([]);
	});

	it('the block menu: its field holds the keyboard, the rows are menu items, → opens a flyout', async () => {
		const { edytor, editor } = await chrome([p('a'), p('b')]);
		await click(grip('a'));
		const field = one('custom-block-menu-field') as HTMLInputElement;
		expect(document.activeElement).toBe(field);
		const menu = named(field.getAttribute('aria-controls'));
		expect(menu?.getAttribute('role')).toBe('menu');
		expect(named(editor.getAttribute('aria-controls'))).toBe(menu);
		expect(editor.getAttribute('aria-haspopup')).toBe('menu');
		expect(grip('a').getAttribute('aria-expanded')).toBe('true');
		const rows = () => all('custom-block-menu-row');
		expect(rows()[0]!.getAttribute('role')).toBe('menuitem');
		expect(rows()[0]!.getAttribute('aria-haspopup')).toBe('menu');
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(rows()[0]);
		await key(field, { key: 'ArrowDown' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(rows()[1]);
		await key(field, { key: 'End' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(rows().at(-1));
		await key(field, { key: 'Home' });
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(rows()[0]);

		// → opens Turn into: the field names the flyout and its first row.
		await key(field, { key: 'ArrowRight' });
		const flyout = one('custom-block-menu-flyout')!;
		expect(flyout.getAttribute('role')).toBe('menu');
		expect(flyout.hasAttribute('data-edytor-block-menu-flyout')).toBe(true);
		expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
		expect(named(field.getAttribute('aria-controls'))).toBe(flyout);
		expect(named(field.getAttribute('aria-activedescendant'))).toBe(
			flyout.querySelector('[role="menuitem"]')
		);
		// Escape closes the flyout, then the menu.
		await key(field, { key: 'Escape' });
		expect(one('custom-block-menu-flyout')).toBeNull();
		expect(named(field.getAttribute('aria-controls'))).toBe(menu);
		await key(field, { key: 'Escape' });
		expect(one('custom-block-menu')).toBeNull();
		expect(grip('a').hasAttribute('aria-expanded')).toBe(false);
		expect(noPopup(editor)).toEqual([]);

		// Delete, with an empty query, removes the block.
		await click(grip('b'));
		await key(one('custom-block-menu-field')!, { key: 'Delete' });
		expect(edytor.value.children?.map((block) => block.id)).toEqual(['a']);
	});

	it('the toolbar: named by the root, reached with Alt+F10, one tab stop, Escape returns', async () => {
		const { edytor, editor } = await chrome([p('a', 'hello')]);
		const a = edytor.idToBlock.get('a')!;
		edytor.selection.setAtRange(a.firstText!, 0, a.firstText!, 5);
		await flushDomUpdates();
		const toolbar = named(editor.getAttribute('aria-controls'));
		expect(toolbar).toBe(one('custom-toolbar'));
		expect(toolbar?.getAttribute('role')).toBe('toolbar');
		expect(toolbar?.getAttribute('aria-label')).toBe(englishLabels.toolbar.bar);
		expect(toolbar?.hasAttribute('data-edytor-toolbar-bar')).toBe(true);
		expect(editor.getAttribute('aria-keyshortcuts')).toBe('Alt+F10');

		await dispatchDomKeyDown(editor, { key: 'F10', altKey: true });
		const stops = [...toolbar!.querySelectorAll<HTMLElement>('button')];
		expect(document.activeElement).toBe(stops[0]);
		expect(stops.filter((button) => button.tabIndex === 0)).toEqual([stops[0]]);
		await key(stops[0]!, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(stops[1]);
		expect(stops.filter((button) => button.tabIndex === 0)).toEqual([stops[1]]);
		await key(stops[1]!, { key: 'End' });
		expect(document.activeElement).toBe(stops.at(-1));
		await key(stops.at(-1)!, { key: 'Home' });
		expect(document.activeElement).toBe(stops[0]);
		await key(stops[0]!, { key: 'Escape' });
		expect(document.activeElement).toBe(editor);
		expect(edytor.selection.value).toMatchObject({ kind: 'text' });
	});

	it('the toolbar: the link field takes the focus when opened, Enter links the selection', async () => {
		const { edytor, editor } = await chrome([p('a', 'hello')]);
		const a = edytor.idToBlock.get('a')!;
		edytor.selection.setAtRange(a.firstText!, 0, a.firstText!, 5);
		await flushDomUpdates();
		await dispatchDomKeyDown(editor, {
			key: 'k',
			metaKey: edytor.keymap.isMac,
			ctrlKey: !edytor.keymap.isMac
		});
		const field = one('custom-toolbar-link-field') as HTMLInputElement;
		expect(document.activeElement).toBe(field);
		expect(field.id).toBe(edytor.popups.idOf('toolbar-link'));
		expect(document.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
		await fill(field, 'https://edytor.dev');
		await key(field, { key: 'Enter' });
		expect(edytor.value.children?.[0]?.content).toEqual([
			{ text: 'hello', marks: { link: { href: 'https://edytor.dev' } } }
		]);
		expect(document.activeElement).toBe(editor);
	});

	it('the link card: a `card` snippet shows under a hovered link', async () => {
		const { editor } = await chrome([
			{
				id: 'a',
				type: 'paragraph',
				content: [{ text: 'docs', marks: { link: { href: 'https://edytor.dev' } } }]
			}
		]);
		editor.querySelector('a[href]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		await flushDomUpdates();
		expect(one('custom-link-card')?.textContent).toContain('https://edytor.dev');
		expect(document.querySelector('[data-testid="link-card"]')).toBeNull();
	});

	it('a trigger menu: the root names the listbox and its highlighted option; Enter picks', async () => {
		const { edytor, editor } = await chrome([p('a', '')]);
		await caretIn(edytor, 'a', 0);
		await type(editor, '@a');
		const listbox = named(editor.getAttribute('aria-controls'));
		expect(listbox).toBe(one('custom-mention-menu'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(listbox?.getAttribute('aria-label')).toBe(englishLabels.mention.menu);
		const options = [...listbox!.querySelectorAll('[role="option"]')];
		expect(options.map((option) => option.textContent)).toEqual([
			'Ada Lovelace',
			'Alan Turing',
			'Grace Hopper'
		]);
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[0]);
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[1]);
		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(edytor.value.children?.[0]?.content).toMatchObject([
			{ type: 'mention', data: { id: 'alan', label: 'Alan Turing' } }
		]);
		expect(noPopup(editor)).toEqual([]);
	});

	it('the URL paste menu: the root names the listbox and its highlighted option; Enter converts', async () => {
		const { edytor, editor } = await chrome([{ id: 'p', type: 'paragraph', content: [] }]);
		await setNativeSelection(edytor, edytor.idToBlock.get('p')!.firstText, 0);
		const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
		await dispatchClipboardPaste(editor, { 'text/plain': url });
		await flushDomUpdates();
		const listbox = named(editor.getAttribute('aria-controls'));
		expect(listbox).toBe(one('custom-paste-menu'));
		expect(listbox?.getAttribute('role')).toBe('listbox');
		expect(editor.getAttribute('aria-haspopup')).toBe('listbox');
		const options = [...listbox!.querySelectorAll<HTMLElement>('[role="option"]')];
		expect(options.map((option) => option.dataset.option)).toEqual(['link', 'embed']);
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[0]);
		await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		expect(named(editor.getAttribute('aria-activedescendant'))).toBe(options[1]);
		await dispatchDomKeyDown(editor, { key: 'Enter' });
		expect(edytor.value.children?.[0]).toMatchObject({ type: 'embed', data: { url } });
		expect(noPopup(editor)).toEqual([]);
	});

	it('the image toolbar: placed on the hovered image; its alt field focuses, Enter closes it', async () => {
		const src = 'https://example.com/a.png';
		const { edytor, editor } = await chrome([
			{ id: 'img', type: 'image', data: { src }, content: [{ text: '' }] },
			p('b')
		]);
		editor
			.querySelector('[data-edytor-image] img')!
			.dispatchEvent(new Event('pointerover', { bubbles: true }));
		await frame();
		const toolbar = one('custom-image-toolbar')!;
		expect(toolbar.getAttribute('role')).toBe('toolbar');
		expect(toolbar.getAttribute('aria-label')).toBe(englishLabels.image.toolbar);
		expect(document.querySelector('[data-edytor-image-toolbar]')).toBe(toolbar);
		await click(one('custom-image-left')!);
		expect(edytor.facade.blockDataOf('img')).toEqual({ src, align: 'left' });

		await click(one('custom-image-alt')!);
		const field = one('custom-image-alt-field') as HTMLInputElement;
		expect(document.activeElement).toBe(field);
		await fill(field, 'a cat');
		expect(edytor.facade.blockDataOf('img')).toEqual({ src, align: 'left', alt: 'a cat' });
		// A press on the toolbar keeps the field: its Alt button closes it.
		await click(one('custom-image-alt')!);
		expect(one('custom-image-alt-field')).toBeNull();
		await click(one('custom-image-alt')!);
		await key(one('custom-image-alt-field')!, { key: 'Enter' });
		expect(one('custom-image-alt-field')).toBeNull();
	});

	it('an empty image and an empty embed render their `empty` snippet; Enter embeds the link', async () => {
		const { edytor } = await chrome([
			{ id: 'img', type: 'image', content: [{ text: '' }] },
			{ id: 'e', type: 'embed', content: [{ text: '' }] }
		]);
		expect(document.querySelector('[data-edytor-image-add]')).toBeNull();
		const image = one('custom-image-empty-field') as HTMLInputElement;
		await fill(image, 'not a source');
		await key(image, { key: 'Enter' });
		expect(one('custom-image-empty-error')?.textContent).toBe('invalid');
		await fill(image, 'https://example.com/a.png');
		await key(image, { key: 'Enter' });
		expect(edytor.facade.blockDataOf('img')).toEqual({ src: 'https://example.com/a.png' });

		expect(one('custom-media-empty')?.dataset.kind).toBe('embed');
		const embed = one('custom-media-empty-field') as HTMLInputElement;
		await fill(embed, 'https://example.com/not-a-player');
		await key(embed, { key: 'Enter' });
		expect(one('custom-media-empty-error')?.textContent).toBe('invalid');
		await fill(embed, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		await key(embed, { key: 'Enter' });
		expect(edytor.facade.blockDataOf('e')).toEqual({
			url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
		});
	});

	it('a suggestion `bar` reads the plugin’s words from its payload', async () => {
		const { edytor } = await chrome([p('a')]);
		edytor.suggestions.add({ after: 'a' }, [{ type: 'paragraph', content: [{ text: 'more' }] }]);
		await flushDomUpdates();
		expect(one('custom-suggestion-bar')?.textContent).toContain(
			englishLabels.suggestions.suggestion
		);
		expect(one('custom-suggestion-accept')?.textContent).toBe(englishLabels.suggestions.accept);
		await click(one('custom-suggestion-accept')!);
		expect(edytor.value.children?.map((block) => block.content)).toEqual([
			[{ text: 'a' }],
			[{ text: 'more' }]
		]);
	});

	it('a handle: its `+` and grip name the menu they opened from the payload (`expanded`, `controls`)', async () => {
		const { editor } = await chrome([p('a'), p('b')]);
		expect(plus('a').getAttribute('aria-label')).toBe(englishLabels.blockHandles.add('Text'));
		expect(grip('a').getAttribute('aria-label')).toBe(englishLabels.blockHandles.grip('Text'));
		expect(plus('a').hasAttribute('aria-controls')).toBe(false);
		await click(plus('a'));
		const list = named(plus('a').getAttribute('aria-controls'));
		expect(list?.getAttribute('role')).toBe('listbox');
		expect(named(editor.getAttribute('aria-controls'))).toBe(list);
		await key(one('custom-slash-field')!, { key: 'Escape' });
		expect(plus('a').hasAttribute('aria-controls')).toBe(false);

		await click(grip('b'));
		expect(grip('b').getAttribute('aria-expanded')).toBe('true');
		expect(named(grip('b').getAttribute('aria-controls'))?.getAttribute('role')).toBe('menu');
		expect(grip('a').hasAttribute('aria-expanded')).toBe(false);
		await key(one('custom-block-menu-field')!, { key: 'Escape' });
		expect(grip('b').hasAttribute('aria-controls')).toBe(false);
	});

	describe('a table’s grips, menu and `+` (`grip`, `menu`, `add`)', () => {
		const cell = (id: string, column: string): JSONBlock => ({
			id,
			type: 'tableCell',
			data: { column },
			content: [{ text: id.toLowerCase() }]
		});
		const table = (): JSONBlock[] => [
			p('p'),
			{
				id: 'T',
				type: 'table',
				data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
				children: [
					{ id: 'R1', type: 'tableRow', children: [cell('A', 'c1'), cell('B', 'c2')] },
					{ id: 'R2', type: 'tableRow', children: [cell('C', 'c1'), cell('D', 'c2')] }
				]
			},
			p('z')
		];
		const texts = (edytor: Edytor) =>
			edytor.facade
				.tableGrid('T')
				?.rows.map((r) => r.cells.map((c) => (c === null ? '_' : edytor.facade.blockText(c))));
		const hover = async (edytor: Edytor, editor: HTMLElement, id: string) => {
			editor
				.querySelector(`[data-edytor-id="${id}"]`)!
				.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
			edytor.overlay.invalidate();
			await frame();
		};
		const tableGrip = (kind: 'row' | 'column') =>
			document.querySelector<HTMLElement>(`[data-testid="custom-table-grip"][data-kind="${kind}"]`);
		const rows = () => all('custom-table-row');

		it('a grip: drags, names its menu; its menu holds the keys, walks the rows that run, Escape returns', async () => {
			const { edytor, editor } = await chrome(table());
			await hover(edytor, editor, 'A');
			const grip = tableGrip('row')!;
			// No built-in grip: the app's, placed in the grip's host.
			expect(document.querySelector('[data-edytor-table-grip]')).toBeNull();
			expect(grip.closest('[data-edytor-table-grip-host="row"]')).not.toBeNull();
			expect(grip.dataset.index).toBe('0');
			expect(grip.getAttribute('draggable')).toBe('true');
			expect(grip.getAttribute('aria-label')).toBe(englishLabels.table.rowMenu);
			expect(grip.getAttribute('aria-haspopup')).toBe('menu');
			expect(grip.getAttribute('aria-expanded')).toBe('false');
			expect(tableGrip('column')?.getAttribute('aria-label')).toBe(englishLabels.table.columnMenu);

			await click(grip);
			const menu = one('custom-table-menu')!;
			expect(menu.closest('[data-edytor-table-menu-host]')).not.toBeNull();
			expect(document.activeElement).toBe(menu);
			expect(menu.getAttribute('role')).toBe('menu');
			expect(menu.getAttribute('aria-label')).toBe(englishLabels.table.rowMenu);
			expect(menu.dataset.edytorTableMenu).toBe('row');
			expect(named(editor.getAttribute('aria-controls'))).toBe(menu);
			expect(editor.getAttribute('aria-haspopup')).toBe('menu');
			expect(grip.getAttribute('aria-expanded')).toBe('true');
			expect(named(grip.getAttribute('aria-controls'))).toBe(menu);
			expect(rows().map((row) => row.dataset.row)).toEqual([
				'insert-above',
				'insert-below',
				'move-up',
				'move-down',
				'delete-row'
			]);
			expect(rows().every((row) => row.getAttribute('role') === 'menuitem')).toBe(true);
			// The first row cannot move up.
			expect(rows()[2]!.getAttribute('aria-disabled')).toBe('true');
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[0]);
			expect(rows()[0]!.dataset.selected).toBe('true');
			await key(menu, { key: 'ArrowDown' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[1]);
			// The arrows skip the row that cannot run.
			await key(menu, { key: 'ArrowDown' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[3]);
			await key(menu, { key: 'End' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[4]);
			await key(menu, { key: 'ArrowDown' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[0]);
			await key(menu, { key: 'ArrowUp' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[4]);
			await key(menu, { key: 'Home' });
			expect(named(menu.getAttribute('aria-activedescendant'))).toBe(rows()[0]);

			await key(menu, { key: 'Escape' });
			expect(one('custom-table-menu')).toBeNull();
			expect(noPopup(editor)).toEqual([]);
			expect(tableGrip('row')?.getAttribute('aria-expanded')).toBe('false');
			expect(document.activeElement).toBe(editor);
			expect(texts(edytor)).toEqual([
				['a', 'b'],
				['c', 'd']
			]);
		});

		it('a grip’s menu: Enter runs the keyboard’s row; ArrowDown on a grip opens it', async () => {
			const { edytor, editor } = await chrome(table());
			await hover(edytor, editor, 'A');
			await click(tableGrip('row')!);
			await key(one('custom-table-menu')!, { key: 'ArrowDown' });
			await key(one('custom-table-menu')!, { key: 'Enter' });
			expect(one('custom-table-menu')).toBeNull();
			expect(texts(edytor)).toEqual([
				['a', 'b'],
				['', ''],
				['c', 'd']
			]);

			await hover(edytor, editor, 'B');
			const column = tableGrip('column')!;
			await key(column, { key: 'ArrowDown' });
			const menu = one('custom-table-menu')!;
			expect(menu.dataset.edytorTableMenu).toBe('column');
			expect(menu.getAttribute('aria-label')).toBe(englishLabels.table.columnMenu);
			expect(document.activeElement).toBe(menu);
			// Move left: the second column becomes the first.
			const at = rows().findIndex((row) => row.dataset.row === 'move-left');
			for (let step = 0; step < at; step++) await key(menu, { key: 'ArrowDown' });
			await key(menu, { key: 'Enter' });
			expect(texts(edytor)).toEqual([
				['b', 'a'],
				['', ''],
				['d', 'c']
			]);
		});

		it('a `+` snippet adds a row under the table and a column beside it', async () => {
			const { edytor, editor } = await chrome(table());
			await hover(edytor, editor, 'A');
			const adds = all('custom-table-add');
			expect(adds.map((add) => add.dataset.kind)).toEqual(['row', 'column']);
			expect(adds.map((add) => add.getAttribute('aria-label'))).toEqual([
				englishLabels.table.addRow,
				englishLabels.table.addColumn
			]);
			expect(document.querySelector('[data-edytor-table-add]')).toBeNull();
			await click(adds[0]!);
			expect(texts(edytor)).toHaveLength(3);
			await hover(edytor, editor, 'A');
			await click(all('custom-table-add')[1]!);
			expect(texts(edytor)?.[0]).toEqual(['a', 'b', '']);
		});
	});

	describe('a code block’s header and language list (`header`, `menu`)', () => {
		const code = (language = 'sql'): JSONBlock[] => [
			{
				id: 'code',
				type: 'code',
				data: { language },
				children: [{ id: 'l0', type: 'codeLine', content: [{ text: 'x' }] }]
			}
		];
		const button = () => one('custom-code-language')!;
		const rows = () => all('custom-language-row');
		const highlighted = () => rows().find((row) => row.getAttribute('aria-selected') === 'true');

		it('the header’s button opens the list; its field holds the keys and names the highlighted row', async () => {
			const { edytor, editor } = await chrome(code());
			expect(document.querySelector('[data-edytor-code-language]')).toBeNull();
			expect(button().textContent).toBe('SQL');
			expect(button().getAttribute('aria-haspopup')).toBe('listbox');
			expect(button().getAttribute('aria-expanded')).toBe('false');
			expect(button().getAttribute('aria-label')).toBe(`${englishLabels.code.language}: SQL`);

			await click(button());
			// Placed under the button in the overlay's next frame.
			await frame();
			const field = one('custom-language-field') as HTMLInputElement;
			expect(document.activeElement).toBe(field);
			expect(field.getAttribute('role')).toBe('combobox');
			expect(field.getAttribute('aria-expanded')).toBe('true');
			const list = named(field.getAttribute('aria-controls'));
			expect(list?.getAttribute('role')).toBe('listbox');
			expect(list?.getAttribute('aria-label')).toBe(englishLabels.code.language);
			expect(named(editor.getAttribute('aria-controls'))).toBe(list);
			expect(editor.getAttribute('aria-haspopup')).toBe('listbox');
			expect(button().getAttribute('aria-expanded')).toBe('true');
			expect(named(button().getAttribute('aria-controls'))).toBe(list);
			expect(rows().every((row) => row.getAttribute('role') === 'option')).toBe(true);
			// The block's language is highlighted and marked.
			expect(highlighted()?.dataset.language).toBe('sql');
			expect(highlighted()?.dataset.current).toBe('true');
			expect(named(field.getAttribute('aria-activedescendant'))).toBe(highlighted());

			await fill(field, 'script');
			expect(rows().map((row) => row.dataset.language)).toEqual(['javascript', 'typescript']);
			await key(field, { key: 'ArrowDown' });
			expect(highlighted()?.dataset.language).toBe('typescript');
			expect(named(field.getAttribute('aria-activedescendant'))).toBe(highlighted());
			await key(field, { key: 'Enter' });
			expect(one('custom-language-menu')).toBeNull();
			expect(edytor.facade.blockDataOf('code')).toEqual({ language: 'typescript' });
			expect(button().textContent).toBe('TypeScript');
			expect(button().getAttribute('aria-expanded')).toBe('false');
			expect(noPopup(editor)).toEqual([]);
		});

		it('opened by the keys, Escape gives them back to the button and writes nothing', async () => {
			const { edytor, editor } = await chrome(code());
			edytor.selection.setAtTextOffset(edytor.idToBlock.get('l0')!.firstText!, 1);
			await flushDomUpdates();
			await dispatchDomKeyDown(editor, { key: 'F10', code: 'F10', altKey: true });
			expect(document.activeElement).toBe(button());
			await key(button(), { key: 'ArrowDown' });
			await frame();
			const field = one('custom-language-field')!;
			expect(document.activeElement).toBe(field);
			await key(field, { key: 'ArrowDown' });
			await key(field, { key: 'Escape' });
			expect(one('custom-language-menu')).toBeNull();
			expect(document.activeElement).toBe(button());
			expect(edytor.facade.blockDataOf('code')).toEqual({ language: 'sql' });
			// Escape on the button gives the keys back to the editor.
			await key(button(), { key: 'Escape' });
			expect(document.activeElement).toBe(editor);
		});

		it('a readonly view: the header shows the label, nothing opens', async () => {
			const { edytor } = await chrome(code('python'));
			edytor.readonly = true;
			await flushDomUpdates();
			expect(button().tagName).toBe('SPAN');
			expect(button().textContent).toBe('Python');
		});
	});

	describe('an equation’s editor (`panel`)', () => {
		const equation = (): JSONBlock[] => [
			{ id: 'eq', type: 'equation', data: { expression: 'x^2' } },
			p('b')
		];
		const open = async (editor: HTMLElement) => {
			editor
				.querySelector<HTMLElement>('[data-edytor-equation]')!
				.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await frame();
		};

		it('the field takes the focus; typing writes the source; Enter closes, the equation selected', async () => {
			const { edytor, editor } = await chrome(equation());
			await open(editor);
			const panel = one('custom-equation-panel')!;
			expect(document.querySelector('[data-edytor-equation-editor]')).toBeNull();
			expect(panel.closest('[data-edytor-equation-panel][data-display="block"]')).not.toBeNull();
			const field = one('custom-equation-field') as HTMLInputElement;
			expect(document.activeElement).toBe(field);
			expect(field.value).toBe('x^2');
			expect(field.selectionStart).toBe(3);
			await fill(field, 'x^3');
			expect(edytor.facade.blockDataOf('eq')).toEqual({ expression: 'x^3' });
			// Shift+Enter in a block equation is the field's own (a newline in a textarea).
			await key(field, { key: 'Enter', shiftKey: true });
			expect(one('custom-equation-panel')).not.toBeNull();
			await key(field, { key: 'Enter' });
			expect(one('custom-equation-panel')).toBeNull();
			expect(edytor.selection.value).toMatchObject({ kind: 'blocks', ids: ['eq'] });
			expect(document.activeElement).toBe(editor);
		});

		it('Enter on the selected equation opens it again; Escape closes it', async () => {
			const { edytor, editor } = await chrome(equation());
			edytor.selection.selectBlocks(edytor.idToBlock.get('eq')!);
			await flushDomUpdates();
			await dispatchDomKeyDown(editor, { key: 'Enter' });
			await frame();
			const field = one('custom-equation-field')!;
			expect(document.activeElement).toBe(field);
			await key(field, { key: 'Escape' });
			expect(one('custom-equation-panel')).toBeNull();
			expect(edytor.facade.blockDataOf('eq')).toEqual({ expression: 'x^2' });
		});

		it('focus leaving the panel closes it', async () => {
			const { editor } = await chrome(equation());
			await open(editor);
			const field = one('custom-equation-field')!;
			field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: editor }));
			await flushDomUpdates();
			expect(one('custom-equation-panel')).toBeNull();
		});
	});
});
