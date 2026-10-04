/** @jsxImportSource ../../jsx */
/**
 * The layout commands (docs/columns-plan.md §5): `columns.2` … `columns.5`
 * ("2 columns" …, group "Layout") insert a layout of N columns, each
 * holding one empty paragraph, the caret in the first column's paragraph.
 * Placed as a kind that replaces content (`placing`): an empty line (a
 * slash line holding only its query) is converted in place, after any other
 * block the layout is inserted. One undo step. Refused inside a column
 * (D2, `layout.nest`): disabled there, so the slash menu does not list
 * them. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { dispatchDomBeforeInput, flushDomUpdates } from '../../dom/test.utils.js';
import {
	block,
	caret,
	caretIn,
	click,
	column,
	columns,
	contractDoc,
	p,
	renderColumns,
	tree
} from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** Root blocks as kinds: a layout as its columns' kinds and texts. */
const shape = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((b) =>
		b.type === 'columns'
			? (b.children ?? []).map((item) => [
					item.type,
					(item.children ?? []).map(
						(kid) =>
							`${kid.type}:${(kid.content ?? []).map((c) => ('text' in c ? c.text : '@')).join('')}`
					)
				])
			: `${b.type}:${(b.content ?? []).map((c) => ('text' in c ? c.text : '@')).join('')}`
	);

const empties = (n: number) => Array.from({ length: n }, () => ['column', ['paragraph:']]);

/** The caret's block sits in the first column of a layout, at offset 0. */
const inFirstColumn = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	const item = startBlock?.parent;
	return {
		kind: startBlock?.type,
		item: item?.type,
		index: item?.index,
		layout: item?.parent?.type,
		offset: yStart,
		isCollapsed
	};
};
const FIRST = {
	kind: 'paragraph',
	item: 'column',
	index: 0,
	layout: 'columns',
	offset: 0,
	isCollapsed: true
};

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const rows = () =>
	[...document.querySelectorAll('[data-testid="slash-menu-item"]')].map((row) =>
		row.textContent?.trim()
	);

describe('the layout commands', () => {
	it('are four commands in the Layout group, with Notion’s col<n>, columns<n> and column <n> keywords', async () => {
		const { edytor } = await renderColumns([p('P', '')]);
		const listed = [2, 3, 4, 5].map((n) => {
			const command = edytor.commands.get(`columns.${n}`)!;
			return [command.label, command.group, command.keywords];
		});
		expect(listed).toEqual(
			[2, 3, 4, 5].map((n) => [
				`${n} columns`,
				'Layout',
				['columns', 'layout', 'side by side', `col${n}`, `columns${n}`, `column ${n}`]
			])
		);
	});

	for (const n of [2, 3, 4, 5]) {
		it(`columns.${n} converts an empty paragraph in place, caret in column 1, one undo step`, async () => {
			const { edytor } = await renderColumns([p('P', '')]);
			await caretIn(edytor, 'P', 0);
			const steps = edytor.undoManager!.undoStack.length;
			expect(await edytor.runCommand(`columns.${n}`)).toBe(true);
			await flushDomUpdates();
			expect(shape(edytor)).toEqual([empties(n)]);
			expect(inFirstColumn(edytor)).toEqual(FIRST);
			expect(document.querySelectorAll('[data-edytor-column]')).toHaveLength(n);
			expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(shape(edytor)).toEqual(['paragraph:']);
		});
	}

	it('after a block holding text the layout is inserted after it', async () => {
		const { edytor } = await renderColumns([p('P', 'hello'), p('Z', 'z')]);
		await caretIn(edytor, 'P', 5);
		expect(await edytor.runCommand('columns.2')).toBe(true);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:hello', empties(2), 'paragraph:z']);
		expect(inFirstColumn(edytor)).toEqual(FIRST);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:hello', 'paragraph:z']);
	});

	it('from the slash menu: the query line becomes the layout; undo gives the query back', async () => {
		const { edytor, editor } = await renderColumns([p('P', '')], [slashMenuPlugin]);
		await caretIn(edytor, 'P', 0);
		await type(editor, '/3 col');
		expect(rows()).toEqual(['3 columns']);
		const steps = edytor.undoManager!.undoStack.length;
		await click(document.querySelector('[data-testid="slash-menu-item"]')!);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([empties(3)]);
		expect(inFirstColumn(edytor)).toEqual(FIRST);
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:/3 col']);
	});

	it('the slash menu lists the layouts at the top level, by any keyword', async () => {
		const { edytor, editor } = await renderColumns([p('P', '')], [slashMenuPlugin]);
		await caretIn(edytor, 'P', 0);
		await type(editor, '/side by');
		expect(rows()).toEqual(['2 columns', '3 columns', '4 columns', '5 columns']);
	});

	for (const [query, row] of [
		['/col3', '3 columns'],
		['/columns3', '3 columns'],
		['/col5', '5 columns'],
		['/columns2', '2 columns'],
		// Round 3: a word and the count, as Notion matches them.
		['/column 2', '2 columns'],
		['/column 4', '4 columns'],
		['/columns 3', '3 columns'],
		['/col 5', '5 columns']
	])
		it(`the slash menu finds ${row} by ${query} (Notion)`, async () => {
			const { edytor, editor } = await renderColumns([p('P', '')], [slashMenuPlugin]);
			await caretIn(edytor, 'P', 0);
			await type(editor, query);
			expect(rows()).toEqual([row]);
		});

	it('inside a column: disabled, not listed, and refused when run (D2)', async () => {
		const { edytor, editor } = await renderColumns(
			[columns('C', column('K1', [p('A', '')]), column('K2', [p('B')]))],
			[slashMenuPlugin]
		);
		await caretIn(edytor, 'A', 0);
		const command = edytor.commands.get('columns.2')!;
		expect(command.isEnabled?.(edytor)).toBe(false);
		const before = tree(edytor);
		expect(await edytor.runCommand('columns.2')).toBe(false);
		expect(command.run(edytor)).toBe(false);
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(tree(edytor)).toEqual(before);
		expect(caret(edytor)).toEqual({ block: 'A', offset: 0, isCollapsed: true });

		await type(editor, '/column');
		expect(rows()).toEqual([]);
	});

	it('inside a block nested in a column too (any depth)', async () => {
		const { edytor } = await renderColumns([
			columns('C', column('K1', [p('A', 'a', [p('A1', '')])]), column('K2', [p('B')]))
		]);
		await caretIn(edytor, 'A1', 0);
		expect(edytor.commands.get('columns.3')!.isEnabled?.(edytor)).toBe(false);
	});

	it('after a layout (outside any column) they are enabled', async () => {
		const { edytor } = await renderColumns([...contractDoc()]);
		await caretIn(edytor, 'Z', 1);
		expect(edytor.commands.get('columns.2')!.isEnabled?.(edytor)).toBe(true);
		expect(block(edytor, 'Z').parent?.isRoot).toBe(true);
	});
});
