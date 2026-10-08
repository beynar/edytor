import type { Block } from '$lib/block/block.svelte.js';
import { autoScrollFor } from '$lib/dnd/autoScroll.js';
import {
	draggable,
	dropTargetForElements,
	setCustomNativeDragPreview
} from '$lib/dnd/pragmatic.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { EDYTOR_BLOCK_DRAG_MIME } from '$lib/events/onDrop.js';
import { isLonePress, takeKeys } from '$lib/events/onFocus.js';
import type { TableLabels } from '$lib/labels.js';
import { tablePreview } from './dragPreview.js';
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
	/**
	 * The part of the grid its box shows (`table.overflow`): the scroller's
	 * client box, horizontally; unbounded where nothing is laid out.
	 */
	view: { left: number; right: number };
	/**
	 * The widest the grid's columns may be together at the table's place
	 * (`table.width.fit`): the box's client width less the grid's border;
	 * `Infinity` where nothing is laid out.
	 */
	room: number;
};

/**
 * A column resize in progress: where the pointer went down, where it is, the
 * width it started at, and the widest the room leaves it (`table.width.fit`).
 */
type Drag = {
	table: string;
	column: number;
	from: number;
	at: number;
	width: number;
	max: number;
};

/**
 * A row's or a column's drag in progress (`table.drag`): its table, the row's
 * or the column's id, and the gap it would land in (`null`: nowhere, or its
 * own place), by position among the rows (columns), `0` before the first.
 */
export type TableMove = {
	kind: 'row' | 'column';
	table: string;
	id: string;
	gap: number | null;
};

/** The drag data key naming the chrome a row's or a column's drag is from. */
const MOVE = Symbol('edytor table move');
/** How far past the table's box a drag still aims at it (the grips stand outside it). */
const GUTTER = 32;

/** The resolved widths of `grid`'s columns, as laid out (none where nothing is). */
const trackWidths = (grid: HTMLElement): number[] =>
	(grid.ownerDocument.defaultView?.getComputedStyle(grid).gridTemplateColumns ?? '')
		.split(/\s+/)
		.map((w) => Number.parseFloat(w))
		.filter((w) => Number.isFinite(w));

/** A computed length in pixels, `0` when none. */
const px = (value: string | undefined) => Number.parseFloat(value ?? '') || 0;

type Point = { clientX: number; clientY: number };

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
	/** The row's or column's drag in progress (`table.drag`). */
	moving = $state<TableMove | null>(null);
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

	/**
	 * The table the chrome is for: the one a band drags or a grip moves, a
	 * menu is open on, or under the pointer.
	 */
	get table(): string | null {
		return (
			this.drag?.table ?? this.moving?.table ?? this.menu?.table ?? this.hovered?.table ?? null
		);
	}

	/** The row the row grip stands for: the open menu's, else the hovered one. */
	get gripRow(): string | null {
		return this.menu?.kind === 'row' ? this.menu.row : (this.hovered?.row ?? null);
	}

	/** The column (by position) the column grip stands for: the open menu's, else the hovered one. */
	get gripColumn(): number | null {
		return this.menu?.kind === 'column' ? this.menu.column : (this.hovered?.column ?? null);
	}

	/** The selection changed: a caret in a cell is the one the block menu acts on. */
	track = () => {
		if (this.edytor.selection.value.kind !== 'text') return;
		this.cell = caretCell(this.edytor)?.id ?? null;
	};

	/** Whether the chrome shows (on its table all through a band's or a grip's drag). */
	get shown() {
		return (
			this.drag !== null ||
			this.moving !== null ||
			(!this.readonly && !this.dragging && this.table !== null)
		);
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

	/** The resize's width: the pointer's, between the minimum and the room's (`table.width.fit`). */
	private dragWidth = (drag: Drag) =>
		Math.max(this.minColumnWidth, Math.min(drag.max, Math.round(drag.width + drag.at - drag.from)));

	/**
	 * The widths `table`'s grid shows, by position (its columns' stored
	 * widths, else the default one): what its template reads, the model's.
	 */
	private widthsOf(table: Block): number[] {
		const columns = gridOf(table)?.columns ?? [];
		const stored = table.edytor.facade.blockDataOf(table.id)?.columns;
		const entries: unknown[] = Array.isArray(stored) ? stored : [];
		return columns.map((id) =>
			widthOf(
				entries.find((c) => (c as { id?: unknown } | null)?.id === id),
				this.columnWidth
			)
		);
	}

	/**
	 * The widest column `column` of `table` may be (`table.width.fit`): what
	 * the room leaves after the other columns, never less than its width now
	 * (a table already wider than its place narrows, nothing grows).
	 */
	private widest(table: Block, column: number, room: number): number {
		const widths = this.widthsOf(table);
		const others = widths.reduce((sum, w, i) => (i === column ? sum : sum + w), 0);
		return Math.max(widths[column] ?? this.columnWidth, Math.floor(room - others));
	}

	/** The pointer is over `target`: the table, row and column holding it (the innermost table). */
	hover = (target: EventTarget | null) => {
		// A grip's drag keeps its row or column.
		if (this.moving) return;
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
		if (!this.menu && !this.drag && !this.moving) this.hovered = null;
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
		const widths = trackWidths(grid);
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
		// The box the grid scrolls in: its client box is what shows, and the room.
		const scroller = grid.closest<HTMLElement>('[data-edytor-table-scroll]') ?? grid.parentElement;
		const inner = scroller?.clientWidth ?? 0;
		const clip = inner > 0 ? scroller?.getBoundingClientRect() : undefined;
		const style = grid.ownerDocument.defaultView?.getComputedStyle(grid);
		const border = px(style?.borderLeftWidth) + px(style?.borderRightWidth);
		const left = clip ? clip.left + (scroller?.clientLeft ?? 0) - origin.left : 0;
		return {
			table: table.id,
			left: box.left - origin.left,
			top: box.top - origin.top,
			width: Math.min(box.width, x - (box.left - origin.left)) || box.width,
			height: box.height,
			rows,
			columns: cols,
			view: clip ? { left, right: left + inner } : { left: -Infinity, right: Infinity },
			room: clip ? inner - border : Infinity
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
		const table = this.block(layout.table);
		if (!table) return;
		this.drag = {
			table: layout.table,
			column,
			from: event.clientX,
			at: event.clientX,
			width: col.width,
			max: this.widest(table, column, layout.room)
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
	 * column by 8px (Shift: 32px) from its stored width, as far as the room
	 * leaves it (`table.width.fit`); each press is one width write.
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
		const table = this.block(layout?.table);
		if (!layout || !table || this.drag) return;
		const width = this.widthsOf(table)[column];
		if (width === undefined) return;
		const by = step * (event.shiftKey ? 32 : 8);
		const max = this.widest(table, column, layout.room);
		this.release({ table: layout.table, column, from: 0, at: by, width, max });
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

	/** What the row grip or the column grip stands for now: its table, the row's or column's id, its position. */
	private source(kind: TableMove['kind']) {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return null;
		if (kind === 'row') {
			const id = this.gripRow;
			const index = grid.rows.findIndex((r) => r.id === id);
			return id && index >= 0 ? { table, id, index } : null;
		}
		const index = this.gripColumn;
		const id = index === null ? undefined : grid.columns[index];
		return index === null || id === undefined ? null : { table, id, index };
	}

	/**
	 * Make `node` the `kind` grip's drag source (`table.drag`): in an
	 * editable view, dragging it moves its row or column within its table; a
	 * click with no drag is the grip's own (its menu). Answers the teardown.
	 */
	grip = (node: HTMLElement, kind: TableMove['kind']) => {
		const cleanup = draggable({
			element: node,
			canDrag: () =>
				!this.edytor.readonly && this.edytor.dispatcher.permits() && this.source(kind) !== null,
			getInitialData: () => ({ [MOVE]: this }),
			// The editor's own drag: no view takes it as a foreign drop.
			getInitialDataForExternal: () => {
				const source = this.source(kind);
				return { [EDYTOR_BLOCK_DRAG_MIME]: (kind === 'row' ? source?.id : source?.table.id) ?? '' };
			},
			onGenerateDragPreview: ({ nativeSetDragImage, location }) =>
				this.begin(kind, node, location.current.input, nativeSetDragImage),
			// The drag library tells the source before the drop target: the drop runs first.
			onDrop: () => queueMicrotask(() => this.finish())
		});
		return { destroy: cleanup };
	};

	/** The drop target and auto-scroll of the drag in progress, released when it ends. */
	#releases: (() => void)[] = [];

	/** The drag starts: what it moves, its ghost, the page as its drop target, auto-scroll. */
	private begin(
		kind: TableMove['kind'],
		node: HTMLElement,
		pointer: Point,
		nativeSetDragImage: DataTransfer['setDragImage'] | null
	) {
		const source = this.source(kind);
		if (!source) return;
		const { table } = source;
		this.menu = null;
		this.moving = { kind, table: table.id, id: source.id, gap: null };
		const preview = nativeSetDragImage ? this.preview(kind, source, pointer) : null;
		if (nativeSetDragImage && preview)
			setCustomNativeDragPreview({
				nativeSetDragImage,
				getOffset: preview.offset,
				render: ({ container }) => container.append(preview.element)
			});
		const ours = (data: Record<string | symbol, unknown>) => data[MOVE] === this;
		// The page is the target: the line follows the pointer from the grips, outside the grid.
		this.#releases.push(
			dropTargetForElements({
				element: node.ownerDocument.body,
				canDrop: ({ source }) => ours(source.data),
				onDragEnter: ({ location }) => this.aim(location.current.input),
				onDrag: ({ location }) => this.aim(location.current.input),
				onDragLeave: () => this.aim(null),
				onDrop: ({ location }) => this.drop(location.current.input)
			})
		);
		const scroller = table.node?.querySelector<HTMLElement>('[data-edytor-table-scroll]');
		if (scroller) this.#releases.push(autoScrollFor(scroller, ours));
		this.edytor.overlay.invalidate();
	}

	/** The ghost: the row's cells side by side, or the column's cells one under the other. */
	private preview(
		kind: TableMove['kind'],
		{ table, index }: { table: Block; index: number },
		pointer: Point
	) {
		const grid = gridOf(table);
		const gridNode = table.node?.querySelector<HTMLElement>('[data-edytor-table-grid]');
		if (!grid || !gridNode) return null;
		const document = gridNode.ownerDocument;
		const nodeOf = (id: string | null | undefined) =>
			(id ? this.edytor.idToBlock.get(id)?.node : null) ?? null;
		const widths = this.widthsOf(table);
		const heights = grid.rows.map((r) => nodeOf(r.id)?.getBoundingClientRect().height ?? 0);
		const box = gridNode.getBoundingClientRect();
		if (kind === 'row') {
			const row = nodeOf(grid.rows[index]?.id)?.getBoundingClientRect() ?? box;
			const cells = grid.rows[index]?.cells.map(nodeOf) ?? [];
			return tablePreview(document, [cells], widths, [heights[index] ?? 0], row, pointer);
		}
		const left = box.left + widths.slice(0, index).reduce((sum, w) => sum + w, 0);
		const width = widths[index] ?? this.columnWidth;
		const column = new DOMRect(left, box.top, width, box.height);
		const cells = grid.rows.map((r) => [nodeOf(r.cells[index])]);
		return tablePreview(document, cells, [width], heights, column, pointer);
	}

	/**
	 * Where the moving row or column would land at `input` (`table.drag`):
	 * its gap, by the rows' (columns') middles, and its position once moved;
	 * `null` outside the table (past its box and the gutter) and at its own
	 * place (the gap before or after it).
	 */
	private landing(input: Point | null) {
		const move = this.moving;
		const table = this.block(move?.table);
		const grid = gridOf(table);
		const gridNode = table?.node?.querySelector<HTMLElement>('[data-edytor-table-grid]');
		if (!move || !input || !table?.node || !grid || !gridNode) return null;
		const box = table.node.getBoundingClientRect();
		const { clientX: x, clientY: y } = input;
		if (
			x < box.left - GUTTER ||
			x > box.right + GUTTER ||
			y < box.top - GUTTER ||
			y > box.bottom + GUTTER
		)
			return null;
		let from: number;
		let gap = 0;
		if (move.kind === 'row') {
			from = grid.rows.findIndex((r) => r.id === move.id);
			for (const row of grid.rows) {
				const rect = this.edytor.idToBlock.get(row.id)?.node?.getBoundingClientRect();
				if (rect && y > rect.top + rect.height / 2) gap++;
			}
		} else {
			from = grid.columns.indexOf(move.id);
			const style = gridNode.ownerDocument.defaultView?.getComputedStyle(gridNode);
			let left = gridNode.getBoundingClientRect().left + px(style?.borderLeftWidth);
			for (const width of trackWidths(gridNode)) {
				if (x > left + width / 2) gap++;
				left += width;
			}
		}
		if (from < 0 || gap === from || gap === from + 1) return null;
		return { gap, to: gap > from ? gap - 1 : gap };
	}

	/** The pointer moved during the drag: the drop line follows it. */
	private aim(input: Point | null) {
		const move = this.moving;
		if (!move) return;
		const gap = this.landing(input)?.gap ?? null;
		if (gap === move.gap) return;
		move.gap = gap;
		this.edytor.overlay.invalidate();
	}

	/**
	 * The drop: the row or column moves to the gap at the pointer (`moveRows`,
	 * `moveColumn`: one command, one undo step), the keys go to the editor;
	 * nothing where no line shows.
	 */
	private drop(input: Point) {
		const move = this.moving;
		const landing = this.landing(input);
		const table = this.block(move?.table);
		if (!move) return;
		move.gap = null;
		if (!landing || !table) return;
		if (move.kind === 'row') {
			const row = this.edytor.idToBlock.get(move.id);
			if (row) moveRows(table, [row], landing.to);
		} else moveColumn(table, move.id, landing.to);
		takeKeys(this.edytor);
	}

	/** The drag ended, dropped or cancelled: no line, no target; the chrome follows the pointer again. */
	private finish() {
		for (const release of this.#releases.splice(0)) release();
		this.moving = null;
		this.edytor.overlay.invalidate();
	}
}

const sameLayout = (a: TableLayout | null, b: TableLayout | null) =>
	a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
