/** @jsxImportSource ../../jsx */
/**
 * Leaving the document's last caret stop (`nav.trailing.exit`,
 * `nav.trailing.press` in docs/editor-delete-contract.md, Notion):
 *
 * - ArrowDown on the last line of the last stop, when that stop is not a
 *   top-level paragraph (a toggle's body or header, a callout, a quote's
 *   child, a nested list item, a column, a table cell, a code block's last
 *   line, a heading), puts the caret in a top-level empty paragraph after
 *   the document's last top-level block, created by one command (its own
 *   undo step, whose undo gives the caret back). A stop below the caret
 *   (after it, not beside it in another column or cell of its row) leaves
 *   the key to the browser; Shift+ArrowDown extends; a readonly view
 *   inserts nothing; a closed toggle's body holds no stop.
 * - A press in the host below its last block puts the caret in that
 *   trailing paragraph, created when the last block is not one.
 *
 * Expected states are written from the rows, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const block = (type: string, id: string, text: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type,
	content: [{ text }],
	...(children && { children })
});
const p = (id: string, text = id.toLowerCase(), children?: JSONBlock[]) =>
	block('paragraph', id, text, children);
const toggle = (id: string, text: string, children: JSONBlock[] = []) =>
	block('toggle', id, text, children);
const line = (id: string, text: string): JSONBlock => block('codeLine', id, text);
const cell = (id: string, column: string): JSONBlock => ({
	...block('tableCell', id, id.toLowerCase()),
	data: { column }
});
const row = (id: string, ...cells: JSONBlock[]): JSONBlock => ({
	id,
	type: 'tableRow',
	children: cells
});

const render = (children: JSONBlock[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [codePlugin, columnsPlugin, tablePlugin, richTextPlugin],
			value: { children },
			autoSelectFixture: false,
			readonly
		}
	);

/** The top-level blocks as `type:text`, a block with children as `type:text[…]`. */
const shape = (edytor: Edytor): string[] => {
	const walk = (blocks: JSONBlock[] = []): string[] =>
		blocks.map((b) => {
			const text = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
			return b.children?.length
				? `${b.type}:${text}[${walk(b.children).join(',')}]`
				: `${b.type}:${text}`;
		});
	return walk(edytor.value.children);
};

const open = async (edytor: Edytor, id: string) => {
	(edytor.idToBlock.get(id)!.node as HTMLDetailsElement).open = true;
	await flushDomUpdates();
};

const caretIn = async (edytor: Edytor, id: string, offset?: number) => {
	const text = edytor.idToBlock.get(id)!.lastText!;
	edytor.selection.setAtTextOffset(text, offset ?? text.length);
	await flushDomUpdates();
};

/** The model caret: its block's type and whether it is top-level, its offset. */
const caret = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return {
		type: startBlock?.type,
		topLevel: !startBlock?.isNested,
		index: startBlock?.index,
		offset: yStart,
		isCollapsed
	};
};
const caretId = (edytor: Edytor) => edytor.selection.state.startBlock?.id;

const arrowDown = (editor: HTMLElement, shiftKey = false) =>
	dispatchDomKeyDown(editor, { key: 'ArrowDown', shiftKey });

/** The caret went to a new trailing paragraph, the last of `count` top-level blocks. */
const atTrailing = (edytor: Edytor, count: number) => {
	expect(edytor.root!.children.length).toBe(count);
	expect(caret(edytor)).toEqual({
		type: 'paragraph',
		topLevel: true,
		index: count - 1,
		offset: 0,
		isCollapsed: true
	});
};

describe('ArrowDown at the last stop leaves a nested block (nav.trailing.exit)', () => {
	it("an open toggle's last child: a paragraph after the toggle; one undo step gives the caret back", async () => {
		const { edytor, editor } = await render([p('P'), toggle('T', 'title', [p('C', 'child')])]);
		await open(edytor, 'T');
		await caretIn(edytor, 'C');
		const steps = edytor.undoManager!.undoStack.length;
		const { defaultPrevented } = await arrowDown(editor);
		expect(defaultPrevented).toBe(true);
		expect(shape(edytor)).toEqual(['paragraph:p', 'toggle:title[paragraph:child]', 'paragraph:']);
		atTrailing(edytor, 3);
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);

		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:p', 'toggle:title[paragraph:child]']);
		expect(caretId(edytor)).toBe('C');
		expect(edytor.selection.state.yStart).toBe(5);
	});

	it("a closed toggle's header: its hidden body holds no stop", async () => {
		const { edytor, editor } = await render([toggle('T', 'title', [p('C', 'hidden')])]);
		await caretIn(edytor, 'T', 2);
		expect((await arrowDown(editor)).defaultPrevented).toBe(true);
		expect(shape(edytor)).toEqual(['toggle:title[paragraph:hidden]', 'paragraph:']);
		atTrailing(edytor, 2);
	});

	it("an open toggle's header with a child below: the browser's move, nothing written", async () => {
		const { edytor, editor } = await render([toggle('T', 'title', [p('C', 'child')])]);
		await open(edytor, 'T');
		await caretIn(edytor, 'T');
		expect((await arrowDown(editor)).defaultPrevented).toBe(false);
		expect(shape(edytor)).toEqual(['toggle:title[paragraph:child]']);
	});

	it("a callout's own text, and its child", async () => {
		const first = await render([block('callout', 'K', 'note')]);
		await caretIn(first.edytor, 'K');
		await arrowDown(first.editor);
		expect(shape(first.edytor)).toEqual(['callout:note', 'paragraph:']);
		atTrailing(first.edytor, 2);
		document.body.innerHTML = '';

		const second = await render([block('callout', 'K', 'note', [p('C', 'inside')])]);
		await caretIn(second.edytor, 'C', 0);
		await arrowDown(second.editor);
		expect(shape(second.edytor)).toEqual(['callout:note[paragraph:inside]', 'paragraph:']);
		atTrailing(second.edytor, 2);
	});

	it("a quote's child", async () => {
		const { edytor, editor } = await render([block('quote', 'Q', 'said', [p('C', 'more')])]);
		await caretIn(edytor, 'C');
		await arrowDown(editor);
		expect(shape(edytor)).toEqual(['quote:said[paragraph:more]', 'paragraph:']);
		atTrailing(edytor, 2);
	});

	it('a nested list item', async () => {
		const { edytor, editor } = await render([
			block('bulleted-list-item', 'L', 'one', [block('bulleted-list-item', 'L2', 'two')])
		]);
		await caretIn(edytor, 'L2', 1);
		await arrowDown(editor);
		expect(shape(edytor)).toEqual(['bulleted-list-item:one[bulleted-list-item:two]', 'paragraph:']);
		atTrailing(edytor, 2);
	});

	it('a top-level heading', async () => {
		const { edytor, editor } = await render([p('P'), block('heading', 'H', 'Title')]);
		await caretIn(edytor, 'H');
		await arrowDown(editor);
		expect(shape(edytor)).toEqual(['paragraph:p', 'heading:Title', 'paragraph:']);
		atTrailing(edytor, 3);
	});

	it("a column's last block: the next column is beside it, not below", async () => {
		const layout = () => ({
			id: 'C',
			type: 'columns',
			children: [
				{ id: 'K1', type: 'column', children: [p('A'), p('A2')] },
				{ id: 'K2', type: 'column', children: [p('B')] }
			]
		});
		const first = await render([p('P'), layout()]);
		await caretIn(first.edytor, 'A2');
		expect((await arrowDown(first.editor)).defaultPrevented).toBe(true);
		atTrailing(first.edytor, 3);
		document.body.innerHTML = '';

		const second = await render([p('P'), layout()]);
		await caretIn(second.edytor, 'B');
		await arrowDown(second.editor);
		atTrailing(second.edytor, 3);
		document.body.innerHTML = '';

		// A block below the caret in its own column is the browser's move.
		const third = await render([p('P'), layout()]);
		await caretIn(third.edytor, 'A');
		expect((await arrowDown(third.editor)).defaultPrevented).toBe(false);
		expect(third.edytor.root!.children.length).toBe(2);
	});

	it("a table's last row: the cells of its row are beside it", async () => {
		const table = {
			id: 'T',
			type: 'table',
			data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
			children: [
				row('R1', cell('A', 'c1'), cell('B', 'c2')),
				row('R2', cell('C', 'c1'), cell('D', 'c2'))
			]
		};
		const { edytor, editor } = await render([p('P'), table]);
		await caretIn(edytor, 'C');
		expect((await arrowDown(editor)).defaultPrevented).toBe(true);
		atTrailing(edytor, 3);
	});

	it("a code block's last line (the code plugin keeps no rule of its own)", async () => {
		const { edytor, editor } = await render([
			{ id: 'K', type: 'code', children: [line('l1', 'a'), line('l2', 'bc')] }
		]);
		await caretIn(edytor, 'l2', 1);
		await arrowDown(editor);
		atTrailing(edytor, 2);
	});

	it("a code block's last line inside a toggle: the paragraph is top-level, after the toggle", async () => {
		const { edytor, editor } = await render([
			toggle('T', 'title', [{ id: 'K', type: 'code', children: [line('l1', 'a')] }])
		]);
		await open(edytor, 'T');
		await caretIn(edytor, 'l1');
		await arrowDown(editor);
		expect(edytor.root!.children.map((b) => b.type)).toEqual(['toggle', 'paragraph']);
		atTrailing(edytor, 2);
	});
});

describe('ArrowDown where the rule does not apply', () => {
	it('an empty top-level paragraph below is reached as any stop: nothing is written', async () => {
		const { edytor, editor } = await render([toggle('T', 'title', [p('C', 'child')]), p('E', '')]);
		await open(edytor, 'T');
		await caretIn(edytor, 'C');
		expect((await arrowDown(editor)).defaultPrevented).toBe(false);
		expect(shape(edytor)).toEqual(['toggle:title[paragraph:child]', 'paragraph:']);
	});

	it('the last stop is a top-level paragraph: nothing is written', async () => {
		const { edytor, editor } = await render([toggle('T', 'title'), p('Z')]);
		await caretIn(edytor, 'Z');
		expect((await arrowDown(editor)).defaultPrevented).toBe(false);
		expect(shape(edytor)).toEqual(['toggle:title', 'paragraph:z']);
	});

	it('a caret before the last line break of its block is not on its last line', async () => {
		const { edytor, editor } = await render([block('callout', 'K', 'one\ntwo')]);
		await caretIn(edytor, 'K', 1);
		expect((await arrowDown(editor)).defaultPrevented).toBe(false);
		expect(shape(edytor)).toEqual(['callout:one\ntwo']);
	});

	it('Shift+ArrowDown extends and inserts nothing', async () => {
		const { edytor, editor } = await render([toggle('T', 'title', [p('C', 'child')])]);
		await open(edytor, 'T');
		await caretIn(edytor, 'C', 0);
		await arrowDown(editor, true);
		expect(shape(edytor)).toEqual(['toggle:title[paragraph:child]']);
		expect(edytor.selection.state.isCollapsed).toBe(false);
	});

	it('a readonly view inserts nothing', async () => {
		const { edytor, editor } = await render([block('callout', 'K', 'note')], true);
		await caretIn(edytor, 'K');
		await arrowDown(editor);
		expect(shape(edytor)).toEqual(['callout:note']);
	});
});

describe('a press below the last block (nav.trailing.press)', () => {
	const pressBelow = async (edytor: Edytor, target: HTMLElement = edytor.node!) => {
		const at = edytor.root!.children.at(-1)!.node!.getBoundingClientRect().bottom + 40;
		target.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				button: 0,
				isPrimary: true,
				pointerType: 'mouse',
				clientX: 10,
				clientY: at
			})
		);
		edytor.node!.dispatchEvent(
			new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: at })
		);
		await flushDomUpdates();
	};

	it('after a toggle: a trailing paragraph is created and takes the caret, one undo step', async () => {
		const { edytor } = await render([p('P'), toggle('T', 'title', [p('C', 'child')])]);
		const steps = edytor.undoManager!.undoStack.length;
		await pressBelow(edytor);
		expect(shape(edytor)).toEqual(['paragraph:p', 'toggle:title[paragraph:child]', 'paragraph:']);
		atTrailing(edytor, 3);
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
	});

	it('after a paragraph with text: a new one (Notion)', async () => {
		const { edytor } = await render([p('P')]);
		await pressBelow(edytor);
		expect(shape(edytor)).toEqual(['paragraph:p', 'paragraph:']);
		atTrailing(edytor, 2);
	});

	it('after an empty paragraph: that one takes the caret, nothing is written', async () => {
		const { edytor } = await render([toggle('T', 'title'), p('E', '')]);
		await pressBelow(edytor);
		expect(shape(edytor)).toEqual(['toggle:title', 'paragraph:']);
		expect(caretId(edytor)).toBe('E');
	});

	it('a press on a block is not below the last block', async () => {
		const { edytor } = await render([toggle('T', 'title')]);
		await pressBelow(edytor, edytor.idToBlock.get('T')!.node as HTMLElement);
		expect(shape(edytor)).toEqual(['toggle:title']);
	});

	it('a readonly view inserts nothing', async () => {
		const { edytor } = await render([toggle('T', 'title')], true);
		await pressBelow(edytor);
		expect(shape(edytor)).toEqual(['toggle:title']);
	});
});
