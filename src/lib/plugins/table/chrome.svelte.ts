import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import { autoScrollFor } from '$lib/dnd/autoScroll.js';
import {
	draggable,
	dropTargetForElements,
	setCustomNativeDragPreview
} from '$lib/dnd/pragmatic.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { EDYTOR_BLOCK_DRAG_MIME } from '$lib/events/onDrop.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { pin } from '$lib/surface/overlay.js';
import { attribute, type MenuItemPayload } from '../chrome.js';
import { ChromeList, holdKeys, menuKey, optionAttachment } from '../list.svelte.js';
import { BandDrag, bandKey } from '../bands.svelte.js';
import { all, listen } from '$lib/utils/listen.js';
import { dragPreview } from '../blockHandles/dragPreview.js';
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

type Kind = 'row' | 'column';

/**
 * A table's grid box and its rows and columns, layer-relative.
 * @internal
 */
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
 * A column resize in progress: its table and column, where the pointer went
 * down and where it is, the width it started at, and the widest the room
 * leaves it (`table.width.fit`); the free room it started with and its right
 * neighbour's width (none for the last column), which give the neighbour's
 * width (`table.width.neighbour`).
 */
type Drag = {
	table: string;
	column: number;
	from: number;
	at: number;
	width: number;
	max: number;
	slack: number;
	next: number | undefined;
};

/**
 * A row's or a column's drag in progress (`table.drag`): its table, the row's
 * or the column's id, and the gap it would land in (`null`: nowhere, or its
 * own place), by position among the rows (columns), `0` before the first.
 * @internal
 */
export type TableMove = { kind: Kind; table: string; id: string; gap: number | null };

/** The drag data key naming the chrome a row's or a column's drag is from. */
const MOVE = Symbol('edytor table move');
/** How far past the table's box a drag still aims at it (the grips stand outside it). */
const GUTTER = 32;

const styleOf = (node: HTMLElement) => node.ownerDocument.defaultView?.getComputedStyle(node);

/** A computed length in pixels, `0` when none. */
const px = (value: string | undefined) => Number.parseFloat(value ?? '') || 0;

/** The resolved widths of `grid`'s columns, as laid out (none where nothing is). */
const trackWidths = (grid: HTMLElement): number[] =>
	(styleOf(grid)?.gridTemplateColumns ?? '')
		.split(/\s+/)
		.map(Number.parseFloat)
		.filter(Number.isFinite);

/** The grid element of a table block. */
const gridNode = (table: Block | null | undefined) =>
	table?.node?.querySelector<HTMLElement>('[data-edytor-table-grid]');

/** A table's stored column entries (`data.columns`), each found by its column id. */
const entriesOf = (table: Block): unknown[] => {
	const stored = table.edytor.facade.blockDataOf(table.id)?.columns;
	return Array.isArray(stored) ? stored : [];
};
const entryIndex = (entries: unknown[], id: string | undefined) =>
	entries.findIndex((c) => (c as { id?: unknown } | null)?.id === id);

type Point = { clientX: number; clientY: number };

/** What a grip's menu acts on: a row (its block id) or a column (its id) of a table. */
export type TableMenu = { kind: Kind; table: string; id: string };

/**
 * A row of a grip's menu: `insert-above`, `insert-below`, `move-up`,
 * `move-down`, `delete-row`; `insert-left`, `insert-right`, `move-left`,
 * `move-right`, `delete-column`.
 */
export type TableMenuRow = { id: string };

/**
 * One row of a grip's menu, for your `menu`: the row shape every menu
 * shares (`item` is the row, `run` runs it and closes the menu), with
 * whether it can run now and whether it deletes.
 */
export type TableMenuItem = MenuItemPayload<TableMenuRow> & {
	/** It cannot run now (`aria-disabled`): the keys skip it, a click does nothing. */
	disabled: boolean;
	/** It deletes. */
	danger: boolean;
};

/**
 * What a `grip` snippet receives: the grip of the hovered row (left of the
 * table) or column (above it). Put `{@attach grip}` on its element (a
 * `button`): it drags the row or the column, a click opens its menu,
 * ArrowDown opens it too and Escape closes it, and it carries the ARIA
 * (`aria-haspopup`, `aria-expanded`, `aria-controls` while its menu is
 * open; name it). The plugin centers it where the grip stands.
 */
export type TableGripPayload = {
	kind: Kind;
	/** The row's block id, or the column's id. */
	id: string;
	/** Its position among the table's rows (columns). */
	index: number;
	/** Its menu is open. */
	expanded: boolean;
	/** It is being dragged. */
	dragging: boolean;
	/** Open its menu, or close it when it is open (what a click does). */
	toggle: () => void;
	/** The grip's behavior and ARIA: `{@attach grip}`. */
	grip: Attachment<HTMLElement>;
	/** The table's chrome (its menu, its actions). */
	chrome: TableChrome;
};

/**
 * What an `add` snippet receives: the `+` under the hovered table (a row at
 * its end) or beside it (a column at its end). The plugin places it along
 * the table's edge, as wide (tall) as the table shows; a press on it keeps
 * the editor's selection.
 */
export type TableAddPayload = {
	kind: Kind;
	/** Add the row or the column. */
	add: () => void;
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
 *
 * What a `menu` snippet receives: the open menu (`menu`), its rows
 * (`items`, each a `MenuItemPayload`), the keyboard's row (`index`), the
 * attachments that give it the keys and the ARIA (`popup` and `keys` on
 * the menu's element, `option(index)` spread on each row) and `close()`.
 * A grip's own attachment is its payload's `grip`.
 */
export class TableChrome extends ChromeList {
	/**
	 * The table, row and column (their ids) under the pointer.
	 * @internal
	 */
	hovered = $state<{ table: string; row: string | null; column: string | null } | null>(null);
	/** What the open grip menu acts on (`null`: none is open). */
	menu = $state<TableMenu | null>(null);
	/**
	 * The measured table the chrome is for.
	 * @internal
	 */
	layout = $state.raw<TableLayout | null>(null);
	/**
	 * A block drag is in progress: no chrome takes the pointer.
	 * @internal
	 */
	dragging = $state(false);
	/**
	 * The column resize (its drag in progress, `band.drag`).
	 * @internal
	 */
	band: BandDrag<Drag>;
	/**
	 * The row's or column's drag in progress (`table.drag`).
	 * @internal
	 */
	moving = $state<TableMove | null>(null);
	/**
	 * The cell the caret was last in: the row and column the block menu's
	 * actions on its table act on. A block selection (the grip that opens
	 * the menu) keeps it; a caret outside every table clears it.
	 * @internal
	 */
	cell: string | null = null;

	constructor(
		edytor: Edytor,
		/**
		 * A column's width when it sets none, and the narrowest a resize leaves.
		 * @internal
		 */
		readonly columnWidth: number,
		/** @internal */
		readonly minColumnWidth: number
	) {
		super(edytor, 'table-menu', 'menu', (node) => {
			const kind = this.menu?.kind;
			if (!kind) return null;
			node.setAttribute('data-edytor-table-menu', kind);
			return {};
		});
		this.band = new BandDrag(edytor);
	}

	protected get count() {
		return this.#rows.length;
	}

	/** The view is readonly (reactive): the chrome shows nothing. */
	get readonly() {
		return this.edytor.readonly;
	}

	/**
	 * The column resize in progress.
	 * @internal
	 */
	get drag() {
		return this.band.drag;
	}

	/**
	 * The table the chrome is for: the one a band drags or a grip moves, a
	 * menu is open on, or under the pointer.
	 * @internal
	 */
	get table(): string | null {
		return (
			this.drag?.table ?? this.moving?.table ?? this.menu?.table ?? this.hovered?.table ?? null
		);
	}

	/**
	 * What the `kind` grip stands for now (the open menu's row or column,
	 * else the hovered one): its table, id and position; `null` when none.
	 */
	#source(kind: Kind) {
		const table = this.block(this.table);
		const grid = gridOf(table);
		const id = this.menu?.kind === kind ? this.menu.id : this.hovered?.[kind];
		const ids = kind === 'row' ? grid?.rows.map((row) => row.id) : grid?.columns;
		const index = id ? (ids?.indexOf(id) ?? -1) : -1;
		return table && grid && index >= 0 ? { table, grid, id: id!, index } : null;
	}

	/**
	 * The selection changed: a caret in a cell is the one the block menu acts on.
	 * @internal
	 */
	track = () => {
		if (this.edytor.selection.value.kind === 'text') this.cell = caretCell(this.edytor)?.id ?? null;
	};

	/**
	 * Whether the chrome shows (on its table all through a band's or a grip's drag).
	 * @internal
	 */
	get shown() {
		return (
			this.drag !== null ||
			this.moving !== null ||
			(!this.readonly && !this.dragging && this.table !== null)
		);
	}

	/**
	 * The block of table `id`, if it is still a shown table.
	 * @internal
	 */
	block = (id: string | null | undefined): Block | null => {
		const block = id ? this.edytor.idToBlock.get(id) : undefined;
		return block?.isInTree && this.edytor.facade.isTable(block.id) ? block : null;
	};

	/**
	 * Whether layer-relative `x` is in the part of the grid its box shows
	 * (`table.overflow`): a band or a grip outside it is not shown.
	 * @internal
	 */
	inView = (x: number) => {
		const view = this.layout?.view;
		return !!view && x >= view.left - 1 && x <= view.right + 1;
	};

	/**
	 * The grid's visible span, horizontally, layer-relative.
	 * @internal
	 */
	get span() {
		const layout = this.layout;
		if (!layout) return { left: 0, width: 0 };
		const left = Math.max(layout.left, layout.view.left);
		const right = Math.min(layout.left + layout.width, layout.view.right);
		return { left, width: Math.max(0, right - left) };
	}

	/**
	 * The open menu's or the hovered row's and column's lines in the
	 * measured table, with their positions.
	 */
	#lines(kind: Kind) {
		const layout = this.layout;
		const id = this.menu?.kind === kind ? this.menu.id : this.hovered?.[kind];
		const lines: { id: string }[] = (kind === 'row' ? layout?.rows : layout?.columns) ?? [];
		const index = lines.findIndex((line) => line.id === id);
		return index < 0 ? null : { layout: layout!, index, id: id! };
	}

	/**
	 * Where the grips stand, layer-relative, the point each centers on: the
	 * row grip on the grid's left edge, at the middle of the row it stands
	 * for; the column grip on its top edge, at the middle of the column it
	 * stands for, while that middle shows (the grip a drag started from
	 * stays, its source, even scrolled out of view).
	 * @internal
	 */
	get grips(): { kind: Kind; id: string; index: number; x: number; y: number }[] {
		const row = this.#lines('row');
		const column = this.#lines('column');
		const r = row && row.layout.rows[row.index]!;
		const c = column && column.layout.columns[column.index]!;
		const x = c ? c.left + c.width / 2 : 0;
		return [
			...(row && r
				? [{ ...row, kind: 'row' as const, x: row.layout.left, y: r.top + r.height / 2 }]
				: []),
			...(column && (this.moving?.kind === 'column' || this.inView(x))
				? [{ ...column, kind: 'column' as const, x, y: column.layout.top }]
				: [])
		];
	}

	/**
	 * Where the `+` under the table stands (as wide as the grid shows) and
	 * the one beside it (as tall as the grid, while its right edge shows).
	 * @internal
	 */
	get bars(): { kind: Kind; left: number; top: number; width?: number; height?: number }[] {
		const layout = this.layout;
		if (!layout) return [];
		const { left, width } = this.span;
		const right = layout.left + layout.width;
		return [
			{ kind: 'row', left, top: layout.top + layout.height + 2, width },
			...(this.inView(right)
				? [{ kind: 'column' as const, left: right + 2, top: layout.top, height: layout.height }]
				: [])
		];
	}

	/**
	 * Where the open menu stands: under its grip.
	 * @internal
	 */
	get menuPlace(): { left: number; top: number } | null {
		const kind = this.menu?.kind;
		const at = kind && this.#lines(kind);
		if (!at) return null;
		const { layout, index } = at;
		if (kind === 'row') {
			const row = layout.rows[index]!;
			return { left: layout.left - 9, top: row.top + Math.min(row.height, 28) };
		}
		const column = layout.columns[index]!;
		return { left: column.left + column.width / 2 - 12, top: layout.top + 10 };
	}

	/**
	 * The drop line of a grip's drag, layer-relative: between two rows
	 * (columns), where the drop would land.
	 * @internal
	 */
	get line() {
		const move = this.moving;
		const gap = move?.gap ?? null;
		const layout = this.layout;
		if (!move || gap === null || !layout) return null;
		const row = move.kind === 'row';
		const lines = row ? layout.rows : layout.columns.map((c) => ({ top: c.left, height: c.width }));
		const last = lines.at(-1);
		const at = lines[gap]?.top ?? (last && last.top + last.height);
		if (at === undefined) return null;
		if (row)
			return { kind: move.kind, gap, left: this.span.left, top: at - 2, width: this.span.width };
		return this.inView(at)
			? { kind: move.kind, gap, left: at - 2, top: layout.top, height: layout.height }
			: null;
	}

	/**
	 * The width column `index` of `table` shows (its `data.columns` entry, the
	 * resize preview while a band drags it): what the grid's template reads.
	 * @internal
	 */
	width = (table: string, index: number, column: unknown): number => {
		const drag = this.drag;
		const at = drag?.table === table ? index - drag.column : -1;
		const preview =
			at === 0 ? this.#dragWidth(drag!) : at === 1 ? this.#nextWidth(drag!) : undefined;
		return preview ?? widthOf(column, this.columnWidth);
	};

	/** The resize's width: the pointer's, between the minimum and the room's (`table.width.fit`). */
	#dragWidth = (drag: Drag) =>
		Math.max(this.minColumnWidth, Math.min(drag.max, Math.round(drag.width + drag.at - drag.from)));

	/**
	 * The right neighbour's width while column `drag.column` is `#dragWidth`
	 * (`table.width.neighbour`): the column grows into the free room first,
	 * then what it gains past it comes off its neighbour, down to the
	 * minimum; a narrowing gives nothing back.
	 */
	#nextWidth(drag: Drag): number | undefined {
		if (drag.next === undefined) return undefined;
		const take = Math.max(0, this.#dragWidth(drag) - drag.width - drag.slack);
		return Math.max(Math.min(drag.next, this.minColumnWidth), drag.next - take);
	}

	/**
	 * The widths `table`'s grid shows, by position (its columns' stored
	 * widths, else the default one): what its template reads, the model's.
	 */
	#widthsOf(table: Block): number[] {
		const entries = entriesOf(table);
		return (gridOf(table)?.columns ?? []).map((id) =>
			widthOf(entries[entryIndex(entries, id)], this.columnWidth)
		);
	}

	/**
	 * A resize of column `column` of the measured table, pressed at `from`
	 * (`table.width.fit`, `table.width.neighbour`): the column may grow by the
	 * room the table leaves free and by what its right neighbour can give
	 * (down to the minimum), so the table never gets wider; it may always narrow.
	 */
	#resize(column: number, from: number, at: number): Drag | null {
		const layout = this.layout;
		const table = this.block(layout?.table);
		const widths = table ? this.#widthsOf(table) : [];
		const width = widths[column];
		if (!layout || !table || width === undefined) return null;
		const next = widths[column + 1];
		const slack = Math.max(0, layout.room - widths.reduce((sum, w) => sum + w, 0));
		const gives = next === undefined ? 0 : next - Math.min(next, this.minColumnWidth);
		const max = Math.floor(width + slack + gives);
		return { table: table.id, column, from, at, width, max, slack, next };
	}

	/**
	 * The pointer is over `target`: the table, row and column holding it (the innermost table).
	 * @internal
	 */
	hover = (target: EventTarget | null) => {
		// A grip's drag keeps its row or column.
		if (this.moving) return;
		const element = target instanceof Element ? target : null;
		const cell = element?.closest<HTMLElement>('[data-edytor-table-cell], [data-edytor-table-pad]');
		const table = element?.closest<HTMLElement>('[data-edytor-table]')?.dataset.edytorId;
		const grid = gridOf(this.block(table));
		const next =
			table && grid
				? {
						table,
						row: cell?.closest<HTMLElement>('[data-edytor-table-row]')?.dataset.edytorId ?? null,
						column: grid.columns[Number(cell?.dataset.edytorColumn)] ?? null
					}
				: null;
		// Over the chrome (a grip, the `+`), the row and column it is for stay.
		if (JSON.stringify(next) === JSON.stringify(this.hovered) || (!next && this.menu)) return;
		this.hovered = next;
		this.edytor.overlay.invalidate();
	};

	/**
	 * The pointer left for `to`: the chrome stays while it is over the editor or the overlay.
	 * @internal
	 */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		const { edytor } = this;
		if (node && (edytor.overlay.layer?.contains(node) || edytor.node?.contains(node))) return;
		if (!this.menu && !this.drag && !this.moving) this.hovered = null;
		edytor.overlay.invalidate();
	};

	/**
	 * The overlay measure: the shown table's grid, rows and columns.
	 * @internal
	 */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const layout = this.shown ? this.#read(origin) : null;
		return () => {
			pin(host);
			if (JSON.stringify(layout) !== JSON.stringify(this.layout)) this.layout = layout;
		};
	};

	#read(origin: DOMRect): TableLayout | null {
		const table = this.block(this.table);
		const grid = gridNode(table);
		const columns = gridOf(table)?.columns;
		if (!table || !grid?.isConnected || !columns) return null;
		const box = grid.getBoundingClientRect();
		const widths = trackWidths(grid);
		const left = box.left - origin.left;
		let x = left;
		const cols = columns.map((id, i) => {
			const width = widths[i] ?? this.columnWidth;
			x += width;
			return { id, left: x - width, width };
		});
		const rows = table.children.flatMap((row) => {
			const rect = row.node?.getBoundingClientRect();
			return rect ? [{ id: row.id, top: rect.top - origin.top, height: rect.height }] : [];
		});
		// The box the grid scrolls in: its client box is what shows, and the room.
		const scroller = grid.closest<HTMLElement>('[data-edytor-table-scroll]') ?? grid.parentElement;
		const inner = scroller?.clientWidth ?? 0;
		const clip = inner > 0 ? scroller!.getBoundingClientRect() : undefined;
		const style = styleOf(grid);
		const at = clip ? clip.left + scroller!.clientLeft - origin.left : 0;
		return {
			table: table.id,
			left,
			top: box.top - origin.top,
			width: Math.min(box.width, x - left) || box.width,
			height: box.height,
			rows,
			columns: cols,
			view: clip ? { left: at, right: at + inner } : { left: -Infinity, right: Infinity },
			room: clip ? inner - px(style?.borderLeftWidth) - px(style?.borderRightWidth) : Infinity
		};
	}

	/**
	 * Open the `kind` grip's menu on the row or column it stands for, its
	 * first row that can run the keyboard's, or close it when it is open
	 * there (a grip's click).
	 */
	toggle = (kind: Kind) => {
		const source = this.#source(kind);
		const open = this.menu?.kind === kind;
		this.menu = open || !source ? null : { kind, table: source.table.id, id: source.id };
		if (this.menu)
			this.index = Math.max(
				0,
				this.#rows.findIndex((row) => !row.disabled)
			);
		this.edytor.overlay.invalidate();
	};

	/** Whether a menu is open (reactive). */
	get isOpen() {
		return this.menu !== null;
	}

	/** Close the menu; the editor takes the keys back. */
	close = () => {
		this.menu = null;
		this.edytor.overlay.invalidate();
		takeKeys(this.edytor);
	};

	/**
	 * The open menu's rows: insert before and after, move back and forth,
	 * delete (whether each can run now; the last deletes).
	 */
	get #rows(): { id: string; disabled: boolean; run: () => unknown }[] {
		const kind = this.menu?.kind;
		const at = kind && this.#source(kind);
		if (!at) return [];
		const { table, grid, id, index } = at;
		const row = kind === 'row';
		const block = this.edytor.idToBlock.get(id);
		const last = (row ? grid.rows : grid.columns).length - 1;
		const insert = (to: number) => (row ? insertRow(table, to, true) : insertColumn(table, to));
		const move = (to: number) => (row ? moveRows(table, [block!], to) : moveColumn(table, id, to));
		const [before, after, back, forth] = row
			? ['above', 'below', 'up', 'down']
			: ['left', 'right', 'left', 'right'];
		return [
			{ id: `insert-${before}`, disabled: false, run: () => insert(index) },
			{ id: `insert-${after}`, disabled: false, run: () => insert(index + 1) },
			{ id: `move-${back}`, disabled: index === 0, run: () => move(index - 1) },
			{ id: `move-${forth}`, disabled: index === last, run: () => move(index + 1) },
			{
				id: `delete-${kind}`,
				disabled: false,
				run: () => (row ? deleteRows(table, [block!]) : deleteColumn(table, id))
			}
		];
	}

	/**
	 * The open menu's rows for your `menu`: each the row shape every menu
	 * shares (`run` runs it and closes the menu, `select` makes it the
	 * keyboard's, `option` its attributes), whether it can run now
	 * (`disabled`) and whether it deletes (`danger`).
	 */
	get items(): TableMenuItem[] {
		return this.#rows.map(({ id, disabled, run }, index) => ({
			item: { id },
			id: this.rowId(index),
			selected: index === this.index,
			disabled,
			danger: id.startsWith('delete'),
			run: () => {
				if (disabled) return;
				this.menu = this.hovered = null;
				takeKeys(this.edytor);
				run();
				this.edytor.overlay.invalidate();
			},
			select: () => {
				if (!disabled) this.index = index;
			},
			option: this.option(index)
		}));
	}

	/**
	 * The attachment of the open menu's row at `index`
	 * (`{@attach chrome.option(index)}`). Its id, `menuitem` role,
	 * `aria-disabled` when it cannot run now, `data-selected` for the
	 * keyboard's row, which scrolls into view. The menu's element takes
	 * `data-edytor-table-menu` (the kind it is open on) from `popup`.
	 */
	option(index: number): Attachment<HTMLElement> {
		const extra = this.#rows[index]?.disabled ? { 'aria-disabled': true } : {};
		return optionAttachment(this.rowId(index), 'menuitem', index === this.index, extra);
	}

	/**
	 * The element that holds the menu's keyboard (`{@attach chrome.keys}`,
	 * the menu's own): it takes the focus when it mounts and names the
	 * keyboard's row (`aria-activedescendant`); ArrowDown and ArrowUp walk
	 * the rows that can run (around the ends), Home and End reach the first
	 * and last, Enter or Space runs the row, Escape and Tab close the menu
	 * and give the keys back to the editor. No key reaches the page behind.
	 */
	keys: Attachment<HTMLElement> = (node) =>
		untrack(() => {
			if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
			return holdKeys(node, this.#keydown, () => this.rowId(this.index));
		});

	/** The menu's keys (`keys`). */
	#keydown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing) return;
		const items = this.items;
		const menu = {
			at: this.index,
			count: items.length,
			to: (index: number) => (this.index = index),
			pick: () => items[this.index]?.run(),
			close: this.close
		};
		if (menuKey(event, menu, { usable: (index) => !items[index]!.disabled }))
			event.stopPropagation();
	};

	/**
	 * The `kind` grip's attachment (`{@attach}` it on a grip's element; a
	 * `grip` snippet's payload carries it): in an editable view, dragging it
	 * moves its row or column within its table (`table.drag`); a click with
	 * no drag opens or closes its menu; ArrowDown opens the menu, Escape
	 * closes it and gives the keys back to the editor. It carries
	 * `aria-haspopup`, `aria-expanded`, `aria-controls` while its menu is
	 * open, and `data-dragging` during its drag. A press on it is never
	 * prevented: that would stop the native drag.
	 */
	gripOf = (kind: Kind): Attachment<HTMLElement> =>
		(this.#grips[kind] ??= (node) => untrack(() => this.#grip(node, kind)));

	#grips: Partial<Record<Kind, Attachment<HTMLElement>>> = {};

	#grip = (node: HTMLElement, kind: Kind) => {
		node.setAttribute('aria-haspopup', 'menu');
		$effect(() => {
			const open = this.menu?.kind === kind;
			attribute(node, 'aria-expanded', String(open));
			attribute(node, 'aria-controls', open ? this.listId : undefined);
			attribute(node, 'data-dragging', this.moving?.kind === kind ? 'true' : undefined);
		});
		const off = all(
			listen(node, 'click', () => this.toggle(kind)),
			listen(node, 'keydown', (event: KeyboardEvent) => {
				// Escape gives the keys back to the editor (closing the menu if open).
				if (event.key === 'Escape') this.close();
				else if (event.key === 'ArrowDown' && this.menu?.kind !== kind) this.toggle(kind);
				else return;
				event.preventDefault();
				event.stopPropagation();
			}),
			draggable({
				element: node,
				canDrag: () =>
					!this.edytor.readonly && this.edytor.dispatcher.permits() && this.#source(kind) !== null,
				getInitialData: () => ({ [MOVE]: this }),
				// The editor's own drag: no view takes it as a foreign drop.
				getInitialDataForExternal: () => {
					const source = this.#source(kind);
					return {
						[EDYTOR_BLOCK_DRAG_MIME]: (kind === 'row' ? source?.id : source?.table.id) ?? ''
					};
				},
				onGenerateDragPreview: ({ nativeSetDragImage, location }) =>
					this.#begin(kind, node, location.current.input, nativeSetDragImage),
				// The drag library tells the source before the drop target: the drop runs first.
				onDrop: () =>
					queueMicrotask(() => {
						for (const release of this.#releases.splice(0)) release();
						this.moving = null;
						this.edytor.overlay.invalidate();
					})
			})
		);
		return off;
	};

	/**
	 * The `+` under the table (`row`: a row at its end, the caret in its
	 * first cell) or beside it (a column at its end).
	 * @internal
	 */
	add = (kind: Kind) => {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return;
		takeKeys(this.edytor);
		if (kind === 'row') insertRow(table, grid.rows.length, true);
		else insertColumn(table, grid.columns.length);
	};

	/**
	 * Press on column `column`'s band (its `pointerdown`, or its lone
	 * `mousedown`): the drag starts; the preview follows the pointer and the
	 * release writes the width (`#release`); Escape, a cancel or the view
	 * turning readonly drop the preview, nothing written.
	 * @internal
	 */
	start = (event: PointerEvent | MouseEvent, column: number) => {
		const drag = this.band.drag ? null : this.#resize(column, event.clientX, event.clientX);
		const shown = this.layout?.columns[column]?.width;
		if (!drag || shown === undefined) return;
		// The press starts from the width the grid shows.
		this.band.start(
			event,
			{ ...drag, width: shown, max: Math.max(drag.max, shown) },
			(drag) => drag && this.#release(drag)
		);
	};

	/**
	 * A key on a focused band: ArrowRight/ArrowLeft widen or narrow the
	 * column by 8px (Shift: 32px) from its stored width, as far as the room
	 * leaves it (`table.width.fit`); each press is one width write.
	 * @internal
	 */
	key = (event: KeyboardEvent, column: number) => {
		const step = bandKey(this.edytor, this.band, event, { ArrowLeft: -1, ArrowRight: 1 });
		const drag = step && this.#resize(column, 0, step * (event.shiftKey ? 32 : 8));
		if (drag) this.#release(drag);
	};

	/**
	 * The release: column `drag.column`'s width, and its right neighbour's
	 * when the column took from it (`table.width.neighbour`), one command;
	 * nothing when neither changed, or when the table does not list the
	 * column. A width is written on its column's entry by its item id (the
	 * first entry naming it), never by position: the stored array may hold
	 * an entry the grid does not show.
	 */
	#release(drag: Drag) {
		const table = this.block(drag.table);
		const columns = gridOf(table)?.columns;
		if (!table || !columns || columns[drag.column] === undefined) return;
		const entries = entriesOf(table);
		const items = table.edytor.facade.dataItemIds(table.id, ['columns']);
		const ops = [this.#dragWidth(drag), this.#nextWidth(drag)].flatMap((width, i) => {
			const at = entryIndex(entries, columns[drag.column + i]);
			const item = items[at];
			return at < 0 || item === undefined || width === undefined
				? []
				: width === widthOf(entries[at], this.columnWidth)
					? []
					: [{ path: ['columns', item, 'width'], value: width }];
		});
		if (ops.length) this.edytor.patchData(table.id, ops);
	}

	/** The drop target and auto-scroll of the drag in progress, released when it ends. */
	#releases: (() => void)[] = [];

	/**
	 * The drag starts: what it moves; its ghost, the row's cells side by side
	 * or the column's one under the other, at their columns' widths (the
	 * blocks' ghost, `dragPreview`); the page as its drop target; auto-scroll.
	 */
	#begin(
		kind: Kind,
		node: HTMLElement,
		pointer: Point,
		nativeSetDragImage: DataTransfer['setDragImage'] | null
	) {
		const source = this.#source(kind);
		const root = this.edytor.node;
		if (!source || !root) return;
		const { table, grid, id, index } = source;
		this.menu = null;
		this.moving = { kind, table: table.id, id, gap: null };
		const widths = this.#widthsOf(table);
		const cells = (
			kind === 'row' ? grid.rows[index]!.cells : grid.rows.map((r) => r.cells[index])
		).flatMap((cell) => (cell && this.edytor.idToBlock.get(cell)?.node) || []);
		if (nativeSetDragImage && cells.length) {
			const preview = dragPreview(root, cells, pointer, kind === 'row' ? widths : [widths[index]!]);
			setCustomNativeDragPreview({
				nativeSetDragImage,
				getOffset: preview.offset,
				render: ({ container }) => container.append(preview.element)
			});
		}
		const ours = (data: Record<string | symbol, unknown>) => data[MOVE] === this;
		// The page is the target: the line follows the pointer from the grips, outside the grid.
		this.#releases.push(
			dropTargetForElements({
				element: node.ownerDocument.body,
				canDrop: ({ source }) => ours(source.data),
				onDragEnter: ({ location }) => this.#aim(location.current.input),
				onDrag: ({ location }) => this.#aim(location.current.input),
				onDragLeave: () => this.#aim(null),
				onDrop: ({ location }) => this.#drop(location.current.input)
			})
		);
		const scroller = table.node?.querySelector<HTMLElement>('[data-edytor-table-scroll]');
		if (scroller) this.#releases.push(autoScrollFor(scroller, ours));
		this.edytor.overlay.invalidate();
	}

	/**
	 * Where the moving row or column would land at `input` (`table.drag`):
	 * its gap, by the rows' (columns') middles, and its position once moved;
	 * `null` outside the table (past its box and the gutter) and at its own
	 * place (the gap before or after it).
	 */
	#landing(input: Point | null) {
		const move = this.moving;
		const table = this.block(move?.table);
		const grid = gridOf(table);
		const node = gridNode(table);
		const box = table?.node?.getBoundingClientRect();
		if (!move || !input || !box || !grid || !node) return null;
		const { clientX: x, clientY: y } = input;
		if (
			x < box.left - GUTTER ||
			x > box.right + GUTTER ||
			y < box.top - GUTTER ||
			y > box.bottom + GUTTER
		)
			return null;
		// The gap: the rows' (columns', from the grid's left border) middles before the pointer.
		let gap = 0;
		let from: number;
		if (move.kind === 'row') {
			from = grid.rows.findIndex((r) => r.id === move.id);
			for (const row of grid.rows) {
				const rect = this.edytor.idToBlock.get(row.id)?.node?.getBoundingClientRect();
				if (rect && y > rect.top + rect.height / 2) gap++;
			}
		} else {
			from = grid.columns.indexOf(move.id);
			let left = node.getBoundingClientRect().left + px(styleOf(node)?.borderLeftWidth);
			for (const width of trackWidths(node)) if (x > (left += width) - width / 2) gap++;
		}
		if (from < 0 || gap === from || gap === from + 1) return null;
		return { gap, to: gap > from ? gap - 1 : gap };
	}

	/** The pointer moved during the drag: the drop line follows it. */
	#aim(input: Point | null) {
		const move = this.moving;
		const gap = this.#landing(input)?.gap ?? null;
		if (!move || gap === move.gap) return;
		move.gap = gap;
		this.edytor.overlay.invalidate();
	}

	/**
	 * The drop: the row or column moves to the gap at the pointer (`moveRows`,
	 * `moveColumn`: one command, one undo step), the keys go to the editor;
	 * nothing where no line shows.
	 */
	#drop(input: Point) {
		const move = this.moving;
		const landing = this.#landing(input);
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
}
