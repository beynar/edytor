/** @jsxImportSource ../../jsx */
/**
 * Wave 17 (`docs/reviews/2026-09-30-rescore-14.md`), selection and block
 * menu units. Expected states are hand-authored from Notion and the
 * contract rows (`sel.blocks.exact`).
 *
 * - HX-01: a grip-selected list or code block is ONE block to the block
 *   menu (the link row shows; Escape, Move and Duplicate return a caret);
 *   its actions that act on content (Delete, Turn into) take its items.
 * - HX-02: the documented "delete the selected blocks" snippet
 *   (`selection.selectedMembers`) removes a grip-selected list whole; the
 *   documented custom-menu Turn into converts its items.
 * - HX-08: leaving a block selection whose divider starts or ends the
 *   document gives the range over its lines, the divider left out.
 * - HX-13: the range a list's block selection leaves ends at its last
 *   nested item, as its members do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	dispatchClipboardPaste,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const li = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'list-item',
	content: [{ text: id }],
	...(children && { children })
});
const list = (items: JSONBlock[]): JSONBlock => ({
	id: 'L',
	type: 'unordered-list',
	children: items
});
const code: JSONBlock = {
	id: 'C',
	type: 'code',
	children: [
		{ id: 'l1', type: 'codeLine', content: [{ text: 'let a' }] },
		{ id: 'l2', type: 'codeLine', content: [{ text: 'let b' }] }
	]
};

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [
				richTextPlugin,
				mentionPlugin,
				codePlugin,
				createBlockMenuPlugin({ linkTo: (block) => `#${block.id}` })
			],
			value: { children }
		}
	);

type Outline = string | [string, Outline[]];
const outline = (b: JSONBlock): Outline => {
	const text = (b.content ?? [])
		.map((part) => ('text' in part ? (part.marks?.bold ? `*${part.text}*` : part.text) : '@'))
		.join('');
	const self = text ? `${b.type} "${text}"` : b.type;
	return b.children?.length ? [self, b.children.map(outline)] : self;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
const block = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!;
/** The selection as `block@offset…block@offset` (a caret: `block@offset`), or `blocks:…`. */
const shape = (edytor: Edytor) => {
	const { value } = edytor.selection;
	if (value.kind === 'blocks') return `blocks:${value.ids.join(',')}`;
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	const start = `${startText?.parent.id}@${yStart}`;
	return isCollapsed ? start : `${start}…${endText?.parent.id}@${yEnd}`;
};

/** A handle click: the block is selected, then the menu opens beside it. */
const grip = async (edytor: Edytor, editor: HTMLElement, id: string) => {
	const target = block(edytor, id);
	edytor.selection.selectBlocks(target);
	editor.dispatchEvent(
		new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block: target, anchor: target.node } })
	);
	await flushDomUpdates();
};
const rows = () =>
	[...document.querySelectorAll('[data-testid^="block-menu-"]')].map((row) =>
		row.getAttribute('data-testid')!.slice('block-menu-'.length)
	);
const click = async (id: string) => {
	const button = document.querySelector(`[data-testid="block-menu-${id}"]`)!;
	button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const escape = async () => {
	const input = document.querySelector('[data-testid="block-menu"] input')!;
	input.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
	);
	await flushDomUpdates();
};

describe('HX-01: the block menu over a grip-selected list or code block', () => {
	const cases = [
		['list', 'L', [p('a'), list([li('one'), li('two')]), p('b')], 'one@0'],
		['code block', 'C', [p('a'), code, p('b')], 'l1@0']
	] as const;

	for (const [name, id, children, caret] of cases) {
		it(`${name}: one block — the link row shows, Escape returns a caret`, async () => {
			const { edytor, editor } = await render([...children]);
			await grip(edytor, editor, id);
			expect(rows()).toContain('link');
			await escape();
			expect(shape(edytor)).toBe(caret);
		});

		it(`${name}: Move down moves it whole and returns a caret`, async () => {
			const { edytor, editor } = await render([...children]);
			await grip(edytor, editor, id);
			await click('down');
			expect(doc(edytor).map((b) => (typeof b === 'string' ? b : b[0]))).toEqual([
				'paragraph "a"',
				'paragraph "b"',
				name === 'list' ? 'unordered-list' : 'code'
			]);
			expect(shape(edytor)).toBe(caret);
		});

		it(`${name}: Duplicate copies it once, the caret in the copy`, async () => {
			const { edytor, editor } = await render([...children]);
			await grip(edytor, editor, id);
			await click('duplicate');
			const kinds = doc(edytor).map((b) => (typeof b === 'string' ? b : b[0]));
			const kind = name === 'list' ? 'unordered-list' : 'code';
			expect(kinds).toEqual(['paragraph "a"', kind, kind, 'paragraph "b"']);
			expect(edytor.selection.value.kind).toBe('text');
			const copy = edytor.value.children![2]!;
			expect(edytor.selection.state.startBlock?.id).toBe(copy.children![0]!.id);
		});

		it(`${name}: Delete removes it with its ${name === 'list' ? 'items' : 'lines'}`, async () => {
			const { edytor, editor } = await render([...children]);
			await grip(edytor, editor, id);
			await click('delete');
			expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
			expect(shape(edytor)).toBe('a@1');
		});
	}

	it('list: Turn into converts its items, which stay selected', async () => {
		const { edytor, editor } = await render([p('a'), list([li('one'), li('two')]), p('b')]);
		await grip(edytor, editor, 'L');
		expect(rows()).toContain('turn');
		await click('turn');
		const heading = [...document.querySelectorAll('.block-menu-flyout button')].find(
			(button) => button.textContent === 'Heading 2'
		)!;
		heading.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			'heading "one"',
			'heading "two"',
			'paragraph "b"'
		]);
		expect(shape(edytor)).toBe('blocks:one,two');
	});

	it('Escape, then Mod+B, leaves a closed toggle in the list as it is (DR-behavior-4)', async () => {
		const toggle: JSONBlock = {
			id: 'T',
			type: 'toggle',
			content: [{ text: 'T' }],
			children: [p('body')]
		};
		const { edytor, editor } = await render([p('a'), list([li('one', [toggle])]), p('b')]);
		expect((block(edytor, 'T').node as HTMLDetailsElement).open).toBe(false);
		await grip(edytor, editor, 'L');
		await escape();
		expect(shape(edytor)).toBe('one@0');
		await dispatchDomKeyDown(document, { key: 'b', metaKey: true, ctrlKey: true });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', [['list-item "one"', [['toggle "T"', ['paragraph "body"']]]]]],
			'paragraph "b"'
		]);
	});

	it('several selected blocks stay several: Escape keeps them selected', async () => {
		const { edytor, editor } = await render([p('a'), list([li('one'), li('two')]), p('b')]);
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'L'));
		const target = block(edytor, 'a');
		editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block: target, anchor: target.node } })
		);
		await flushDomUpdates();
		expect(rows()).not.toContain('link');
		await escape();
		expect(shape(edytor)).toBe('blocks:a,L');
	});
});

describe('HX-02: the documented block-selection snippets', () => {
	it('commands.mdx: deleteBlocks over selection.selectedMembers removes a selected list whole', async () => {
		const { edytor } = await render([p('a'), list([li('one'), li('two')]), p('b')]);
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await flushDomUpdates();
		expect(edytor.selection.selectedMembers.map((b) => b.id)).toEqual(['L', 'one', 'two']);
		edytor.deleteBlocks({ blocks: edytor.selection.selectedMembers });
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('block-handles.mdx: the custom menu Turn into converts a selected list items', async () => {
		const { edytor } = await render([p('a'), list([li('one'), li('two')]), p('b')]);
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await flushDomUpdates();
		expect(await edytor.runCommand('block.heading2')).toBe(true);
		await flushDomUpdates();
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			'heading "one"',
			'heading "two"',
			'paragraph "b"'
		]);
	});
});

describe('HX-08: leaving a block selection with a divider at the document edge', () => {
	it('[x, divider]: the range spans x, the last divider left out', async () => {
		const { edytor } = await render([p('x'), { id: 'd', type: 'divider' }]);
		edytor.selection.selectBlocks(block(edytor, 'x'), block(edytor, 'd'));
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		expect(shape(edytor)).toBe('x@0…x@1');
	});

	it('[divider, after]: the range spans after, the first divider left out', async () => {
		const { edytor } = await render([{ id: 'd', type: 'divider' }, p('after')]);
		edytor.selection.selectBlocks(block(edytor, 'd'), block(edytor, 'after'));
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		expect(shape(edytor)).toBe('after@0…after@5');
	});
});

describe('HX-13: a list with nested items shows its last line last', () => {
	const nested = () => render([p('a'), list([li('one', [li('deep')])]), p('b')]);

	it('leaving its block selection ends at the nested item', async () => {
		const { edytor } = await nested();
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		expect(shape(edytor)).toBe('one@0…deep@4');
	});

	it('setAtBlockRange spans the nested item', async () => {
		const { edytor } = await nested();
		edytor.selection.setAtBlockRange(block(edytor, 'L'));
		await flushDomUpdates();
		expect(shape(edytor)).toBe('one@0…deep@4');
	});
});

/**
 * The user's request (wave 17): the handle's `+` adds nothing until the user
 * picks what to insert. It opens the slash menu beside the handle, with its
 * own search field; a picked row adds the block and converts it as one undo
 * step; Escape or a press outside leaves the document as it was.
 */
describe('the + adds nothing until a row is picked', () => {
	const renderAdd = (plugins = [richTextPlugin, mentionPlugin, slashMenuPlugin]) =>
		renderDomEdytor(
			<root>
				<paragraph>a|</paragraph>
				<paragraph>b</paragraph>
			</root>,
			{ plugins }
		);
	const plus = async (index = 0, altKey = false) => {
		const button = document.querySelectorAll('[data-testid="block-add"]')[index]!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey }));
		await flushDomUpdates();
	};
	const field = () => document.querySelector<HTMLInputElement>('[data-testid="slash-menu"] input')!;
	const key = async (key: string) => {
		field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		await flushDomUpdates();
	};
	const search = async (query: string) => {
		field().value = query;
		field().dispatchEvent(new Event('input', { bubbles: true }));
		await flushDomUpdates();
	};
	const kinds = (edytor: Edytor) => doc(edytor);

	it('opens the slash menu, its search field focused, and changes nothing', async () => {
		const { edytor } = await renderAdd();
		const steps = edytor.undoManager.undoStack.length;
		await plus();
		expect(document.querySelector('[data-testid="slash-menu"]')).not.toBeNull();
		expect(document.activeElement).toBe(field());
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
	});

	it('a picked row adds the block of that kind below, the caret in it, as one undo step', async () => {
		const { edytor, editor } = await renderAdd();
		const steps = edytor.undoManager.undoStack.length;
		await plus();
		await search('head');
		await key('Enter');
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'heading', 'paragraph "b"']);
		expect(document.querySelector('[data-testid="slash-menu"]')).toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(edytor.selection.state.startBlock?.type).toBe('heading');
		expect(edytor.selection.state.yStart).toBe(0);
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('Alt+click adds above; a click on a row picks it', async () => {
		const { edytor } = await renderAdd();
		await plus(1, true);
		const row = [...document.querySelectorAll('[data-testid="slash-menu-item"]')].find(
			(item) => item.textContent === 'Heading 2'
		)!;
		row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'heading', 'paragraph "b"']);
	});

	it('Escape closes it: nothing added, the caret back where it was', async () => {
		const { edytor, editor } = await renderAdd();
		const caret = shape(edytor);
		expect(caret).toMatch(/@1$/);
		await plus();
		await key('Escape');
		expect(document.querySelector('[data-testid="slash-menu"]')).toBeNull();
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(document.activeElement).toBe(editor);
		expect(shape(edytor)).toBe(caret);
	});

	it('a press outside closes it with nothing added; a query with no match keeps it open', async () => {
		const { edytor } = await renderAdd();
		await plus();
		await search('zzz');
		expect(document.querySelector('[data-testid="slash-menu-empty"]')).not.toBeNull();
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="slash-menu"]')).toBeNull();
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('beside an empty paragraph, the picked kind converts it (no extra block)', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin] }
		);
		await plus(1);
		await search('head');
		await key('Enter');
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'heading']);
	});

	it('without a slash menu, the + adds an empty block with the caret in it', async () => {
		const { edytor } = await renderAdd([richTextPlugin, mentionPlugin]);
		await plus();
		expect(kinds(edytor)).toEqual(['paragraph "a"', 'paragraph', 'paragraph "b"']);
		expect(shape(edytor)).toBe(`${edytor.value.children![1]!.id}@0`);
	});
});

describe('a paste over a block selection with a collapsed DOM caret (onPaste)', () => {
	const pasteWithDomCaretIn = async (id: string) => {
		const { edytor, editor } = await render([p('one'), p('two')]);
		edytor.selection.selectBlocks(block(edytor, 'one'));
		await flushDomUpdates();
		// The browser's caret moved before the editor saw a selectionchange.
		const node = block(edytor, id).firstText!.node!;
		const leaf = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!;
		window.getSelection()!.collapse(leaf, 1);
		await dispatchClipboardPaste(editor, { 'text/plain': 'X' });
		return doc(edytor);
	};

	it('outside the selected blocks, it pastes at that caret', async () => {
		expect(await pasteWithDomCaretIn('two')).toEqual(['paragraph "one"', 'paragraph "tXwo"']);
	});

	it('inside them, it replaces the selected blocks', async () => {
		expect(await pasteWithDomCaretIn('one')).toEqual(['paragraph "X"', 'paragraph "two"']);
	});
});

describe('SW17-menus-1: one menu at a time between the grip and the +', () => {
	it('a + click while the block menu is open closes it and opens the + menu alone', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>a|</paragraph>
				<paragraph>b</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin, createBlockMenuPlugin()]
			}
		);
		const first = edytor.root!.children[0]!;
		await grip(edytor, editor, first.id);
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		const add = document.querySelector('[data-testid="block-add"]')!;
		add.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		add.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		expect(document.querySelector('[data-testid="slash-menu"] input')).not.toBeNull();
	});
});
