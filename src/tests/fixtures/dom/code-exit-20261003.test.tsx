/** @jsxImportSource ../../jsx */
/**
 * Leaving a code block by keyboard (site `customization/hotkeys`, Enter and
 * Backspace by role, `lines` island):
 *
 * - Enter in the code block's last line, when that line is empty and not the
 *   only one, removes it and puts the caret in a new paragraph after the
 *   block, as one undo step; an empty line in the middle (or the only line)
 *   is a newline as before.
 * - ArrowDown in the last line goes below the block, creating a paragraph
 *   when nothing follows it.
 * - An empty code line shows no placeholder.
 *
 * Expected values come from that rule, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { richTextPlugin, richTextPlaceholder } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const line = (id: string, text: string): JSONBlock => ({
	id,
	type: 'codeLine',
	content: [{ text }]
});
const code = (...lines: JSONBlock[]): JSONBlock => ({ id: 'c', type: 'code', children: lines });
const para = (id: string, text: string): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [codePlugin, richTextPlugin],
			value: { children },
			autoSelectFixture: false
		}
	);

/** Root blocks as `type:text`, a code block as its lines. */
const shape = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		block.type === 'code'
			? `code[${(block.children ?? []).map((l) => (l.content?.[0] as { text?: string })?.text ?? '').join('|')}]`
			: `${block.type}:${(block.content ?? []).map((p) => ('text' in p ? p.text : '@')).join('')}`
	);

const caretIn = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};

const caret = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return { block: startBlock?.type, offset: yStart, isCollapsed };
};

const enter = (editor: HTMLElement) =>
	dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });

describe('Enter in a code block', () => {
	it('on an empty last line leaves the block: the line goes, a paragraph after takes the caret', async () => {
		const { edytor, editor } = await render([
			code(line('l1', 'let a'), line('l2', '')),
			para('p', 'after')
		]);
		await caretIn(edytor, 'l2', 0);
		await enter(editor);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[let a]', 'paragraph:', 'paragraph:after']);
		expect(caret(edytor)).toEqual({ block: 'paragraph', offset: 0, isCollapsed: true });
		expect(edytor.selection.state.startBlock?.index).toBe(1);

		// One undo step gives the empty line back.
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[let a|]', 'paragraph:after']);
	});

	it('on an empty line in the middle is a newline', async () => {
		const { edytor, editor } = await render([
			code(line('l1', 'let a'), line('l2', ''), line('l3', 'let b'))
		]);
		await caretIn(edytor, 'l2', 0);
		await enter(editor);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[let a|||let b]']);
	});

	it("on a code block's only line, empty, is a newline", async () => {
		const { edytor, editor } = await render([code(line('l1', ''))]);
		await caretIn(edytor, 'l1', 0);
		await enter(editor);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[|]']);
	});

	it('at the end of a last line with text is a newline', async () => {
		const { edytor, editor } = await render([code(line('l1', 'let a'))]);
		await caretIn(edytor, 'l1', 5);
		await enter(editor);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[let a|]']);
	});
});

describe('ArrowDown in a code block', () => {
	it('on the last line, with nothing after the block, creates a paragraph and goes there', async () => {
		const { edytor, editor } = await render([
			para('p', 'before'),
			code(line('l1', 'a'), line('l2', 'bc'))
		]);
		await caretIn(edytor, 'l2', 1);
		await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:before', 'code[a|bc]', 'paragraph:']);
		expect(caret(edytor)).toEqual({ block: 'paragraph', offset: 0, isCollapsed: true });
	});

	it('on the last line, with a block after, writes nothing (the browser moves there)', async () => {
		const { edytor, editor } = await render([code(line('l1', 'a')), para('p', 'next')]);
		await caretIn(edytor, 'l1', 1);
		await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[a]', 'paragraph:next']);
	});

	it('on another line stays a move inside the block', async () => {
		const { edytor, editor } = await render([code(line('l1', 'a'), line('l2', 'b'))]);
		await caretIn(edytor, 'l1', 1);
		await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['code[a|b]']);
	});
});

it('an empty code line shows no placeholder', () => {
	expect(richTextPlaceholder({ type: 'codeLine', data: {}, focused: true } as never)).toBeNull();
	expect(
		richTextPlaceholder({ type: 'paragraph', data: {}, focused: true } as never)
	).not.toBeNull();
});
