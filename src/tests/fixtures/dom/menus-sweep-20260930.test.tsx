/** @jsxImportSource ../../jsx */
/**
 * The menus sweep after re-score 3: the toolbar's Turn into over several
 * blocks, the slash menu's highlight as the query narrows, the block menu
 * over a void block, and a handle drag over a selection holding a parent
 * and its child. Expected states are hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import {
	BLOCK_ACTIVATE_EVENT,
	BlockHandleController
} from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	canonicalTree,
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

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});
const divider = (id: string): JSONBlock => ({ id, type: 'divider' });

const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};

type View = Awaited<ReturnType<typeof render>>;

describe('the toolbar Turn into over several blocks (SW-menus-1)', () => {
	const turn = async ({ edytor }: View, label: string) => {
		await click(document.querySelector('.toolbar-type')!);
		const row = [...document.querySelectorAll('[aria-label="Turn into"] button')].find(
			(button) => button.textContent === label
		)!;
		await click(row);
	};

	it('converts every block the selection touches, keeps the selection, one undo step', async () => {
		const view = await render([toolbarPlugin], [p('a'), p('b', [p('b1')]), p('c'), p('d')]);
		const { edytor } = view;
		const [a, c] = [edytor.idToBlock.get('a')!, edytor.idToBlock.get('c')!];
		edytor.selection.setAtRange(a.firstText!, 0, c.firstText!, 1);
		await flushDomUpdates();

		await turn(view, 'Bulleted list');
		const kinds = () =>
			canonicalTree(edytor).map((block) => [
				block.type,
				(block.children ?? []).map((child) => child.type)
			]);
		expect(kinds()).toEqual([
			['bulleted-list-item', []],
			['bulleted-list-item', ['bulleted-list-item']],
			['bulleted-list-item', []],
			['paragraph', []]
		]);
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual(['a', 0, 'c', 1]);

		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(kinds()).toEqual([
			['paragraph', []],
			['paragraph', ['paragraph']],
			['paragraph', []],
			['paragraph', []]
		]);
	});
});

describe('the slash menu highlight as the query changes (SW-menus-2)', () => {
	it('returns to the first match when the query narrows, as in Notion', async () => {
		const { edytor, editor } = await render([slashMenuPlugin], [p('a')]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		await type(editor, ' /');
		for (let i = 0; i < 3; i++) await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		await type(editor, 'l');
		const selected = () =>
			document.querySelector('[data-testid="slash-menu-item"][data-selected="true"]')?.textContent;
		expect(selected()).toBe('Bulleted list');

		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'bulleted-list-item', content: [{ text: 'a ' }] }
		]);
	});

	it('keeps the highlight while the caret moves without changing the query', async () => {
		const { edytor, editor } = await render([slashMenuPlugin], [p('a')]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		edytor.selection.setAtTextOffset(text, 1);
		await flushDomUpdates();
		await type(editor, ' /head');
		await dispatchDomKeyDown(document, { key: 'ArrowDown' });
		// The same caret written again (a selection change that keeps the query).
		edytor.selection.setAtTextOffset(text, text.length);
		await flushDomUpdates();
		expect(
			document.querySelector('[data-testid="slash-menu-item"][data-selected="true"]')?.textContent
		).toBe('Heading 2');
	});
});

describe('the block menu over a void block (SW-menus-3)', () => {
	const open = async ({ edytor, editor }: View, id: string) => {
		const block = edytor.idToBlock.get(id)!;
		editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
	};
	const selected = ({ edytor }: View) => [...edytor.selection.selectedBlocks].map((b) => b.id);

	it('Duplicate selects the copy (a void block holds no caret)', async () => {
		const view = await render([blockMenuPlugin], [p('a'), divider('rule'), p('c')]);
		await open(view, 'rule');
		await click(document.querySelector('[data-testid="block-menu-duplicate"]')!);
		const ids = canonicalTree(view.edytor, true).map((b) => b.id!);
		expect(ids).toHaveLength(4);
		expect(ids.slice(0, 2)).toEqual(['a', 'rule']);
		expect(selected(view)).toEqual([ids[2]]);
		// The next key acts on the copy, not on the text before it.
		await type(view.editor, 'x');
		expect(canonicalTree(view.edytor).map((b) => b.content?.[0])).not.toContainEqual({
			text: 'xa'
		});
	});

	it('Move up keeps the moved block selected', async () => {
		const view = await render([blockMenuPlugin], [p('a'), divider('rule'), p('c')]);
		await open(view, 'rule');
		await click(document.querySelector('[data-testid="block-menu-up"]')!);
		expect(canonicalTree(view.edytor, true).map((b) => b.id)).toEqual(['rule', 'a', 'c']);
		expect(selected(view)).toEqual(['rule']);
	});

	it('Escape keeps the block selected', async () => {
		const view = await render([blockMenuPlugin], [p('a'), divider('rule'), p('c')]);
		await open(view, 'rule');
		await dispatchDomKeyDown(
			document.querySelector<HTMLInputElement>('[aria-label="Search actions"]')!,
			{ key: 'Escape' }
		);
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		expect(selected(view)).toEqual(['rule']);
	});
});

describe('a handle drag over a selection holding a parent and its child (SW-menus-4)', () => {
	it('drags the selected blocks without their selected descendants', async () => {
		const { edytor } = await render([], [p('a'), p('b', [p('b1')]), p('c'), p('d')]);
		const [b, b1, c] = ['b', 'b1', 'c'].map((id) => edytor.idToBlock.get(id)!);
		edytor.selection.selectBlocks(b!, b1!, c!);
		await flushDomUpdates();
		const controller = new BlockHandleController(edytor, { draggable: true });
		expect(controller.dragBlocks(c!).map((block) => block.id)).toEqual(['b', 'c']);
		expect(controller.dragBlocks(b1!).map((block) => block.id)).toEqual(['b', 'c']);
	});
});

describe('a menu open when the editor turns readonly (SW-menus-5)', () => {
	it('the slash menu hides, and Enter no longer runs its command', async () => {
		const { edytor, editor } = await render([slashMenuPlugin], [p('a')]);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('a')!.firstText!, 1);
		await flushDomUpdates();
		await type(editor, ' /h2');
		expect(document.querySelector('[data-testid="slash-menu"]')).not.toBeNull();
		edytor.readonly = true;
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="slash-menu"]')).toBeNull();
		await dispatchDomKeyDown(document, { key: 'Enter' });
		expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: 'a /h2' }] }]);
	});

	it('the toolbar hides, and shows again over the same selection when editable', async () => {
		const { edytor } = await render([toolbarPlugin], [p('abc')]);
		const text = edytor.idToBlock.get('abc')!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 2);
		await flushDomUpdates();
		const bar = () => document.querySelector('[data-testid="selection-toolbar"]');
		expect(bar()).not.toBeNull();
		edytor.readonly = true;
		await flushDomUpdates();
		expect(bar()).toBeNull();
		edytor.readonly = false;
		await flushDomUpdates();
		expect(bar()).not.toBeNull();
	});

	it('the block menu closes', async () => {
		const view = await render([blockMenuPlugin], [p('a'), p('b')]);
		const block = view.edytor.idToBlock.get('a')!;
		view.editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		view.edytor.readonly = true;
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		view.edytor.readonly = false;
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
	});
});

describe('the block menu over a block selection (SW-menus-6)', () => {
	const setup = async () => {
		const view = await render(
			[blockHandlesPlugin, blockMenuPlugin],
			[p('a'), p('b'), p('c'), p('d')]
		);
		const { edytor } = view;
		edytor.selection.selectBlocks(edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!);
		await flushDomUpdates();
		await click(document.querySelector('[data-testid="block-handle"][data-block-id="b"]')!);
		return view;
	};
	const ids = ({ edytor }: View) => canonicalTree(edytor, true).map((b) => b.id);
	const selected = ({ edytor }: View) => [...edytor.selection.selectedBlocks].map((b) => b.id);
	const texts = ({ edytor }: View) =>
		canonicalTree(edytor).map((b) => (b.content?.[0] as { text: string }).text);

	it('a grip click inside the selection keeps it and opens the menu for all of it', async () => {
		const view = await setup();
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		expect(selected(view)).toEqual(['a', 'b']);
	});

	it('a grip click outside the selection selects that block alone', async () => {
		const view = await setup();
		await click(document.querySelector('[data-testid="block-handle"][data-block-id="d"]')!);
		expect(selected(view)).toEqual(['d']);
	});

	it('Delete removes every selected block, one undo step; the caret goes to the next text', async () => {
		const view = await setup();
		await click(document.querySelector('[data-testid="block-menu-delete"]')!);
		expect(ids(view)).toEqual(['c', 'd']);
		const { startBlock, yStart } = view.edytor.selection.state;
		expect([startBlock?.id, yStart]).toEqual(['c', 0]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(ids(view)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('Duplicate copies every selected block, each after itself (as Mod+D), and selects the copies', async () => {
		const view = await setup();
		await click(document.querySelector('[data-testid="block-menu-duplicate"]')!);
		expect(texts(view)).toEqual(['a', 'a', 'b', 'b', 'c', 'd']);
		expect(selected(view)).toHaveLength(2);
		expect(selected(view).some((id) => id === 'a' || id === 'b')).toBe(false);
	});

	it('Move down moves the group and keeps it selected', async () => {
		const view = await setup();
		await click(document.querySelector('[data-testid="block-menu-down"]')!);
		expect(ids(view)).toEqual(['c', 'a', 'b', 'd']);
		expect(selected(view)).toEqual(['a', 'b']);
	});

	it('Turn into converts every selected block, one undo step, and keeps them selected', async () => {
		const view = await setup();
		await click(document.querySelector('[data-testid="block-menu-turn"]')!);
		const heading = [
			...document.querySelectorAll('[role="menu"][aria-label="Turn into"] button')
		].find((b) => b.textContent === 'Heading 2')!;
		await click(heading);
		const types = () => canonicalTree(view.edytor).map((b) => b.type);
		expect(types()).toEqual(['heading', 'heading', 'paragraph', 'paragraph']);
		expect(selected(view)).toEqual(['a', 'b']);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(types()).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
	});
});

describe('the toolbar mark buttons show the marks the selection holds (SW-menus-7)', () => {
	it('a mark covering the whole selection is pressed; toggling it clears the state', async () => {
		const { edytor } = await render(
			[toolbarPlugin],
			[
				{
					id: 'x',
					type: 'paragraph',
					content: [{ text: 'bold', marks: { bold: true } }, { text: ' plain' }]
				}
			]
		);
		const text = edytor.idToBlock.get('x')!.firstText!;
		const pressed = (mark: string) =>
			document.querySelector(`[data-testid="toolbar-${mark}"]`)?.getAttribute('aria-pressed');
		edytor.selection.setAtRange(text, 0, text, 4);
		await flushDomUpdates();
		expect([pressed('bold'), pressed('italic')]).toEqual(['true', 'false']);
		// Partly bold: not pressed (the button bolds the whole range).
		edytor.selection.setAtRange(text, 0, text, 7);
		await flushDomUpdates();
		expect(pressed('bold')).toBe('false');
		edytor.selection.setAtRange(text, 0, text, 4);
		await flushDomUpdates();
		await click(document.querySelector('[data-testid="toolbar-bold"]')!);
		expect(pressed('bold')).toBe('false');
	});
});

describe('a kind command over several blocks (SW-menus-8)', () => {
	const types = ({ edytor }: View) =>
		canonicalTree(edytor).map((b) => [b.type, (b.data as { level?: string } | undefined)?.level]);

	it('Mod+Alt+1 over a block selection turns every selected block into a heading, one undo step', async () => {
		const view = await render([], [p('a'), p('b'), p('c')]);
		const { edytor } = view;
		edytor.selection.selectBlocks(edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
		expect(types(view)).toEqual([
			['heading', 'h1'],
			['heading', 'h1'],
			['paragraph', undefined]
		]);
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['a', 'b']);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(types(view).map(([type]) => type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
	});

	it('Mod+Alt+5 over a text range across blocks converts each, keeping the range', async () => {
		const view = await render([], [p('a'), p('b'), p('c')]);
		const { edytor } = view;
		const [a, b] = [edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!];
		edytor.selection.setAtRange(a.firstText!, 0, b.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: '5', code: 'Digit5', ctrlKey: true, altKey: true });
		expect(types(view).map(([type]) => type)).toEqual([
			'bulleted-list-item',
			'bulleted-list-item',
			'paragraph'
		]);
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual(['a', 0, 'b', 1]);
	});
});
