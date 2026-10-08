/** @jsxImportSource ../../jsx */
/**
 * The `+` menu's wave-17 lows: a refused pick leaves the undo AND redo
 * steps as they were; Escape after a grip menu gives back what was held
 * before the grip; the filter field is the menu's one keyboard owner; and
 * a command that cannot run in the block being added is not listed.
 * Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { noSelection } from '$lib/session/selection.js';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const render = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin, ...plugins], value: { children } }
	);

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((b) =>
		[b.type, (b.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')].join(' ')
	);
const handleOf = (id: string, testid: 'block-add' | 'block-handle') =>
	document.querySelector<HTMLElement>(
		`[data-edytor-block-handle-host][data-block-id="${id}"] [data-testid="${testid}"]`
	)!;
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const menu = () => document.querySelector('[data-testid="slash-menu"]');
const field = () => document.querySelector<HTMLInputElement>('[data-testid="slash-menu"] input')!;
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="slash-menu-item"]')];
const key = async (key: string, target: Element = field()) => {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const caretAt = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};

describe('a refused + pick leaves the history as it was (low 1)', () => {
	it('keeps the redo step the user had', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'setBlock') prevent();
			}
		});
		const { edytor, editor } = await render([p('a'), p('b')], [veto]);
		await caretAt(edytor, 'a', 1);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		edytor.history.undo();
		await flushDomUpdates();
		const [undo, redo] = [edytor.undoManager.undoStack.length, edytor.undoManager.redoStack.length];
		expect(redo).toBe(1);

		await click(handleOf('a', 'block-add'));
		await click(rows().find((row) => row.textContent === 'Heading 1')!);

		expect(texts(edytor)).toEqual(['paragraph a', 'paragraph b']);
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(edytor.undoManager.undoStack.length).toBe(undo);
		expect(edytor.undoManager.redoStack.length).toBe(redo);
		edytor.history.redo();
		expect(texts(edytor)).toEqual(['paragraph ax', 'paragraph b']);
	});
});

describe('Escape in a + menu opened over a grip menu (low 2)', () => {
	it('gives back the caret held before the grip, not the grip block selection', async () => {
		const { edytor } = await render([p('a'), p('b')], [blockMenuPlugin]);
		await caretAt(edytor, 'a', 1);
		await click(handleOf('b', 'block-handle'));
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['b']);

		await click(handleOf('b', 'block-add'));
		expect(menu()).not.toBeNull();
		await key('Escape');

		expect(menu()).toBeNull();
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		expect([startText?.parent.id, yStart, isCollapsed]).toEqual(['a', 1, true]);
	});
});

describe('Escape in a + menu while the grip block selection still stands', () => {
	it("gives back the pre-grip caret, even after the grip menu's Escape left a divider selected", async () => {
		const { edytor } = await render(
			[p('a'), { id: 'd', type: 'divider' }, p('c')],
			[blockMenuPlugin]
		);
		await caretAt(edytor, 'a', 1);
		await click(handleOf('d', 'block-handle'));
		await key('Escape', document.querySelector('[aria-label="Search actions"]')!);
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);

		await click(handleOf('d', 'block-add'));
		await key('Escape');
		// Never a block selection the next key would replace.
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		const { startText, yStart } = edytor.selection.state;
		expect([startText?.parent.id, yStart]).toEqual(['a', 1]);
	});
});

describe('a + after a grip click on a divider, with no selection before (DR-handles)', () => {
	it('leaves no block selection behind', async () => {
		const { edytor } = await render(
			[p('a'), { id: 'd', type: 'divider' }, p('c')],
			[blockMenuPlugin]
		);
		edytor.selection.select(noSelection);
		await flushDomUpdates();
		await click(handleOf('d', 'block-handle'));
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);

		await click(handleOf('d', 'block-add'));
		await key('Escape');
		expect(menu()).toBeNull();
		expect(edytor.selection.selectedBlocks.size).toBe(0);
		// The editor, focused again, takes a caret: never the divider's block selection.
		expect(edytor.selection.value.kind).not.toBe('blocks');
	});
});

describe('the filter field owns the + menu keyboard (low 3)', () => {
	it('with a row focused, arrows move the highlight, Enter runs it, Escape closes', async () => {
		const { edytor } = await render([p('a'), p('b')]);
		await caretAt(edytor, 'a', 1);
		await click(handleOf('a', 'block-add'));
		const [first] = rows();
		first!.focus();
		await flushDomUpdates();
		// Focus goes back to the field, which keeps the highlight.
		expect(document.activeElement).toBe(field());

		await key('ArrowDown', first);
		expect(rows()[1]!.dataset.selected).toBe('true');
		await key('Escape', first);
		expect(menu()).toBeNull();

		await click(handleOf('a', 'block-add'));
		expect(
			rows()
				.map((row) => row.textContent)
				.slice(0, 2)
		).toEqual(['Text', 'Heading 1']);
		await key('ArrowDown');
		// Enter on another (focused) row runs the highlighted one.
		await key('Enter', rows()[0]!);
		expect(menu()).toBeNull();
		expect(texts(edytor)).toEqual(['paragraph a', 'heading ', 'paragraph b']);
	});
});

describe('a + menu lists what can run in the block being added (low 4)', () => {
	const inCallout: Plugin = () => ({
		commands: [
			{
				id: 'callout.only',
				label: 'Callout only',
				isEnabled: (edytor) => edytor.selection.state.startBlock?.parent?.type === 'callout',
				run: () => true
			},
			{
				id: 'todo.only',
				label: 'To-do only',
				isEnabled: (edytor) => edytor.selection.state.startBlock?.type === 'todo-item',
				run: () => true
			}
		]
	});

	it('a command whose isEnabled throws on the stand-in is not listed; the menu works', async () => {
		const throwing: Plugin = () => ({
			commands: [
				{
					id: 'reads.node',
					label: 'Reads node',
					isEnabled: (edytor) => edytor.selection.state.startBlock!.node!.isConnected,
					run: () => true
				}
			]
		});
		const { edytor } = await render([p('a')], [throwing]);
		await caretAt(edytor, 'a', 1);
		await click(handleOf('a', 'block-add'));
		expect(rows().map((row) => row.textContent)).not.toContain('Reads node');
		expect(rows().map((row) => row.textContent)).toContain('Heading 1');
	});

	it('hides a command its context does not allow, and lists the kinds', async () => {
		const { edytor } = await render(
			[
				p('a'),
				{
					id: 'c',
					type: 'callout',
					data: { icon: '!' },
					content: [{ text: 'c' }],
					children: [p('c1')]
				},
				{ id: 't', type: 'todo-item', content: [{ text: 't' }] }
			],
			[inCallout]
		);
		const labels = () => rows().map((row) => row.textContent);

		await caretAt(edytor, 'a', 1);
		await click(handleOf('a', 'block-add'));
		expect(labels()).toContain('Heading 1');
		expect(labels()).not.toContain('Callout only');
		expect(labels()).not.toContain('To-do only');
		await key('Escape');

		// Beside a callout's child the new block is the callout's too.
		await click(handleOf('c1', 'block-add'));
		expect(labels()).toContain('Callout only');
		await key('Escape');

		// Beside a to-do, the new block is a paragraph: no to-do command.
		await click(handleOf('t', 'block-add'));
		expect(labels()).not.toContain('To-do only');
	});
});
