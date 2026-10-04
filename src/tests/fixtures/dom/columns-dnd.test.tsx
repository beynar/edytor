/** @jsxImportSource ../../jsx */
/**
 * Columns by drag and drop (docs/columns-plan.md §5 "DnD", C3; the delete
 * contract's `layout.place-beside`): dragging blocks to the left or right
 * edge of another block puts them beside it.
 *
 * - The move positions: `edytor.moveBlocks`/`canMoveBlocks` take `left` and
 *   `right`, routed to `prepare.placeBeside`: the one move path (one command,
 *   one undo step, `dispatcher.last` on a refusal, hooks see `moveBlock(s)`).
 * - The bands, only while the pointer is within the row's height, the
 *   document has a layout kind and the layout is not stacked (480px):
 *   right = the row's last 15% (at least 32px); left = the 20px slop left of
 *   a row whose parent is the root or a column (nested rows keep
 *   reparent-by-x). Checked before the hitbox; a refused band shows nothing.
 * - The gap between two columns: a new column between them.
 * - `rowAt` measures a column only when the pointer is inside it, and a
 *   sticky target never holds the pointer over another column.
 * - The indicator: a vertical 4px bar at the row's edge, the layout's height
 *   when the drop adds a column to it.
 * - The drag preview: the source at its own width.
 *
 * Driven through the real drag library's native events over hand-laid-out
 * boxes (jsdom has no layout, `dnd-nest-backdrop.test.tsx`'s method).
 * Expected states come from the plan and the contract, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { HIDDEN } from '$lib/selection/visibility.js';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import {
	block,
	caret,
	caretIn,
	column,
	columns,
	contractDoc,
	p,
	renderColumns,
	selected
} from './columns.helpers.js';

afterEach(() => {
	// A drag a failed test left open would swallow the next test's.
	window.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
	document.body.innerHTML = '';
});

const ROW = 24;

/**
 * The displayed tree: a layout or a column as its kind (new ones get fresh
 * ids), any other block as its id; children as `[name, children]`.
 */
const shape = (edytor: Edytor): unknown[] => {
	const walk = (blocks: JSONBlock[] = []): unknown[] =>
		blocks.map((b) => {
			const name = b.type === 'columns' || b.type === 'column' ? b.type : b.id;
			return b.children?.length ? [name, walk(b.children)] : name;
		});
	return walk(edytor.value.children);
};

/** The contract document's shape, `C:columns[K1:column[A, A2], K2:column[B]]`. */
const C = [
	'columns',
	[
		['column', ['A', 'A2']],
		['column', ['B']]
	]
];

const list = (id: string, ...items: string[]): JSONBlock => ({
	id,
	type: 'unordered-list',
	children: items.map((item) => ({ id: item, type: 'list-item', content: [{ text: item }] }))
});

/**
 * Lay the shown blocks out (jsdom has no layout): rows of 24px from x 0 in a
 * `width` wide editor; a block's children 24px in, a container's (a list's,
 * no own row) not; a layout's columns side by side with `gap` between them,
 * equal widths, its height its tallest column's.
 */
const layout = ({ width = 600, gap = 46 }: { width?: number; gap?: number } = {}) => {
	const editor = document.querySelector<HTMLElement>('[data-edytor]')!;
	const all = [...editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	const parentOf = (node: HTMLElement) =>
		node.parentElement?.closest<HTMLElement>('[data-edytor-block="true"]') ?? null;
	const kids = (node: HTMLElement | null) => all.filter((other) => parentOf(other) === node);
	const ownsText = (node: HTMLElement) =>
		[...node.querySelectorAll('[data-edytor-text="true"]')].some(
			(text) => text.closest('[data-edytor-block="true"]') === node
		);
	const set = (node: HTMLElement, rect: DOMRect) => (node.getBoundingClientRect = () => rect);
	const place = (node: HTMLElement, x: number, y: number, w: number): number => {
		if (node.closest(HIDDEN)) {
			set(node, new DOMRect(0, 0, 0, 0));
			for (const kid of kids(node)) place(kid, 0, 0, 0);
			return 0;
		}
		let height = 0;
		if (node.hasAttribute('data-edytor-columns')) {
			const items = kids(node);
			const each = (w - gap * (items.length - 1)) / items.length;
			items.forEach((item, i) => {
				height = Math.max(height, place(item, x + i * (each + gap), y, each));
			});
		} else if (node.hasAttribute('data-edytor-column')) {
			for (const kid of kids(node)) height += place(kid, x, y + height, w);
		} else {
			const own = ownsText(node) ? ROW : 0;
			const indent = own ? ROW : 0;
			height = own;
			for (const kid of kids(node)) height += place(kid, x + indent, y + height, w - indent);
		}
		set(node, new DOMRect(x, y, w, height));
		return height;
	};
	let y = 0;
	for (const node of kids(null)) y += place(node, 0, y, width);
};

let dragImage: HTMLElement | null = null;
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
			setDragImage: (image: Element) => (dragImage = image.cloneNode(true) as HTMLElement),
			dropEffect: 'move',
			effectAllowed: 'all',
			items: [],
			files: []
		}
	});
	target.dispatchEvent(event);
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const rectOf = (edytor: Edytor, id: string) => block(edytor, id).node!.getBoundingClientRect();

/**
 * A drag of `source`'s grip. `over`/`drop` fire on `target`'s element at
 * `x` px right of its left edge (negative: left of it) and `at` (0 top … 1
 * bottom of its first 24px row); `overAt`/`dropAt` fire on a block's
 * element at a client point.
 */
const startDrag = async (
	edytor: Edytor,
	source: string,
	geometry?: Parameters<typeof layout>[0]
) => {
	await flushDomUpdates();
	layout(geometry);
	dragImage = null;
	const grip = document.querySelector<HTMLElement>(
		`[data-testid="block-handle"][data-block-id="${source}"]`
	)!;
	const from = rectOf(edytor, source);
	fire(grip, 'dragstart', { clientX: from.left - 12, clientY: from.top + 12 });
	await frame();
	const point = (target: string, at: number, x: number) => {
		const rect = rectOf(edytor, target);
		return { clientX: rect.left + x, clientY: rect.top + at * ROW };
	};
	const overAt = async (target: string, clientX: number, clientY: number) => {
		const node = block(edytor, target).node!;
		fire(node, 'dragenter', { clientX, clientY });
		fire(node, 'dragover', { clientX, clientY });
		await frame();
	};
	const dropAt = async (target: string, clientX: number, clientY: number) => {
		fire(block(edytor, target).node!, 'drop', { clientX, clientY });
		await flushDomUpdates();
		await frame();
	};
	return {
		over: (target: string, at: number, x: number) => {
			const { clientX, clientY } = point(target, at, x);
			return overAt(target, clientX, clientY);
		},
		drop: (target: string, at: number, x: number) => {
			const { clientX, clientY } = point(target, at, x);
			return dropAt(target, clientX, clientY);
		},
		overAt,
		dropAt
	};
};

/**
 * The pointer over the page left or right of the editor (the page target,
 * `margin`): jsdom has no layout nor hit test, so the root gets the blocks'
 * box and `elementsFromPoint` answers the blocks at a point, innermost first.
 * `on` is the element under the pointer (a block reaching into the handle
 * column, which hands it to the page target), else the page. Answers the
 * release.
 */
const overPage = async (
	edytor: Edytor,
	clientX: number,
	clientY: number,
	on: HTMLElement = document.body
) => {
	const root = edytor.node!;
	const blocks = [...root.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	const bottom = Math.max(...blocks.map((node) => node.getBoundingClientRect().bottom));
	root.getBoundingClientRect = () => new DOMRect(0, 0, 600, bottom);
	const hits = (x: number, y: number) =>
		blocks
			.filter((node) => {
				const r = node.getBoundingClientRect();
				return x >= r.left && x <= r.right && y >= r.top && y < r.bottom;
			})
			.reverse();
	Object.assign(document, { elementsFromPoint: hits });
	fire(on, 'dragenter', { clientX, clientY });
	fire(on, 'dragover', { clientX, clientY });
	await frame();
	return async () => {
		fire(on, 'drop', { clientX, clientY });
		await flushDomUpdates();
		await frame();
		delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
	};
};

const indicator = () => document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');
const position = () => indicator()?.dataset.position;
/** The block the placement is relative to (`data-edytor-block-drop-position`). */
const indicated = () =>
	document.querySelector<HTMLElement>('[data-edytor-block-drop-position]')?.dataset.edytorId;
/** The bar's layer-relative box (the layer sits at 0,0). */
const bar = () => {
	const { left, top, width, height } = indicator()!.style;
	return {
		left: parseFloat(left),
		top: parseFloat(top),
		width: parseFloat(width),
		height: parseFloat(height)
	};
};
const backdropShown = () =>
	document.querySelector('[data-edytor-drop-backdrop][data-shown="true"]') !== null;

const plugins: Plugin[] = [blockHandlesPlugin];
const render = (children: JSONBlock[]) => renderColumns(children, plugins);

/** `P, C[K1[A, A2], K2[B]], Z, X`: X is the dragged block. */
const withX = () => [...contractDoc(), p('X')];

describe('move positions left and right (one move path)', () => {
	it('right of a root block wraps it and the moved blocks in a new layout, one undo step', async () => {
		const { edytor } = await render(withX());
		const request = { blocks: [block(edytor, 'X')], target: block(edytor, 'P'), position: 'right' };
		expect(edytor.canMoveBlocks(request as never)).toBe(true);
		const moved = edytor.moveBlocks(request as never);
		await flushDomUpdates();
		expect(moved.map((b) => b.id)).toEqual(['X']);
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', ['P']],
					['column', ['X']]
				]
			],
			C,
			'Z'
		]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlock', status: 'applied' });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
	});

	it('left of a root block puts the moved blocks first', async () => {
		const { edytor } = await render(withX());
		edytor.moveBlocks({
			blocks: [block(edytor, 'X')],
			target: block(edytor, 'P'),
			position: 'left'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', ['X']],
					['column', ['P']]
				]
			],
			C,
			'Z'
		]);
	});

	it("beside a column's block: a new column next to that column", async () => {
		const { edytor } = await render(withX());
		edytor.moveBlocks({
			blocks: [block(edytor, 'X')],
			target: block(edytor, 'A2'),
			position: 'right'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', ['A', 'A2']],
					['column', ['X']],
					['column', ['B']]
				]
			],
			'Z'
		]);
	});

	it('right of a column (the gap after it): a new column between', async () => {
		const { edytor } = await render(withX());
		edytor.moveBlocks({
			blocks: [block(edytor, 'X')],
			target: block(edytor, 'K1'),
			position: 'right'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', ['A', 'A2']],
					['column', ['X']],
					['column', ['B']]
				]
			],
			'Z'
		]);
	});

	it("moving a column's only block out dissolves the layout it leaves", async () => {
		const { edytor } = await render(withX());
		edytor.moveBlocks({
			blocks: [block(edytor, 'B')],
			target: block(edytor, 'Z'),
			position: 'right'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'P',
			'A',
			'A2',
			[
				'columns',
				[
					['column', ['Z']],
					['column', ['B']]
				]
			],
			'X'
		]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
	});

	it('beside a list item: the layout wraps the whole list', async () => {
		const { edytor } = await render([list('L', 'i1', 'i2'), p('X')]);
		edytor.moveBlocks({
			blocks: [block(edytor, 'X')],
			target: block(edytor, 'i2'),
			position: 'right'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', [['L', ['i1', 'i2']]]],
					['column', ['X']]
				]
			]
		]);
	});

	it('a layout beside a block is refused (no layout in a column, D2): nothing moves, last reads refused', async () => {
		const { edytor } = await render(withX());
		const request = { blocks: [block(edytor, 'C')], target: block(edytor, 'X'), position: 'right' };
		expect(edytor.canMoveBlocks(request as never)).toBe(false);
		expect(edytor.moveBlocks(request as never)).toEqual([]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlock', status: 'refused' });
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
	});

	it('a block beside itself or its own descendant is refused', async () => {
		const { edytor } = await render([p('P', 'p', [p('P1')]), p('X')]);
		const self = { blocks: [block(edytor, 'P')], target: block(edytor, 'P'), position: 'left' };
		const inner = { blocks: [block(edytor, 'P')], target: block(edytor, 'P1'), position: 'right' };
		expect(edytor.canMoveBlocks(self as never)).toBe(false);
		expect(edytor.canMoveBlocks(inner as never)).toBe(false);
	});

	it('an extension veto of the move cancels it', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (/^moveBlocks?$/.test(operation)) prevent();
			}
		});
		const { edytor } = await renderColumns(withX(), [veto]);
		edytor.moveBlocks({
			blocks: [block(edytor, 'X')],
			target: block(edytor, 'P'),
			position: 'right'
		});
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
	});

	it('without a layout kind there is no beside', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin], value: { children: [p('P'), p('X')] } }
		);
		const request = { blocks: [block(edytor, 'X')], target: block(edytor, 'P'), position: 'right' };
		expect(edytor.canMoveBlocks(request as never)).toBe(false);
		expect(edytor.moveBlocks(request as never)).toEqual([]);
		expect(edytor.dispatcher.last?.status).toBe('refused');
	});
});

describe('the beside bands', () => {
	it("the right band (the row's last 15%) shows a vertical bar at the row's right edge; the drop makes a layout, selects the moved block, one undo restores", async () => {
		const { edytor } = await render(withX());
		await caretIn(edytor, 'Z', 1);
		const drag = await startDrag(edytor, 'X');
		await drag.over('P', 0.5, 590);
		expect(position()).toBe('right');
		expect(indicated()).toBe('P');
		expect(bar()).toEqual({ left: 598, top: 0, width: 4, height: 24 });
		expect(backdropShown()).toBe(false);
		await drag.drop('P', 0.5, 590);
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', ['P']],
					['column', ['X']]
				]
			],
			C,
			'Z'
		]);
		expect(selected(edytor)).toEqual(['X']);
		expect(indicator()).toBeNull();
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
		expect(caret(edytor)).toEqual({ block: 'Z', offset: 1, isCollapsed: true });
	});

	it('a drop gives the keys to the editor: Mod+Z, then Mod+Shift+Z after an undo that gave back no selection (round 3)', async () => {
		const { edytor, editor } = await render(withX());
		expect(edytor.selection.value.kind).toBe('none');
		const drag = await startDrag(edytor, 'X');
		await drag.over('P', 0.5, 590);
		await drag.drop('P', 0.5, 590);
		const beside = [
			[
				'columns',
				[
					['column', ['P']],
					['column', ['X']]
				]
			],
			C,
			'Z'
		];
		expect(shape(edytor)).toEqual(beside);
		expect(document.activeElement).toBe(editor);
		expect(selected(edytor)).toEqual(['X']);
		await dispatchDomKeyDown(editor, { key: 'z', ctrlKey: true });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
		expect(edytor.selection.value.kind).toBe('none');
		expect(document.activeElement).toBe(editor);
		await dispatchDomKeyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(beside);
	});

	it('the band starts at 85% of the row; before it the hitbox halves stand', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X');
		await drag.over('P', 0.25, 505);
		expect(position()).toBe('before');
		await drag.over('P', 0.25, 515);
		expect(position()).toBe('right');
		await drag.over('P', 0.25, 300);
		expect(position()).toBe('before');
		expect(bar().height).toBeNaN();
	});

	it('a narrow row keeps a 32px band', async () => {
		const three = columns(
			'C3',
			column('K1', [p('A')]),
			column('K2', [p('B')]),
			column('K3', [p('D')])
		);
		const { edytor } = await render([three, p('X')]);
		const drag = await startDrag(edytor, 'X');
		// Each column (600 - 2 × 46) / 3 ≈ 169px wide: 15% ≈ 25px < 32px.
		const b = rectOf(edytor, 'B');
		await drag.overAt('B', b.right - 30, b.top + 6);
		expect(position()).toBe('right');
		await drag.overAt('B', b.right - 35, b.top + 6);
		expect(position()).toBe('before');
	});

	it('left of a root row, the handle column reorders; the page margin past it is the left band, the moved block first (R2)', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X');
		// 10px left of P, over P's element (in its sticky slop): the handle
		// column, which P hands to the page target (round 3), a reorder.
		await overPage(edytor, -10, 12, block(edytor, 'P').node!);
		expect([position(), indicated()]).toEqual(['after', 'P']);
		// The page there (the handle column, 50px when the handle is not measured): P's halves.
		await overPage(edytor, -10, 6);
		expect([position(), indicated()]).toEqual(['before', 'P']);
		await overPage(edytor, -45, 18);
		expect([position(), indicated()]).toEqual(['after', 'P']);
		// Past it, the page margin: left of P.
		const drop = await overPage(edytor, -60, 12);
		expect([position(), indicated()]).toEqual(['left', 'P']);
		expect(bar()).toEqual({ left: -2, top: 0, width: 4, height: 24 });
		await drop();
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', ['X']],
					['column', ['P']]
				]
			],
			C,
			'Z'
		]);
	});

	it('in the handle column a block reaching into it hands the pointer to the page: no placement held from it (round 3)', async () => {
		const { edytor } = await render([
			p('P1'),
			p('L1', 'l1', [p('L1a')]),
			...contractDoc().slice(1)
		]);
		const drag = await startDrag(edytor, 'P1');
		// L1's element reaches 20px into the handle column (a list marker).
		const l1 = block(edytor, 'L1').node!;
		const own = l1.getBoundingClientRect();
		l1.getBoundingClientRect = () => new DOMRect(-20, own.top, own.width + 20, own.height);
		const l1a = rectOf(edytor, 'L1a');
		await overPage(edytor, -12, l1a.top + 6, l1);
		expect([position(), indicated()]).toEqual(['before', 'L1a']);
		// Down to the layout's row, the pointer off L1: A's row, not a held "before L1a".
		const a = rectOf(edytor, 'A');
		const drop = await overPage(edytor, -12, a.top + 18);
		expect([position(), indicated()]).toEqual(['after', 'A']);
		await drop();
		expect(shape(edytor)).toEqual([
			['L1', ['L1a']],
			[
				'columns',
				[
					['column', ['A', 'P1', 'A2']],
					['column', ['B']]
				]
			],
			'Z'
		]);
	});

	it("in the handle column a list's first item offers no inside: before or after only (round 3)", async () => {
		const { edytor } = await render([p('P'), list('L', 'i1', 'i2'), p('X')]);
		const drag = await startDrag(edytor, 'X');
		const i1 = rectOf(edytor, 'i1');
		for (const y of [i1.top + 6, i1.top + 18]) {
			await overPage(edytor, -10, y, block(edytor, 'i1').node!);
			expect(position()).not.toBe('inside');
		}
		// In the text, the hitbox's own placements stand (inside as a fallback there).
		await drag.over('i1', 0.75, 10);
		expect(position()).toBe('inside');
	});

	it('a nested row has no left band: the pointer still picks the level (reparent-by-x)', async () => {
		const { edytor } = await render([p('P', 'p', [p('P1')]), p('X')]);
		const drag = await startDrag(edytor, 'X');
		// P1 starts 24px in; 20px left of it is 4px right of P's text column.
		await drag.over('P1', 0.75, -20);
		expect(position()).toBe('after');
		expect(indicated()).toBe('P');
	});

	it("beside a column's block: the bar spans the layout, at the gap or the layout's edge", async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X');
		const c = rectOf(edytor, 'C');
		// B, in the last column: its right is the layout's right edge.
		await drag.over('B', 0.5, 270);
		expect([position(), indicated()]).toEqual(['right', 'B']);
		expect(bar()).toEqual({ left: 598, top: c.top, width: 4, height: c.height });
		// A2's right, in the first column: the middle of the gap (277 + 23).
		await drag.over('A2', 0.5, 270);
		expect([position(), indicated()]).toEqual(['right', 'A2']);
		expect(bar()).toEqual({ left: 298, top: c.top, width: 4, height: c.height });
		// B's left: the same gap.
		await drag.over('B', 0.5, -10);
		expect([position(), indicated()]).toEqual(['left', 'B']);
		expect(bar()).toEqual({ left: 298, top: c.top, width: 4, height: c.height });
		// A's left, in the first column: the editor's handle column, a reorder (R2),
		// the page target's even over A's element (round 3).
		await overPage(edytor, -10, rectOf(edytor, 'A').top + 12, block(edytor, 'A').node!);
		expect([position(), indicated()]).toEqual(['after', 'A']);
		// Past the handle column, the page margin: the layout's left edge.
		const a = rectOf(edytor, 'A');
		const drop = await overPage(edytor, -60, a.top + 12);
		expect([position(), indicated()]).toEqual(['left', 'A']);
		expect(bar()).toEqual({ left: -2, top: c.top, width: 4, height: c.height });
		await drop();
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', ['X']],
					['column', ['A', 'A2']],
					['column', ['B']]
				]
			],
			'Z'
		]);
	});

	it('the gap between two columns: a new column between them', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X');
		const c = rectOf(edytor, 'C');
		await drag.overAt('C', 300, c.top + 30);
		expect([position(), indicated()]).toEqual(['right', 'K1']);
		expect(bar()).toEqual({ left: 298, top: c.top, width: 4, height: c.height });
		await drag.dropAt('C', 300, c.top + 30);
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', ['A', 'A2']],
					['column', ['X']],
					['column', ['B']]
				]
			],
			'Z'
		]);
		expect(selected(edytor)).toEqual(['X']);
	});

	it('over a layout, the row is the block of the column under the pointer (rowAt skips the others)', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X');
		const b = rectOf(edytor, 'B');
		// Column 1's second row (A2) starts below the pointer: column 2 is still measured.
		await drag.overAt('C', 400, b.top + 2);
		expect([position(), indicated()]).toEqual(['before', 'B']);
		await drag.dropAt('C', 400, b.top + 2);
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', ['A', 'A2']],
					['column', ['X', 'B']]
				]
			],
			'Z'
		]);
	});

	it('dragging the only block of a column beside a root block dissolves the layout it leaves', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'B');
		await drag.over('P', 0.5, 590);
		expect(position()).toBe('right');
		await drag.drop('P', 0.5, 590);
		expect(shape(edytor)).toEqual([
			[
				'columns',
				[
					['column', ['P']],
					['column', ['B']]
				]
			],
			'A',
			'A2',
			'Z',
			'X'
		]);
	});

	it('beside a list item: the bar spans the list, the layout wraps it', async () => {
		const { edytor } = await render([p('P'), list('L', 'i1', 'i2'), p('X')]);
		const drag = await startDrag(edytor, 'X');
		const l = rectOf(edytor, 'L');
		await drag.over('i1', 0.5, 590);
		expect([position(), indicated()]).toEqual(['right', 'i1']);
		expect(bar()).toEqual({ left: 598, top: l.top, width: 4, height: l.height });
		await drag.drop('i1', 0.5, 590);
		expect(shape(edytor)).toEqual([
			'P',
			[
				'columns',
				[
					['column', [['L', ['i1', 'i2']]]],
					['column', ['X']]
				]
			]
		]);
	});

	it('a refused band shows nothing: a whole layout dragged beside a root block (D2)', async () => {
		const { edytor } = await render(withX());
		edytor.selection.selectBlocks(block(edytor, 'A'), block(edytor, 'A2'), block(edytor, 'B'));
		const drag = await startDrag(edytor, 'B');
		await drag.over('X', 0.25, 300);
		expect([position(), indicated()]).toEqual(['before', 'X']);
		await drag.over('X', 0.25, 590);
		expect(indicator()).toBeNull();
		expect(document.querySelector('[data-edytor-block-drop-position]')).toBeNull();
		await drag.drop('X', 0.25, 590);
		expect(shape(edytor)).toEqual(['P', C, 'Z', 'X']);
	});

	it('no band when the layout would stack (under 480px wide)', async () => {
		const { edytor } = await render(withX());
		const drag = await startDrag(edytor, 'X', { width: 400 });
		await drag.over('P', 0.25, 390);
		expect(position()).toBe('before');
		await drag.over('B', 0.25, 170);
		expect(position()).toBe('before');
		// The handle column, the page target's (round 3): a reorder.
		await overPage(edytor, -10, 6, block(edytor, 'P').node!);
		expect(position()).toBe('before');
	});

	it('no band without a layout kind', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [blockHandlesPlugin, richTextPlugin],
				value: { children: [p('P'), p('Q'), p('X')] }
			}
		);
		const drag = await startDrag(edytor, 'X');
		await drag.over('P', 0.25, 590);
		expect(position()).toBe('before');
		// The handle column, the page target's (round 3): a reorder.
		await overPage(edytor, -10, 6, block(edytor, 'P').node!);
		expect(position()).toBe('before');
	});

	it('a sticky target never holds the pointer over another column', async () => {
		const { edytor } = await render(withX());
		// Columns 10px apart: column 1's 20px slop reaches into column 2.
		const drag = await startDrag(edytor, 'X', { gap: 10 });
		await drag.over('A', 0.25, 100);
		expect([position(), indicated()]).toEqual(['before', 'A']);
		const b = rectOf(edytor, 'B');
		expect(b.left).toBe(305);
		await drag.overAt('C', 310, b.top + 2);
		expect([position(), indicated()]).toEqual(['before', 'B']);
	});
});

describe('the drag preview', () => {
	it("clones a column's block at its own width, a root block at the root's", async () => {
		const { edytor } = await render(withX());
		const ghostWidth = async (source: string) => {
			await flushDomUpdates();
			layout();
			dragImage = null;
			const grip = document.querySelector<HTMLElement>(
				`[data-testid="block-handle"][data-block-id="${source}"]`
			)!;
			const from = rectOf(edytor, source);
			fire(grip, 'dragstart', { clientX: from.left - 12, clientY: from.top + 12 });
			await frame();
			const image = (dragImage as HTMLElement | null)?.querySelector<HTMLElement>(
				'[data-edytor-drag-preview]'
			);
			fire(block(edytor, source).node!, 'drop', {
				clientX: from.left + 100,
				clientY: from.top + 1
			});
			await flushDomUpdates();
			await frame();
			return (image?.firstElementChild as HTMLElement | null)?.style.width;
		};
		// Column 2 is (600 - 46) / 2 = 277px wide, scaled by 0.8.
		expect(await ghostWidth('B')).toBe(`${277 * 0.8}px`);
		expect(await ghostWidth('X')).toBe(`${600 * 0.8}px`);
	});
});
