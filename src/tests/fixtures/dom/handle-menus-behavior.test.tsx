/** @jsxImportSource ../../jsx */
/**
 * Wave 17 review follow-up (area "behavior"): the handle's `+` adds nothing
 * until a pick applies. Expected states are hand-authored (the user's rule:
 * "it should add nothing until the user decided what to insert").
 *
 * - DR-behavior-1: a picked command that refuses the new block (its
 *   `isEnabled` answers false there, the document refuses it or an extension
 *   vetoes it) takes the block back: document, history and caret as before,
 *   `dispatcher.last` refused.
 * - DR-behavior-2: the `+` menu closes once its block is gone (a peer's or
 *   a command's delete), as the block menu does.
 * - DR-behavior-3: a grip activation (the keyboard's) closes the `+` menu,
 *   the mirror of SW17-menus-1.
 * - DR-behavior-4: leaving a block selection whose edge divider has only
 *   dividers beyond it leaves them out, as selection.mdx says.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** The documented plugin command (writing-plugins.mdx): enabled on a to-do only. */
const todoCommandsPlugin: Plugin = () => ({
	commands: [
		{
			id: 'todo.toggle',
			label: 'Toggle to-do',
			keywords: ['check', 'done'],
			isEnabled: (edytor) => edytor.selection.state.startBlock?.type === 'todo-item',
			run: (edytor) => {
				const block = edytor.selection.state.startBlock;
				block?.setBlock({ value: { data: { ...block.data, checked: !block.data.checked } } });
			}
		}
	]
});
/** An extension that refuses every heading. */
const noHeadings: Plugin = () => ({
	onBeforeOperation: ({ operation, payload, prevent }) => {
		const type = (payload as { value?: { type?: string } } | undefined)?.value?.type;
		if (operation === 'setBlock' && type === 'heading') prevent();
	}
});

const outline = (b: JSONBlock) => {
	const text = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
	return text ? `${b.type} "${text}"` : b.type;
};
const doc = (edytor: Edytor) => (edytor.value.children ?? []).map(outline);
const caret = (edytor: Edytor) => {
	const { startText, yStart } = edytor.selection.state;
	return `${startText?.parent.id}@${yStart}`;
};
const menu = () => document.querySelector('[data-testid="slash-menu"]');
const field = () => document.querySelector<HTMLInputElement>('[data-testid="slash-menu"] input')!;
const plus = async (index = 0) => {
	const button = document.querySelectorAll('[data-testid="block-add"]')[index]!;
	button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
/** Search the `+` menu's field and pick its first row. */
const pick = async (query: string) => {
	field().value = query;
	field().dispatchEvent(new Event('input', { bubbles: true }));
	await flushDomUpdates();
	field().dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
	);
	await flushDomUpdates();
};

const renderTwo = (extra: Plugin[]) =>
	renderDomEdytor(
		<root>
			<paragraph>a|</paragraph>
			<paragraph>b</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin, ...extra] }
	);

describe('DR-behavior-1: a refused + pick adds nothing', () => {
	it('a command disabled on the new block (the documented todo.toggle) is not listed; nothing is added', async () => {
		const { edytor } = await renderTwo([todoCommandsPlugin]);
		const [steps, at] = [edytor.undoManager.undoStack.length, caret(edytor)];
		await plus();
		// Asked of the block the `+` adds (a paragraph), `isEnabled` answers false (wave-18 low 4).
		await pick('Toggle to-do');
		expect(document.querySelector('[data-testid="slash-menu-empty"]')).not.toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
		expect(edytor.undoManager.redoStack.length).toBe(0);
		field().dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(caret(edytor)).toBe(at);
	});

	it('a kind an extension vetoes leaves all as it was', async () => {
		const { edytor } = await renderTwo([noHeadings]);
		const [steps, at] = [edytor.undoManager.undoStack.length, caret(edytor)];
		await plus();
		await pick('Heading 2');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
		expect(edytor.undoManager.redoStack.length).toBe(0);
		expect(caret(edytor)).toBe(at);
		expect(edytor.dispatcher.last?.status).toBe('refused');
	});

	it('beside an empty paragraph (reused, nothing inserted), a vetoed kind keeps it and the caret', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a|</paragraph>
				<paragraph></paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin, noHeadings] }
		);
		const [steps, at] = [edytor.undoManager.undoStack.length, caret(edytor)];
		await plus(1);
		await pick('Heading 2');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph']);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
		expect(caret(edytor)).toBe(at);
	});

	it('a pick that applies still adds the block with its kind, one undo step', async () => {
		const { edytor } = await renderTwo([noHeadings]);
		const steps = edytor.undoManager.undoStack.length;
		await plus();
		await pick('Quote');
		expect(doc(edytor)).toEqual(['paragraph "a"', 'quote', 'paragraph "b"']);
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
		expect(edytor.dispatcher.last?.status).toBe('applied');
	});
});

describe('DR-behavior-2: the + menu closes once its block is gone', () => {
	it('a delete of the block (a peer, a command) closes it, the focus back in the editor', async () => {
		const { edytor, editor } = await renderTwo([]);
		const a = edytor.idToBlock.get(edytor.value.children![0]!.id!)!;
		await plus();
		expect(menu()).not.toBeNull();
		a.removeBlock();
		// The menu's placement (and its close) runs in the overlay's next frame.
		await new Promise((resolve) => requestAnimationFrame(resolve));
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "b"']);
		expect(document.activeElement).toBe(editor);
		// The caret it held was in the deleted block: it follows to the next line.
		expect(caret(edytor)).toBe(`${edytor.value.children![0]!.id}@0`);
	});
});

describe('DR-behavior-3: one menu at a time, the grip after the +', () => {
	it('activating a grip (keyboard) while the + menu is open closes it', async () => {
		const { edytor, editor } = await renderTwo([createBlockMenuPlugin()]);
		const a = edytor.idToBlock.get(edytor.value.children![0]!.id!)!;
		await plus();
		expect(menu()).not.toBeNull();
		edytor.selection.selectBlocks(a);
		editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block: a, anchor: a.node } })
		);
		await flushDomUpdates();
		expect(menu()).toBeNull();
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		expect(doc(edytor)).toEqual(['paragraph "a"', 'paragraph "b"']);
	});
});

describe('DR-behavior-4: an edge divider with only dividers beyond it is left out', () => {
	it('[x, divider, divider] selected, then left: the range spans x', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin],
				value: {
					children: [
						{ id: 'x', type: 'paragraph', content: [{ text: 'x' }] },
						{ id: 'd1', type: 'divider' },
						{ id: 'd2', type: 'divider' }
					]
				}
			}
		);
		const [x, d1, d2] = ['x', 'd1', 'd2'].map((id) => edytor.idToBlock.get(id)!);
		edytor.selection.selectBlocks(x!, d1!, d2!);
		await flushDomUpdates();
		edytor.selection.selectBlocks();
		await flushDomUpdates();
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect(`${startText?.parent.id}@${yStart}…${endText?.parent.id}@${yEnd}`).toBe('x@0…x@1');
	});
});
