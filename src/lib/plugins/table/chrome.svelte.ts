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
import type { TableLabels } from '$lib/labels.js';
import { iconOf } from '../icons.js';
import {
	attribute,
	optionAttributes,
	type MenuItemPayload,
	type OptionAttributes
} from '../chrome.js';
import { holdKeys, listPopup, menuKey } from '../list.svelte.js';
import { BandDrag, listen } from '../bands.svelte.js';
import { tablePreview } from './dragPreview.js';
import {
	caretCell,
	deleteColumn,
	deleteRows,
	gridOf,
	insertColumn,
	insertRow,
	kebab,
	moveColumn,
	moveRows,
	widthOf
} from './table.js';

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
	(styleOf(grid)?.gridTemplateColumns ?? '')
		.split(/\s+/)
		.map(Number.parseFloat)
		.filter(Number.isFinite);

const styleOf = (node: HTMLElement) => node.ownerDocument.defaultView?.getComputedStyle(node);

/** A computed length in pixels, `0` when none. */
const px = (value: string | undefined) => Number.parseFloat(value ?? '') || 0;

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

/** What a grip's menu acts on: a row of a table (its block id), or a column (its position). */
export type TableMenu =
	| { kind: 'row'; table: string; row: string }
	| { kind: 'column'; table: string; column: number };

/** A row of a grip's menu (insert, move, delete). */
export type TableMenuRow = {
	/**
	 * `insert-above`, `insert-below`, `move-up`, `move-down`, `delete-row`;
	 * `insert-left`, `insert-right`, `move-left`, `move-right`, `delete-column`.
	 */
	id: string;
	/** Its words, in the plugin's labels. */
	label: string;
	/** Its built-in icon's name. */
	icon: string;
	/** It deletes. */
	danger?: boolean;
	/** Whether it can run now (Move up on the first row cannot). */
	isEnabled: () => boolean;
	run: () => unknown;
};

/**
 * One row of a grip's menu, for a custom `menu`: the row shape every menu
 * shares (`item` is the row, `run` runs it and closes the menu), with
 * whether it can run now, whether it deletes, and its built-in icon.
 */
export type TableMenuItem = MenuItemPayload<TableMenuRow> & {
	/** It cannot run now (`aria-disabled`): the keys skip it, a click does nothing. */
	disabled: boolean;
	/** It deletes. */
	danger: boolean;
	/** The built-in line icon as a CSS `mask-image` value, when the row has one. */
	icon: string | undefined;
};

/**
 * What a `grip` snippet receives: the grip of the hovered row (left of the
 * table) or column (above it). Put `{@attach grip}` on its element (a
 * `button`): it drags the row or the column, a click opens its menu,
 * ArrowDown opens it too and Escape closes it, and it carries the ARIA
 * (`aria-haspopup`, `aria-expanded`, `aria-controls` while its menu is
 * open, its name unless you set one). The plugin centers it where the
 * grip stands.
 */
export type TableGripPayload = {
	kind: 'row' | 'column';
	/** The row's block id, or the column's id. */
	id: string;
	/** Its position among the table's rows (columns). */
	index: number;
	/** Its menu is open. */
	expanded: boolean;
	/** It is being dragged. */
	dragging: boolean;
	/** Its accessible name (`labels.rowMenu`, `labels.columnMenu`). */
	label: string;
	/** Open its menu, or close it when it is open (what a click does). */
	toggle: () => void;
	/** The grip's behavior and ARIA: `{@attach grip}`. */
	grip: Attachment<HTMLElement>;
	/** The plugin's words. */
	labels: TableLabels;
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
	kind: 'row' | 'column';
	/** Its accessible name (`labels.addRow`, `labels.addColumn`). */
	label: string;
	/** Add the row or the column. */
	add: () => void;
	/** The plugin's words. */
	labels: TableLabels;
};

/** Where a grip stands, layer-relative: the point it centers on. */
type GripPlace = { kind: 'row' | 'column'; id: string; index: number; x: number; y: number };

/** Where a `+` stands, layer-relative: along the grid's bottom edge (`row`) or its right one. */
type Bar = { kind: 'row' | 'column'; left: number; top: number; width?: number; height?: number };

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
 * What a custom `menu` snippet receives: the open menu (`menu`), its rows
 * (`items`, each a `MenuItemPayload`), the keyboard's row (`index`), the
 * attachments that keep the built-in keys and ARIA (`popup` and `keys` on
 * the menu's element, `option(index)` spread on each row), `close()` and
 * the plugin's `labels`. A grip's own attachment is its payload's `grip`.
 */
export class TableChrome {
	/**
	 * The table, row and column under the pointer.
	 * @internal
	 */
	hovered = $state<{ table: string; row: string | null; column: number | null } | null>(null);
	/** What the open grip menu acts on (`null`: none is open). */
	menu = $state<TableMenu | null>(null);
	/** The keyboard's row of the open menu, in `rows` (never a disabled one). */
	index = $state(0);
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
		/** @internal */
		readonly edytor: Edytor,
		/** The words the chrome shows and says (the plugin's `labels`). */
		readonly labels: TableLabels,
		/**
		 * A column's width when it sets none, and the narrowest a resize leaves.
		 * @internal
		 */
		readonly columnWidth: number,
		/** @internal */
		readonly minColumnWidth: number
	) {
		this.band = new BandDrag(edytor);
		this.popup = listPopup(
			edytor,
			'table-menu',
			'menu',
			() => (this.menu?.kind === 'row' ? labels.rowMenu : labels.columnMenu),
			(node) => {
				const kind = this.menu?.kind;
				if (!kind) return null;
				node.setAttribute('data-edytor-table-menu', kind);
				return {};
			}
		);
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
	 * The row (`row`: its id) or the column (`column`: its position) the
	 * `kind` grip stands for: the open menu's, else the hovered one.
	 */
	#gripOf(kind: TableMenu['kind']): string | number | null {
		const menu = this.menu as Record<string, string | number> | null;
		return (menu?.kind === kind ? menu[kind] : this.hovered?.[kind]) ?? null;
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
	 * Where the grips stand, layer-relative, the point each centers on: the
	 * row grip on the grid's left edge, at the middle of the row it stands
	 * for; the column grip on its top edge, at the middle of the column it
	 * stands for, while that middle shows (the grip a drag started from
	 * stays, its source, even scrolled out of view).
	 * @internal
	 */
	get grips(): GripPlace[] {
		const layout = this.layout;
		if (!layout) return [];
		const grips: GripPlace[] = [];
		const id = this.#gripOf('row');
		const index = layout.rows.findIndex((row) => row.id === id);
		const row = layout.rows[index];
		if (row)
			grips.push({ kind: 'row', id: row.id, index, x: layout.left, y: row.top + row.height / 2 });
		const at = this.#gripOf('column') as number | null;
		const column = at === null ? undefined : layout.columns[at];
		const x = column ? column.left + column.width / 2 : 0;
		if (column && (this.moving?.kind === 'column' || this.inView(x)))
			grips.push({ kind: 'column', id: column.id, index: at!, x, y: layout.top });
		return grips;
	}

	/**
	 * Where the `+` under the table stands (as wide as the grid shows) and
	 * the one beside it (as tall as the grid, while its right edge shows).
	 * @internal
	 */
	get bars(): Bar[] {
		const layout = this.layout;
		if (!layout) return [];
		const { left, width } = this.span;
		const right = layout.left + layout.width;
		const bars: Bar[] = [{ kind: 'row', left, top: layout.top + layout.height + 2, width }];
		if (this.inView(right))
			bars.push({ kind: 'column', left: right + 2, top: layout.top, height: layout.height });
		return bars;
	}

	/**
	 * Where the open menu stands: under its grip.
	 * @internal
	 */
	get menuPlace(): { left: number; top: number } | null {
		const menu = this.menu;
		const layout = this.layout;
		if (!menu || !layout) return null;
		if (menu.kind === 'row') {
			const row = layout.rows.find((r) => r.id === menu.row);
			return row ? { left: layout.left - 9, top: row.top + Math.min(row.height, 28) } : null;
		}
		const column = layout.columns[menu.column];
		return column ? { left: column.left + column.width / 2 - 12, top: layout.top + 10 } : null;
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
		const lines: { top: number; height: number }[] = row
			? layout.rows
			: layout.columns.map((c) => ({ top: c.left, height: c.width }));
		const last = lines[lines.length - 1];
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
		const column = Number(cell?.dataset.edytorColumn);
		const next =
			table && this.block(table)
				? {
						table,
						row: cell?.closest<HTMLElement>('[data-edytor-table-row]')?.dataset.edytorId ?? null,
						column: Number.isInteger(column) ? column : null
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
	 * Open the menu of a row's or a column's grip (a second press on it
	 * closes it), its first row that can run the keyboard's.
	 */
	open = (menu: TableMenu) => {
		const same = JSON.stringify(this.menu) === JSON.stringify(menu);
		this.menu = same ? null : menu;
		if (!same)
			this.index = Math.max(
				0,
				this.rows.findIndex((row) => row.isEnabled())
			);
		this.edytor.overlay.invalidate();
	};

	/** Open the `kind` grip's menu on the row or column it stands for, or close it (a grip's click). */
	toggle = (kind: TableMenu['kind']) => {
		const source = this.#source(kind);
		if (source)
			this.open(
				kind === 'row'
					? { kind, table: source.table.id, row: source.id }
					: { kind, table: source.table.id, column: source.index }
			);
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

	/** The menu element's id (page-unique), for `aria-controls`. */
	get menuId() {
		return this.edytor.popups.idOf('table-menu');
	}

	/** A row's element id (page-unique), for `aria-activedescendant`. */
	rowId = (row: TableMenuRow) => this.edytor.popups.idOf(`table-menu-${row.id}`);

	/**
	 * The open menu's rows for a custom `menu`: each the row shape every menu
	 * shares (`run` runs it and closes the menu, `select` makes it the
	 * keyboard's, `option` its attributes), whether it can run now
	 * (`disabled`), whether it deletes (`danger`), and its icon.
	 */
	get items(): TableMenuItem[] {
		return this.rows.map((row, index) => {
			const disabled = !row.isEnabled();
			return {
				item: row,
				id: this.rowId(row),
				label: row.label,
				selected: index === this.index,
				disabled,
				danger: Boolean(row.danger),
				icon: iconOf(row.icon),
				run: () => this.runRow(row),
				select: () => {
					if (!disabled) this.index = index;
				},
				option: this.option(index)
			};
		});
	}

	/**
	 * The attributes of the open menu's row at `index`: spread them on its
	 * element (`{...chrome.option(index)}`). Its id, `menuitem` role,
	 * `aria-disabled` when it cannot run now, `data-selected` for the
	 * keyboard's row, which scrolls into view.
	 */
	option = (index: number): OptionAttributes => {
		const row = this.rows[index];
		return optionAttributes(
			row ? this.rowId(row) : this.edytor.popups.idOf(`table-menu-${index}`),
			'menuitem',
			index === this.index,
			row && !row.isEnabled() ? { 'aria-disabled': true } : {}
		);
	};

	/**
	 * The menu's element (`{@attach chrome.popup}`): its id, `menu` role and
	 * name (Row options, Column options) unless it has its own, presses that
	 * keep the focus, and its publication to the view's root
	 * (`edytor.popups`: `aria-controls`, `aria-haspopup`) while it is in
	 * the page; `data-edytor-table-menu` names the kind it is open on.
	 */
	popup: Attachment<HTMLElement>;

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
			return holdKeys(node, this.#keydown, () => {
				const row = this.rows[this.index];
				return row && this.rowId(row);
			});
		});

	/** The menu's keys (`keys`). */
	#keydown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing) return;
		const rows = this.rows;
		const row = rows[this.index];
		const menu = {
			at: this.index,
			count: rows.length,
			to: (index: number) => (this.index = index),
			pick: () => row && this.runRow(row),
			close: this.close
		};
		if (menuKey(event, menu, { usable: (index) => rows[index]!.isEnabled() }))
			event.stopPropagation();
	};

	/**
	 * The `kind` grip's attachment (`{@attach}` it on a grip's element; a
	 * `grip` snippet's payload carries it): in an editable view, dragging it
	 * moves its row or column within its table (`table.drag`); a click with
	 * no drag opens or closes its menu; ArrowDown opens the menu, Escape
	 * closes it and gives the keys back to the editor. It names the element (its own name wins) and carries
	 * `aria-haspopup`, `aria-expanded`, `aria-controls` while its menu is
	 * open, and `data-dragging` during its drag. A press on it is never
	 * prevented: that would stop the native drag.
	 */
	gripOf = (kind: TableMenu['kind']): Attachment<HTMLElement> =>
		(this.#grips[kind] ??= (node) => untrack(() => this.#grip(node, kind)));

	#grips: Partial<Record<TableMenu['kind'], Attachment<HTMLElement>>> = {};

	#grip = (node: HTMLElement, kind: TableMenu['kind']) => {
		if (!node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby'))
			node.setAttribute('aria-label', this.labels[`${kind}Menu`]);
		node.setAttribute('aria-haspopup', 'menu');
		$effect(() => {
			const open = this.menu?.kind === kind;
			attribute(node, 'aria-expanded', String(open));
			attribute(node, 'aria-controls', open ? this.menuId : undefined);
			attribute(node, 'data-dragging', this.moving?.kind === kind ? 'true' : undefined);
		});
		const offs = [
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
				onDrop: () => queueMicrotask(() => this.#finish())
			})
		];
		return () => offs.forEach((off) => off());
	};

	/** The rows of the open menu: insert before and after, move back and forth, delete. */
	get rows(): TableMenuRow[] {
		const menu = this.menu;
		const table = this.block(menu?.table);
		const grid = gridOf(table);
		if (!menu || !table || !grid) return [];
		const row = menu.kind === 'row';
		const block = row ? this.edytor.idToBlock.get(menu.row) : undefined;
		const index = row ? grid.rows.findIndex((r) => r.id === menu.row) : menu.column;
		const last = (row ? grid.rows : grid.columns).length - 1;
		if (index < 0 || index > last || (row && !block)) return [];
		const insert = (at: number) => (row ? insertRow(table, at, true) : insertColumn(table, at));
		const move = (to: number) =>
			row ? moveRows(table, [block!], to) : moveColumn(table, index, to);
		const [back, forth] = row ? ['Up', 'Down'] : ['Left', 'Right'];
		const [before, after] = row ? ['Above', 'Below'] : [back, forth];
		const icons = row ? ['action.up', 'action.down'] : ['table.left', 'table.right'];
		return (
			[
				[`insert${before}`, icons[0], true, () => insert(index)],
				[`insert${after}`, icons[1], true, () => insert(index + 1)],
				[`move${back}`, icons[0], index > 0, () => move(index - 1)],
				[`move${forth}`, icons[1], index < last, () => move(index + 1)],
				[
					row ? 'deleteRow' : 'deleteColumn',
					'action.delete',
					true,
					() => (row ? deleteRows(table, [block!]) : deleteColumn(table, index))
				]
			] as const
		).map(([key, icon, enabled, run], at) => ({
			id: kebab(key),
			label: this.labels[key as keyof TableLabels] as string,
			icon: icon!,
			...(at === 4 && { danger: true }),
			isEnabled: () => enabled,
			run
		}));
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

	/**
	 * The `+` under the table (`row`: a row at its end, the caret in its
	 * first cell) or beside it (a column at its end).
	 * @internal
	 */
	add = (kind: TableMenu['kind']) => {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return;
		takeKeys(this.edytor);
		if (kind === 'row') insertRow(table, grid.rows.length, true);
		else insertColumn(table, grid.columns.length);
	};

	/** The `+` under the table: a row at its end, the caret in its first cell. */
	addRow = () => this.add('row');

	/** The `+` beside the table: a column at its end. */
	addColumn = () => this.add('column');

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
		const step = this.band.key(event, { ArrowLeft: -1, ArrowRight: 1 });
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
		if (ops.length) table.patchData({ ops });
	}

	/** What the row grip or the column grip stands for now: its table, the row's or column's id, its position. */
	#source(kind: TableMove['kind']) {
		const table = this.block(this.table);
		const grid = gridOf(table);
		if (!table || !grid) return null;
		const at = this.#gripOf(kind);
		const index = kind === 'row' ? grid.rows.findIndex((r) => r.id === at) : (at as number | null);
		const id = kind === 'row' ? (at as string | null) : index === null ? null : grid.columns[index];
		return index === null || index < 0 || id == null ? null : { table, id, index };
	}

	/** The drop target and auto-scroll of the drag in progress, released when it ends. */
	#releases: (() => void)[] = [];

	/** The drag starts: what it moves, its ghost, the page as its drop target, auto-scroll. */
	#begin(
		kind: TableMove['kind'],
		node: HTMLElement,
		pointer: Point,
		nativeSetDragImage: DataTransfer['setDragImage'] | null
	) {
		const source = this.#source(kind);
		if (!source) return;
		const { table } = source;
		this.menu = null;
		this.moving = { kind, table: table.id, id: source.id, gap: null };
		const preview = nativeSetDragImage && this.#preview(kind, source, pointer);
		if (preview)
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

	/** The ghost: the row's cells side by side, or the column's cells one under the other. */
	#preview(
		kind: TableMove['kind'],
		{ table, index }: { table: Block; index: number },
		pointer: Point
	) {
		const grid = gridOf(table);
		const node = gridNode(table);
		if (!grid || !node) return null;
		const nodeOf = (id: string | null | undefined) =>
			(id ? this.edytor.idToBlock.get(id)?.node : null) ?? null;
		const widths = this.#widthsOf(table);
		const heights = grid.rows.map((r) => nodeOf(r.id)?.getBoundingClientRect().height ?? 0);
		const box = node.getBoundingClientRect();
		const preview = (
			lines: (HTMLElement | null)[][],
			widths: number[],
			heights: number[],
			box: DOMRect
		) => tablePreview(node.ownerDocument, lines, widths, heights, box, pointer);
		if (kind === 'row') {
			const row = grid.rows[index];
			const rect = nodeOf(row?.id)?.getBoundingClientRect() ?? box;
			return preview([row?.cells.map(nodeOf) ?? []], widths, [heights[index] ?? 0], rect);
		}
		const left = box.left + widths.slice(0, index).reduce((sum, w) => sum + w, 0);
		const width = widths[index] ?? this.columnWidth;
		const cells = grid.rows.map((r) => [nodeOf(r.cells[index])]);
		return preview(cells, [width], heights, new DOMRect(left, box.top, width, box.height));
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

	/** The drag ended, dropped or cancelled: no line, no target; the chrome follows the pointer again. */
	#finish() {
		for (const release of this.#releases.splice(0)) release();
		this.moving = null;
		this.edytor.overlay.invalidate();
	}
}
