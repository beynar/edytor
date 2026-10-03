/** @jsxImportSource ../../jsx */
/**
 * Turn into N columns (Notion; `layout.wrap`): over a block selection of 2
 * to 5 sibling blocks, the block menu's Turn into lists "N columns" (N the
 * number of blocks), which wraps them in one layout, one block per column,
 * at the first one's place: one plan, one undo step, the blocks still
 * selected. Not offered for one block, more than five, blocks of different
 * parents, or inside a column (D2). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { flushDomUpdates } from '../../dom/test.utils.js';
import { block, click, column, columns, p, renderColumns, selected } from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const KNOWN = new Set(['X', 'Y', 'W', 'V', 'U', 'T', 'Z', 'C', 'K1', 'K2', 'A', 'B', 'X1']);
const named = (edytor: Edytor) => {
	const walk = (blocks: { id?: string; children?: unknown[] }[] = []): unknown[] =>
		blocks.map((b) => {
			const id = KNOWN.has(b.id!) ? b.id : 'NEW';
			return b.children?.length ? [id, walk(b.children as never)] : id;
		});
	return walk(edytor.value.children as never);
};

const grip = (id: string) =>
	document.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!;
const flyoutRows = () =>
	[...document.querySelectorAll('[aria-label="Turn into"] button')].map((b) => b.textContent);
const flyoutRow = (label: string) =>
	[...document.querySelectorAll<HTMLElement>('[aria-label="Turn into"] button')].find(
		(b) => b.textContent === label
	);

const render = (children = [p('X', 'x', [p('X1')]), p('Y', 'y'), p('W', 'w'), p('Z', 'z')]) =>
	renderColumns(children, [blockHandlesPlugin, blockMenuPlugin]);

/** Select `ids`, click the first one's grip, open Turn into. */
const turnMenu = async (edytor: Edytor, ...ids: string[]) => {
	edytor.selection.selectBlocks(...ids.map((id) => block(edytor, id)));
	await flushDomUpdates();
	await click(grip(ids[0]!));
	await click(document.querySelector('[data-testid="block-menu-turn"]')!);
};

describe('Turn into N columns over sibling blocks', () => {
	it('three selected paragraphs: "3 columns" wraps them, one per column, one undo step', async () => {
		const { edytor } = await render();
		await turnMenu(edytor, 'X', 'Y', 'W');
		expect(flyoutRows()).toContain('3 columns');
		expect(flyoutRows()).not.toContain('2 columns');
		const steps = edytor.undoManager!.undoStack.length;
		await click(flyoutRow('3 columns')!);
		expect(named(edytor)).toEqual([
			[
				'NEW',
				[
					['NEW', [['X', ['X1']]]],
					['NEW', ['Y']],
					['NEW', ['W']]
				]
			],
			'Z'
		]);
		expect(edytor.value.children![0]!.type).toBe('columns');
		expect(selected(edytor)).toEqual(['X', 'Y', 'W']);
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(named(edytor)).toEqual([['X', ['X1']], 'Y', 'W', 'Z']);
	});

	it('two: "2 columns"', async () => {
		const { edytor } = await render();
		await turnMenu(edytor, 'Y', 'W');
		await click(flyoutRow('2 columns')!);
		expect(named(edytor)).toEqual([
			['X', ['X1']],
			[
				'NEW',
				[
					['NEW', ['Y']],
					['NEW', ['W']]
				]
			],
			'Z'
		]);
	});

	it('not offered for one block, six blocks, or blocks of different parents', async () => {
		const six = ['X', 'Y', 'W', 'V', 'U', 'T'].map((id) => p(id, id.toLowerCase()));
		const { edytor } = await render(six);
		await turnMenu(edytor, 'X');
		expect(flyoutRows().filter((row) => row?.endsWith('columns'))).toEqual([]);
		document.body.innerHTML = '';
		const again = await render(six);
		await turnMenu(again.edytor, 'X', 'Y', 'W', 'V', 'U', 'T');
		expect(flyoutRows().filter((row) => row?.endsWith('columns'))).toEqual([]);
		document.body.innerHTML = '';
		const nested = await render();
		await turnMenu(nested.edytor, 'X', 'X1');
		expect(flyoutRows().filter((row) => row?.endsWith('columns'))).toEqual([]);
	});

	it('not offered inside a column (D2)', async () => {
		const { edytor } = await render([
			columns('C', column('K1', [p('A', 'a'), p('X', 'x')]), column('K2', [p('B', 'b')])),
			p('Z', 'z')
		]);
		await turnMenu(edytor, 'A', 'X');
		expect(flyoutRows().filter((row) => row?.endsWith('columns'))).toEqual([]);
	});
});
