/** @jsxImportSource ../../jsx */
/**
 * A container's body (`body.*` in the delete contract): an open toggle and
 * a callout show where their content goes. An empty body shows a hint
 * (chrome, never content) whose press creates the first child; Enter at
 * the end of the header goes into the body; a toggle this view creates
 * opens. A callout is an icon, a title (its own text) and a content (its
 * children); its icon is `data.icon`, picked in a popover.
 *
 * Expected states are hand-authored from Notion and the contract rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	createRichTextPlaceholder,
	createRichTextPlugin,
	richTextPlaceholder,
	richTextPlugin
} from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';
import { customPicker } from '../../dom/CustomCalloutPicker.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const render = (
	children: JSONBlock[],
	plugins: Plugin[] = [richTextPlugin],
	options: { readonly?: boolean } = {}
) => renderDomEdytor(empty, { plugins, value: { children }, ...options });

type Outline = string | [string, Outline[]];
const outline = (block: JSONBlock): Outline => {
	const text = (block.content ?? []).map((p) => ('text' in p ? p.text : '@')).join('');
	const self = text ? `${block.type} "${text}"` : block.type;
	return block.children?.length ? [self, block.children.map(outline)] : self;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
const caret = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return [startBlock?.parent?.id ?? null, startBlock?.index, yStart, isCollapsed];
};
const typeText = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
const nodeOf = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.node as HTMLElement;
const hintOf = (edytor: Edytor, id: string) =>
	[...nodeOf(edytor, id).querySelectorAll<HTMLElement>('[data-edytor-empty-body]')].find(
		(hint) => hint.closest('[data-edytor-block="true"]') === nodeOf(edytor, id)
	) ?? null;
/** A press and its click, as a pointer gives them. */
const press = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const atEnd = async (edytor: Edytor, id: string) => {
	const text = edytor.idToBlock.get(id)!.firstText!;
	edytor.selection.setAtTextOffset(text, text.length);
	await flushDomUpdates();
};
const enter = (editor: HTMLElement) =>
	dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });

const toggle = (): JSONBlock[] => [
	{ id: 't', type: 'toggle', content: [{ text: 'title' }] },
	{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
];
const callout = (children?: JSONBlock[], data: Record<string, string> = { icon: '💡' }) => [
	{ id: 'c', type: 'callout', data, content: [{ text: 'note' }], ...(children && { children }) },
	{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
];

describe('body.hint: an empty body shows where its content goes', () => {
	it('an empty toggle holds the hint, never as content or editable text', async () => {
		const { edytor } = await render(toggle());
		const hint = hintOf(edytor, 't')!;
		expect(hint).not.toBeNull();
		// Inside the `details`, after its `summary`: the browser shows it only while open.
		expect(hint.parentElement).toBe(nodeOf(edytor, 't'));
		expect(hint.previousElementSibling?.localName).toBe('summary');
		expect(hint.getAttribute('contenteditable')).toBe('false');
		expect(hint.textContent).toBe('Empty toggle. Click or drop blocks inside.');
		expect(hint.querySelector('[data-edytor-text]')).toBeNull();
		expect(doc(edytor)).toEqual(['toggle "title"', 'paragraph "after"']);
	});

	it('a toggle with children, a readonly view and a quote show none', async () => {
		const withBody = await render([
			{
				id: 't',
				type: 'toggle',
				content: [{ text: 'title' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			},
			{ id: 'q', type: 'quote', content: [{ text: 'quote' }] }
		]);
		expect(hintOf(withBody.edytor, 't')).toBeNull();
		expect(hintOf(withBody.edytor, 'q')).toBeNull();
		document.body.innerHTML = '';
		const readonly = await render(toggle(), [richTextPlugin], { readonly: true });
		expect(hintOf(readonly.edytor, 't')).toBeNull();
	});

	it('the hint goes once the body has a child, and comes back when it has none', async () => {
		const { edytor, editor } = await render(toggle());
		(nodeOf(edytor, 't') as HTMLDetailsElement).open = true;
		await atEnd(edytor, 't');
		await enter(editor);
		expect(doc(edytor)).toEqual([['toggle "title"', ['paragraph']], 'paragraph "after"']);
		expect(hintOf(edytor, 't')).toBeNull();
		await undo();
		expect(doc(edytor)).toEqual(['toggle "title"', 'paragraph "after"']);
		expect(hintOf(edytor, 't')).not.toBeNull();
	});

	it("pressing a toggle's hint creates its first child, the caret in it: one undo step", async () => {
		const { edytor, editor } = await render(toggle());
		(nodeOf(edytor, 't') as HTMLDetailsElement).open = true;
		await press(hintOf(edytor, 't')!);
		expect(doc(edytor)).toEqual([['toggle "title"', ['paragraph']], 'paragraph "after"']);
		expect(caret(edytor)).toEqual(['t', 0, 0, true]);
		expect(edytor.dispatcher.last?.status).toBe('applied');
		await typeText(editor, 'hi');
		expect(doc(edytor)).toEqual([['toggle "title"', ['paragraph "hi"']], 'paragraph "after"']);
		await undo();
		expect(doc(edytor)).toEqual([['toggle "title"', ['paragraph']], 'paragraph "after"']);
		await undo();
		expect(doc(edytor)).toEqual(['toggle "title"', 'paragraph "after"']);
	});

	it("pressing a callout's hint creates its first child", async () => {
		const { edytor } = await render(callout());
		await press(hintOf(edytor, 'c')!);
		expect(doc(edytor)).toEqual([['callout "note"', ['paragraph']], 'paragraph "after"']);
		expect(caret(edytor)).toEqual(['c', 0, 0, true]);
		await undo();
		expect(doc(edytor)).toEqual(['callout "note"', 'paragraph "after"']);
	});

	it('a readonly view refuses nothing it never shows', async () => {
		const { edytor } = await render(callout(), [richTextPlugin], { readonly: true });
		expect(hintOf(edytor, 'c')).toBeNull();
	});
});

describe('body.open: a toggle this view creates opens', () => {
	it('`> ` typed on a new line makes an open toggle; Enter after its title goes into the body', async () => {
		const { edytor, editor } = await render(
			[{ id: 'a', type: 'paragraph', content: [] }],
			[markdownShortcutsPlugin, richTextPlugin]
		);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 0);
		await flushDomUpdates();
		await typeText(editor, '> ');
		expect(doc(edytor)).toEqual(['toggle']);
		expect((nodeOf(edytor, 'a') as HTMLDetailsElement).open).toBe(true);
		expect(hintOf(edytor, 'a')).not.toBeNull();
		await typeText(editor, 'title');
		await enter(editor);
		expect(doc(edytor)).toEqual([['toggle "title"', ['paragraph']]]);
		expect(caret(edytor)).toEqual(['a', 0, 0, true]);
	});

	it('the toggle command (slash menu, Turn into) opens the toggle it makes', async () => {
		const { edytor } = await render([{ id: 'a', type: 'paragraph', content: [{ text: 'title' }] }]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 2);
		await flushDomUpdates();
		await edytor.runCommand('block.toggle');
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['toggle "title"']);
		expect((nodeOf(edytor, 'a') as HTMLDetailsElement).open).toBe(true);
	});

	it('a closed toggle turned into a toggle heading stays closed', async () => {
		const { edytor } = await render([
			{
				id: 't',
				type: 'toggle',
				content: [{ text: 'title' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
		expect((nodeOf(edytor, 't') as HTMLDetailsElement).open).toBe(false);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('t')!.firstText!, 0);
		await flushDomUpdates();
		await edytor.runCommand('block.toggle-heading2');
		await flushDomUpdates();
		expect(edytor.idToBlock.get('t')!.type).toBe('toggle-heading');
		expect((nodeOf(edytor, 't') as HTMLDetailsElement).open).toBe(false);
	});

	it('Enter at the end of a closed toggle still opens a closed sibling toggle', async () => {
		const { edytor, editor } = await render(toggle());
		await atEnd(edytor, 't');
		await enter(editor);
		expect(doc(edytor)).toEqual(['toggle "title"', 'toggle', 'paragraph "after"']);
		const sibling = edytor.root!.children[1]!;
		expect((sibling.node as HTMLDetailsElement).open).toBe(false);
	});
});

describe('callout: an icon, a title and a content', () => {
	it('renders its icon, its title and the hint of its empty content', async () => {
		const { edytor } = await render(callout());
		const node = nodeOf(edytor, 'c');
		const icon = node.querySelector<HTMLElement>('[data-edytor-callout-icon]')!;
		expect(icon.localName).toBe('button');
		expect(icon.textContent?.trim()).toBe('💡');
		expect(icon.getAttribute('aria-label')).toBe('Change icon');
		const title = node.querySelector<HTMLElement>('[data-edytor-callout-title]')!;
		expect(title.textContent).toBe('note');
		expect(title.querySelector('[data-edytor-text]')).not.toBeNull();
		expect(hintOf(edytor, 'c')?.textContent).toBe('Empty callout. Click or drop blocks inside.');
	});

	it('its children are its content, any kind nested any way, and no hint shows', async () => {
		const { edytor } = await render(
			callout([
				{
					type: 'toggle',
					content: [{ text: 'deep' }],
					children: [{ type: 'bulleted-list-item', content: [{ text: 'item' }] }]
				},
				{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'h' }] }
			])
		);
		expect(hintOf(edytor, 'c')).toBeNull();
		expect(doc(edytor)[0]).toEqual([
			'callout "note"',
			[['toggle "deep"', ['bulleted-list-item "item"']], 'heading "h"']
		]);
	});

	it('Enter at the end of its title (no content yet) starts its content', async () => {
		const { edytor, editor } = await render(callout());
		await atEnd(edytor, 'c');
		await enter(editor);
		expect(doc(edytor)).toEqual([['callout "note"', ['paragraph']], 'paragraph "after"']);
		expect(caret(edytor)).toEqual(['c', 0, 0, true]);
		await typeText(editor, 'body');
		expect(doc(edytor)).toEqual([['callout "note"', ['paragraph "body"']], 'paragraph "after"']);
	});

	it('Enter in the middle of its title moves the rest into its content', async () => {
		const { edytor, editor } = await render(callout());
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('c')!.firstText!, 2);
		await flushDomUpdates();
		await enter(editor);
		expect(doc(edytor)).toEqual([['callout "no"', ['paragraph "te"']], 'paragraph "after"']);
	});

	it('its empty title shows its placeholder, focused or not', () => {
		expect(richTextPlaceholder({ type: 'callout', data: {}, focused: false } as never)).toBe(
			'Callout title'
		);
		expect(
			createRichTextPlaceholder({ placeholders: { callout: 'Titre' } })({
				type: 'callout',
				data: {},
				focused: true
			} as never)
		).toBe('Titre');
	});

	it('a readonly view shows the icon, no button', async () => {
		const { edytor } = await render(callout(), [richTextPlugin], { readonly: true });
		const icon = nodeOf(edytor, 'c').querySelector<HTMLElement>('[data-edytor-callout-icon]')!;
		expect(icon.localName).toBe('span');
		expect(icon.textContent?.trim()).toBe('💡');
	});

	it('copies as its icon, title, then content, which pastes back as the callout', async () => {
		const { edytor, editor } = await render([
			...callout([{ type: 'paragraph', content: [{ text: 'body' }] }], { icon: '🔥' }),
			{ id: 'e', type: 'paragraph', content: [] }
		]);
		// A block selection is exactly its members (`sel.blocks.exact`): the callout and its content.
		const c = edytor.idToBlock.get('c')!;
		edytor.selection.selectBlocks(c, c.children[0]!);
		await flushDomUpdates();
		const { clipboardData } = await dispatchCopy(editor);
		const html = clipboardData['text/html']!;
		expect(html).toContain('<div data-edytor-callout="🔥"><p>note</p><p>body</p></div>');
		expect(clipboardData['text/plain']).toBe('note\nbody');
		await atEnd(edytor, 'e');
		await dispatchClipboardPaste(editor, {
			'text/html': html.replace(/<span[^>]*hidden><\/span>/, ''),
			'text/plain': 'note\nbody'
		});
		const pasted = edytor.value.children!.find(
			(block) => block.type === 'callout' && block.id !== 'c'
		)!;
		expect(pasted.data).toMatchObject({ icon: '🔥' });
		expect(outline(pasted)).toEqual(['callout "note"', ['paragraph "body"']]);
	});

	it('a pasted callout with an empty title keeps its first paragraph as content', async () => {
		const { edytor, editor } = await render([{ id: 'p', type: 'paragraph', content: [] }]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('p')!.firstText!, 0);
		await flushDomUpdates();
		await dispatchClipboardPaste(editor, {
			'text/html': '<div data-edytor-callout="💡"><p></p><p>body</p></div>',
			'text/plain': 'body'
		});
		expect(doc(edytor)).toEqual([['callout', ['paragraph "body"']]]);
	});
});

describe('callout.icon: the icon picker', () => {
	const picker = () => document.querySelector<HTMLElement>('[data-edytor-callout-icons]');
	const choices = () => [
		...(picker()?.querySelectorAll<HTMLButtonElement>('[data-edytor-callout-icon-choice]') ?? [])
	];
	/** The open picker's menu: the element holding the focus and the keys. */
	const menu = () =>
		document.querySelector<HTMLElement>('[role="menu"][aria-label="Callout icons"]');
	/** The keyboard's row: the one the menu names. */
	const active = () =>
		document.getElementById(menu()?.getAttribute('aria-activedescendant') ?? '') as HTMLElement;
	const iconButton = (edytor: Edytor) =>
		nodeOf(edytor, 'c').querySelector<HTMLButtonElement>('[data-edytor-callout-icon]')!;

	it('a click on the icon opens the picker; a choice writes data.icon as one undo step', async () => {
		const { edytor } = await render(callout());
		expect(picker()).toBeNull();
		await press(iconButton(edytor));
		expect(picker()).not.toBeNull();
		expect(iconButton(edytor).getAttribute('aria-expanded')).toBe('true');
		expect(menu()).not.toBeNull();
		expect(document.activeElement).toBe(menu());
		const fire = choices().find((choice) => choice.textContent?.trim() === '🔥')!;
		expect(fire.getAttribute('role')).toBe('menuitemradio');
		await press(fire);
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('🔥');
		expect(picker()).toBeNull();
		expect(iconButton(edytor).textContent?.trim()).toBe('🔥');
		expect(doc(edytor)).toEqual(['callout "note"', 'paragraph "after"']);
		await undo();
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('💡');
	});

	it('the keyboard walks the choices; Enter picks, Escape closes with nothing written', async () => {
		const { edytor } = await render(callout());
		await press(iconButton(edytor));
		// The menu holds the keys; the current icon is the keyboard's row.
		expect(document.activeElement).toBe(menu());
		expect(active().textContent?.trim()).toBe('💡');
		expect(active().getAttribute('aria-checked')).toBe('true');
		await dispatchDomKeyDown(menu()!, { key: 'ArrowRight' });
		expect(active()).toBe(choices()[1]);
		expect(active().hasAttribute('data-active')).toBe(true);
		await dispatchDomKeyDown(menu()!, { key: 'ArrowDown' });
		expect(active()).toBe(choices()[9]);
		await dispatchDomKeyDown(menu()!, { key: 'Escape' });
		expect(picker()).toBeNull();
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('💡');
		// The editor takes the keys back.
		expect(document.activeElement).toBe(edytor.node);
		await press(iconButton(edytor));
		await dispatchDomKeyDown(menu()!, { key: 'ArrowRight' });
		const picked = active().textContent?.trim();
		await dispatchDomKeyDown(menu()!, { key: 'Enter' });
		expect(picker()).toBeNull();
		expect(edytor.idToBlock.get('c')!.data.icon).toBe(picked);
	});

	it('Remove icon leaves the callout without one; the button stays to add one back', async () => {
		const { edytor } = await render(callout());
		await press(iconButton(edytor));
		const remove = picker()!.querySelector<HTMLElement>('[data-edytor-callout-icon-remove]')!;
		expect(remove.textContent?.trim()).toBe('Remove icon');
		await press(remove);
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('');
		expect(iconButton(edytor).hasAttribute('data-empty')).toBe(true);
		expect(iconButton(edytor).getAttribute('aria-label')).toBe('Add icon');
		expect(iconButton(edytor).textContent?.trim()).toBe('');
	});

	it('a press outside closes it', async () => {
		const { edytor } = await render(callout());
		await press(iconButton(edytor));
		expect(picker()).not.toBeNull();
		await press(edytor.idToBlock.get('p')!.node!);
		expect(picker()).toBeNull();
	});

	it('createRichTextPlugin({ callout }) sets the default icon and the choices', async () => {
		const plugin = createRichTextPlugin({ callout: { icon: '📌', icons: ['📌', '✅', '❗'] } });
		const { edytor } = await render(
			[
				{ id: 'c', type: 'callout', content: [{ text: 'note' }] },
				{ id: 'p', type: 'paragraph', content: [{ text: 'x' }] }
			],
			[plugin]
		);
		// No icon of its own: the view's default.
		expect(iconButton(edytor).textContent?.trim()).toBe('📌');
		await press(iconButton(edytor));
		expect(choices().map((choice) => choice.textContent?.trim())).toEqual(['📌', '✅', '❗']);
		await dispatchDomKeyDown(menu()!, { key: 'Escape' });
		// A new callout takes the default icon.
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('p')!.firstText!, 0);
		await flushDomUpdates();
		await edytor.runCommand('block.callout');
		await flushDomUpdates();
		expect(edytor.idToBlock.get('p')!.type).toBe('callout');
		expect(edytor.idToBlock.get('p')!.data.icon).toBe('📌');
	});

	it('the block menu of a callout opens the picker (the keyboard way)', async () => {
		const { edytor, editor } = await render(callout(), [blockMenuPlugin, richTextPlugin]);
		const block = edytor.idToBlock.get('c')!;
		edytor.selection.selectBlocks(block);
		editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
		const row = document.querySelector<HTMLElement>('[data-testid="block-menu-callout.icon"]')!;
		expect(row.textContent).toContain('Change icon');
		await press(row);
		expect(document.activeElement).toBe(menu());
		expect(active().textContent?.trim()).toBe('💡');
	});

	it("an app's `callout.picker` snippet replaces the markup, with the controller's keys and rows", async () => {
		const plugin = createRichTextPlugin({
			callout: { icons: ['🅰️', '🅱️'], picker: customPicker }
		});
		const { edytor } = await render(callout(), [plugin]);
		await press(iconButton(edytor));
		const custom = document.querySelector<HTMLElement>('[data-testid="custom-picker"]')!;
		expect(custom).not.toBeNull();
		expect(document.querySelector('.callout-icons')).toBeNull();
		// The attachments: focus, keys, role and name, and the popup on the view's root.
		expect(document.activeElement).toBe(custom);
		expect(custom.getAttribute('role')).toBe('menu');
		expect(edytor.node!.getAttribute('aria-controls')).toBe(custom.id);
		expect(document.querySelector('[data-testid="custom-picker-current"]')!.textContent).toBe('💡');
		const icons = [...document.querySelectorAll<HTMLElement>('[data-testid="custom-icon"]')];
		expect(icons.map((icon) => icon.getAttribute('role'))).toEqual([
			'menuitemradio',
			'menuitemradio'
		]);
		await dispatchDomKeyDown(custom, { key: 'ArrowRight' });
		expect(custom.getAttribute('aria-activedescendant')).toBe(icons[1]!.id);
		await dispatchDomKeyDown(custom, { key: 'Enter' });
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('🅱️');
		expect(document.querySelector('[data-testid="custom-picker"]')).toBeNull();
		await press(iconButton(edytor));
		await press(document.querySelector('[data-testid="custom-remove"]')!);
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('');
		await press(iconButton(edytor));
		await press(document.querySelector('[data-testid="custom-close"]')!);
		expect(document.querySelector('[data-testid="custom-picker"]')).toBeNull();
		expect(edytor.idToBlock.get('c')!.data.icon).toBe('');
	});
});
