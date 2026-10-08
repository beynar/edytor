/**
 * The table plugin's commands and reads over the document's table ops
 * (`table.*` in the delete contract): each command is one dispatched plan
 * (hooks see it by its name: `insertTableRow`, `deleteTableRows`,
 * `insertTableColumn`, `deleteTableColumn`, `moveTableColumn`,
 * `moveTableRows`, `fillTableCell`), its own undo step, refused in a
 * readonly view. The grid is the document's (`facade.tableGrid`): a padded
 * cell is `null` there, and the first edit in it creates it.
 */
import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan, type BlockOperations } from '$lib/block/block.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Prepared } from '$lib/crdt/index.js';
import type { PartialLabels } from '$lib/labels.js';

export type TablePluginOptions = {
	/** The rows a new table has (default 3). */
	rows?: number;
	/** The columns a new table has (default 3). */
	columns?: number;
	/** A column's width when it sets none, in pixels (default 120, Notion's). */
	columnWidth?: number;
	/** The narrowest a column may be resized to, in pixels (default 48). */
	minColumnWidth?: number;
	/** The words the table's command and controls say, over the English ones. */
	labels?: PartialLabels<'table'>;
	/** The slash menu's keywords of the table command (`block.table`), which replace its own. */
	keywords?: Partial<Record<string, string[]>>;
};

/** The table commands' operation names, as hooks see them. */
type TableOperation =
	| 'insertTableRow'
	| 'deleteTableRows'
	| 'insertTableColumn'
	| 'deleteTableColumn'
	| 'moveTableColumn'
	| 'moveTableRows'
	| 'fillTableCell';

/** A table's grid as the document shows it (`facade.tableGrid`). */
export type TableGrid = {
	columns: string[];
	rows: { id: string; cells: (string | null)[] }[];
};

/** Where a cell stands in its table: the table, the cell's row and column positions. */
export type CellPosition = { table: Block; grid: TableGrid; row: number; column: number };

/** The table `block` is, or whose row or cell it is. */
export const tableOf = (block: Block | null | undefined): Block | null => {
	if (!block?.id) return null;
	const id = block.edytor.facade.tableOf(block.id);
	return id === null ? null : (block.edytor.idToBlock.get(id) ?? null);
};

/** The grid of `table` (the document's), or `null` when it is no shown table. */
export const gridOf = (table: Block | null | undefined): TableGrid | null =>
	table?.id ? table.edytor.facade.tableGrid(table.id) : null;

/** Where `cell` stands in its table, or `null` when it is no shown cell. */
export const positionOf = (cell: Block | null | undefined): CellPosition | null => {
	if (!cell?.id || !cell.edytor.facade.isTableCell(cell.id)) return null;
	const table = tableOf(cell);
	const grid = gridOf(table);
	if (!table || !grid) return null;
	for (let row = 0; row < grid.rows.length; row++) {
		const column = grid.rows[row]!.cells.indexOf(cell.id);
		if (column >= 0) return { table, grid, row, column };
	}
	return null;
};

/** The cell at `row`, `column` of `table`'s grid, `null` where the row shows none (padded). */
export const cellAt = (table: Block, grid: TableGrid, row: number, column: number) => {
	const id = grid.rows[row]?.cells[column];
	return id ? (table.edytor.idToBlock.get(id) ?? null) : null;
};

/** The cell holding the caret (or the selection's start), if it is a table's cell. */
export const caretCell = (edytor: Edytor): Block | null => {
	const block = edytor.selection.state.startBlock;
	return block?.id && edytor.facade.isTableCell(block.id) ? block : null;
};

/** `prepare` dispatched as `operation` on `table`: one plan, its own undo step; the plan or `null`. */
const run = <O extends TableOperation>(
	table: Block,
	operation: O,
	payload: BlockOperations[O],
	prepare: (payload: BlockOperations[O]) => Prepared
) => dispatchPlan(table, operation, payload, prepare, []);

/** The first text of the shown cell `id`, for a caret. */
const firstCellText = (edytor: Edytor, id: string | null | undefined) =>
	id ? edytor.idToBlock.get(id)?.firstText : undefined;

/** Insert a row at `index` (`table.insert-row`); the caret goes to its first cell when `caret`. */
export const insertRow = (table: Block, index: number, caret = false): Block | null => {
	const { edytor } = table;
	const plan = run(table, 'insertTableRow', { index }, (p) =>
		edytor.facade.prepare.insertTableRow(table.id, p.index)
	);
	const row = plan ? (edytor.idToBlock.get(plan.ids[0]!) ?? null) : null;
	if (row && caret) edytor.dispatcher.caret(row.children[0]?.firstText, 0);
	return row;
};

/** Delete `rows` with their cells (`table.delete-row`). */
export const deleteRows = (table: Block, rows: readonly Block[]) =>
	run(table, 'deleteTableRows', { rows: [...rows] }, (p) =>
		table.edytor.facade.prepare.deleteTableRows(p.rows.map((row) => row.id))
	) !== null;

/** Insert a column at `index` (`table.insert-column`). */
export const insertColumn = (table: Block, index: number, width?: number) =>
	run(table, 'insertTableColumn', { index, width }, (p) =>
		table.edytor.facade.prepare.insertTableColumn(table.id, p.index, p.width)
	) !== null;

/** Delete a column, by id or position (`table.delete-column`). */
export const deleteColumn = (table: Block, column: string | number) =>
	run(table, 'deleteTableColumn', { column }, (p) =>
		table.edytor.facade.prepare.deleteTableColumn(table.id, p.column)
	) !== null;

/** Move a column to position `to` (`table.move-column`). */
export const moveColumn = (table: Block, column: string | number, to: number) =>
	run(table, 'moveTableColumn', { column, to }, (p) =>
		table.edytor.facade.prepare.moveTableColumn(table.id, p.column, p.to)
	) !== null;

/** Move rows to position `to` among their table's rows (`table.move-row`). */
export const moveRows = (table: Block, rows: readonly Block[], to: number) =>
	run(table, 'moveTableRows', { rows: [...rows], to }, (p) =>
		table.edytor.facade.prepare.moveTableRows(
			p.rows.map((row) => row.id),
			p.to
		)
	) !== null;

/**
 * Fill the padded cell of `row` in `column` (`table.pad`): the cell is
 * created, the caret placed in it. Its block, or `null` when refused.
 */
export const fillCell = (table: Block, row: string, column: string | number): Block | null => {
	const { edytor } = table;
	const plan = run(table, 'fillTableCell', { row, column }, (p) =>
		edytor.facade.prepare.fillTableCell(p.row, p.column)
	);
	const cell = plan ? (edytor.idToBlock.get(plan.ids[0]!) ?? null) : null;
	if (cell) edytor.dispatcher.caret(cell.firstText, 0);
	return cell;
};

/** Toggle `flag` (`headerRow` or `headerColumn`) of `table`'s data (`table.header`). */
export const toggleHeader = (table: Block, flag: 'headerRow' | 'headerColumn') => {
	(table.data as Record<string, unknown>)[flag] = table.data[flag] !== true;
};

/** A cell's width as set, else `fallback`: `data.columns[i].width`. */
export const widthOf = (column: unknown, fallback: number): number => {
	const width = (column as { width?: unknown } | null)?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : fallback;
};

/**
 * Tab (`step` 1) or Shift+Tab (`-1`) from `cell` (`table.keys`): the caret
 * goes to the end of the next (previous) shown cell in reading order, row by
 * row; Tab in the last cell inserts a row after it and goes there (Notion).
 * Shift+Tab in the first cell keeps the caret. `false` when `cell` is no
 * shown cell.
 */
export const tabFrom = (cell: Block, step: 1 | -1): boolean => {
	const at = positionOf(cell);
	if (!at) return false;
	const { table, grid } = at;
	const { edytor } = table;
	const width = grid.columns.length;
	for (
		let i = at.row * width + at.column + step;
		i >= 0 && i < grid.rows.length * width;
		i += step
	) {
		const next = cellAt(table, grid, Math.floor(i / width), i % width);
		const text = next?.lastText;
		if (text) {
			edytor.selection.setAtTextOffset(text, text.length);
			return true;
		}
	}
	if (step > 0) insertRow(table, grid.rows.length, true);
	else edytor.selection.setAtTextOffset(cell.firstText!, 0);
	return true;
};

/**
 * ArrowUp (`step` -1) on a cell's first line, ArrowDown (`1`) on its last
 * (`table.keys`): the caret goes to the nearest shown cell above (below) in
 * the same column, at the same offset in its last (first) line. `false`
 * where no row is there: the browser moves out of the table.
 */
export const verticalFrom = (cell: Block, step: 1 | -1): boolean => {
	const at = positionOf(cell);
	const { edytor } = cell;
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	if (!at || !isCollapsed || !startText) return false;
	const value = startText.stringContent;
	const before = value.lastIndexOf('\n', yStart - 1);
	// Not on the edge line: the caret moves inside the cell.
	if (step < 0 ? before >= 0 || startText !== cell.firstText : value.indexOf('\n', yStart) >= 0)
		return false;
	if (step > 0 && startText !== cell.lastText) return false;
	const column = yStart - before - 1;
	for (let row = at.row + step; row >= 0 && row < at.grid.rows.length; row += step) {
		const target = cellAt(at.table, at.grid, row, at.column);
		const text = step < 0 ? target?.lastText : target?.firstText;
		if (!text) continue;
		const content = text.stringContent;
		const start = step < 0 ? content.lastIndexOf('\n') + 1 : 0;
		const end = step < 0 ? content.length : (content.indexOf('\n') + 1 || content.length + 1) - 1;
		edytor.selection.setAtTextOffset(text, Math.min(start + column, end));
		return true;
	}
	return false;
};
