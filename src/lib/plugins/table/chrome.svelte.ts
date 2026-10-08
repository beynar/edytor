import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { isLonePress, takeKeys } from '$lib/events/onFocus.js';
import type { TableLabels } from '$lib/labels.js';
import {
	caretCell,
	deleteColumn,
	deleteRows,
	gridOf,
	insertColumn,
	insertRow,
	moveColumn,
	moveRows,
	widthOf
} from './table.js';

/** A table's grid box and its rows and columns, layer-relative. */
export type TableLayout = {
	table: string;
	left: number;
	top: number;
	width: number;
	height: number;
	rows: { id: string; top: number; height: number }[];
	/** By position: the column id, its left edge and width. */
	columns: { id: string; left: number; width: number }[];
};

/** A column resize in progress: where the pointer went down, where it is, the width it started at. */
type Drag = { table: string; column: number; from: number; at: number; width: number };

/** What a grip's menu acts on. */
export type TableMenu =
	| { kind: 'row'; table: string; row: string }
	| { kind: 'column'; table: string; column: number };

/** A row of a grip's menu. */
export type TableMenuRow = {
	id: string;
	label: string;
	icon: string;
	danger?: boolean;
	isEnabled: () => boolean;
	run: () => unknown;
};

/**
 * The table's chrome (`table.*`), in the overlay: while the pointer is over
 * a table of an editable view, a `+` under it (a row at its end) and one
 * beside it (a column at its end), a grip left of the hovered row and one
 * above the hovered column, each opening its menu (insert, move, delete),
 * and a resize band on each column's right edge. Positions are read in the
 * overlay's measure, once per frame. A resize drags a view-only preview
 * width (`width`), which the table's grid reads; the release writes the
 * column's `data.columns[i].width` (one command, one undo step), Escape
 * drops the preview. Every action is a table command (`table.ts`): refused
 * when the view is readonly.
 */
export class TableChrome {
	/** The table, row and column under the pointer. */
	hovered = $state<{ table: string; row: string | null; column: number | null } | null>(null);
	/** The grip menu open. */
	menu = $state<TableMenu | null>(null);
	/** The measured table the chrome is for. */
	layout = $state.raw<TableLayout | null>(null);
	/** A block drag is in progress: no chrome takes the pointer. */
	dragging = $state(false);
	/** The column resize in progress. */
	drag = $state<Drag | null>(null);
	/**
	 * The cell the caret was last in: the row and column the block menu's
	 * actions on its table act on. A block selection (the grip that opens
	 * the menu) keeps it; a caret outside every table clears it.
	 */
	cell: string | null = null;

	constructor(
		readonly edytor: Edytor,
		readonly labels: TableLabels,
		/** A column's width when it sets none, and the narrowest a resize leaves. */
		readonly columnWidth: number,
		readonly minColumnWidth: number
	) {}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.edytor.readonly;
	}

	/** A text selection is in progress: the chrome takes no pointer. */
	get selecting() {
		return this.drag === null && this.edytor.selection.dragging;
	}

	/** The table the chrome is for: the one a band drags, a menu is open on, or under the pointer. */
	get table(): string | null {
		return this.drag?.table ?? this.menu?.table ?? this.hovered?.table ?? null;
	}

	/** The selection changed: a caret in a cell is the one the block menu acts on. */
	track = () => {
		if (this.edytor.selection.value.kind !== 'text') return;
		this.cell = caretCell(this.edytor)?.id ?? null;
	};

	/** Whether the chrome shows. */
	get shown() {
		return this.drag !== null || (!this.readonly && !this.dragging && this.table !== null);
	}

	/** The block of table `id`, if it is still a shown table. */
	block = (id: string | null | undefined): Block | null => {
		const block = id ? this.edytor.idToBlock.get(id) : undefined;
		return block?.isInTree && this.edytor.facade.isTable(block.id) ? block : null;
	};

	/**
	 * The width column `index` of `table` shows (its `data.columns` entry, the
	 * resize preview while a band drags it): what the grid's template reads.
	 */
	width = (table: string, index: number, column: unknown): number => {
		const drag = this.drag;
		if (drag && drag.table === table && drag.column === index) return this.dragWidth(drag);
		return widthOf(column, this.columnWidth);
	};

	private dragWidth = (drag: Drag) =>
		Math.max(this.minColumnWidth, Math.round(drag.width + drag.at - drag.from));

	/** The pointer is over `target`: the table, row and column holding it (the innermost table). */
	hover = (target: EventTarget | null) => {
		const element = target instanceof Element ? target : null;
		const cell = element?.closest<HTMLElement>('[data-edytor-table-cell], [data-edytor-table-pad]');
		const tableNode = element?.closest<HTMLElement>('[data-edytor-table]');
		const table = tableNode?.dataset.edytorId ?? null;
		let next: TableChrome['hovered'] = null;
		if (table && this.block(table)) {
			const rowNode = cell?.closest<HTMLElement>('[data-edytor-table-row]');
			const row = rowNode?.dataset.edytorId ?? null;
			const column = cell ? Number(cell.dataset.edytorColumn) : NaN;
			next = { table, row, column: Number.isInteger(column) ? column : null };
		}
		const was = this.hovered;
		if (was?.table === next?.table && was?.row === next?.row && was?.column === next?.column)
			return;
		// Over the chrome (a grip, the `+`), the row and column it is for stay.
		if (next === null && this.menu) return;
		this.hovered = next;
		this.edytor.overlay.invalidate();
	};

	/** The pointer left for `to`: the chrome stays while it is over the editor or the overlay. */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		const { edytor } = this;
		if (node && (edytor.overlay.layer?.contains(node) || edytor.node?.contains(node))) return;
		if (!this.menu && !this.drag) this.hovered = null;
		edytor.overlay.invalidate();
	};

	/** The overlay measure: the shown table's grid, rows and columns. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const layout = this.shown ? this.read(origin) : null;
		return () => {
			Object.assign(host.style, { position: 'absolute', left: '0px', top: '0px' });
			if (!sameLayout(layout, this.layout)) this.layout = layout;
		};
	};

	private read(origin: DOMRect): TableLayout | null {
		const table = this.block(this.table);
		const grid = table?.node?.querySelector<HTMLElement>('[data-edytor-table-grid]');
		const columns = gridOf(table)?.columns;
		if (!table || !grid?.isConnected || !columns) return null;
		const box = grid.getBoundingClientRect();
		const widths = (
			grid.ownerDocument.defaultView?.getComputedStyle(grid).gridTemplateColumns ?? ''
		)
			.split(/\s+/)
			.map((w) => Number.parseFloat(w))
			.filter((w) => Number.isFinite(w));
		let x = box.left - origin.left;
		const cols = columns.map((id, i) => {
			const width = widths[i] ?? this.columnWidth;
			const col = { id, left: x, width };
			x += width;
			return col;
		});
		const rows = table.children.flatMap((row) => {
			const rect = row.node?.getBoundingClientRect();
			return rect ? [{ id: row.id, top: rect.top - origin.top, height: rect.height }] : [];
		});
		return {
			table: table.id,
			left: box.left - origin.left,
			top: box.top - origin.top,
			width: Math.min(box.width, x - (box.left - origin.left)) || box.width,
			height: box.height,
			rows,
			columns: cols
		};
	}

	/** Open the menu of a row's or a column's grip (a second press on it closes it). */
	open = (menu: TableMenu) => {
		const same =
			this.menu?.kind === menu.kind &&
			this.menu.table === menu.table &&
			(menu.kind === 'row'
				? (this.menu as { row: string }).row === menu.row
				: (this.menu as { column: number }).column === menu.column);
		this.menu = same ? null : menu;
		this.edytor.overlay.invalidate();
	};

	/** Close the menu; the editor takes the keys back. */
	close = () => {
		this.menu = null;
		this.edytor.overlay.invalidate();
		takeKeys(this.edytor);
	};

	/** The rows of the open menu. */
	get rows(): TableMenuRow[] {
		const menu = this.menu;
		const table = this.block(menu?.table);
		const grid = gridOf(table);
		if (!menu || !table || !grid) return [];
		const { labels } = this;
		if (menu.kind === 'row') {
			const index = grid.rows.findIndex((r) => r.id === menu.row);
			const row = this.edytor.idToBlock.get(menu.row);
			if (index < 0 || !row) return [];
			const last = grid.rows.length - 1;
			return [
				{
					id: 'insert-above',
					label: labels.insertAbove,
					icon: 'action.up',
					isEnabled: () => true,
					run: () => insertRow(table, index, true)
				},
				{
					id: 'insert-below',
					label: labels.insertBelow,
					icon: 'action.down',
					isEnabled: () => true,
					run: () => insertRow(table, index + 1, true)
				},
				{
					id: 'move-up',
					label: labels.moveUp,
					icon: 'action.up',
					isEnabled: () => index > 0,
					run: () => moveRows(table, [row], index - 1)
				},
				{
					id: 'move-down',
					label: labels.moveDown,
					icon: 'action.down',
					isEnabled: () => index < last,
					run: () => moveRows(table, [row], index + 1)
				},
				{
					id: 'delete-row',
					label: labels.deleteRow,
					icon: 'action.delete',
					danger: true,
					isEnabled: () => true,
					run: () => deleteRows(table, [row])
				}
			];
		}
		const index = menu.column;
		const column = grid.columns[index];
		if (column === undefined) return [];
		const last = grid.columns.length - 1;
		return [
			{
				id: 'insert-left',
				label: labels.insertLeft,
				icon: 'table.left',
				isEnabled: () => true,
				run: () => insertColumn(table, index)
			},
			{
				id: 'insert-right',
				label: labels.insertRight,
				icon: 'table.right',
				isEnabled: () => true,
				run: () => insertColumn(table, index + 1)
			},
			{
				id: 'move-left',
				label: labels.moveLeft,
				icon: 'table.left',
				isEnabled: () => index > 0,
				run: () => moveColumn(table, index, index - 1)
			},
			{
				id: 'move-right',
				label: labels.moveRight,
				icon: 'table.right',
				isEnabled: () => index < last,
				run: () => moveColumn(table, index, index + 1)
			},
			{
				id: 'delete-column',
				label: labels.deleteColumn,
				icon: 'action.delete',
				danger: true,
				isEnabled: () => true,
				run: () => deleteColumn(table, index)
			}
		];
	}

	/** Run a menu row, then close the menu. */
	runRow = (row: TableMenuRow) => {
		if (!row.isEnabled()) return;
		this.menu = null;
		this.hovered = null;
		takeKeys(this.edytor);
		row.run();
		this.edytor.overlay.invalidate();
	};

	/** The `+` under the table: a row at its end, the caret in its first cell. */
	addRow = () => {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return;
		takeKeys(this.edytor);
		insertRow(table, grid.rows.length, true);
	};

	/** The `+` beside the table: a column at its end. */
	addColumn = () => {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return;
		takeKeys(this.edytor);
		insertColumn(table, grid.columns.length);
	};

	/** A `mousedown` on a band: no native selection; the press itself when no `pointerdown` came. */
	mousedown = (event: MouseEvent, column: number) => {
		event.preventDefault();
		if (isLonePress(this.edytor, event)) this.start(event, column);
	};

	/**
	 * Press on column `column`'s band: the drag starts; the preview follows
	 * the pointer and the release writes the width (`release`); Escape, a
	 * cancel or the view turning readonly drop the preview, nothing written.
	 */
	start = (event: PointerEvent | MouseEvent, column: number) => {
		const { edytor } = this;
		const layout = this.layout;
		if (event.button !== 0 || edytor.readonly || this.drag || !layout) return;
		const col = layout.columns[column];
		if (!col) return;
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement | null;
		const pointer = event.type === 'pointerdown';
		if (pointer) target?.setPointerCapture?.((event as PointerEvent).pointerId);
		this.drag = {
			table: layout.table,
			column,
			from: event.clientX,
			at: event.clientX,
			width: col.width
		};
		const document = target?.ownerDocument ?? edytor.node?.ownerDocument;
		const tracked = pointer ? document : document?.defaultView;
		const [moves, ups] = pointer ? ['pointermove', 'pointerup'] : ['mousemove', 'mouseup'];
		const move = (moved: MouseEvent) => {
			if (!this.drag) return;
			if (!edytor.dispatcher.permits()) return end(moved);
			this.drag.at = moved.clientX;
			edytor.overlay.invalidate();
		};
		const end = (ended: Event) => {
			tracked?.removeEventListener(moves, move as EventListener);
			tracked?.removeEventListener(ups, end);
			tracked?.removeEventListener('pointercancel', end);
			document?.removeEventListener('keydown', escape, true);
			const drag = this.drag;
			if (drag && ended.type === ups) {
				drag.at = (ended as MouseEvent).clientX;
				this.release(drag);
				takeKeys(edytor);
			}
			this.drag = null;
			edytor.overlay.invalidate();
		};
		const escape = (key: KeyboardEvent) => {
			if (key.key !== 'Escape') return;
			key.preventDefault();
			key.stopPropagation();
			end(key);
		};
		this.#cancel = () => end(new Event('cancel'));
		tracked?.addEventListener(moves, move as EventListener);
		tracked?.addEventListener(ups, end);
		if (pointer) tracked?.addEventListener('pointercancel', end);
		document?.addEventListener('keydown', escape, true);
		edytor.overlay.invalidate();
	};
	#cancel: (() => void) | null = null;

	/** The view turned readonly mid-drag: the preview goes, nothing written. */
	lock = () => {
		if (this.drag && !this.edytor.dispatcher.permits()) this.#cancel?.();
	};

	/**
	 * A key on a focused band: ArrowRight/ArrowLeft widen or narrow the
	 * column by 8px (Shift: 32px); each press is one width write.
	 */
	key = (event: KeyboardEvent, column: number) => {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			return takeKeys(this.edytor);
		}
		const step = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[event.key];
		if (step === undefined) return;
		event.preventDefault();
		const layout = this.layout;
		const col = layout?.columns[column];
		if (!layout || !col || this.drag) return;
		const by = step * (event.shiftKey ? 32 : 8);
		this.release({ table: layout.table, column, from: 0, at: by, width: col.width });
	};

	/**
	 * The release: column `drag.column`'s width, one command; nothing when it
	 * did not change, or when the table does not list the column. The width
	 * is written on the column's entry by its item id (the first entry
	 * naming it), never by position: the stored array may hold an entry the
	 * grid does not show.
	 */
	private release(drag: Drag) {
		const table = this.block(drag.table);
		const id = gridOf(table)?.columns[drag.column];
		if (!table || id === undefined) return;
		const { facade } = table.edytor;
		const stored = facade.blockDataOf(table.id)?.columns;
		const entries: unknown[] = Array.isArray(stored) ? stored : [];
		const at = entries.findIndex((c) => (c as { id?: unknown } | null)?.id === id);
		const item = at < 0 ? undefined : facade.dataItemIds(table.id, ['columns'])[at];
		if (item === undefined) return;
		const width = this.dragWidth(drag);
		if (width === widthOf(entries[at], this.columnWidth)) return;
		table.patchData({ ops: [{ path: ['columns', item, 'width'], value: width }] });
	}
}

const sameLayout = (a: TableLayout | null, b: TableLayout | null) =>
	a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
