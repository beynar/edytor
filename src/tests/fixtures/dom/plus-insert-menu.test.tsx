/** @jsxImportSource ../../jsx */
/**
 * The handle's `+` (user request, wave 17): it changes nothing in the
 * document until the user picks what to insert. It opens the slash menu's
 * rows beside the handle, with the menu's own query; a picked kind inserts
 * one block of that kind after the block (before it with Alt), where the
 * kind fits, as one undo step with the caret in it; an empty default block
 * converts in place. Escape, a press outside, a blur or readonly insert
 * nothing. Expected states are hand-authored from Notion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createSlashMenuPlugin, slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import type { SlashMenuController } from '$lib/plugins/slashMenu/SlashMenuController.svelte.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const li = (id: string): JSONBlock => ({ id, type: 'list-item', content: [{ text: id }] });
const list: JSONBlock = { id: 'L', type: 'unordered-list', children: [li('one'), li('two')] };

const render = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, codePlugin, ...plugins],
			value: { children }
		}
	);
const withMenu = (children: JSONBlock[], plugins: Plugin[] = []) =>
	render(children, [slashMenuPlugin, ...plugins]);

type Outline = string | [string, Outline[]];
const outline = (b: JSONBlock): Outline => {
	const text = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
	const self = text ? `${b.type} "${text}"` : b.type;
	return b.children?.length ? [self, b.children.map(outline)] : self;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return isCollapsed ? `${startText?.parent.type}@${yStart}` : 'range';
};

const plus = async (id: string, altKey = false) => {
	const button = document.querySelector(
		`[data-edytor-block-handle-host][data-block-id="${id}"] [data-testid="block-add"]`
	)!;
	button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey }));
	await flushDomUpdates();
};
const menu = () => document.querySelector('[data-testid="slash-menu"]');
const field = () => document.querySelector<HTMLInputElement>('[data-testid="slash-menu"] input')!;
const key = async (key: string, target: Element = field()) => {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const search = async (query: string) => {
	field().value = query;
	field().dispatchEvent(new Event('input', { bubbles: true }));
	await flushDomUpdates();
};
const pick = async (label: string) => {
	const row = [...document.querySelectorAll('[data-testid="slash-menu-item"]')].find(
		(item) => item.textContent === label
	);
	if (!row) throw new Error(`no row ${label}`);
	row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

describe('the + opens the insert menu and changes nothing', () => {
	it('click: the menu opens with its own field focused; the document and history stay', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		const steps = edytor.undoManager.undoStack.length;
		await plus('a');
		expect(menu()).not.toBeNull();
		expect(document.activeElement).toBe(field());
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
	});

	it('typing filters the menu, never the document', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		await plus('a');
		await search('head');
		const rows = [...document.querySelectorAll('[data-testid="slash-menu-item"]')];
		expect(rows.map((row) => row.textContent)).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		await key('ArrowDown');
		expect(rows[1]!.getAttribute('data-selected')).toBe('true');
	});

	it('picking Heading 1 inserts one heading after, the caret in it, as one undo step', async () => {
		const { edytor, editor } = await withMenu([p('a'), p('b')]);
		const steps = edytor.undoManager.undoStack.length;
		await plus('a');
		await pick('Heading 1');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'heading', 'paragraph "b"']);
		expect(edytor.value.children![1]!.data).toEqual({ level: 'h1' });
		expect(menu()).toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(caret(edytor)).toBe('heading@0');
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('Alt-click inserts before the block', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		await plus('b', true);
		await search('head');
		await key('Enter');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'heading', 'paragraph "b"']);
		expect(caret(edytor)).toBe('heading@0');
	});

	it('beside an empty paragraph, the pick converts it in place', async () => {
		const { edytor } = await withMenu([p('a'), p('e', '')]);
		await plus('e');
		await pick('Heading 1');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'heading']);
		expect(edytor.value.children![1]!.id).toBe('e');
		expect(caret(edytor)).toBe('heading@0');
	});

	it('Text beside an empty paragraph keeps it and puts the caret in it', async () => {
		const { edytor } = await withMenu([p('a'), p('e', '')]);
		await plus('e');
		await pick('Text');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph']);
		expect(edytor.selection.state.startText?.parent.id).toBe('e');
		expect(edytor.dispatcher.last?.status).not.toBe('refused');
	});

	it('Text beside a filled paragraph inserts an empty paragraph after it', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		const steps = edytor.undoManager.undoStack.length;
		await plus('a');
		await pick('Text');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph', 'paragraph "b"']);
		expect(caret(edytor)).toBe('paragraph@0');
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
	});

	it('Escape: nothing inserted, no undo step, focus and caret back where they were', async () => {
		const { edytor, editor } = await withMenu([p('a'), p('b')]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		const steps = edytor.undoManager.undoStack.length;
		await plus('b');
		await search('head');
		await key('Escape');
		expect(menu()).toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
		expect(document.activeElement).toBe(editor);
		expect(caret(edytor)).toBe('paragraph@1');
		expect(edytor.selection.state.startText?.parent.id).toBe('a');
	});

	it('a press outside closes it: nothing inserted, the caret as it was', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		await plus('b');
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.selection.state.startText?.parent.id).toBe('a');
	});

	it('focus leaving the menu (Tab away) closes it with nothing inserted', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		const outside = document.body.appendChild(document.createElement('button'));
		await plus('a');
		outside.focus();
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(document.activeElement).toBe(outside);
	});

	it('SW17-plus-1: Enter or Escape that ends an IME composition in the field picks and closes nothing', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		await plus('a');
		await search('head');
		for (const key of ['Enter', 'Escape'])
			field().dispatchEvent(
				new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })
			);
		await flushDomUpdates();
		expect(menu()).not.toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});

	it('readonly: the + opens no menu and inserts nothing; turning readonly closes an open one', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		await plus('a');
		edytor.readonly = true;
		await flushDomUpdates();
		expect(menu()).toBeNull();
		await plus('a');
		expect(menu()).toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});
});

describe('the + places the picked kind where it fits', () => {
	it('beside a list item, a heading splits the list after the item', async () => {
		const { edytor } = await withMenu([p('a'), list, p('b')]);
		await plus('one');
		await pick('Heading 1');
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', ['list-item "one"']],
			'heading',
			['unordered-list', ['list-item "two"']],
			'paragraph "b"'
		]);
		expect(caret(edytor)).toBe('heading@0');
	});

	it('beside a list item, Bulleted list adds an item in the list', async () => {
		const { edytor } = await withMenu([p('a'), list, p('b')]);
		await plus('one');
		await pick('Bulleted list');
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', ['list-item "one"', 'list-item', 'list-item "two"']],
			'paragraph "b"'
		]);
		expect(caret(edytor)).toBe('list-item@0');
	});

	it('beside the last item, a heading lands after the list', async () => {
		const { edytor } = await withMenu([p('a'), list, p('b')]);
		await plus('two');
		await pick('Heading 1');
		expect(doc(edytor)).toEqual([
			'paragraph "a"',
			['unordered-list', ['list-item "one"', 'list-item "two"']],
			'heading',
			'paragraph "b"'
		]);
	});

	it('Divider inserts a divider after the block, the caret on a line after it', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		const steps = edytor.undoManager.undoStack.length;
		await plus('a');
		await pick('Divider');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'divider', 'paragraph', 'paragraph "b"']);
		expect(caret(edytor)).toBe('paragraph@0');
		expect(edytor.selection.state.startText?.parent.index).toBe(2);
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
	});

	it('Code inserts a code block after the block, the caret in its line', async () => {
		const { edytor } = await withMenu([p('a'), p('b')]);
		await plus('a');
		await pick('Code');
		expect(doc(edytor)).toEqual(['paragraph "a"', ['code', ['codeLine']], 'paragraph "b"']);
		expect(caret(edytor)).toBe('codeLine@0');
	});
});

describe('a veto on the + insert', () => {
	const veto =
		(operation: string): Plugin =>
		() => ({
			onBeforeOperation: ({ operation: op, prevent }) => {
				if (op === operation) prevent();
			}
		});

	for (const operation of ['insertBlockAfter', 'setBlock']) {
		it(`a vetoed ${operation} inserts nothing and reports refused`, async () => {
			const { edytor } = await withMenu([p('a'), p('b')], [veto(operation)]);
			edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
			await flushDomUpdates();
			const steps = edytor.undoManager.undoStack.length;
			await plus('a');
			await pick('Heading 1');
			expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
			expect(edytor.undoManager.undoStack.length).toBe(steps);
			expect(edytor.undoManager.redoStack.length).toBe(0);
			expect(edytor.dispatcher.last?.status).toBe('refused');
			expect(edytor.selection.state.startText?.parent.id).toBe('a');
		});
	}
});

describe('without the slash menu, or with a custom menu', () => {
	it('no slash menu: the + inserts an empty default block, the caret in it, no "/"', async () => {
		const { edytor } = await render([p('a'), p('b')]);
		await plus('a');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph', 'paragraph "b"']);
		expect(caret(edytor)).toBe('paragraph@0');
	});

	it('a custom `menu` snippet: typing goes to the menu query, never the document', async () => {
		let controller: SlashMenuController | undefined;
		const custom = createRawSnippet((get: () => SlashMenuController) => ({
			render: () => '<div data-testid="custom-menu"></div>',
			setup: () => {
				controller = get();
			}
		}));
		const { edytor, editor } = await render(
			[p('a'), p('b')],
			[createSlashMenuPlugin({ menu: custom })]
		);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		await plus('a');
		expect(document.querySelector('[data-testid="custom-menu"]')).not.toBeNull();
		// The editor does not hold the keyboard while the menu is open.
		expect(editor.contains(document.activeElement)).toBe(false);
		const typing = document.activeElement!;
		for (const letter of 'head') await key(letter, typing);
		expect(controller!.query).toBe('head');
		await key('Backspace', typing);
		expect(controller!.query).toBe('hea');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		await key('Enter', typing);
		expect(doc(edytor)).toEqual(['paragraph "a"', 'heading', 'paragraph "b"']);
	});
});
