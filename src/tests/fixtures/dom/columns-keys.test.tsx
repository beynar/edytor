/** @jsxImportSource ../../jsx */
/**
 * Keys at a layout's edges (`layout.merge`, D4, as Notion; docs/columns-plan.md §5):
 *
 * - Backspace at the start of a column's first block merges it into the
 *   previous shown line in reading order: the previous column's last line,
 *   or, in the first column, the line before the layout; the caret at the
 *   join. An emptied column goes and a layout left with one column
 *   dissolves. Backspace at another block of a column merges as anywhere;
 *   Backspace at the block after a layout joins the last column's last line.
 * - Delete at the end of a column's last line pulls the next column's first
 *   line into it; at the end of the line before the layout, column 1's
 *   first; at the end of the last column, the block after the layout.
 * - Mod+Shift+↑ at a column's first block, ↓ at its last, moves the block
 *   out before or after the layout (dissolve applies).
 *
 * `P "p", C[K1[A "a", A2 "a2"], K2[B "b"]], Z "z"`. Expected states are
 * hand-authored from the contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates
} from '../../dom/test.utils.js';
import {
	caret,
	caretIn,
	column,
	columns,
	contractDoc,
	p,
	renderColumns,
	text,
	tree
} from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const LAYOUT = [
	'C',
	[
		['K1', ['A', 'A2']],
		['K2', ['B']]
	]
];
const backspace = (editor: HTMLElement) =>
	dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
const del = (editor: HTMLElement) =>
	dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
const render = (children = contractDoc()) => renderColumns(children, [arrowMovePlugin]);

describe('Backspace at a column edge (layout.merge)', () => {
	it("at column 2's first block: into column 1's last line; the layout dissolves", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'B', 0);
		const steps = edytor.undoManager!.undoStack.length;
		await backspace(editor);
		expect(tree(edytor)).toEqual(['P', 'A', 'A2', 'Z']);
		expect(text(edytor, 'A2')).toBe('a2b');
		expect(caret(edytor)).toEqual({ block: 'A2', offset: 2, isCollapsed: true });
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['P', LAYOUT, 'Z']);
	});

	it("at column 1's first block: into the line before the layout", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A', 0);
		await backspace(editor);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
		expect(text(edytor, 'P')).toBe('pa');
		expect(caret(edytor)).toEqual({ block: 'P', offset: 1, isCollapsed: true });
	});

	it('an empty first block is removed, the caret at the end of the line before', async () => {
		const { edytor, editor } = await render([
			p('P', 'p'),
			columns('C', column('K1', [p('A', 'a')]), column('K2', [p('B', ''), p('B2', 'b2')])),
			p('Z', 'z')
		]);
		await caretIn(edytor, 'B', 0);
		await backspace(editor);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A']],
					['K2', ['B2']]
				]
			],
			'Z'
		]);
		expect(text(edytor, 'A')).toBe('a');
		expect(caret(edytor)).toEqual({ block: 'A', offset: 1, isCollapsed: true });
	});

	it("in a column of three, the middle one's first block keeps the others", async () => {
		const { edytor, editor } = await render([
			columns(
				'C',
				column('K1', [p('A', 'a')]),
				column('K2', [p('B', 'b'), p('B2', 'b2')]),
				column('K3', [p('D', 'd')])
			)
		]);
		await caretIn(edytor, 'B', 0);
		await backspace(editor);
		expect(tree(edytor)).toEqual([
			[
				'C',
				[
					['K1', ['A']],
					['K2', ['B2']],
					['K3', ['D']]
				]
			]
		]);
		expect(text(edytor, 'A')).toBe('ab');
		expect(caret(edytor)).toEqual({ block: 'A', offset: 1, isCollapsed: true });
	});

	it("at a column's last (not first) block: merges into the block before it", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A2', 0);
		await backspace(editor);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
		expect(text(edytor, 'A')).toBe('aa2');
		expect(caret(edytor)).toEqual({ block: 'A', offset: 1, isCollapsed: true });
	});

	it("at the block after the layout: into the last column's last line", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'Z', 0);
		await backspace(editor);
		expect(tree(edytor)).toEqual(['P', LAYOUT]);
		expect(text(edytor, 'B')).toBe('bz');
		expect(caret(edytor)).toEqual({ block: 'B', offset: 1, isCollapsed: true });
	});
});

describe('Delete at a column edge (layout.merge)', () => {
	it("at column 1's last line: pulls column 2's first line; the layout dissolves", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A2', 2);
		await del(editor);
		expect(tree(edytor)).toEqual(['P', 'A', 'A2', 'Z']);
		expect(text(edytor, 'A2')).toBe('a2b');
		expect(caret(edytor)).toEqual({ block: 'A2', offset: 2, isCollapsed: true });
	});

	it("at the line before the layout: pulls column 1's first line", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'P', 1);
		await del(editor);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
		expect(text(edytor, 'P')).toBe('pa');
		expect(caret(edytor)).toEqual({ block: 'P', offset: 1, isCollapsed: true });
	});

	it('at the end of the last column: pulls the block after the layout', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'B', 1);
		await del(editor);
		expect(tree(edytor)).toEqual(['P', LAYOUT]);
		expect(text(edytor, 'B')).toBe('bz');
		expect(caret(edytor)).toEqual({ block: 'B', offset: 1, isCollapsed: true });
	});
});

describe('Mod+Shift+arrows: the way out of a column', () => {
	const up = (editor: HTMLElement) =>
		dispatchDomKeyDown(editor, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
	const down = (editor: HTMLElement) =>
		dispatchDomKeyDown(editor, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });

	it("↑ at a column's first block moves it before the layout, the caret riding along", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A', 1);
		await up(editor);
		expect(tree(edytor)).toEqual([
			'P',
			'A',
			[
				'C',
				[
					['K1', ['A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
		expect(caret(edytor)).toEqual({ block: 'A', offset: 1, isCollapsed: true });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['P', LAYOUT, 'Z']);
	});

	it("↓ at a column's last block moves it after the layout; an emptied column dissolves it", async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'B', 0);
		await down(editor);
		expect(tree(edytor)).toEqual(['P', 'A', 'A2', 'B', 'Z']);
		expect(caret(edytor)).toEqual({ block: 'B', offset: 0, isCollapsed: true });
	});

	it('inside a column the blocks swap as anywhere', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A', 0);
		await down(editor);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A2', 'A']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});
});
