/** @jsxImportSource ../../jsx */
/**
 * The row naming a block (the toolbar's label, the block menu's current
 * kind) is its kind's closest preset; Duplicate copies a block under fresh
 * ids as one undo step. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { rowOf } from '$lib/kinds.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { notePlugin } from '../../dom/NoteKind.svelte';
import {
	canonicalTree,
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
		{ plugins: [richTextPlugin, mentionPlugin, notePlugin, ...plugins], value: { children } }
	);

const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

const blocks: JSONBlock[] = [
	{ id: 'warn', type: 'note', data: { tone: 'warn' }, content: [{ text: 'careful' }] },
	{ id: 'done', type: 'todo-item', data: { checked: true }, content: [{ text: 'shipped' }] },
	{ id: 'odd', type: 'note', data: { tone: 'other' }, content: [{ text: 'odd' }] }
];

describe('the current kind is the closest preset', () => {
	it('names each block by the preset sharing the most data', async () => {
		const { edytor } = await render([], blocks);
		const label = (id: string) => rowOf(edytor, edytor.idToBlock.get(id)!)?.label;
		expect([label('warn'), label('done'), label('odd')]).toEqual([
			'Warning note',
			'To-do list',
			'Info note'
		]);
	});

	it('the toolbar labels a two-preset kind and a checked to-do', async () => {
		const { edytor } = await render([toolbarPlugin], blocks);
		const labelOf = async (id: string) => {
			const text = edytor.idToBlock.get(id)!.firstText!;
			edytor.selection.setAtRange(text, 0, text, text.length);
			await flushDomUpdates();
			return document.querySelector('.toolbar-type')?.firstChild?.textContent;
		};
		expect(await labelOf('warn')).toBe('Warning note');
		expect(await labelOf('done')).toBe('To-do list');
	});

	it('the block menu marks the current kind of a two-preset kind and a checked to-do', async () => {
		const { edytor, editor } = await render([blockMenuPlugin], blocks);
		const currentOf = async (id: string) => {
			const block = edytor.idToBlock.get(id)!;
			editor.dispatchEvent(
				new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
			);
			await flushDomUpdates();
			await click(document.querySelector('[data-testid="block-menu-turn"]')!);
			return document.querySelector('[role="menu"][aria-label="Turn into"] [data-current="true"]')
				?.textContent;
		};
		expect(await currentOf('warn')).toContain('Warning note');
		expect(await currentOf('done')).toContain('To-do list');
	});
});

describe('duplicate', () => {
	const source: JSONBlock[] = [
		{
			id: 'src',
			type: 'bulleted-list-item',
			content: [
				{ text: 'hi ' },
				{ id: 'atom', type: 'mention', data: { name: 'Ada' } },
				{ text: '' }
			],
			children: [{ id: 'kid', type: 'paragraph', content: [{ text: 'child' }] }]
		}
	];

	it('copies the block after it under fresh ids (block, children, atoms), one undo step', async () => {
		const { edytor } = await render([], source);
		edytor.undoManager.stopCapturing();
		const before = edytor.undoManager.undoStack.length;
		const copy = edytor.idToBlock.get('src')!.duplicateBlock();
		await flushDomUpdates();

		const [original, duplicate] = canonicalTree(edytor, true);
		expect(copy?.id).toBe(duplicate!.id);
		const ids = (block: typeof original) => [
			block!.id,
			...(block!.content ?? []).flatMap((part) => ('id' in part ? [part.id] : [])),
			...(block!.children ?? []).map((child) => child.id)
		];
		expect(ids(original)).toEqual(['src', 'atom', 'kid']);
		const fresh = ids(duplicate);
		expect(fresh).toHaveLength(3);
		expect(fresh.every((id) => id && !['src', 'atom', 'kid'].includes(id))).toBe(true);
		const withoutIds = canonicalTree(edytor);
		expect(withoutIds[1]).toEqual(withoutIds[0]);

		expect(edytor.undoManager.undoStack.length).toBe(before + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(edytor, true).map((b) => b.id)).toEqual(['src']);
	});

	it('Mod+D duplicates the caret block and keeps the caret in the copy', async () => {
		const { edytor } = await render([blockMenuPlugin], source);
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('src')!.firstText!, 0);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'd', ctrlKey: true });
		const ids = canonicalTree(edytor, true).map((b) => b.id);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe('src');
		expect(edytor.selection.state.startBlock?.id).toBe(ids[1]);
	});
});
