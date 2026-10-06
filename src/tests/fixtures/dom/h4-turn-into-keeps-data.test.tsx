/** @jsxImportSource ../../jsx */
/**
 * H4 (CRDT study 2026-10; contract row `data.retype.keep`): Turn into, a
 * markdown shortcut and Backspace at the start of a kind (`del.start.kind`)
 * retype a block and keep its properties, as Notion does: a checked red
 * to-do turned into a heading keeps `checked` and `color` and gains the
 * heading's `level`. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { convertToKind } from '$lib/kinds.js';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const todo: JSONBlock = {
	id: 't',
	type: 'todo-item',
	data: { checked: true, color: 'red' },
	content: [{ text: 'buy milk' }]
};
const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin], value: { children: [todo] } }
	);
type View = Awaited<ReturnType<typeof render>>;
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const row = (view: View, label: string) => view.edytor.kinds.find((kind) => kind.label === label)!;

describe('H4: a retype keeps the block’s properties', () => {
	it('Turn into Heading 1 keeps checked and color and sets the level', async () => {
		const view = await render();
		expect(convertToKind(view.edytor, get(view, 't'), row(view, 'Heading 1'))).toBe(true);
		await flushDomUpdates();
		const [block] = view.edytor.value.children!;
		expect(block!.type).toBe('heading');
		expect(block!.data).toEqual({ checked: true, color: 'red', level: 'h1' });
		// Back to a to-do: the preset's `checked: false` is set, the rest kept.
		expect(convertToKind(view.edytor, get(view, 't'), row(view, 'To-do list'))).toBe(true);
		await flushDomUpdates();
		expect(view.edytor.value.children![0]!.data).toEqual({
			checked: false,
			color: 'red',
			level: 'h1'
		});
	});

	it('Backspace at the start of a to-do turns it into a paragraph with its properties', async () => {
		const view = await render();
		view.edytor.selection.setAtTextOffset(get(view, 't').firstText!, 0);
		await flushDomUpdates();
		dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		await flushDomUpdates();
		const [block] = view.edytor.value.children!;
		expect(block!.type).toBe('paragraph');
		expect(block!.data).toEqual({ checked: true, color: 'red' });
	});
});
