/** @jsxImportSource ../../jsx */
/**
 * Notion parity: the shortcuts, markdown and menus the demos rely on.
 * Expected states are hand-authored from Notion's behavior.
 */
import { describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock, SerializableContent } from '$lib/utils/json.js';
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
	type CanonicalBlock,
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** The text a block's content opens with (it may open with an atom: undefined). */
const firstTextOf = (block: { content?: unknown[] }) =>
	(block.content?.[0] as { text?: string } | undefined)?.text;

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

type Data = Record<string, SerializableContent>;

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
				// The shortcut dispatches under its own name, outside the operation union.
				if ((operation as string) === 'inlineMarkdown') prevent();
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
		expect(canonicalTree(edytor).map((b) => firstTextOf(b))).toEqual(['b', 'a']);
	});

	it('Mod+D duplicates the caret block', async () => {
		const { edytor } = await render([blockMenuPlugin], {
			children: [{ type: 'paragraph', content: [{ text: 'twice' }] }]
		});
		await caretIn(edytor);
		await dispatchDomKeyDown(document, { key: 'd', ctrlKey: true });
		expect(canonicalTree(edytor).map((b) => firstTextOf(b))).toEqual(['twice', 'twice']);
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
		canonicalTree(edytor).map((b) => [b.type, firstTextOf(b) ?? '']);

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

	it('Enter in an empty middle nested item outdents it; the items after it follow as its children', async () => {
		const item = (text: string, children?: JSONBlock[]): JSONBlock => ({
			type: 'bulleted-list-item',
			content: [{ text }],
			...(children && { children })
		});
		const { edytor, editor } = await render([], {
			children: [item('one', [item('a'), item(''), item('c')])]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!.children[1]!, 'end');
		type Shape = [string, Shape[]];
		const shape = (b: CanonicalBlock): Shape => [
			firstTextOf(b) ?? '',
			(b.children ?? []).map(shape)
		];
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['one', [['a', []]]],
			['', [['c', []]]]
		]);
		expect(edytor.selection.state.startBlock?.index).toBe(1);
	});

	it('Enter in an empty to-do inside a callout makes it text in the callout', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'callout',
					content: [{ text: 'note' }],
					children: [
						{ type: 'todo-item', data: { checked: false }, content: [{ text: 'e' }] },
						{ type: 'todo-item', data: { checked: false }, content: [{ text: '' }] }
					]
				},
				{ type: 'bulleted-list-item', content: [{ text: 'after' }] }
			]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!.children[1]!, 'end');
		const tree = canonicalTree(edytor);
		expect(tree.map((b) => b.type)).toEqual(['callout', 'bulleted-list-item']);
		expect(tree[0]!.children?.map((b) => b.type)).toEqual(['todo-item', 'paragraph']);
		expect(edytor.selection.state.startBlock?.type).toBe('paragraph');
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

describe('containers on Enter', () => {
	const textOf = (block: { content?: unknown[] }) =>
		(block.content?.[0] as { text?: string } | undefined)?.text ?? '';
	/** Top-level blocks as `[type, text, children]` (children as `[type, text]`). */
	const shape = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
		canonicalTree(edytor).map((b) => [
			b.type,
			textOf(b),
			(b.children ?? []).map((c) => [c.type, textOf(c)])
		]);
	const enterAtEnd = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		editor: HTMLElement
	) => {
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtTextOffset(text, text.length);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
	};
	const withBody = (type: string, data?: Data) => ({
		children: [
			{
				type,
				...(data && { data }),
				content: [{ text: 'title' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]
	});

	it.each([['callout', { icon: '💡' }], ['quote']] as [string, Data?][])(
		'Enter at the end of a %s header with children opens a first child',
		async (type, data) => {
			const { edytor, editor } = await render([], withBody(type, data));
			await enterAtEnd(edytor, editor);
			expect(shape(edytor)).toEqual([
				[
					type,
					'title',
					[
						['paragraph', ''],
						['paragraph', 'body']
					]
				]
			]);
			const caret = edytor.selection.state.startBlock!;
			expect([caret.type, caret.parent?.type, caret.index]).toEqual(['paragraph', type, 0]);
		}
	);

	it('Enter at the end of an open toggle with children opens a first child', async () => {
		const { edytor, editor } = await render([], withBody('toggle'));
		(edytor.root!.children[0]!.node as HTMLDetailsElement).open = true;
		await enterAtEnd(edytor, editor);
		expect(shape(edytor)).toEqual([
			[
				'toggle',
				'title',
				[
					['paragraph', ''],
					['paragraph', 'body']
				]
			]
		]);
		expect(edytor.selection.state.startBlock?.parent?.type).toBe('toggle');
	});

	it('Enter at the end of an open toggle without children opens a first child', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'toggle', content: [{ text: 'title' }] }]
		});
		(edytor.root!.children[0]!.node as HTMLDetailsElement).open = true;
		await enterAtEnd(edytor, editor);
		expect(shape(edytor)).toEqual([['toggle', 'title', [['paragraph', '']]]]);
		const caret = edytor.selection.state.startBlock!;
		expect([caret.type, caret.parent?.type, caret.index]).toEqual(['paragraph', 'toggle', 0]);
	});

	it('Enter at the end of a closed toggle without children opens a sibling toggle', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'toggle', content: [{ text: 'title' }] }]
		});
		expect((edytor.root!.children[0]!.node as HTMLDetailsElement).open).toBe(false);
		await enterAtEnd(edytor, editor);
		expect(shape(edytor)).toEqual([
			['toggle', 'title', []],
			['toggle', '', []]
		]);
		const caret = edytor.selection.state.startBlock!;
		expect([caret.type, caret.parent?.isRoot, caret.index]).toEqual(['toggle', true, 1]);
	});

	it('Enter at the end of a closed toggle opens a sibling toggle; the children stay', async () => {
		const { edytor, editor } = await render([], withBody('toggle'));
		expect((edytor.root!.children[0]!.node as HTMLDetailsElement).open).toBe(false);
		await enterAtEnd(edytor, editor);
		expect(shape(edytor)).toEqual([
			['toggle', 'title', [['paragraph', 'body']]],
			['toggle', '', []]
		]);
		const caret = edytor.selection.state.startBlock!;
		expect([caret.type, caret.parent?.isRoot, caret.index]).toEqual(['toggle', true, 1]);
	});

	it('Enter at the end of a callout without children starts a paragraph after it', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'callout', data: { icon: '💡' }, content: [{ text: 'note' }] }]
		});
		await enterAtEnd(edytor, editor);
		expect(shape(edytor)).toEqual([
			['callout', 'note', []],
			['paragraph', '', []]
		]);
		expect(edytor.selection.state.startBlock?.index).toBe(1);
	});
});

describe('lists on Backspace', () => {
	const backspaceAtStartOf = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		editor: HTMLElement,
		path: number[]
	) => {
		let block = edytor.root!;
		for (const index of path) block = block.children[index]!;
		edytor.selection.setAtTextOffset(block.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
	};
	const caret = (edytor: Awaited<ReturnType<typeof render>>['edytor']) => {
		const { startBlock, yStart } = edytor.selection.state;
		return [startBlock?.type, startBlock?.firstText?.stringContent, yStart];
	};

	it('a bullet after a paragraph turns into text first, then merges', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ type: 'paragraph', content: [{ text: 'para' }] },
				{ type: 'bulleted-list-item', content: [{ text: 'item' }] }
			]
		});
		await backspaceAtStartOf(edytor, editor, [1]);
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'para' }] },
			{ type: 'paragraph', content: [{ text: 'item' }] }
		]);
		expect(caret(edytor)).toEqual(['paragraph', 'item', 0]);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: 'paraitem' }] }]);
	});

	it('a bullet after a bullet leaves the list', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ type: 'bulleted-list-item', content: [{ text: 'one' }] },
				{ type: 'bulleted-list-item', content: [{ text: 'two' }] }
			]
		});
		await backspaceAtStartOf(edytor, editor, [1]);
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'bulleted-list-item', content: [{ text: 'one' }] },
			{ type: 'paragraph', content: [{ text: 'two' }] }
		]);
	});

	it('a checked to-do after a to-do turns into text without its checked state', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ type: 'todo-item', data: { checked: false }, content: [{ text: 'one' }] },
				{ type: 'todo-item', data: { checked: true }, content: [{ text: 'two' }] }
			]
		});
		await backspaceAtStartOf(edytor, editor, [1]);
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'one' }] },
			{ type: 'paragraph', content: [{ text: 'two' }] }
		]);
	});

	it.each([
		['heading', { level: 'h2' }],
		['quote', undefined],
		['toggle', undefined]
	] as [string, Data | undefined][])(
		'a %s after a paragraph turns into text first',
		async (type, data) => {
			const { edytor, editor } = await render([], {
				children: [
					{ type: 'paragraph', content: [{ text: 'para' }] },
					{ type, ...(data && { data }), content: [{ text: 'kind' }] }
				]
			});
			await backspaceAtStartOf(edytor, editor, [1]);
			expect(canonicalTree(edytor)).toEqual([
				{ type: 'paragraph', content: [{ text: 'para' }] },
				{ type: 'paragraph', content: [{ text: 'kind' }] }
			]);
			expect(caret(edytor)).toEqual(['paragraph', 'kind', 0]);
		}
	);

	it('a non-empty first heading turns into text', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] }]
		});
		await backspaceAtStartOf(edytor, editor, [0]);
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: 'Title' }] }]);
	});

	it('an empty only bullet turns into text and gets the text placeholder back', async () => {
		const { edytor, editor } = await renderDomEdytor(empty, {
			plugins: [richTextPlugin, mentionPlugin],
			// The harness types the prop as a string; `<Edytor>` takes a function too.
			placeholder: richTextPlaceholder as unknown as string,
			value: { children: [{ type: 'bulleted-list-item', content: [{ text: '' }] }] }
		});
		await backspaceAtStartOf(edytor, editor, [0]);
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph' }]);
		expect(caret(edytor)).toEqual(['paragraph', '', 0]);
		await flushDomUpdates();
		expect(
			edytor.root!.children[0]!.firstText!.node?.getAttribute('data-placeholder') ?? null
		).not.toBe('List');
	});

	it('a nested last-child bullet turns into text and stays nested', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'bulleted-list-item',
					content: [{ text: 'one' }],
					children: [{ type: 'bulleted-list-item', content: [{ text: 'two' }] }]
				}
			]
		});
		await backspaceAtStartOf(edytor, editor, [0, 0]);
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'bulleted-list-item',
				content: [{ text: 'one' }],
				children: [{ type: 'paragraph', content: [{ text: 'two' }] }]
			}
		]);
		expect(caret(edytor)).toEqual(['paragraph', 'two', 0]);
	});

	it('a structural kind outside the catalogue keeps the unnest (a nested list-item)', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'ordered-list',
					children: [
						{
							type: 'list-item',
							content: [{ text: 'First' }],
							children: [{ type: 'list-item', content: [{ text: 'Second' }] }]
						}
					]
				}
			]
		});
		await backspaceAtStartOf(edytor, editor, [0, 0, 0]);
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'ordered-list',
				children: [
					{ type: 'list-item', content: [{ text: 'First' }] },
					{ type: 'list-item', content: [{ text: 'Second' }] }
				]
			}
		]);
		expect(caret(edytor)).toEqual(['list-item', 'Second', 0]);
	});
});

describe('code auto-pairs', () => {
	const inCode = () =>
		render([codePlugin], {
			children: [{ type: 'code', children: [{ type: 'codeLine', content: [{ text: '' }] }] }]
		});
	const line = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
		edytor.root!.children[0]!.children[0]!.firstText!;
	const typeInCode = async (typed: string) => {
		const { edytor, editor } = await inCode();
		edytor.selection.setAtTextOffset(line(edytor), 0);
		await flushDomUpdates();
		await type(editor, typed);
		return [line(edytor).stringContent, edytor.selection.state.yStart];
	};

	it.each([
		['()', '()', 2],
		['[]', '[]', 2],
		['{}', '{}', 2],
		['""', '""', 2],
		["''", "''", 2],
		['f(a)', 'f(a)', 4],
		["don't", "don't", 5],
		['it"s', 'it"s', 4],
		['(', '()', 1],
		['x = "', 'x = ""', 5]
	])('typing %j leaves %j with the caret at %i', async (typed, text, offset) => {
		expect(await typeInCode(typed)).toEqual([text, offset]);
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
				{ id: 'two', type: 'paragraph', content: [{ text: 'two' }] },
				{ id: 'three', type: 'paragraph', content: [{ text: 'three' }] }
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
		// The caret returns to the converted block (the block selection is gone).
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		expect(edytor.selection.state.startBlock?.id).toBe('one');

		await open('two');
		await click(document.querySelector('[data-testid="block-menu-delete"]')!);
		expect(canonicalTree(edytor).map((b) => firstTextOf(b))).toEqual(['one', 'three']);
		// The caret lands at the start of the block after the deleted one.
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		expect(edytor.selection.state.startBlock?.id).toBe('three');
		expect(edytor.selection.state.yStart).toBe(0);
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
