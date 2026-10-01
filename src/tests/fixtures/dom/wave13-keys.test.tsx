/** @jsxImportSource ../../jsx */
/**
 * Wave 13 (`docs/reviews/2026-09-30-rescore-10.md`), keys over the Enter
 * role rules: Mod+Enter only modifies the block it is in, as Notion's does
 * (a to-do checks, a toggle opens or closes), and never splits (DW-03);
 * Enter over a block selection leaves it for the caret at the end of the
 * first selected block's line, changing nothing and removing nothing
 * (DW-04). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import {
	dispatchCut,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

/** Every `onDeleteSelectedBlocks` call's ids; the hook never refuses. */
const hookCalls: string[][] = [];
const watching: Plugin = () => ({
	onDeleteSelectedBlocks: ({ selectedBlocks }) => {
		hookCalls.push(selectedBlocks.map((b) => b.id));
	}
});
afterEach(() => {
	hookCalls.length = 0;
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [watching, richTextPlugin, mentionPlugin, codePlugin], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, extra: Partial<JSONBlock> = {}): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...extra
});
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
/** The document with ids, as JSON: every row compares it before and after. */
const doc = ({ edytor }: View) => JSON.stringify(edytor.value.children);
const caret = ({ edytor }: View) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return [startText?.parent.id, yStart, isCollapsed];
};
const caretIn = async (view: View, id: string, offset?: number) => {
	const text = get(view, id).firstText!;
	view.edytor.selection.setAtTextOffset(text, offset ?? text.length);
	await flushDomUpdates();
};
const modEnter = () => dispatchDomKeyDown(document, { key: 'Enter', ctrlKey: true });

describe('Mod+Enter modifies the block it is in and never splits (DW-03)', () => {
	it.each(['callout', 'quote'])(
		'in a %s header with children: nothing changes, the caret stays',
		async (type) => {
			const view = await render([
				{ id: 'C', type, content: [{ text: 'C' }], children: [p('k'), p('k2')] },
				p('z')
			]);
			await caretIn(view, 'C');
			const before = doc(view);
			const { defaultPrevented } = await modEnter();
			expect(defaultPrevented).toBe(true);
			expect(doc(view)).toBe(before);
			expect(caret(view)).toEqual(['C', 1, true]);
		}
	);

	it('with the caret before an atom: the atom and the rest of the line stay', async () => {
		const view = await render([
			{
				id: 'P',
				type: 'paragraph',
				content: [
					{ text: 'Ping ' },
					{ type: 'mention', data: { name: 'Ada' } },
					{ text: ' about the release' }
				]
			}
		]);
		await caretIn(view, 'P', 2);
		const before = doc(view);
		await modEnter();
		expect(doc(view)).toBe(before);
		expect(caret(view)).toEqual(['P', 2, true]);
	});

	it('in a paragraph: nothing changes, and the key is claimed (no native Enter)', async () => {
		const view = await render([p('Hello'), p('z')]);
		await caretIn(view, 'Hello');
		const before = doc(view);
		const { defaultPrevented } = await modEnter();
		expect(defaultPrevented).toBe(true);
		expect(doc(view)).toBe(before);
	});

	it('over selected to-dos: flips each one (Notion) as one undo step, the selection stays', async () => {
		const todo = (id: string, checked: boolean): JSONBlock => ({
			id,
			type: 'todo-item',
			data: { checked },
			content: [{ text: id }]
		});
		const view = await render([todo('t1', false), todo('t2', true), p('z')]);
		view.edytor.selection.selectBlocks(get(view, 't1'), get(view, 't2'));
		await flushDomUpdates();
		await modEnter();
		expect(get(view, 't1').data).toMatchObject({ checked: true });
		expect(get(view, 't2').data).toMatchObject({ checked: false });
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['t1', 't2']);
		// One undo step restores both.
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(get(view, 't1').data).toMatchObject({ checked: false });
		expect(get(view, 't2').data).toMatchObject({ checked: true });
	});

	it('over a selected toggle: opens and closes it; the document is unchanged', async () => {
		const view = await render([
			{ id: 'G', type: 'toggle', content: [{ text: 'G' }], children: [p('k')] },
			p('z')
		]);
		const node = get(view, 'G').node as HTMLDetailsElement;
		view.edytor.selection.selectBlocks(get(view, 'G'));
		await flushDomUpdates();
		const before = doc(view);
		await modEnter();
		expect(node.open).toBe(true);
		await modEnter();
		expect(node.open).toBe(false);
		expect(doc(view)).toBe(before);
	});
});

describe('Enter over a block selection leaves it for the caret; nothing is removed (DW-04)', () => {
	const enterOver = async (view: View, ...ids: string[]) => {
		view.edytor.selection.selectBlocks(...ids.map((id) => get(view, id)));
		await flushDomUpdates();
		const before = doc(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		await flushDomUpdates();
		expect(doc(view)).toBe(before);
		expect(hookCalls).toEqual([]);
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
	};

	it('two paragraphs: the caret goes to the end of the first', async () => {
		const view = await render([p('a'), p('b'), p('z')]);
		await enterOver(view, 'a', 'b');
		expect(caret(view)).toEqual(['a', 1, true]);
	});

	it('a heading stays a heading with its text', async () => {
		const view = await render([
			{ id: 'H', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Head' }] },
			p('z')
		]);
		await enterOver(view, 'H');
		expect(caret(view)).toEqual(['H', 4, true]);
	});

	it('a checked to-do stays checked, with its text', async () => {
		const view = await render([
			{ id: 'T', type: 'todo-item', data: { checked: true }, content: [{ text: 'Task' }] },
			p('z')
		]);
		await enterOver(view, 'T');
		expect(caret(view)).toEqual(['T', 4, true]);
	});

	it('a closed toggle keeps its children; the caret ends its header', async () => {
		const view = await render([
			{ id: 'G', type: 'toggle', content: [{ text: 'Title' }], children: [p('k')] },
			p('z')
		]);
		await enterOver(view, 'G');
		expect(caret(view)).toEqual(['G', 5, true]);
	});

	it('a code block stays; the caret ends its last line', async () => {
		const view = await render([
			{
				id: 'C',
				type: 'code',
				children: [
					{ id: 'l1', type: 'codeLine', content: [{ text: 'one' }] },
					{ id: 'l2', type: 'codeLine', content: [{ text: 'two' }] }
				]
			},
			p('z')
		]);
		await enterOver(view, 'C');
		expect(caret(view)).toEqual(['l2', 3, true]);
	});

	it('a parent and its next sibling: the child stays', async () => {
		const view = await render([p('P', { children: [p('k')] }), p('b'), p('z')]);
		await enterOver(view, 'P', 'b');
		expect(caret(view)).toEqual(['P', 1, true]);
	});

	it('the select-all ladder (Mod+A, Mod+A, Enter) keeps the text', async () => {
		const view = await render([p('s'), p('z')]);
		await caretIn(view, 's', 0);
		await dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		await dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['s']);
		const before = doc(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		expect(doc(view)).toBe(before);
		expect(hookCalls).toEqual([]);
		expect(caret(view)).toEqual(['s', 1, true]);
	});

	it('the Enter key with no beforeinput (its keydown deadline) does the same', async () => {
		const view = await render([p('a'), p('b'), p('z')]);
		view.edytor.selection.selectBlocks(get(view, 'a'), get(view, 'b'));
		await flushDomUpdates();
		const before = doc(view);
		await dispatchDomKeyDown(document, { key: 'Enter' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await flushDomUpdates();
		expect(doc(view)).toBe(before);
		expect(hookCalls).toEqual([]);
		expect(caret(view)).toEqual(['a', 1, true]);
	});

	it('a selected divider alone: a line after it, nothing removed', async () => {
		const view = await render([p('a'), { id: 'd', type: 'divider' }, p('z')]);
		view.edytor.selection.selectBlocks(get(view, 'd'));
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		expect(hookCalls).toEqual([]);
		const children = view.edytor.value.children ?? [];
		expect(children.map((b) => (b.id?.length === 1 ? b.id : b.type))).toEqual([
			'a',
			'd',
			'paragraph',
			'z'
		]);
		expect(view.edytor.selection.state.startText?.parent.id).toBe(children[2]!.id);
	});
});

describe('Shift+Enter over a block selection edits the text as Enter does (SW13-keys-3)', () => {
	it('a checked to-do and a paragraph stay; the caret ends the to-do', async () => {
		const view = await render([
			{ id: 'T', type: 'todo-item', data: { checked: true }, content: [{ text: 'Task' }] },
			p('b'),
			p('z')
		]);
		view.edytor.selection.selectBlocks(get(view, 'T'), get(view, 'b'));
		await flushDomUpdates();
		const before = doc(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertLineBreak' });
		expect(doc(view)).toBe(before);
		expect(hookCalls).toEqual([]);
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
		expect(caret(view)).toEqual(['T', 4, true]);
	});

	it('the Shift+Enter key with no beforeinput does the same', async () => {
		const view = await render([p('a'), p('z')]);
		view.edytor.selection.selectBlocks(get(view, 'a'));
		await flushDomUpdates();
		const before = doc(view);
		await dispatchDomKeyDown(document, { key: 'Enter', shiftKey: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await flushDomUpdates();
		expect(doc(view)).toBe(before);
		expect(caret(view)).toEqual(['a', 1, true]);
	});
});

describe('Cutting every block leaves the caret in the emptied document (SW13-keys-1)', () => {
	it('select all, cut, type: the text lands in the virtual paragraph', async () => {
		const view = await render([p('s'), p('t')]);
		await caretIn(view, 's', 0);
		for (let i = 0; i < 3; i++) await dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['s', 't']);
		await dispatchCut(view.editor);
		expect(hookCalls).toEqual([['s', 't']]);
		expect(view.edytor.value.children).toEqual([]);
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
		expect((view.edytor.value.children ?? []).map((b) => b.content)).toEqual([[{ text: 'x' }]]);
	});
});

describe('Deleting the blocks beside a divider leaves it selected (SW13-keys-2)', () => {
	it.each(['cut', 'backspace'])(
		'%s: the divider is selected, and typing replaces it',
		async (how) => {
			const view = await render([{ id: 'd', type: 'divider' }, p('s'), p('t')]);
			view.edytor.selection.selectBlocks(get(view, 's'), get(view, 't'));
			await flushDomUpdates();
			if (how === 'cut') await dispatchCut(view.editor);
			else await dispatchDomKeyDown(document, { key: 'Backspace' });
			expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
			await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
			expect(hookCalls).toEqual([['s', 't'], ['d']]);
			expect((view.edytor.value.children ?? []).map((b) => [b.type, b.content])).toEqual([
				['paragraph', [{ text: 'x' }]]
			]);
		}
	);
});

describe('Deleting the only items of a list beside a divider selects the divider (DR-behavior-1)', () => {
	const list: JSONBlock = {
		id: 'L',
		type: 'unordered-list',
		children: [{ id: 'i', type: 'list-item', content: [{ text: 'i' }] }]
	};
	const divider: JSONBlock = { id: 'd', type: 'divider' };
	it.each([
		['cut', 'divider first', [divider, list]],
		['backspace', 'divider first', [divider, list]],
		['cut', 'divider last', [list, divider]],
		['backspace', 'divider last', [list, divider]]
	] as const)(
		'%s, %s: the emptied list goes, the divider is selected, typing replaces it',
		async (how, _, children) => {
			const view = await render([...children]);
			view.edytor.selection.selectBlocks(get(view, 'i'));
			await flushDomUpdates();
			if (how === 'cut') await dispatchCut(view.editor);
			else await dispatchDomKeyDown(document, { key: 'Backspace' });
			expect((view.edytor.value.children ?? []).map((b) => b.id)).toEqual(['d']);
			expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
			await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
			expect(hookCalls).toEqual([['i'], ['d']]);
			expect((view.edytor.value.children ?? []).map((b) => [b.type, b.content])).toEqual([
				['paragraph', [{ text: 'x' }]]
			]);
		}
	);
});

describe('Mod+Enter acts on each shown selected block (DR-behavior-2)', () => {
	const todo = (id: string, checked: boolean, extra: Partial<JSONBlock> = {}): JSONBlock => ({
		id,
		type: 'todo-item',
		data: { checked },
		content: [{ text: id }],
		...extra
	});
	it('a selected toggle and to-do: the to-do checks and the toggle opens', async () => {
		const view = await render([
			{ id: 'G', type: 'toggle', content: [{ text: 'G' }], children: [p('k')] },
			todo('t', false),
			p('z')
		]);
		const node = get(view, 'G').node as HTMLDetailsElement;
		view.edytor.selection.selectBlocks(get(view, 'G'), get(view, 't'));
		await flushDomUpdates();
		const { defaultPrevented } = await modEnter();
		expect(defaultPrevented).toBe(true);
		expect(get(view, 't').data).toMatchObject({ checked: true });
		expect(node.open).toBe(true);
	});

	it('select all over a closed toggle holding a to-do: the toggle opens, the hidden to-do stays', async () => {
		const view = await render([
			{ id: 'G', type: 'toggle', content: [{ text: 'G' }], children: [todo('T', false)] },
			p('z')
		]);
		const node = get(view, 'G').node as HTMLDetailsElement;
		await caretIn(view, 'z', 0);
		for (let i = 0; i < 3; i++) await dispatchDomKeyDown(document, { key: 'a', ctrlKey: true });
		expect(view.edytor.selection.selectedBlocks.size).toBe(3);
		await modEnter();
		expect(get(view, 'T').data).toMatchObject({ checked: false });
		expect(node.open).toBe(true);
	});

	it('a caret in a to-do still checks it and claims the key', async () => {
		const view = await render([todo('t', false), p('z')]);
		await caretIn(view, 't');
		// `block.data` is live: copy it to keep what it was.
		const before = { ...get(view, 't').data };
		const { defaultPrevented } = await modEnter();
		expect(before).toMatchObject({ checked: false });
		expect(defaultPrevented).toBe(true);
		expect(get(view, 't').data).toMatchObject({ checked: true });
	});
});
