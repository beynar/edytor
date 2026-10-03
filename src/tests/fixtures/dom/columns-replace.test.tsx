/** @jsxImportSource ../../jsx */
/**
 * Typing, a composition or a paste over a block selection inside a column
 * replaces the selected blocks in place (`flow.slot`, `layout.flow-slot`,
 * as Notion): the new line takes the first selected block's slot before
 * the delete decides what it empties, so a column whose only block is
 * replaced stays, and its layout with it.
 *
 * `P "p", C[K1[A "a", A2 "a2"], K2[B "b"]], Z "z"`. Expected states are
 * hand-authored from the contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	dispatchClipboardPaste,
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates
} from '../../dom/test.utils.js';
import {
	block,
	caret,
	caretIn,
	contractDoc,
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
/** The tree with the one new block's id shown as `NEW`. */
const shown = (ids: unknown[], known: Set<string>): unknown[] =>
	ids.map((id) =>
		Array.isArray(id)
			? [known.has(id[0]) ? id[0] : 'NEW', shown(id[1], known)]
			: known.has(id as string)
				? id
				: 'NEW'
	);
const KNOWN = new Set(['P', 'C', 'K1', 'K2', 'A', 'A2', 'B', 'Z']);

const selectB = async (edytor: Awaited<ReturnType<typeof renderColumns>>['edytor']) => {
	edytor.selection.selectBlocks(block(edytor, 'B'));
	await flushDomUpdates();
	expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['B']);
};

describe('a block selection in a column replaced in place (layout.flow-slot)', () => {
	it('typing over the only block of column 2: the column and the layout stay', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		await selectB(edytor);
		const steps = edytor.undoManager!.undoStack.length;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(shown(tree(edytor), KNOWN)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['NEW']]
				]
			],
			'Z'
		]);
		const fresh = edytor.selection.state.startBlock!;
		expect(text(edytor, fresh.id)).toBe('x');
		expect(caret(edytor)).toEqual({ block: fresh.id, offset: 1, isCollapsed: true });
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['P', LAYOUT, 'Z']);
	});

	it('Mod+A twice in B then typing: the same', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		await caretIn(edytor, 'B', 1);
		await dispatchDomKeyDown(document, { key: 'a', metaKey: true });
		await dispatchDomKeyDown(document, { key: 'a', metaKey: true });
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['B']);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(shown(tree(edytor), KNOWN)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['NEW']]
				]
			],
			'Z'
		]);
	});

	it('typing over both blocks of column 1: one block takes their place', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		edytor.selection.selectBlocks(block(edytor, 'A'), block(edytor, 'A2'));
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'y' });
		expect(shown(tree(edytor), KNOWN)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['NEW']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});

	it('a composition over the selected block: the column stays', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		await selectB(edytor);
		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		expect(shown(tree(edytor), KNOWN)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['NEW']]
				]
			],
			'Z'
		]);
	});

	it('a paste over the selected block: the pasted line takes its place', async () => {
		const { edytor, editor } = await renderColumns(contractDoc());
		await selectB(edytor);
		await dispatchClipboardPaste(editor, { 'text/plain': 'pasted' });
		expect(shown(tree(edytor), KNOWN)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['NEW']]
				]
			],
			'Z'
		]);
		const k2 = edytor.idToBlock.get('K2')!.children[0]!;
		expect(text(edytor, k2.id)).toBe('pasted');
	});
});
