/** @jsxImportSource ../../jsx */
/**
 * Notion parity: the shortcuts, markdown and menus the demos rely on.
 * Expected states are hand-authored from Notion's behavior.
 */
import { describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlaceholder, richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const render = (plugins: Plugin[], value?: { children: JSONBlock[] }) =>
	renderDomEdytor(empty, {
		plugins: [richTextPlugin, mentionPlugin, ...plugins],
		...(value && { value })
	});

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};

/** A caret at the start of the `index`th top-level block (a `value` carries no cursor). */
const caretIn = async (edytor: Awaited<ReturnType<typeof render>>['edytor'], index = 0) => {
	const text = edytor.root!.children[index]!.firstText!;
	edytor.selection.setAtTextOffset(text, 0);
	await flushDomUpdates();
};

const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

describe('inline markdown', () => {
	it.each([
		['**bold** ', [{ text: 'bold', marks: { bold: true } }, { text: ' ' }]],
		['*it* ', [{ text: 'it', marks: { italic: true } }, { text: ' ' }]],
		['_it_ ', [{ text: 'it', marks: { italic: true } }, { text: ' ' }]],
		['`code` ', [{ text: 'code', marks: { code: true } }, { text: ' ' }]],
		['~~gone~~ ', [{ text: 'gone', marks: { strike: true } }, { text: ' ' }]],
		['a *b* ', [{ text: 'a ' }, { text: 'b', marks: { italic: true } }, { text: ' ' }]]
	])('%j marks its content and drops the markers', async (typed, content) => {
		const { edytor, editor } = await render([markdownShortcutsPlugin]);
		await type(editor, typed);
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content }]);
	});

	it.each(['x * a*', '2 * 3 * 4', 'x ** **'])('%j stays text (padded or empty)', async (typed) => {
		const { edytor, editor } = await render([markdownShortcutsPlugin]);
		await type(editor, typed);
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: typed }] }]);
	});
});

describe('inline markdown refused', () => {
	it('a plugin refusing the shortcut leaves the character as typed', async () => {
		const refuse: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'inlineMarkdown') prevent();
			}
		});
		const { edytor, editor } = await render([refuse, markdownShortcutsPlugin]);
		await type(editor, '`x`');
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: '`x`' }] }]);
	});
});

describe('shortcuts', () => {
	it('Mod+Alt+1 turns the block into a Heading 1, Mod+Alt+0 back into text', async () => {
		const { edytor } = await render([]);
		await dispatchDomKeyDown(document, { key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
		expect(canonicalTree(edytor)).toEqual([{ type: 'heading', data: { level: 'h1' } }]);
		await dispatchDomKeyDown(document, { key: '0', code: 'Digit0', ctrlKey: true, altKey: true });
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph' }]);
	});

	it('Mod+Enter checks and unchecks a to-do', async () => {
		const { edytor } = await render([], {
			children: [{ type: 'todo-item', data: { checked: false }, content: [{ text: 'task' }] }]
		});
		await caretIn(edytor);
		await dispatchDomKeyDown(document, { key: 'Enter', ctrlKey: true });
		expect(canonicalTree(edytor)[0]).toMatchObject({ data: { checked: true } });
		await dispatchDomKeyDown(document, { key: 'Enter', ctrlKey: true });
		expect(canonicalTree(edytor)[0]).toMatchObject({ data: { checked: false } });
	});

	it('clicking the to-do checkbox checks it', async () => {
		const { edytor } = await render([], {
			children: [{ type: 'todo-item', data: { checked: false }, content: [{ text: 'task' }] }]
		});
		await click(document.querySelector('[data-edytor-todo-checkbox]')!);
		expect(canonicalTree(edytor)[0]).toMatchObject({ data: { checked: true } });
	});

	it('Mod+Shift+Down moves the caret block (no selection needed)', async () => {
		const { edytor } = await render([arrowMovePlugin], {
			children: [
				{ type: 'paragraph', content: [{ text: 'a' }] },
				{ type: 'paragraph', content: [{ text: 'b' }] }
			]
		});
		await caretIn(edytor);
		await dispatchDomKeyDown(document, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });
		expect(canonicalTree(edytor).map((b) => b.content?.[0]?.text)).toEqual(['b', 'a']);
	});

	it('Mod+D duplicates the caret block', async () => {
		const { edytor } = await render([blockMenuPlugin], {
			children: [{ type: 'paragraph', content: [{ text: 'twice' }] }]
		});
		await caretIn(edytor);
		await dispatchDomKeyDown(document, { key: 'd', ctrlKey: true });
		expect(canonicalTree(edytor).map((b) => b.content?.[0]?.text)).toEqual(['twice', 'twice']);
	});

	it('a "space" binding fires on the space bar', async () => {
		let pressed = 0;
		const spacePlugin: Plugin = () => ({ hotkeys: { 'mod+space': () => void pressed++ } });
		await render([spacePlugin]);
		await dispatchDomKeyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
		expect(pressed).toBe(1);
	});
});

describe('lists on Enter', () => {
	const enterAt = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		editor: HTMLElement,
		block: { firstText: unknown },
		where: 'start' | 'end'
	) => {
		const text = block.firstText as Parameters<typeof edytor.selection.setAtTextOffset>[0];
		edytor.selection.setAtTextOffset(text, where === 'end' ? text!.length : 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
	};
	const kinds = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
		canonicalTree(edytor).map((b) => [b.type, b.content?.[0]?.text ?? '']);

	it.each(['bulleted-list-item', 'numbered-list-item', 'toggle'])(
		'Enter at the end of a non-empty %s adds another',
		async (type) => {
			const { edytor, editor } = await render([], {
				children: [{ type, content: [{ text: 'one' }] }]
			});
			await enterAt(edytor, editor, edytor.root!.children[0]!, 'end');
			expect(kinds(edytor)).toEqual([
				[type, 'one'],
				[type, '']
			]);
		}
	);

	it('a new to-do starts unchecked', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] }]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!, 'end');
		expect(canonicalTree(edytor)[1]).toMatchObject({ type: 'todo-item', data: { checked: false } });
	});

	it('Enter in the middle of a to-do splits it into two unchecked to-dos', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'todo-item', data: { checked: true }, content: [{ text: 'onetwo' }] }]
		});
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 3);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(canonicalTree(edytor)).toMatchObject([
			{ type: 'todo-item', data: { checked: true }, content: [{ text: 'one' }] },
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'two' }] }
		]);
	});

	it('Enter at the start of a list item adds an empty one above', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'bulleted-list-item', content: [{ text: 'one' }] }]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!, 'start');
		expect(kinds(edytor)).toEqual([
			['bulleted-list-item', ''],
			['bulleted-list-item', 'one']
		]);
	});

	it('Enter in an empty top-level list item makes it a paragraph', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ type: 'bulleted-list-item', content: [{ text: 'one' }] },
				{ type: 'bulleted-list-item', content: [{ text: '' }] }
			]
		});
		await enterAt(edytor, editor, edytor.root!.children[1]!, 'end');
		expect(kinds(edytor)).toEqual([
			['bulleted-list-item', 'one'],
			['paragraph', '']
		]);
		expect(edytor.selection.state.startBlock?.type).toBe('paragraph');
	});

	it('Enter in an empty nested list item outdents it', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'bulleted-list-item',
					content: [{ text: 'one' }],
					children: [{ type: 'bulleted-list-item', content: [{ text: '' }] }]
				}
			]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!.children[0]!, 'end');
		expect(canonicalTree(edytor).map((b) => [b.type, b.children?.length ?? 0])).toEqual([
			['bulleted-list-item', 0],
			['bulleted-list-item', 0]
		]);
	});

	it('Enter at the end of a heading still starts a paragraph', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] }]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!, 'end');
		expect(kinds(edytor)).toEqual([
			['heading', 'Title'],
			['paragraph', '']
		]);
	});
});

describe('menus', () => {
	it('the slash menu shows Notion sections and markdown hints', async () => {
		const { editor } = await render([codePlugin, slashMenuPlugin]);
		await type(editor, '/');
		const menu = document.querySelector('[data-testid="slash-menu"]')!;
		expect([...menu.querySelectorAll('.slash-heading')].map((h) => h.textContent)).toEqual([
			'Basic blocks',
			'Media'
		]);
		const hint = (id: string) =>
			menu.querySelector(`[data-command-id="${id}"]`)?.getAttribute('data-hint');
		expect([hint('block.heading2'), hint('block.quote'), hint('block.toggle')]).toEqual([
			'##',
			'"',
			'>'
		]);
	});

	it('a handle activation opens the block menu; Turn into and Delete act on its block', async () => {
		const { edytor, editor } = await render([blockMenuPlugin], {
			children: [
				{ id: 'one', type: 'paragraph', content: [{ text: 'one' }] },
				{ id: 'two', type: 'paragraph', content: [{ text: 'two' }] }
			]
		});
		const open = async (id: string) => {
			const block = edytor.idToBlock.get(id)!;
			editor.dispatchEvent(
				new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
			);
			await flushDomUpdates();
		};
		await open('one');
		expect(document.querySelector('[data-testid="block-menu"]')).toBeTruthy();
		await click(document.querySelector('[data-testid="block-menu-turn"]')!);
		const heading = [
			...document.querySelectorAll('[role="menu"][aria-label="Turn into"] button')
		].find((b) => b.textContent === 'Heading 2')!;
		await click(heading);
		expect(canonicalTree(edytor)[0]).toMatchObject({ type: 'heading', data: { level: 'h2' } });
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();

		await open('two');
		await click(document.querySelector('[data-testid="block-menu-delete"]')!);
		expect(canonicalTree(edytor).map((b) => b.content?.[0]?.text)).toEqual(['one']);
	});

	it('the keyboard reaches the Turn into flyout, and Delete removes the block', async () => {
		const { edytor, editor } = await render([blockMenuPlugin], {
			children: [
				{ id: 'one', type: 'paragraph', content: [{ text: 'one' }] },
				{ id: 'two', type: 'paragraph', content: [{ text: 'two' }] }
			]
		});
		const open = async (id: string) => {
			const block = edytor.idToBlock.get(id)!;
			editor.dispatchEvent(
				new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
			);
			await flushDomUpdates();
		};
		const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search actions"]')!;
		await open('one');
		// Turn into is the first row: → opens its flyout, ↓↓ reaches Heading 2, Enter converts.
		for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'Enter'])
			await dispatchDomKeyDown(search(), { key });
		expect(canonicalTree(edytor)[0]).toMatchObject({ type: 'heading', data: { level: 'h2' } });

		await open('two');
		await dispatchDomKeyDown(search(), { key: 'Delete' });
		expect(canonicalTree(edytor)).toHaveLength(1);
	});

	it('the toolbar turns the block into a kind and colors the selection', async () => {
		const { edytor } = await render([toolbarPlugin], {
			children: [{ type: 'paragraph', content: [{ text: 'hello' }] }]
		});
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 5);
		await flushDomUpdates();
		await click(document.querySelector('.toolbar-color')!);
		await click(document.querySelector('[title="Red text"]')!);
		expect(canonicalTree(edytor)[0]!.content).toEqual([
			{ text: 'hello', marks: { color: '#cf5148' } }
		]);
		await click(document.querySelector('.toolbar-type')!);
		const quote = [...document.querySelectorAll('[aria-label="Turn into"] button')].find(
			(b) => b.textContent === 'Quote'
		)!;
		await click(quote);
		expect(canonicalTree(edytor)[0]).toMatchObject({ type: 'quote' });
	});
});

describe('placeholders', () => {
	it('names each kind as Notion does', () => {
		const at = (type: string, data = {}, focused = false) =>
			richTextPlaceholder({ type, data, focused, empty: true });
		expect([
			at('heading', { level: 'h2' }),
			at('bulleted-list-item'),
			at('todo-item'),
			at('toggle'),
			at('quote'),
			at('paragraph'),
			at('paragraph', {}, true)
		]).toEqual([
			'Heading 2',
			'List',
			'To-do',
			'Toggle',
			'Empty quote',
			null,
			"Type '/' for commands"
		]);
	});
});
