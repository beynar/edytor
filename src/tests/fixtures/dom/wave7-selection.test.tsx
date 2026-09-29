/** @jsxImportSource ../../jsx */
/**
 * Wave 7, selection and menus: the block-menu caret after Delete beside a
 * closed toggle (XW-06), Turn into over a range across a closed toggle
 * (XW-13), and a readonly view's `clear()`. Expected states are
 * hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins: Plugin[], children: JSONBlock[], readonly?: boolean) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, ...plugins], value: { children }, readonly }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});
/** A toggle `id` with a text of its id; closed unless opened (its default). */
const toggle = (id: string, children: JSONBlock[]): JSONBlock => ({
	id,
	type: 'toggle',
	content: [{ text: id }],
	children
});
const open = async ({ edytor }: View, id: string) => {
	(edytor.idToBlock.get(id)!.node as HTMLDetailsElement).open = true;
	await flushDomUpdates();
};

const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const caret = ({ edytor }: View) => {
	const { startBlock, yStart } = edytor.selection.state;
	return [startBlock?.id, yStart];
};
/** Blocks as `[type, text, children]`. */
type Shape = [string, string, Shape[]];
const shape = (block: CanonicalBlock): Shape => [
	block.type,
	(block.content?.[0] as { text?: string } | undefined)?.text ?? '',
	(block.children ?? []).map(shape)
];

describe('the block menu Delete beside a closed toggle (XW-06)', () => {
	const remove = async (view: View, id: string) => {
		const block = view.edytor.idToBlock.get(id)!;
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
		await click(document.querySelector('[data-testid="block-menu-delete"]')!);
	};

	it('of the last block after it, lands at the end of the header, not in the hidden body', async () => {
		const view = await render([blockMenuPlugin], [toggle('t', [p('body')]), p('last')]);
		await remove(view, 'last');
		expect(canonicalTree(view.edytor).map(shape)).toEqual([
			['toggle', 't', [['paragraph', 'body', []]]]
		]);
		expect(caret(view)).toEqual(['t', 1]);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
		expect(canonicalTree(view.edytor).map(shape)).toEqual([
			['toggle', 'tx', [['paragraph', 'body', []]]]
		]);
	});

	it('of the block after it with a block after that, lands at the start of that block', async () => {
		const view = await render([blockMenuPlugin], [toggle('t', [p('body')]), p('mid'), p('z')]);
		await remove(view, 'mid');
		expect(caret(view)).toEqual(['z', 0]);
	});

	it('of the toggle itself, its body takes its place and holds the caret (FW-05)', async () => {
		const view = await render([blockMenuPlugin], [p('a'), toggle('t', [p('body')]), p('z')]);
		await remove(view, 't');
		expect(canonicalTree(view.edytor).map(shape)).toEqual([
			['paragraph', 'a', []],
			['paragraph', 'body', []],
			['paragraph', 'z', []]
		]);
		expect(caret(view)).toEqual(['body', 0]);
	});

	it('of the last block after a closed toggle nested in a closed toggle, lands at the outer header', async () => {
		const view = await render(
			[blockMenuPlugin],
			[toggle('o', [toggle('i', [p('deep')])]), p('last')]
		);
		await remove(view, 'last');
		expect(caret(view)).toEqual(['o', 1]);
	});
});

describe('Turn into over a text range across a toggle (XW-13)', () => {
	const doc = () => [p('a'), toggle('t', [p('body')]), p('z')];
	const range = async ({ edytor }: View) => {
		const [a, z] = [edytor.idToBlock.get('a')!, edytor.idToBlock.get('z')!];
		edytor.selection.setAtRange(a.firstText!, 0, z.firstText!, 1);
		await flushDomUpdates();
	};
	const heading = () =>
		dispatchDomKeyDown(document, { key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
	const types = ({ edytor }: View) =>
		canonicalTree(edytor).map((block) => [
			block.type,
			(block.children ?? []).map((child) => child.type)
		]);

	it('Mod+Alt+1 leaves a closed toggle’s hidden body unchanged', async () => {
		const view = await render([], doc());
		await range(view);
		await heading();
		expect(types(view)).toEqual([
			['heading', []],
			['heading', ['paragraph']],
			['heading', []]
		]);
	});

	it('Mod+Alt+1 converts an open toggle’s visible children', async () => {
		const view = await render([], doc());
		await open(view, 't');
		await range(view);
		await heading();
		expect(types(view)).toEqual([
			['heading', []],
			['heading', ['heading']],
			['heading', []]
		]);
	});

	it('the toolbar Turn into leaves a closed toggle’s hidden body unchanged', async () => {
		const view = await render([toolbarPlugin], doc());
		await range(view);
		await click(document.querySelector('.toolbar-type')!);
		const row = [...document.querySelectorAll('[aria-label="Turn into"] button')].find(
			(button) => button.textContent === 'Bulleted list'
		)!;
		await click(row);
		expect(types(view)).toEqual([
			['bulleted-list-item', []],
			['bulleted-list-item', ['paragraph']],
			['bulleted-list-item', []]
		]);
	});
});

describe('clear() on a readonly view', () => {
	it('is refused: the shared document keeps its blocks', async () => {
		const view = await render([], [p('a'), p('b')], true);
		const before = canonicalTree(view.edytor);
		expect(view.edytor.clear()).toBe(false);
		await flushDomUpdates();
		expect(canonicalTree(view.edytor)).toEqual(before);
		expect(view.edytor.dispatcher.last).toEqual({ operation: 'clear', status: 'refused' });
	});

	it('an editable view clears to one empty block, as one undo step', async () => {
		const view = await render([], [p('a'), p('b')]);
		expect(view.edytor.clear()).toBe(true);
		await flushDomUpdates();
		expect(canonicalTree(view.edytor).map(shape)).toEqual([['paragraph', '', []]]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(canonicalTree(view.edytor).map(shape)).toEqual([
			['paragraph', 'a', []],
			['paragraph', 'b', []]
		]);
	});
});

describe('the sweep: walkers beside a closed toggle', () => {
	it('a native range ending at the start of the block after it ends at the header, not the hidden body (SW7-selection-1)', async () => {
		const view = await render([], [toggle('t', [p('body')]), p('after')]);
		const { edytor } = view;
		const [t, after] = [edytor.idToBlock.get('t')!, edytor.idToBlock.get('after')!];
		await setNativeSelection(edytor, t.firstText, 0, after.firstText, 0);
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual(['t', 0, 't', 1]);
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['toggle', '', [['paragraph', 'body', []]]],
			['paragraph', 'after', []]
		]);
	});

	it('Backspace over a selected closed toggle keeps its body in its place and puts the caret there', async () => {
		const view = await render([], [toggle('t', [p('body')]), p('z')]);
		const { edytor } = view;
		edytor.selection.selectBlocks(edytor.idToBlock.get('t')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['paragraph', 'body', []],
			['paragraph', 'z', []]
		]);
		expect(caret(view)).toEqual(['body', 4]);
	});

	it('Tab over a range across a closed toggle nests the toggle with its body', async () => {
		const view = await render([], [p('a'), toggle('t', [p('body')]), p('z')]);
		const { edytor } = view;
		const [t, z] = [edytor.idToBlock.get('t')!, edytor.idToBlock.get('z')!];
		edytor.selection.setAtRange(t.firstText!, 0, z.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			[
				'paragraph',
				'a',
				[
					['toggle', 't', [['paragraph', 'body', []]]],
					['paragraph', 'z', []]
				]
			]
		]);
	});
});

describe('the sweep: a handle move into a closed toggle (SW7-selection-2)', () => {
	it('Alt+→ on a handle nests the block into the closed toggle before it and opens it, as Tab does', async () => {
		const view = await render([blockHandlesPlugin], [toggle('t', [p('body')]), p('x')]);
		const { edytor } = view;
		const handle = document.querySelector('[data-testid="block-handle"][data-block-id="x"]')!;
		await dispatchDomKeyDown(handle as HTMLElement, {
			key: 'ArrowRight',
			code: 'ArrowRight',
			altKey: true
		});
		expect(canonicalTree(edytor).map(shape)).toEqual([
			[
				'toggle',
				't',
				[
					['paragraph', 'body', []],
					['paragraph', 'x', []]
				]
			]
		]);
		const x = edytor.idToBlock.get('x')!;
		expect(edytor.selection.hidden(x)).toBe(false);
		expect([...edytor.selection.selectedBlocks].map((block) => block.id)).toEqual(['x']);
	});
});

describe('the sweep: Turn into over a block selection holding a hidden body (SW7-selection-3)', () => {
	it('Mod+Alt+1 after selecting every block converts the shown ones only', async () => {
		const view = await render([], [p('a'), toggle('t', [p('body')]), p('z')]);
		const { edytor } = view;
		edytor.selection.selectBlocks(...edytor.facade.order().map((id) => edytor.idToBlock.get(id)!));
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['heading', 'a', []],
			['heading', 't', [['paragraph', 'body', []]]],
			['heading', 'z', []]
		]);
	});
});

describe('the sweep: history on a readonly view (SW7-selection-4)', () => {
	it('historyUndo() and historyRedo() are refused while the view is readonly', async () => {
		const view = await render([], [p('a')]);
		const { edytor, editor } = view;
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(canonicalTree(edytor).map(shape)).toEqual([['paragraph', 'ax', []]]);
		edytor.readonly = true;
		await flushDomUpdates();
		edytor.historyUndo();
		expect(canonicalTree(edytor).map(shape)).toEqual([['paragraph', 'ax', []]]);
		expect(edytor.dispatcher.last).toEqual({ operation: 'undo', status: 'refused' });
		edytor.readonly = false;
		edytor.historyUndo();
		expect(canonicalTree(edytor).map(shape)).toEqual([['paragraph', 'a', []]]);
		edytor.readonly = true;
		edytor.historyRedo();
		expect(canonicalTree(edytor).map(shape)).toEqual([['paragraph', 'a', []]]);
		expect(edytor.dispatcher.last).toEqual({ operation: 'redo', status: 'refused' });
	});
});
