/** @jsxImportSource ../../jsx */
/**
 * Block handles over a layout (D3, as Notion; docs/columns-plan.md §3, §5):
 *
 * - no handle for a layout or a column (decided from the roles); a block
 *   in a column has its `+` and its grip, as Notion (the `+`'s Alt+click
 *   adds a column right of the block's column); a list nested directly in
 *   a list keeps both;
 * - hover lights a block's own handle and its ancestors' that have one,
 *   never a layout's or a column's;
 * - a block selection holding every shown block of every column of a
 *   layout stands for the layout: the one resolver (`outermost`, a grip's
 *   `dragBlocks`) lifts it, so a grip's Alt+arrows, Mod+Shift+arrows, the
 *   block menu's Move, Duplicate and Copy link, and Copy act on the whole
 *   layout, its highlight covers the layout; Delete removes the members
 *   (`selectedMembers`), which leaves no column and so no layout.
 *
 * Expected states are hand-authored from the plan and the contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { dispatchCopy, dispatchDomKeyDown, flushDomUpdates } from '../../dom/test.utils.js';
import {
	block,
	caret,
	click,
	column,
	columns,
	contractDoc,
	p,
	renderColumns,
	selected,
	tree
} from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

const host = (id: string) =>
	document.querySelector<HTMLElement>(`[data-edytor-block-handle-host][data-block-id="${id}"]`);
const parts = (id: string) => {
	const at = host(id);
	return at
		? [
				at.querySelector('[data-testid="block-add"]') ? '+' : '',
				at.querySelector('[data-testid="block-handle"]') ? 'grip' : ''
			].filter(Boolean)
		: null;
};
const grip = (id: string) =>
	document.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!;
const highlighted = () =>
	[...document.querySelectorAll('[data-edytor-columns-selected]')].map((row) =>
		row.closest('[data-edytor-block]')?.getAttribute('data-edytor-id')
	);

const ROW = 24;
/** Lay the shown blocks out as a stack of 24px rows (jsdom has no layout), as the drag rows do. */
const layout = () => {
	const blocks = [...document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	for (const [index, node] of blocks.entries()) {
		const inner = blocks.filter((other) => other !== node && node.contains(other)).length;
		const rect = new DOMRect(0, index * ROW, 600, (inner + 1) * ROW);
		node.getBoundingClientRect = () => rect;
	}
};
/** A native drag event with a data transfer. */
const fire = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) => {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
	const store: Record<string, string> = {};
	Object.defineProperty(event, 'dataTransfer', {
		value: {
			setData: (key: string, value: string) => (store[key] = value),
			getData: (key: string) => store[key] ?? '',
			get types() {
				return Object.keys(store);
			},
			setDragImage: () => {},
			dropEffect: 'move',
			effectAllowed: 'all',
			items: [],
			files: []
		}
	});
	target.dispatchEvent(event);
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
/** Drag `source`'s grip onto the bottom of `target`'s row, then drop: after it. */
const dragAfter = async (edytor: Edytor, source: string, target: string) => {
	await flushDomUpdates();
	layout();
	fire(grip(source), 'dragstart');
	await frame();
	const node = block(edytor, target).node!;
	const rect = node.getBoundingClientRect();
	const point = { clientX: rect.left + 22, clientY: rect.top + 0.95 * ROW };
	fire(node, 'dragenter', point);
	fire(node, 'dragover', point);
	await frame();
	fire(node, 'drop', point);
	await flushDomUpdates();
	await frame();
};

const linked: string[] = [];
const menu = createBlockMenuPlugin({ linkTo: (b) => `#${b.id}` });
const render = (children = contractDoc()) =>
	renderColumns(children, [blockHandlesPlugin, menu, arrowMovePlugin]);

const selectAll = async (edytor: Edytor, ...ids: string[]) => {
	edytor.selection.selectBlocks(...ids.map((id) => block(edytor, id)));
	await flushDomUpdates();
};

describe('which blocks have a handle (D3)', () => {
	it('none for a layout or a column; a block in a column has its + and grip', async () => {
		const { edytor } = await render([
			...contractDoc(),
			{
				id: 'L',
				type: 'unordered-list',
				children: [
					{ id: 'i1', type: 'list-item', content: [{ text: 'i1' }] },
					{
						id: 'L2',
						type: 'unordered-list',
						children: [{ id: 'j1', type: 'list-item', content: [{ text: 'j1' }] }]
					}
				]
			}
		]);
		await flushDomUpdates();
		expect(tree(edytor)).toContainEqual(['L', ['i1', ['L2', ['j1']]]]);
		expect([parts('C'), parts('K1'), parts('K2')]).toEqual([null, null, null]);
		expect([parts('A'), parts('A2'), parts('B')]).toEqual([
			['+', 'grip'],
			['+', 'grip'],
			['+', 'grip']
		]);
		expect([parts('P'), parts('Z')]).toEqual([
			['+', 'grip'],
			['+', 'grip']
		]);
		// A list directly in a list is no layout item: it keeps its whole handle.
		expect([parts('L'), parts('L2'), parts('j1')]).toEqual([
			['+', 'grip'],
			['+', 'grip'],
			['+', 'grip']
		]);
	});

	it('a block nested under a block in a column has both too', async () => {
		await render([columns('C', column('K1', [p('A', 'a', [p('A1')])]), column('K2', [p('B')]))]);
		await flushDomUpdates();
		expect([parts('A'), parts('A1')]).toEqual([
			['+', 'grip'],
			['+', 'grip']
		]);
	});
});

describe("a column block's + (as Notion)", () => {
	const plus = async (id: string, altKey = false) => {
		const add = host(id)!.querySelector<HTMLElement>('[data-testid="block-add"]')!;
		add.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		add.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey }));
		await flushDomUpdates();
	};
	/** The tree with minted ids as `NEW`. */
	const KNOWN = new Set(['P', 'C', 'K1', 'K2', 'A', 'A2', 'B', 'Z']);
	const rename = (ids: unknown[]): unknown[] =>
		ids.map((id) =>
			Array.isArray(id)
				? [KNOWN.has(id[0]) ? id[0] : 'NEW', rename(id[1])]
				: KNOWN.has(id as string)
					? id
					: 'NEW'
		);
	const named = (edytor: Edytor) => rename(tree(edytor));

	it('click: an empty block below it, in its column, the caret in it', async () => {
		const { edytor } = await render();
		await flushDomUpdates();
		await plus('B');
		expect(named(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B', 'NEW']]
				]
			],
			'Z'
		]);
		expect(caret(edytor)).toEqual({
			block: block(edytor, 'K2').children[1]!.id,
			offset: 0,
			isCollapsed: true
		});
	});

	it("Alt+click: a new column right of the block's column, holding an empty block, one undo step", async () => {
		const { edytor } = await render();
		await flushDomUpdates();
		const steps = edytor.undoManager!.undoStack.length;
		await plus('A2', true);
		expect(named(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['NEW', ['NEW']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
		const added = block(edytor, 'C').children[1]!.children[0]!;
		expect(added.type).toBe('paragraph');
		expect(caret(edytor)).toEqual({ block: added.id, offset: 0, isCollapsed: true });
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});

	it('Alt+click on the last column’s block: a new last column', async () => {
		const { edytor } = await render();
		await flushDomUpdates();
		await plus('B', true);
		expect(named(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']],
					['NEW', ['NEW']]
				]
			],
			'Z'
		]);
	});

	it('Alt+click on a block nested in a column, or at the root: a block above, as anywhere', async () => {
		const { edytor } = await render([
			p('P'),
			columns('C', column('K1', [p('A', 'a', [p('A1')])]), column('K2', [p('B')]))
		]);
		await flushDomUpdates();
		await plus('A1', true);
		expect(named(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', [['A', ['NEW', 'NEW']]]],
					['K2', ['B']]
				]
			]
		]);
		await plus('P', true);
		expect(named(edytor)[0]).toBe('NEW');
	});

	it('hover lights the block and its handled ancestors, never a layout or a column', async () => {
		const { edytor } = await render([
			{
				id: 'T',
				type: 'toggle',
				content: [{ text: 't' }],
				children: [columns('C', column('K1', [p('A')]), column('K2', [p('B')]))]
			}
		]);
		await flushDomUpdates();
		block(edytor, 'A').node!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		await flushDomUpdates();
		const visible = [...document.querySelectorAll('[data-edytor-block-handle-host]')]
			.filter((at) => at.getAttribute('data-visible') === 'true')
			.map((at) => at.getAttribute('data-block-id'));
		expect(visible.sort()).toEqual(['A', 'T']);
	});
});

describe('a block selection covering a whole layout stands for it (D3)', () => {
	it('the layout shows selected only when every shown block of every column is', async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2');
		expect(highlighted()).toEqual([]);
		await selectAll(edytor, 'A', 'A2', 'B');
		expect(highlighted()).toEqual(['C']);
		await selectAll(edytor, 'P', 'A', 'A2', 'B');
		expect(highlighted()).toEqual(['C']);
	});

	it("a grip's Alt+ArrowDown moves the whole layout, one undo step, and keeps it selected", async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await dispatchDomKeyDown(grip('A2'), { key: 'ArrowDown', altKey: true });
		expect(tree(edytor)).toEqual([
			'P',
			'Z',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			]
		]);
		expect(selected(edytor)).toEqual(['A', 'A2', 'B']);
		expect(highlighted()).toEqual(['C']);
		// The next step moves it again: the selection still stands for it.
		await dispatchDomKeyDown(grip('B'), { key: 'ArrowUp', altKey: true });
		await dispatchDomKeyDown(grip('B'), { key: 'ArrowUp', altKey: true });
		expect(tree(edytor)).toEqual([
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'P',
			'Z'
		]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});

	it("dragging one of its blocks' grips moves the whole layout, one undo step", async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await dragAfter(edytor, 'B', 'Z');
		expect(tree(edytor)).toEqual([
			'P',
			'Z',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			]
		]);
		expect(selected(edytor)).toEqual(['A', 'A2', 'B']);
		expect(highlighted()).toEqual(['C']);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});

	it('Mod+Shift+ArrowUp moves the whole layout', async () => {
		const { edytor, editor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await dispatchDomKeyDown(editor, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
		expect(tree(edytor)).toEqual([
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'P',
			'Z'
		]);
	});

	it('a selection missing one block moves only its blocks (the layout stays, or dissolves)', async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2');
		await dispatchDomKeyDown(grip('A'), { key: 'ArrowDown', altKey: true });
		// Out of the layout after it (the column's way out); the layout keeps one column and dissolves.
		expect(tree(edytor)).toEqual(['P', 'B', 'A', 'A2', 'Z']);
	});

	it('the block menu: Move down moves the layout', async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await click(grip('A'));
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
		await click(document.querySelector('[data-testid="block-menu-down"]')!);
		expect(tree(edytor)).toEqual([
			'P',
			'Z',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			]
		]);
	});

	it('the block menu: Duplicate copies the layout after it, one undo step', async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await click(grip('B'));
		const steps = edytor.undoManager!.undoStack.length;
		await click(document.querySelector('[data-testid="block-menu-duplicate"]')!);
		const roots = edytor.value.children!;
		expect(roots.map((b) => b.type)).toEqual(['paragraph', 'columns', 'columns', 'paragraph']);
		const copy = roots[2]!;
		expect(copy.id).not.toBe('C');
		expect(
			copy.children!.map((item) =>
				item.children!.map((kid) => (kid.content?.[0] as { text: string }).text)
			)
		).toEqual([['a', 'a2'], ['b']]);
		expect(edytor.undoManager!.undoStack.length).toBe(steps + 1);
	});

	it('the block menu: Copy link links the layout', async () => {
		const writeText = vi.fn(async (value: string) => void linked.push(value));
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await click(grip('A'));
		await click(document.querySelector('[data-testid="block-menu-link"]')!);
		expect(writeText).toHaveBeenCalledWith('#C');
	});

	it('the block menu: Delete removes every block of it; no column, no layout is left', async () => {
		const { edytor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		await click(grip('A'));
		await click(document.querySelector('[data-testid="block-menu-delete"]')!);
		expect(tree(edytor)).toEqual(['P', 'Z']);
		expect(caret(edytor)).toEqual({ block: 'P', offset: 1, isCollapsed: true });
	});

	it('Copy copies the layout with its columns', async () => {
		const { edytor, editor } = await render();
		await selectAll(edytor, 'A', 'A2', 'B');
		const { clipboardData } = await dispatchCopy(editor);
		expect(clipboardData['text/html']).toContain('<div data-edytor-columns>');
		expect(clipboardData['text/html']).toContain('<div data-edytor-column data-width="1">');
		expect(clipboardData['text/plain']).toBe('a\na2\nb');
	});

	it('Copy of some blocks of a layout copies those blocks only', async () => {
		const { edytor, editor } = await render();
		await selectAll(edytor, 'A', 'B');
		const { clipboardData } = await dispatchCopy(editor);
		expect(clipboardData['text/html']).not.toContain('data-edytor-columns');
		expect(clipboardData['text/plain']).toBe('a\nb');
	});
});
