/** @jsxImportSource ../../jsx */
/**
 * The table's chrome over a laid-out grid (jsdom has no layout: the
 * table's box, its grid and its rows are given their rects here): a
 * column's resize stays inside the room at the table's place
 * (`table.width.fit`), a table wider than its place shows its chrome over
 * its visible part only (`table.overflow`), and rows and columns drag by
 * their grips through the real drag library (Pragmatic drag and drop's
 * native events, `table.drag`). Expected states are written from the
 * contract rows and Notion.
 *
 * `P "p", T{c1, c2}[R1[A "a", B "b"], R2[C "c", D "d"]], Z "z"`, the grid at
 * the layer's origin: columns of 120px, rows of 30px under a 1px border.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROW = 30;

const p = (id: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text: id }] });
const cell = (id: string, column: string): JSONBlock => ({
	id,
	type: 'tableCell',
	data: { column },
	content: [{ text: id.toLowerCase() }]
});
const row = (id: string, ...cells: JSONBlock[]): JSONBlock => ({
	id,
	type: 'tableRow',
	children: cells
});
const contract = (widths: (number | undefined)[] = [undefined, undefined]): JSONBlock[] => [
	p('P'),
	{
		id: 'T',
		type: 'table',
		data: {
			columns: ['c1', 'c2'].map((id, i): Record<string, string | number> => {
				const width = widths[i];
				return width ? { id, width } : { id };
			})
		},
		children: [
			row('R1', cell('A', 'c1'), cell('B', 'c2')),
			row('R2', cell('C', 'c1'), cell('D', 'c2'))
		]
	},
	p('Z')
];

const render = (children: JSONBlock[] = contract()) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [tablePlugin, richTextPlugin], value: { children }, autoSelectFixture: false }
	);

const grid = (edytor: Edytor) =>
	edytor.facade.tableGrid('T')?.rows.map((r) => r.cells.map((c) => edytor.facade.blockText(c!)));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-edytor-id="${id}"]`)!;
const layer = () => document.querySelector<HTMLElement>('[data-edytor-table-chrome][role]')!;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const rect = (element: Element, box: DOMRect) => (element.getBoundingClientRect = () => box);

/**
 * Lay the table out: its box (and its scroller) `room` wide at x 0, the grid
 * scrolled `scrolled` px, its columns' widths those of its template.
 */
const lay = (room: number, scrolled = 0) => {
	const table = node('T');
	const scroller = table.querySelector<HTMLElement>('[data-edytor-table-scroll]')!;
	const gridNode = table.querySelector<HTMLElement>('[data-edytor-table-grid]')!;
	const widths = gridNode.style.gridTemplateColumns.split(' ').map((w) => Number.parseFloat(w));
	const width = 1 + widths.reduce((sum, w) => sum + w, 0);
	const rows = [...table.querySelectorAll<HTMLElement>('[data-edytor-table-row]')];
	const height = 1 + rows.length * ROW;
	rect(table, new DOMRect(0, 0, room, height + 22));
	rect(scroller, new DOMRect(0, 0, room, height + 22));
	Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: room });
	rect(gridNode, new DOMRect(-scrolled, 0, width, height));
	rows.forEach((r, i) => rect(r, new DOMRect(-scrolled, 1 + i * ROW, width, ROW)));
};

/** The pointer over cell `id`, the overlay measured. */
const hover = async (edytor: Edytor, id: string, room = 600, scrolled = 0) => {
	await flushDomUpdates();
	lay(room, scrolled);
	node(id).dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
	edytor.overlay.invalidate();
	await flushDomUpdates();
	await frame();
	await flushDomUpdates();
};

const key = async (band: number, k: string, shiftKey = false) => {
	const element = document.querySelector<HTMLElement>(`[data-edytor-table-resize="${band}"]`)!;
	element.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
	await flushDomUpdates();
};
const widths = (edytor: Edytor) =>
	(edytor.facade.blockDataOf('T')!.columns as { id: string; width?: number }[]).map(
		(c) => c.width ?? null
	);

describe('table.width.fit — a resize keeps the table inside its place', () => {
	it('the arrow keys widen a column up to what the other columns leave, no further', async () => {
		const { edytor } = await render();
		// 250px of room (jsdom draws no border): two columns of 120px leave 130px to the second.
		await hover(edytor, 'B', 250);
		await key(1, 'ArrowRight');
		expect(widths(edytor)).toEqual([null, 128]);
		await key(1, 'ArrowRight');
		expect(widths(edytor)).toEqual([null, 130]);
		const version = edytor.facade.version;
		await key(1, 'ArrowRight');
		await key(1, 'ArrowRight', true);
		expect(widths(edytor)).toEqual([null, 130]);
		expect(edytor.facade.version).toBe(version);
		// The first column has no room left: it narrows, it does not grow.
		await hover(edytor, 'A', 250);
		await key(0, 'ArrowRight', true);
		expect(widths(edytor)).toEqual([null, 130]);
		await key(0, 'ArrowLeft');
		expect(widths(edytor)).toEqual([112, 130]);
	});

	it('a band’s drag previews and writes the same clamped width', async () => {
		const { edytor } = await render();
		await hover(edytor, 'B', 250);
		const band = document.querySelector<HTMLElement>('[data-edytor-table-resize="1"]')!;
		const gridNode = node('T').querySelector<HTMLElement>('[data-edytor-table-grid]')!;
		band.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 240, button: 0 }));
		document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 900 }));
		await flushDomUpdates();
		expect(gridNode.style.gridTemplateColumns).toBe('120px 130px');
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 900 }));
		await flushDomUpdates();
		expect(widths(edytor)).toEqual([null, 130]);
		expect(gridNode.style.gridTemplateColumns).toBe('120px 130px');
	});

	it('with nothing laid out, no room limits it', async () => {
		const { edytor } = await render();
		await hover(edytor, 'B', 0);
		await key(1, 'ArrowRight', true);
		await key(1, 'ArrowRight', true);
		expect(widths(edytor)).toEqual([null, 184]);
	});
});

describe('table.overflow — a table wider than its place scrolls in its own box', () => {
	it('a column narrows and none grows; the chrome shows over the visible part only', async () => {
		const { edytor } = await render(contract([200, 200]));
		await hover(edytor, 'A', 250);
		const shown = () =>
			[...layer().querySelectorAll<HTMLElement>('[data-edytor-table-resize]')].map(
				(band) => band.dataset.edytorTableResize
			);
		// The second column's edge (x 401) is past the box: its band does not show, nor the `+`.
		expect(shown()).toEqual(['0']);
		expect(layer().querySelector('[data-edytor-table-add="column"]')).toBeNull();
		expect(layer().querySelector('[data-edytor-table-add="row"]')).not.toBeNull();
		const version = edytor.facade.version;
		await key(0, 'ArrowRight');
		expect(edytor.facade.version).toBe(version);
		await key(0, 'ArrowLeft');
		expect(widths(edytor)).toEqual([192, 200]);
		// Scrolled to its end: the last column's edge is in view, its band and the `+` show.
		await hover(edytor, 'B', 250, 142);
		expect(shown()).toEqual(['0', '1']);
		expect(layer().querySelector('[data-edytor-table-add="column"]')).not.toBeNull();
	});

	it('a column’s grip shows only while its column’s middle is in view', async () => {
		const { edytor } = await render(contract([200, 200]));
		await hover(edytor, 'B', 250);
		expect(layer().querySelector('[data-edytor-table-grip="column"]')).toBeNull();
		await hover(edytor, 'A', 250);
		expect(layer().querySelector('[data-edytor-table-grip="column"]')).not.toBeNull();
	});
});

/** A native drag event carrying a data transfer (the drag library reads and writes it). */
const fire = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) => {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
	const store: Record<string, string> = {};
	Object.defineProperty(event, 'dataTransfer', {
		value: {
			setData: (k: string, value: string) => (store[k] = value),
			getData: (k: string) => store[k] ?? '',
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

type Moved = { indicator: { kind: string; gap: string } | null; ghost: string | null };
let dragImage: HTMLElement | null = null;

/**
 * Drag the `kind` grip of the hovered `from` cell over cell `over` at
 * (`x`, `y`), then drop (`end`: `drop`), cancel (`dragend` alone) or drop on
 * the page outside the table (`outside`).
 */
const drag = async (
	edytor: Edytor,
	kind: 'row' | 'column',
	from: string,
	over: string,
	at: { clientX: number; clientY: number },
	end: 'drop' | 'cancel' = 'drop'
): Promise<Moved> => {
	await hover(edytor, from);
	const grip = layer().querySelector<HTMLElement>(`[data-edytor-table-grip="${kind}"]`)!;
	expect(grip.getAttribute('draggable')).toBe('true');
	dragImage = null;
	fire(grip, 'dragstart');
	await frame();
	lay(600);
	const target = over === 'body' ? document.body : node(over);
	fire(target, 'dragenter', at);
	fire(target, 'dragover', at);
	edytor.overlay.invalidate();
	await frame();
	await flushDomUpdates();
	const line = layer().querySelector<HTMLElement>('[data-edytor-table-drop]');
	const indicator = line ? { kind: line.dataset.edytorTableDrop!, gap: line.dataset.gap! } : null;
	if (end === 'drop') fire(target, 'drop', at);
	else fire(grip.isConnected ? grip : document.body, 'dragend', at);
	await flushDomUpdates();
	await frame();
	await flushDomUpdates();
	// Set by the data transfer's `setDragImage`, which the drag library calls.
	const recorded = dragImage as HTMLElement | null;
	const ghost = recorded?.querySelector('[data-edytor-table-drag-preview]')?.textContent ?? null;
	return { indicator, ghost };
};

describe('table.drag — rows and columns drag by their grips', () => {
	it('a row dropped below the last row moves there; the caret stays in its cell; one undo', async () => {
		const { edytor } = await render();
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('A')!.firstText!, 1);
		await flushDomUpdates();
		// The lower half of the last row: the line under it.
		const { indicator, ghost } = await drag(edytor, 'row', 'A', 'D', {
			clientX: 180,
			clientY: 1 + ROW + 25
		});
		expect(indicator).toEqual({ kind: 'row', gap: '2' });
		// The ghost: the row's cells, side by side.
		expect(ghost).toBe('ab');
		expect(grid(edytor)).toEqual([
			['c', 'd'],
			['a', 'b']
		]);
		const { startBlock, yStart } = edytor.selection.state;
		expect([startBlock?.id, yStart]).toEqual(['A', 1]);
		expect(layer().querySelector('[data-edytor-table-drop]')).toBeNull();
		edytor.historyUndo();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('a column dropped left of the first column moves there; its cells follow it', async () => {
		const { edytor } = await render();
		const { indicator, ghost } = await drag(edytor, 'column', 'B', 'A', {
			clientX: 20,
			clientY: 10
		});
		expect(indicator).toEqual({ kind: 'column', gap: '0' });
		// The ghost: the column's cells, one under the other.
		expect(ghost).toBe('bd');
		expect(grid(edytor)).toEqual([
			['b', 'a'],
			['d', 'c']
		]);
		expect(edytor.facade.tableGrid('T')!.columns).toEqual(['c2', 'c1']);
		expect(node('B').dataset.edytorColumn).toBe('0');
		expect(node('A').dataset.edytorColumn).toBe('1');
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.facade.tableGrid('T')!.columns).toEqual(['c1', 'c2']);
	});

	it('at its own place, outside the table, or cancelled: no line and nothing written', async () => {
		const { edytor } = await render();
		const version = edytor.facade.version;
		// The upper half of the second row: the line between the rows, right under R1.
		const own = await drag(edytor, 'row', 'A', 'C', { clientX: 60, clientY: 1 + ROW + 5 });
		expect(own.indicator).toBeNull();
		const ownColumn = await drag(edytor, 'column', 'B', 'B', { clientX: 230, clientY: 10 });
		expect(ownColumn.indicator).toBeNull();
		// Past the 32px gutter right of the table's box.
		const outside = await drag(edytor, 'row', 'A', 'body', { clientX: 700, clientY: 40 });
		expect(outside.indicator).toBeNull();
		const cancelled = await drag(
			edytor,
			'row',
			'A',
			'D',
			{ clientX: 180, clientY: 1 + ROW + 25 },
			'cancel'
		);
		expect(cancelled.indicator).toEqual({ kind: 'row', gap: '2' });
		expect(layer().querySelector('[data-edytor-table-drop]')).toBeNull();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(edytor.facade.version).toBe(version);
	});

	it('a click with no drag still opens the grip’s menu', async () => {
		const { edytor } = await render();
		await hover(edytor, 'B');
		const grip = layer().querySelector<HTMLButtonElement>('[data-edytor-table-grip="column"]')!;
		expect(grip.getAttribute('draggable')).toBe('true');
		grip.click();
		await flushDomUpdates();
		expect(layer().querySelector('[data-edytor-table-menu="column"]')).not.toBeNull();
	});

	it('a readonly view shows no grip: nothing drags', async () => {
		const { edytor } = await render();
		edytor.readonly = true;
		await hover(edytor, 'A');
		expect(layer()?.querySelector('[draggable="true"]') ?? null).toBeNull();
	});
});
