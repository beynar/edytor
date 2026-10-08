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
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlaceholder, richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	type CanonicalBlock,
	canonicalTree,
	dispatchCut,
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
		// A retype keeps the block's properties (`data.retype.keep`): text ignores the level.
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', data: { level: 'h1' } }]);
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
		const box = document.querySelector<HTMLInputElement>('[data-edytor-todo-checkbox]')!;
		await click(box);
		expect(canonicalTree(edytor)[0]).toMatchObject({ data: { checked: true } });
		// This view shows it too (a canceled click was reverted over the re-render).
		expect(box.checked).toBe(true);
		await click(box);
		expect(canonicalTree(edytor)[0]).toMatchObject({ data: { checked: false } });
		expect(box.checked).toBe(false);
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

	it('Enter at the end of a checked to-do with children lifts it: the new to-do is unchecked', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'todo-item',
					data: { checked: true },
					content: [{ text: 'done' }],
					children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
				}
			]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!, 'end');
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
			{
				type: 'todo-item',
				data: { checked: false },
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
		expect(edytor.selection.state.startBlock?.index).toBe(1);
	});

	it('Enter at the end of a heading with children lifts it: the new heading keeps the level', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					type: 'heading',
					data: { level: 'h2' },
					content: [{ text: 'Title' }],
					children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
				}
			]
		});
		await enterAt(edytor, editor, edytor.root!.children[0]!, 'end');
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] },
			{
				type: 'heading',
				data: { level: 'h2' },
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
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

	/** Enter between "ti" and "tle" of the first block's header. */
	const enterMid = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		editor: HTMLElement
	) => {
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 2);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
	};
	const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });

	it.each([['callout', { icon: '💡' }], ['quote'], ['toggle']] as [string, Data?][])(
		'Enter in the middle of a %s header (open) makes the tail its first child; the body stays',
		async (type, data) => {
			const { edytor, editor } = await render([], withBody(type, data));
			const node = edytor.root!.children[0]!.node as HTMLDetailsElement;
			if (type === 'toggle') node.open = true;
			await enterMid(edytor, editor);
			expect(shape(edytor)).toEqual([
				[
					type,
					'ti',
					[
						['paragraph', 'tle'],
						['paragraph', 'body']
					]
				]
			]);
			const caret = edytor.selection.state;
			expect([caret.startBlock?.parent?.type, caret.startBlock?.index, caret.yStart]).toEqual([
				type,
				0,
				0
			]);
			await undo();
			expect(shape(edytor)).toEqual([[type, 'title', [['paragraph', 'body']]]]);
		}
	);

	it('Enter in the middle of a closed toggle header puts the tail in a toggle after it; the body stays', async () => {
		const { edytor, editor } = await render([], withBody('toggle'));
		expect((edytor.root!.children[0]!.node as HTMLDetailsElement).open).toBe(false);
		await enterMid(edytor, editor);
		expect(shape(edytor)).toEqual([
			['toggle', 'ti', [['paragraph', 'body']]],
			['toggle', 'tle', []]
		]);
		const caret = edytor.selection.state;
		expect([caret.startBlock?.parent?.isRoot, caret.startBlock?.index, caret.yStart]).toEqual([
			true,
			1,
			0
		]);
		await undo();
		expect(shape(edytor)).toEqual([['toggle', 'title', [['paragraph', 'body']]]]);
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

	it('a checked to-do after a to-do turns into text, keeping its checked state hidden', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ type: 'todo-item', data: { checked: false }, content: [{ text: 'one' }] },
				{ type: 'todo-item', data: { checked: true }, content: [{ text: 'two' }] }
			]
		});
		await backspaceAtStartOf(edytor, editor, [1]);
		// A retype keeps the block's properties, as Notion does (`data.retype.keep`):
		// text shows no checkbox; turned back into a to-do, the preset unchecks it.
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'one' }] },
			{ type: 'paragraph', data: { checked: true }, content: [{ text: 'two' }] }
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
			// The kind's properties stay (`data.retype.keep`).
			expect(canonicalTree(edytor)).toEqual([
				{ type: 'paragraph', content: [{ text: 'para' }] },
				{ type: 'paragraph', ...(data && { data }), content: [{ text: 'kind' }] }
			]);
			expect(caret(edytor)).toEqual(['paragraph', 'kind', 0]);
		}
	);

	it('a non-empty first heading turns into text', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] }]
		});
		await backspaceAtStartOf(edytor, editor, [0]);
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'paragraph', data: { level: 'h1' }, content: [{ text: 'Title' }] }
		]);
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

describe('the slash menu in prose', () => {
	/** The Enter key: the menu's command when it holds one, else the paragraph intent. */
	const pressEnter = () => dispatchDomKeyDown(document, { key: 'Enter' });
	const menu = () => document.querySelector('[data-testid="slash-menu"]');
	const labels = () =>
		[...document.querySelectorAll('[data-testid="slash-menu-item"]')].map((i) => i.textContent);

	it.each(['see 1/2', 'a/b', 'and/or', 'w/o'])(
		'%j + Enter keeps the text and starts a paragraph (a slash inside a word opens no menu)',
		async (typed) => {
			const { edytor, editor } = await render([codePlugin, slashMenuPlugin]);
			await type(editor, typed);
			expect(menu()).toBeNull();
			await pressEnter();
			expect(canonicalTree(edytor)).toEqual([
				{ type: 'paragraph', content: [{ text: typed }] },
				{ type: 'paragraph' }
			]);
			expect(menu()).toBeNull();
		}
	);

	it.each(['yes / no', '1 / 2', 'a / b', 'w / o', 'yes / ', 'x /-'])(
		'%j + Enter keeps the text and starts a paragraph (a space after the slash, or a query of only hyphens, closes the menu)',
		async (typed) => {
			const { edytor, editor } = await render([codePlugin, slashMenuPlugin]);
			await type(editor, typed);
			expect(menu()).toBeNull();
			await pressEnter();
			expect(canonicalTree(edytor)).toEqual([
				{ type: 'paragraph', content: [{ text: typed }] },
				{ type: 'paragraph' }
			]);
			expect(menu()).toBeNull();
		}
	);

	it('a slash after a space opens the menu', async () => {
		const { edytor, editor } = await render([slashMenuPlugin]);
		await type(editor, 'hi /h2');
		expect(labels()).toEqual(['Heading 2']);
		await pressEnter();
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'hi ' }] }
		]);
	});

	it.each([
		['/list', ['Bulleted list', 'Numbered list', 'To-do list', 'Toggle list']],
		['/todo', ['To-do list']],
		[
			'/head',
			[
				'Heading 1',
				'Heading 2',
				'Heading 3',
				'Toggle heading 1',
				'Toggle heading 2',
				'Toggle heading 3'
			]
		]
	])('%j matches labels and keywords by word prefix', async (typed, expected) => {
		const { editor } = await render([slashMenuPlugin]);
		await type(editor, typed);
		expect(labels()).toEqual(expected);
	});

	it.each([
		['/to d', ['To-do list'], 'todo-item'],
		['/to do', ['To-do list'], 'todo-item'],
		['/bullet l', ['Bulleted list'], 'bulleted-list-item'],
		['/bullet list', ['Bulleted list'], 'bulleted-list-item'],
		// Notion lists the toggle heading after the heading; Enter takes the first.
		['/heading 2', ['Heading 2', 'Toggle heading 2'], 'heading']
	])(
		'%j keeps the menu open: each word starts a word of the label, in order (FW-18)',
		async (typed, expected, kind) => {
			const { edytor, editor } = await render([slashMenuPlugin]);
			await type(editor, typed);
			expect(labels()).toEqual(expected);
			await pressEnter();
			expect(canonicalTree(edytor)).toEqual([expect.objectContaining({ type: kind })]);
			expect(canonicalTree(edytor)[0]!.content).toBeUndefined();
		}
	);

	it.each(['/list bullet', '/to x'])(
		'%j matches out of order or not at all: the menu closes',
		async (typed) => {
			const { editor } = await render([slashMenuPlugin]);
			await type(editor, typed);
			expect(menu()).toBeNull();
		}
	);

	it.each(['/eading', '/block', '/ist'])(
		'%j matches no word start (nor a command id): the menu closes',
		async (typed) => {
			const { edytor, editor } = await render([slashMenuPlugin]);
			await type(editor, typed);
			expect(menu()).toBeNull();
			await pressEnter();
			expect(canonicalTree(edytor)).toEqual([
				{ type: 'paragraph', content: [{ text: typed }] },
				{ type: 'paragraph' }
			]);
		}
	);
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
		// The caret lands at the end of the block before the deleted one, as
		// the keyboard's block delete does (DR-behavior-1).
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		expect(edytor.selection.state.startBlock?.id).toBe('one');
		expect(edytor.selection.state.yStart).toBe(3);
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

describe('next to a collapsed toggle (FW-02)', () => {
	/** `[toggle 'title' -> [p 'body'], p 'after']`, the toggle closed (its default). */
	const collapsed = () =>
		render([], {
			children: [
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
				},
				{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
			]
		});
	const at = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		id: string,
		offset: 'start' | 'end'
	) => {
		const text = edytor.idToBlock.get(id)!.firstText!;
		edytor.selection.setAtTextOffset(text, offset === 'start' ? 0 : text.length);
		await flushDomUpdates();
	};
	const caret = (edytor: Awaited<ReturnType<typeof render>>['edytor']) => {
		const { startBlock, yStart } = edytor.selection.state;
		return [startBlock?.id, yStart];
	};
	const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
	const before = [
		{
			type: 'toggle',
			content: [{ text: 'title' }],
			children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
		},
		{ type: 'paragraph', content: [{ text: 'after' }] }
	];

	it('Backspace at the start of the block after it merges into the header', async () => {
		const { edytor, editor } = await collapsed();
		expect((edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open).toBe(false);
		await at(edytor, 'after', 'start');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'titleafter' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
		expect(caret(edytor)).toEqual(['toggle', 5]);
		await undo();
		expect(canonicalTree(edytor)).toEqual(before);
	});

	it('Backspace in an empty block after it removes the block; the caret ends the header', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{ id: 'toggle', ...before[0]! },
				{ id: 'after', type: 'paragraph' }
			]
		});
		await at(edytor, 'after', 'start');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor)).toEqual([before[0]]);
		expect(caret(edytor)).toEqual(['toggle', 5]);
	});

	it('Backspace after it keeps the children of the merged block visible, in its place', async () => {
		const { edytor, editor } = await render([], {
			children: [
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
				},
				{
					id: 'after',
					type: 'paragraph',
					content: [{ text: 'after' }],
					children: [{ type: 'paragraph', content: [{ text: 'kid' }] }]
				}
			]
		});
		await at(edytor, 'after', 'start');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'titleafter' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			},
			{ type: 'paragraph', content: [{ text: 'kid' }] }
		]);
	});

	it('Delete at the end of the header merges the block after the toggle', async () => {
		const { edytor, editor } = await collapsed();
		await at(edytor, 'toggle', 'end');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'titleafter' }],
				children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
			}
		]);
		expect(caret(edytor)).toEqual(['toggle', 5]);
		await undo();
		expect(canonicalTree(edytor)).toEqual(before);
	});

	it('Delete at the end of the header of the last block does nothing', async () => {
		const { edytor, editor } = await render([], { children: [before[0]!] });
		const toggle = edytor.root!.children[0]!;
		edytor.selection.setAtTextOffset(toggle.firstText!, 5);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(canonicalTree(edytor)).toEqual([before[0]]);
	});

	it('Tab on the block after it nests the block and opens the toggle', async () => {
		const { edytor } = await collapsed();
		await at(edytor, 'after', 'start');
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'title' }],
				children: [
					{ type: 'paragraph', content: [{ text: 'body' }] },
					{ type: 'paragraph', content: [{ text: 'after' }] }
				]
			}
		]);
		expect((edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open).toBe(true);
		expect(caret(edytor)).toEqual(['after', 0]);
	});

	it('Tab on a selected block after it opens the toggle too', async () => {
		const { edytor } = await collapsed();
		edytor.selection.selectBlocks(edytor.idToBlock.get('after')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(edytor.idToBlock.get('after')!.parent?.id).toBe('toggle');
		expect((edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open).toBe(true);
	});

	const selected = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
		[...edytor.selection.selectedBlocks].map((block) => block.id);

	it('↓ and ↑ over a selected block skip its hidden body (SW-behaviors-2)', async () => {
		const { edytor } = await collapsed();
		edytor.selection.selectBlocks(edytor.idToBlock.get('toggle')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		expect(selected(edytor)).toEqual(['after']);
		await dispatchDomKeyDown(document, { key: 'ArrowUp' });
		expect(selected(edytor)).toEqual(['toggle']);
	});

	it('Shift+↓ and Shift+↑ extend past its hidden body (SW-behaviors-2)', async () => {
		const { edytor } = await collapsed();
		edytor.selection.selectBlocks(edytor.idToBlock.get('toggle')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowDown', shiftKey: true });
		expect(selected(edytor)).toEqual(['toggle', 'after']);
		edytor.selection.selectBlocks(edytor.idToBlock.get('after')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowUp', shiftKey: true });
		expect(selected(edytor)).toEqual(['after', 'toggle']);
	});

	it('Shift+↓ at the end of the header never selects a void block in its hidden body (SW-behaviors-2)', async () => {
		const { edytor } = await render([], {
			children: [
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ id: 'rule', type: 'divider' }]
				},
				{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
			]
		});
		await at(edytor, 'toggle', 'end');
		await dispatchDomKeyDown(document, { key: 'ArrowDown', shiftKey: true });
		expect(selected(edytor)).not.toContain('rule');
	});

	it('deleting the selected block after it puts the caret at the end of the header (SW-behaviors-6)', async () => {
		const { edytor } = await collapsed();
		edytor.selection.selectBlocks(edytor.idToBlock.get('after')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(canonicalTree(edytor)).toEqual([before[0]]);
		expect(caret(edytor)).toEqual(['toggle', 5]);
	});

	it('Shift+Tab on it with blocks after it opens it: they become its children, still displayed (SW-behaviors-7)', async () => {
		const { edytor } = await render([], {
			children: [
				{
					id: 'par',
					type: 'paragraph',
					content: [{ text: 'par' }],
					children: [
						{ id: 'toggle', type: 'toggle', content: [{ text: 'title' }] },
						{ id: 'next', type: 'paragraph', content: [{ text: 'next' }] }
					]
				}
			]
		});
		await at(edytor, 'toggle', 'start');
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(edytor.idToBlock.get('next')!.parent?.id).toBe('toggle');
		expect((edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open).toBe(true);
	});

	it('Mod+Enter in the header opens and closes the toggle; the document is unchanged (SW-behaviors-3)', async () => {
		const { edytor } = await collapsed();
		const node = edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement;
		await at(edytor, 'toggle', 'end');
		await dispatchDomKeyDown(document, { key: 'Enter', ctrlKey: true });
		expect(node.open).toBe(true);
		expect(canonicalTree(edytor)).toEqual(before);
		expect(caret(edytor)).toEqual(['toggle', 5]);
		await dispatchDomKeyDown(document, { key: 'Enter', ctrlKey: true });
		expect(node.open).toBe(false);
		expect(canonicalTree(edytor)).toEqual(before);
	});

	it('Delete at the end of the header before a code block leaves the code alone (SW-behaviors-5)', async () => {
		const { edytor, editor } = await render([codePlugin], {
			children: [
				{ id: 'toggle', ...before[0]! },
				{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'a' }] }] }
			]
		});
		await at(edytor, 'toggle', 'end');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(canonicalTree(edytor)).toEqual([
			before[0],
			{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'a' }] }] }
		]);
	});

	it('Backspace in an empty block after a toggle hiding a code block joins the header (SW-behaviors-5)', async () => {
		const { edytor, editor } = await render([codePlugin], {
			children: [
				{ type: 'paragraph', content: [{ text: 'a' }] },
				{
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'c' }] }] }]
				},
				{ id: 'empty', type: 'paragraph' },
				{ type: 'paragraph', content: [{ text: 'z' }] }
			]
		});
		// Backspace in the empty block after the toggle: it joins the header, not the hidden code.
		await at(edytor, 'empty', 'start');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor).map((b) => b.content?.[0])).toEqual([
			{ text: 'a' },
			{ text: 'title' },
			{ text: 'z' }
		]);
		expect(edytor.selection.state.startBlock?.type).toBe('toggle');
	});

	it('an open toggle keeps the document-order rules (Backspace merges into its last child)', async () => {
		const { edytor, editor } = await collapsed();
		(edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open = true;
		await at(edytor, 'after', 'start');
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'title' }],
				children: [{ type: 'paragraph', content: [{ text: 'bodyafter' }] }]
			}
		]);
	});
});

describe('a text range from a collapsed toggle header (XW-01)', () => {
	type Rendered = Awaited<ReturnType<typeof render>>;
	/** `[p 'before', toggle 'title' -> [p 'body'], p 'after']`, the toggle closed. */
	const collapsed = (plugins: Plugin[] = []) =>
		render(plugins, {
			children: [
				{ id: 'before', type: 'paragraph', content: [{ text: 'before' }] },
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
				},
				{ id: 'after', type: 'paragraph', content: [{ text: 'after' }] }
			]
		});
	const text = ({ edytor }: Rendered, id: string) => edytor.idToBlock.get(id)!.firstText!;
	const select = async (r: Rendered, [a, x]: [string, number], [b, y]: [string, number]) => {
		r.edytor.selection.setAtRange(text(r, a), x, text(r, b), y);
		await flushDomUpdates();
		r.edytor.undoManager.stopCapturing();
	};
	const caret = ({ edytor }: Rendered) => {
		const { startBlock, yStart, isCollapsed } = edytor.selection.state;
		return [startBlock?.id, yStart, isCollapsed];
	};
	const undo = () => dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
	const initial = [
		{ type: 'paragraph', content: [{ text: 'before' }] },
		{
			type: 'toggle',
			content: [{ text: 'title' }],
			children: [{ type: 'paragraph', content: [{ text: 'body' }] }]
		},
		{ type: 'paragraph', content: [{ text: 'after' }] }
	];
	/** The toggle with `title` as its header, its hidden body kept. */
	const kept = (title: string) => [initial[0], { ...initial[1]!, content: [{ text: title }] }];

	it('Shift+→ at the end of the header selects up to the block after it', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 5], ['toggle', 5]);
		await dispatchDomKeyDown(document, { key: 'ArrowRight', shiftKey: true });
		const { startBlock, endBlock, yStart, yEnd } = r.edytor.selection.state;
		expect([startBlock?.id, yStart, endBlock?.id, yEnd]).toEqual(['toggle', 5, 'after', 0]);
	});

	it.each([
		['Backspace', 'deleteContentBackward'],
		['Delete', 'deleteContentForward']
	])('Shift+→ then %s joins the block after it; the hidden body stays', async (_, inputType) => {
		const r = await collapsed();
		await select(r, ['toggle', 5], ['toggle', 5]);
		await dispatchDomKeyDown(document, { key: 'ArrowRight', shiftKey: true });
		await dispatchDomBeforeInput(r.editor, { inputType });
		expect(canonicalTree(r.edytor)).toEqual(kept('titleafter'));
		expect(caret(r)).toEqual(['toggle', 5, true]);
		await undo();
		expect(canonicalTree(r.edytor)).toEqual(initial);
	});

	it('Shift+→ then typing joins the block after it; the hidden body stays', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 5], ['toggle', 5]);
		await dispatchDomKeyDown(document, { key: 'ArrowRight', shiftKey: true });
		await type(r.editor, 'X');
		expect(canonicalTree(r.edytor)).toEqual(kept('titleXafter'));
		expect(caret(r)).toEqual(['toggle', 6, true]);
	});

	it.each([
		['Backspace', 'deleteContentBackward'],
		['Delete', 'deleteContentForward'],
		['a cut', 'deleteByCut']
	])('%s over mid-header to mid-after keeps the hidden body', async (_, inputType) => {
		const r = await collapsed();
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType });
		expect(canonicalTree(r.edytor)).toEqual(kept('tier'));
		expect(caret(r)).toEqual(['toggle', 2, true]);
		await undo();
		expect(canonicalTree(r.edytor)).toEqual(initial);
	});

	it('typing over mid-header to mid-after keeps the hidden body', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 2], ['after', 3]);
		await type(r.editor, 'X');
		expect(canonicalTree(r.edytor)).toEqual(kept('tiXer'));
	});

	it('pasting over mid-header to mid-after keeps the hidden body', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertFromPaste', text: 'P' });
		expect(canonicalTree(r.edytor)).toEqual(kept('tiPer'));
	});

	it('Enter over mid-header to mid-after keeps the hidden body; the tail becomes a toggle after it', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'insertParagraph' });
		const tree = canonicalTree(r.edytor);
		expect(tree.slice(0, 2)).toEqual(kept('ti'));
		expect(tree[2]).toMatchObject({ type: 'toggle', content: [{ text: 'er' }] });
		expect(tree).toHaveLength(3);
	});

	it('a range covering the whole header deletes the toggle as one unit, body included', async () => {
		const r = await collapsed();
		await select(r, ['toggle', 0], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([
			initial[0],
			{ type: 'paragraph', content: [{ text: 'er' }] }
		]);
	});

	it('a range across the whole toggle deletes it as one unit, body included', async () => {
		const r = await collapsed();
		await select(r, ['before', 3], ['after', 2]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([{ type: 'paragraph', content: [{ text: 'befter' }] }]);
	});

	it('an open toggle keeps document order: its shown body is in the range', async () => {
		const r = await collapsed();
		(r.edytor.idToBlock.get('toggle')!.node as HTMLDetailsElement).open = true;
		await select(r, ['toggle', 2], ['after', 3]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([
			initial[0],
			{ type: 'toggle', content: [{ text: 'tier' }] }
		]);
	});

	/** `blocks` rendered with `toggle` closed over its `body`. */
	const tree = (...blocks: ('before' | 'toggle' | 'after')[]) =>
		render([], {
			children: blocks.map((id) =>
				id === 'toggle'
					? {
							id,
							type: 'toggle',
							content: [{ text: 'title' }],
							children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
						}
					: { id, type: 'paragraph', content: [{ text: id }] }
			)
		});
	const deletes = [
		['Backspace', 'deleteContentBackward'],
		['Delete', 'deleteContentForward']
	];

	it.each(deletes)(
		'%s over a whole document opening with the toggle leaves an empty toggle, body gone (DR-delete-1)',
		async (_, inputType) => {
			const r = await tree('toggle', 'after');
			await select(r, ['toggle', 0], ['after', 5]);
			await dispatchDomBeforeInput(r.editor, { inputType });
			expect(canonicalTree(r.edytor)).toEqual([{ type: 'toggle' }]);
			expect(caret(r)).toEqual(['toggle', 0, true]);
			await undo();
			expect(canonicalTree(r.edytor)).toEqual(initial.slice(1));
		}
	);

	it('typing over a whole document opening with the toggle keeps the head and its body', async () => {
		const r = await tree('toggle', 'after');
		await select(r, ['toggle', 0], ['after', 5]);
		await type(r.editor, 'X');
		expect(canonicalTree(r.edytor)).toEqual([{ ...initial[1]!, content: [{ text: 'X' }] }]);
	});

	it.each(deletes)(
		'%s from the block before through the header lands on the revealed body (DR-delete-2)',
		async (_, inputType) => {
			const r = await tree('before', 'toggle', 'after');
			await select(r, ['before', 0], ['toggle', 5]);
			await dispatchDomBeforeInput(r.editor, { inputType });
			expect(canonicalTree(r.edytor)).toEqual([initial[1]!.children![0], initial[2]]);
			expect(caret(r)).toEqual(['body', 0, true]);
		}
	);

	it.each(deletes)(
		'%s from the block before through the last header keeps no extra empty head (DR-delete-2)',
		async (_, inputType) => {
			const r = await tree('before', 'toggle');
			await select(r, ['before', 0], ['toggle', 5]);
			await dispatchDomBeforeInput(r.editor, { inputType });
			expect(canonicalTree(r.edytor)).toEqual([initial[1]!.children![0]]);
			expect(caret(r)).toEqual(['body', 0, true]);
			await undo();
			expect(canonicalTree(r.edytor)).toEqual(initial.slice(0, 2));
		}
	);

	it('a whole-document Backspace selected backward agrees (DR-delete-1)', async () => {
		const r = await tree('toggle', 'after');
		await select(r, ['after', 5], ['toggle', 0]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([{ type: 'toggle' }]);
	});

	it('a revealed body keeps a closed toggle inside it closed: the caret lands on its header (DR-delete-2)', async () => {
		const inner = {
			id: 'inner',
			type: 'toggle',
			content: [{ text: 'inner' }],
			children: [{ id: 'deep', type: 'paragraph', content: [{ text: 'deep' }] }]
		};
		const r = await render([], {
			children: [
				{ id: 'before', type: 'paragraph', content: [{ text: 'before' }] },
				{ id: 'toggle', type: 'toggle', content: [{ text: 'title' }], children: [inner] }
			]
		});
		await select(r, ['before', 0], ['toggle', 5]);
		await dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(r.edytor)).toEqual([
			{
				type: 'toggle',
				content: [{ text: 'inner' }],
				children: [{ type: 'paragraph', content: [{ text: 'deep' }] }]
			}
		]);
		expect(caret(r)).toEqual(['inner', 0, true]);
	});
});

describe('merging next to a collapsed toggle is one command (XW-09)', () => {
	/** The documented `lockedBlocksPlugin` (plugins/operations.mdx). */
	const lockedBlocksPlugin: Plugin = (edytor) => ({
		onBeforeOperation: ({ effect, prevent }) => {
			if (!effect) return;
			const leaving = [...effect.removes, ...effect.merges.map(([from]) => from)];
			if (leaving.some((id) => edytor.idToBlock.get(id)?.data.locked)) prevent();
		}
	});
	/** `[toggle 'title' -> [p 'body'] (closed), p{locked} 'locked' -> [p 'kid']]`. */
	const locked = () =>
		render([lockedBlocksPlugin], {
			children: [
				{
					id: 'toggle',
					type: 'toggle',
					content: [{ text: 'title' }],
					children: [{ id: 'body', type: 'paragraph', content: [{ text: 'body' }] }]
				},
				{
					id: 'locked',
					type: 'paragraph',
					data: { locked: true },
					content: [{ text: 'locked' }],
					children: [{ id: 'kid', type: 'paragraph', content: [{ text: 'kid' }] }]
				}
			]
		});

	it.each([
		['Backspace at the start of the locked block', 'locked', 0, 'deleteContentBackward'],
		['Delete at the end of the header', 'toggle', 5, 'deleteContentForward']
	])('%s: a vetoed merge leaves the tree unchanged', async (_, id, offset, inputType) => {
		const { edytor, editor } = await locked();
		const before = canonicalTree(edytor);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType });
		expect(canonicalTree(edytor)).toEqual(before);
	});
});

describe('code keys (FW-04, FW-19)', () => {
	const inCode = (lines: string[], after: JSONBlock[] = []) =>
		render([codePlugin], {
			children: [
				{
					type: 'code',
					children: lines.map((text) => ({ type: 'codeLine', content: [{ text }] }))
				},
				...after
			]
		});
	type Rendered = Awaited<ReturnType<typeof inCode>>;
	const line = ({ edytor }: Rendered, index: number) =>
		edytor.root!.children[0]!.children[index]!.firstText!;
	const lines = ({ edytor }: Rendered) =>
		edytor.root!.children[0]!.children.map((l) => l.firstText!.stringContent);
	const select = async (rendered: Rendered, from: [number, number], to = from) => {
		rendered.edytor.selection.setAtRange(
			line(rendered, from[0]),
			from[1],
			line(rendered, to[0]),
			to[1]
		);
		await flushDomUpdates();
		rendered.edytor.undoManager.stopCapturing();
	};
	/** The selection as `[startLine, startOffset, endLine, endOffset]`. */
	const range = ({ edytor }: Rendered) => {
		const { startBlock, endBlock, yStart, yEnd } = edytor.selection.state;
		return [startBlock?.index, yStart, endBlock?.index, yEnd];
	};
	const tab = (shiftKey = false) => dispatchDomKeyDown(document, { key: 'Tab', shiftKey });
	const program = ['if (a) {', 'run();', '}'];

	it.each([
		[
			'from the first line to the last',
			[0, 0],
			[2, 1],
			['\tif (a) {', '\trun();', '\t}'],
			[0, 1, 2, 2]
		],
		['from mid-line to the last', [1, 5], [2, 1], ['if (a) {', '\trun();', '\t}'], [1, 6, 2, 2]],
		[
			'ending at a line start (that line stays)',
			[1, 0],
			[2, 0],
			['if (a) {', '\trun();', '}'],
			[1, 1, 2, 0]
		],
		['inside one line', [1, 1], [1, 4], ['if (a) {', '\trun();', '}'], [1, 2, 1, 5]]
	] as [string, [number, number], [number, number], string[], number[]][])(
		'Tab over a selection %s indents each line it touches and keeps the selection',
		async (_, from, to, expected, selection) => {
			const rendered = await inCode(program);
			await select(rendered, from, to);
			await tab();
			expect(lines(rendered)).toEqual(expected);
			expect(range(rendered)).toEqual(selection);
			await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
			expect(lines(rendered)).toEqual(program);
		}
	);

	it('Tab at a caret inserts a tab there', async () => {
		const rendered = await inCode(program);
		await select(rendered, [1, 3]);
		await tab();
		expect(lines(rendered)).toEqual(['if (a) {', 'run\t();', '}']);
		expect(range(rendered)).toEqual([1, 4, 1, 4]);
	});

	it('Shift+Tab over lines removes one leading tab, or up to two spaces, from each', async () => {
		const rendered = await inCode(['\tif', '   run', 'x', '\t\ty']);
		await select(rendered, [0, 2], [3, 3]);
		await tab(true);
		expect(lines(rendered)).toEqual(['if', ' run', 'x', '\ty']);
		expect(range(rendered)).toEqual([0, 1, 3, 2]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(lines(rendered)).toEqual(['\tif', '   run', 'x', '\t\ty']);
	});

	it('Shift+Tab at a caret dedents its line; the caret stays on its character', async () => {
		const rendered = await inCode(['\t\trun()']);
		await select(rendered, [0, 4]);
		await tab(true);
		expect(lines(rendered)).toEqual(['\trun()']);
		expect(range(rendered)).toEqual([0, 3, 0, 3]);
		// Inside the indentation, the caret moves to the line's new start.
		await select(rendered, [0, 1]);
		await tab(true);
		expect(lines(rendered)).toEqual(['run()']);
		expect(range(rendered)).toEqual([0, 0, 0, 0]);
		// Nothing to remove: the key is claimed and nothing changes.
		const { defaultPrevented } = await tab(true);
		expect(defaultPrevented).toBe(true);
		expect(canonicalTree(rendered.edytor)).toHaveLength(1);
		expect(lines(rendered)).toEqual(['run()']);
	});

	it('Backspace in an empty block right after a code block removes it; the caret ends the code', async () => {
		const rendered = await inCode(['a', 'last'], [{ type: 'paragraph' }]);
		const { edytor, editor } = rendered;
		edytor.selection.setAtTextOffset(edytor.root!.children[1]!.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor).map((b) => b.type)).toEqual(['code']);
		expect(lines(rendered)).toEqual(['a', 'last']);
		expect(range(rendered)).toEqual([1, 4, 1, 4]);
		expect(edytor.selection.state.startBlock?.type).toBe('codeLine');
	});

	it('Delete in an empty first block before a code block removes it; the caret starts the code (SW-behaviors-4)', async () => {
		const { edytor, editor } = await render([codePlugin], {
			children: [
				{ type: 'paragraph' },
				{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'a' }] }] }
			]
		});
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		expect(canonicalTree(edytor).map((b) => b.type)).toEqual(['code']);
		const { startBlock, yStart } = edytor.selection.state;
		expect([startBlock?.type, yStart]).toEqual(['codeLine', 0]);
	});

	it('Backspace at the start of a block with text after a code block leaves it in place', async () => {
		const rendered = await inCode(['a'], [{ type: 'paragraph', content: [{ text: 'p' }] }]);
		const { edytor, editor } = rendered;
		edytor.selection.setAtTextOffset(edytor.root!.children[1]!.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor).map((b) => b.type)).toEqual(['code', 'paragraph']);
		// The caret moves to the end of the code.
		expect(range(rendered)).toEqual([0, 1, 0, 1]);
		expect(edytor.selection.state.startBlock?.type).toBe('codeLine');
	});
});

describe('Mod+A in a code block (YW-03)', () => {
	const doc = () =>
		render([codePlugin], {
			children: [
				{ type: 'paragraph', content: [{ text: 'a' }] },
				{
					type: 'code',
					children: ['x', 'y'].map((text) => ({ type: 'codeLine', content: [{ text }] }))
				},
				{ type: 'paragraph', content: [{ text: 'z' }] }
			]
		});
	type Rendered = Awaited<ReturnType<typeof doc>>;
	const shape = ({ edytor }: Rendered) =>
		canonicalTree(edytor).map((block) =>
			block.type === 'code'
				? ['code', (block.children ?? []).map((line) => firstTextOf(line) ?? '')]
				: [block.type, firstTextOf(block) ?? '']
		);
	const selectAll = () => dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
	const caretInLine = async ({ edytor }: Rendered, index: number, offset: number) => {
		edytor.selection.setAtTextOffset(edytor.root!.children[1]!.children[index]!.firstText!, offset);
		await flushDomUpdates();
	};

	it('climbs from the code’s text to the code block, then to every block', async () => {
		const rendered = await doc();
		const { edytor } = rendered;
		await caretInLine(rendered, 1, 1);
		await selectAll();
		const { startBlock, endBlock, yStart, yEnd, isCollapsed } = edytor.selection.state;
		expect([
			startBlock?.firstText?.stringContent,
			yStart,
			endBlock?.firstText?.stringContent,
			yEnd
		]).toEqual(['x', 0, 'y', 1]);
		expect([isCollapsed, edytor.selection.selectedBlocks.size]).toEqual([false, 0]);
		await selectAll();
		expect([...edytor.selection.selectedBlocks].map((block) => block.type)).toEqual(['code']);
		await selectAll();
		expect(edytor.selection.selectedBlocks.size).toBe(edytor.facade.order().length);
	});

	it.each([
		[
			'Backspace',
			(r: Rendered) => dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentBackward' })
		],
		[
			'Delete',
			(r: Rendered) => dispatchDomBeforeInput(r.editor, { inputType: 'deleteContentForward' })
		],
		['cut', (r: Rendered) => dispatchCut(r.editor)]
	] as const)(
		'then %s empties the code block and keeps it, the caret on its line',
		async (_, act) => {
			const rendered = await doc();
			const { edytor } = rendered;
			await caretInLine(rendered, 0, 1);
			await selectAll();
			await act(rendered);
			expect(shape(rendered)).toEqual([
				['paragraph', 'a'],
				['code', ['']],
				['paragraph', 'z']
			]);
			const { startBlock, yStart, isCollapsed } = edytor.selection.state;
			expect([startBlock?.type, yStart, isCollapsed]).toEqual(['codeLine', 0, true]);
			await dispatchDomBeforeInput(rendered.editor, { inputType: 'insertText', data: 'q' });
			expect(shape(rendered)).toEqual([
				['paragraph', 'a'],
				['code', ['q']],
				['paragraph', 'z']
			]);
		}
	);

	it('from an empty line selects the code’s text first too (SW8-behaviors-1)', async () => {
		const rendered = await render([codePlugin], {
			children: [
				{
					type: 'code',
					children: ['x', ''].map((text) => ({ type: 'codeLine', content: [{ text }] }))
				}
			]
		});
		const { edytor } = rendered;
		const [x, empty] = edytor.root!.children[0]!.children;
		edytor.selection.setAtTextOffset(empty!.firstText!, 0);
		await flushDomUpdates();
		await selectAll();
		const { startBlock, endBlock, yStart, yEnd } = edytor.selection.state;
		expect([startBlock?.id, yStart, endBlock?.id, yEnd]).toEqual([x!.id, 0, empty!.id, 0]);
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		await selectAll();
		expect([...edytor.selection.selectedBlocks].map((block) => block.type)).toEqual(['code']);
	});

	it('a code block with no text goes straight to the block', async () => {
		const rendered = await render([codePlugin], {
			children: [{ type: 'code', children: [{ type: 'codeLine', content: [{ text: '' }] }] }]
		});
		const { edytor } = rendered;
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.children[0]!.firstText!, 0);
		await flushDomUpdates();
		await selectAll();
		expect([...edytor.selection.selectedBlocks].map((block) => block.type)).toEqual(['code']);
	});

	it('one undo brings the lines back with the selection', async () => {
		const rendered = await doc();
		const { edytor } = rendered;
		await caretInLine(rendered, 0, 1);
		await selectAll();
		await dispatchDomBeforeInput(rendered.editor, { inputType: 'deleteContentBackward' });
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(shape(rendered)).toEqual([
			['paragraph', 'a'],
			['code', ['x', 'y']],
			['paragraph', 'z']
		]);
		const { startBlock, endBlock, yStart, yEnd } = edytor.selection.state;
		expect([
			startBlock?.firstText?.stringContent,
			yStart,
			endBlock?.firstText?.stringContent,
			yEnd
		]).toEqual(['x', 0, 'y', 1]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'undo', status: 'applied' });
	});

	it('the code’s text deleted headlessly keeps the code block too', async () => {
		const rendered = await doc();
		const { edytor } = rendered;
		const [first, last] = edytor.root!.children[1]!.children;
		const { facade } = edytor;
		edytor.document.transact(() =>
			facade.apply(
				facade.prepare.deleteRange({ block: first!.id, offset: 0 }, { block: last!.id, offset: 1 })
			)
		);
		await flushDomUpdates();
		expect(shape(rendered)).toEqual([
			['paragraph', 'a'],
			['code', ['']],
			['paragraph', 'z']
		]);
	});
});

describe('a relative move never hides the moved block (YW-13)', () => {
	const toggle = (id: string, children: JSONBlock[] = []): JSONBlock => ({
		id,
		type: 'toggle',
		content: [{ text: id }],
		children
	});
	const para = (id: string, children?: JSONBlock[]): JSONBlock => ({
		id,
		type: 'paragraph',
		content: [{ text: id }],
		...(children && { children })
	});
	const isOpen = (edytor: Awaited<ReturnType<typeof render>>['edytor'], id: string) =>
		(edytor.idToBlock.get(id)!.node as HTMLDetailsElement).open;

	it('edytor.moveBlocks({ direction: "in" }) beside a closed toggle opens it', async () => {
		const { edytor } = await render([], { children: [toggle('t', [para('body')]), para('x')] });
		expect(isOpen(edytor, 't')).toBe(false);
		const moved = edytor.moveBlocks({ blocks: [edytor.idToBlock.get('x')!], direction: 'in' });
		await flushDomUpdates();
		expect(moved.map((block) => block.id)).toEqual(['x']);
		expect(edytor.idToBlock.get('x')!.parent?.id).toBe('t');
		expect(isOpen(edytor, 't')).toBe(true);
		expect(edytor.selection.hidden(edytor.idToBlock.get('x')!)).toBe(false);
	});

	it('edytor.moveBlocks inside a closed toggle as a target opens it', async () => {
		const { edytor } = await render([], { children: [toggle('t'), para('x')] });
		const [t, x] = [edytor.idToBlock.get('t')!, edytor.idToBlock.get('x')!];
		edytor.moveBlocks({ blocks: [x], target: t, position: 'inside' });
		await flushDomUpdates();
		expect(isOpen(edytor, 't')).toBe(true);
	});

	it('edytor.moveBlocks({ direction: "out" }) of a closed toggle that adopts its siblings opens it', async () => {
		const { edytor } = await render([], {
			children: [para('p', [toggle('t', [para('body')]), para('s')])]
		});
		edytor.moveBlocks({ blocks: [edytor.idToBlock.get('t')!], direction: 'out' });
		await flushDomUpdates();
		expect(edytor.idToBlock.get('s')!.parent?.id).toBe('t');
		expect(isOpen(edytor, 't')).toBe(true);
	});
});
