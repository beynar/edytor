/** @jsxImportSource ../../jsx */
/**
 * Wave 9, behaviors: Turn into over a block selection that holds a list
 * container (ZW-02); `dispatcher.last` of a Tab over several sibling groups
 * (ZW-07); Delete at the end of a closed toggle's header above a list
 * (ZW-08); the public nest/unnest/move commands reveal a closed toggle
 * (ZW-09). Expected states are hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { hidden } from '$lib/selection/visibility.js';
import { convertToKind } from '$lib/kinds.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, ...plugins], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const text = (value: string) => [{ text: value }];
const block = (type: string, id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type,
	content: text(id),
	...(children && { children })
});
const p = (id: string, children?: JSONBlock[]) => block('paragraph', id, children);
/** A toggle `id` with a text of its id; closed (its default). */
const toggle = (id: string, children: JSONBlock[]) => block('toggle', id, children);
const li = (id: string, children?: JSONBlock[]) => block('list-item', id, children);
/** A structural list (a pasted `<ul>`): no content of its own, items as children. */
const ul = (id: string, children: JSONBlock[]): JSONBlock => ({
	id,
	type: 'unordered-list',
	children
});

/** The tree as `type "text"` lines, a block with children as `[line, children]`. */
const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const line = `${b.type} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const heading2 = () =>
	dispatchDomKeyDown(document, { key: '2', code: 'Digit2', ctrlKey: true, altKey: true });

describe('Turn into over a selection holding a list container (ZW-02)', () => {
	const seed = () => [p('a'), ul('u', [li('b'), li('c')])];
	/**
	 * Notion: every row becomes a heading. The list is never converted; its
	 * items are, and an item turned into another kind leaves the list (a list
	 * holds only items), which goes once it has none.
	 */
	const converted = ['heading "a"', 'heading "b"', 'heading "c"'];
	const selectAll = async (view: View) => {
		view.edytor.selection.selectBlocks(...['a', 'u', 'b', 'c'].map((id) => get(view, id)));
		await flushDomUpdates();
	};
	const pick = async (menu: string, label: string) => {
		const row = [...document.querySelectorAll(`[aria-label="${menu}"] button`)].find(
			(b) => b.textContent === label
		)!;
		await click(row);
	};
	const grip = async (view: View, id: string) => {
		const block = get(view, id);
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
	};

	it('a text range over the rows converts the items, not the container', async () => {
		const view = await render([], seed());
		view.edytor.selection.setAtRange(get(view, 'a').firstText!, 0, get(view, 'c').firstText!, 1);
		await flushDomUpdates();
		await heading2();
		expect(shape(view)).toEqual(converted);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(shape(view)).toEqual([
			'paragraph "a"',
			['unordered-list ""', ['list-item "b"', 'list-item "c"']]
		]);
	});

	it('Mod+Alt+2 over a block selection of the same rows gives the same result', async () => {
		const view = await render([], seed());
		await selectAll(view);
		await heading2();
		expect(shape(view)).toEqual(converted);
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['a', 'b', 'c']);
	});

	it('the block menu Turn into over the block selection gives the same result', async () => {
		const view = await render([blockMenuPlugin], seed());
		await selectAll(view);
		await grip(view, 'a');
		await click(document.querySelector('[data-testid="block-menu-turn"]')!);
		await pick('Turn into', 'Heading 2');
		expect(shape(view)).toEqual(converted);
	});

	it('the toolbar Turn into over the rows gives the same result', async () => {
		const view = await render([toolbarPlugin], seed());
		view.edytor.selection.setAtRange(get(view, 'a').firstText!, 0, get(view, 'c').firstText!, 1);
		await flushDomUpdates();
		await click(document.querySelector('.toolbar-type')!);
		await pick('Turn into', 'Heading 2');
		expect(shape(view)).toEqual(converted);
	});

	it('the list selected alone is not converted: its grip menu offers no Turn into', async () => {
		const view = await render([blockMenuPlugin], seed());
		expect(get(view, 'u').convertible).toBe(false);
		view.edytor.selection.selectBlocks(get(view, 'u'));
		await grip(view, 'u');
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="block-menu-turn"]')).toBeNull();
	});

	it('Mod+Alt+2 over the list selected alone changes nothing (only what is selected converts)', async () => {
		const view = await render([], seed());
		view.edytor.selection.setAtTextOffset(get(view, 'b').firstText!, 0);
		await flushDomUpdates();
		view.edytor.selection.selectBlocks(get(view, 'u'));
		await flushDomUpdates();
		await heading2();
		expect(shape(view)).toEqual([
			'paragraph "a"',
			['unordered-list ""', ['list-item "b"', 'list-item "c"']]
		]);
	});

	it('convertToKind on the list itself is refused', async () => {
		const view = await render([], seed());
		const row = view.edytor.kinds.find((kind) => kind.label === 'Heading 2')!;
		expect(convertToKind(view.edytor, get(view, 'u'), row)).toBe(false);
		expect(get(view, 'u').type).toBe('unordered-list');
	});

	it('a middle item turned into a heading splits the list, as Shift+Tab does; the caret stays', async () => {
		const view = await render([], [ul('u', [li('b'), li('c'), li('d')])]);
		view.edytor.selection.setAtTextOffset(get(view, 'c').firstText!, 1);
		await flushDomUpdates();
		await heading2();
		expect(shape(view)).toEqual([
			['unordered-list ""', ['list-item "b"']],
			'heading "c"',
			['unordered-list ""', ['list-item "d"']]
		]);
		const { startBlock, yStart } = view.edytor.selection.state;
		expect([startBlock?.id, yStart]).toEqual(['c', 1]);
	});

	it('a markdown shortcut in an item makes the kind outside the list', async () => {
		const view = await render([markdownShortcutsPlugin], [ul('u', [li('b'), li('c')])]);
		view.edytor.selection.setAtTextOffset(get(view, 'b').firstText!, 0);
		await flushDomUpdates();
		for (const data of '# ')
			await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data });
		expect(shape(view)).toEqual(['heading "b"', ['unordered-list ""', ['list-item "c"']]]);
	});
});

describe('`dispatcher.last` of a Tab over several sibling groups (ZW-07)', () => {
	it('Tab over two groups where one nests reports applied', async () => {
		const view = await render([], [p('a'), p('b'), p('c', [p('d')])]);
		view.edytor.selection.selectBlocks(get(view, 'b'), get(view, 'd'));
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(shape(view)).toEqual([
			['paragraph "a"', ['paragraph "b"']],
			['paragraph "c"', ['paragraph "d"']]
		]);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
	});

	it('Shift+Tab over a contiguous range spanning two levels reports applied', async () => {
		const view = await render([], [p('a', [p('x')]), p('y')]);
		view.edytor.selection.setAtRange(get(view, 'x').firstText!, 0, get(view, 'y').firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(shape(view)).toEqual(['paragraph "a"', 'paragraph "x"', 'paragraph "y"']);
		expect(view.edytor.dispatcher.last?.status).toBe('applied');
	});

	it('a Tab where no group moves still reports refused', async () => {
		const view = await render([], [p('a'), p('b')]);
		view.edytor.selection.selectBlocks(get(view, 'a'));
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(view.edytor.dispatcher.last?.status).toBe('refused');
	});
});

describe('Delete at the end of a closed toggle header above a list (ZW-08)', () => {
	const caretAtHeaderEnd = async (view: View) => {
		view.edytor.selection.setAtTextOffset(get(view, 't').firstText!, 1);
		await flushDomUpdates();
	};

	it('pulls the first item into the header, as the seam range does', async () => {
		const expected = [
			['toggle "ta"', ['paragraph "body"']],
			['unordered-list ""', ['list-item "b"']]
		];
		const key = await render([], [toggle('t', [p('body')]), ul('u', [li('a'), li('b')])]);
		await caretAtHeaderEnd(key);
		await dispatchDomBeforeInput(key.editor, { inputType: 'deleteContentForward' });
		expect(shape(key)).toEqual(expected);
		const { startBlock, yStart } = key.edytor.selection.state;
		expect([startBlock?.id, yStart]).toEqual(['t', 1]);
		document.body.innerHTML = '';

		const range = await render([], [toggle('t', [p('body')]), ul('u', [li('a'), li('b')])]);
		range.edytor.selection.setAtRange(get(range, 't').firstText!, 1, get(range, 'a').firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(range.editor, { inputType: 'deleteContentBackward' });
		expect(shape(range)).toEqual(expected);
	});

	it('a one-item list goes once its item is pulled up', async () => {
		const view = await render([], [toggle('t', [p('body')]), ul('u', [li('a')])]);
		await caretAtHeaderEnd(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentForward' });
		expect(shape(view)).toEqual([['toggle "ta"', ['paragraph "body"']]]);
	});

	it('Backspace at the list’s first item below it lifts the item out (YW-02), then joins the header', async () => {
		const view = await render([], [toggle('t', [p('body')]), ul('u', [li('a'), li('b')])]);
		view.edytor.selection.setAtTextOffset(get(view, 'a').firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(shape(view)).toEqual([
			['toggle "t"', ['paragraph "body"']],
			'paragraph "a"',
			['unordered-list ""', ['list-item "b"']]
		]);
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(shape(view)).toEqual([
			['toggle "ta"', ['paragraph "body"']],
			['unordered-list ""', ['list-item "b"']]
		]);
	});
});

describe('the public nest, unnest and move commands reveal a closed toggle (ZW-09)', () => {
	const open = (view: View, id: string) => (get(view, id).node as HTMLDetailsElement).open;

	it('nestBlock into a closed toggle opens it', async () => {
		const view = await render([], [toggle('t', [p('body')]), p('x')]);
		expect(open(view, 't')).toBe(false);
		expect(get(view, 'x').nestBlock()).toBe(get(view, 'x'));
		await flushDomUpdates();
		expect(shape(view)).toEqual([['toggle "t"', ['paragraph "body"', 'paragraph "x"']]]);
		expect(open(view, 't')).toBe(true);
		expect(hidden(get(view, 'x'))).toBe(false);
	});

	it('unNestBlock of a closed toggle that adopts the siblings after it opens it', async () => {
		const view = await render([], [p('a', [toggle('x', [p('xb')]), p('y')])]);
		expect(open(view, 'x')).toBe(false);
		get(view, 'x').unNestBlock();
		await flushDomUpdates();
		expect(shape(view)).toEqual([
			'paragraph "a"',
			['toggle "x"', ['paragraph "xb"', 'paragraph "y"']]
		]);
		expect(open(view, 'x')).toBe(true);
		expect(hidden(get(view, 'y'))).toBe(false);
	});

	it('moveBlock and moveBlocks into a closed toggle open it', async () => {
		const view = await render([], [toggle('t', [p('body')]), p('x'), p('y')]);
		get(view, 'x').moveBlock({ path: [0, 1] });
		await flushDomUpdates();
		expect(open(view, 't')).toBe(true);
		(get(view, 't').node as HTMLDetailsElement).open = false;
		const y = get(view, 'y');
		y.moveBlocks({ blocks: [y], path: [0, 2] });
		await flushDomUpdates();
		expect(shape(view)).toEqual([
			['toggle "t"', ['paragraph "body"', 'paragraph "x"', 'paragraph "y"']]
		]);
		expect(open(view, 't')).toBe(true);
		expect(hidden(y)).toBe(false);
	});
});

describe('Enter in an empty list item ends the list (SW9-lists-1)', () => {
	const empty = (id: string): JSONBlock => ({ id, type: 'list-item', content: text('') });
	const enter = async (view: View, id: string) => {
		view.edytor.selection.setAtTextOffset(get(view, id).firstText!, 0);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
	};

	it('the last item leaves the list as a paragraph after it, caret in it', async () => {
		const view = await render([], [ul('u', [li('b'), empty('e')])]);
		await enter(view, 'e');
		expect(shape(view)).toEqual([['unordered-list ""', ['list-item "b"']], 'paragraph ""']);
		const { startBlock, yStart } = view.edytor.selection.state;
		expect([startBlock?.id, yStart]).toEqual(['e', 0]);
	});

	it('a middle item splits the list; the only item leaves it and the list goes', async () => {
		const middle = await render([], [ul('u', [li('b'), empty('e'), li('d')])]);
		await enter(middle, 'e');
		expect(shape(middle)).toEqual([
			['unordered-list ""', ['list-item "b"']],
			'paragraph ""',
			['unordered-list ""', ['list-item "d"']]
		]);
		document.body.innerHTML = '';
		const only = await render([], [p('a'), ul('u', [empty('e')])]);
		await enter(only, 'e');
		expect(shape(only)).toEqual(['paragraph "a"', 'paragraph ""']);
	});

	it('an item with text still adds an item after it', async () => {
		const view = await render([], [ul('u', [li('b')])]);
		view.edytor.selection.setAtTextOffset(get(view, 'b').firstText!, 1);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		expect(shape(view)).toEqual([['unordered-list ""', ['list-item "b"', 'list-item ""']]]);
	});
});
