/**
 * The table ops (`table.*`), prepared over any document's public
 * operations (a view's `edytor.document`, a headless document, a room's
 * `transact`): each answers one plan composed of the document's own
 * (`patchData`, `insertBlocks`, `deleteBlocks`, `moveBlocks`), which
 * `document.apply(…)` writes (`document.apply(insertTableRow(document,
 * 'T', 0))`), or a refusal. A table (a kind whose role says `table`) holds
 * rows, a row cells, each cell names its column (`data.column`) and the
 * table lists its columns in order (`data.columns`: `{ id, width? }`). The
 * columns are data: inserting, deleting or moving one writes the table's
 * `columns` array (and the cells of the rows it shows) in one plan, and
 * the index shows every row's cells in that order (`table.columns`); a
 * cell of no listed column does not display (`table.cell`), and the view
 * pads a row that shows fewer cells than the table's columns
 * (`table.pad`). Rows are blocks: a row moves among its table's rows by
 * placement. No core code references these: the table plugin's commands
 * dispatch them (`table.ts`).
 */
import { id as newId } from '$lib/utils.js';
import { columnIds } from '$lib/crdt/tables.js';
import { ref, refused } from '$lib/crdt/doc/plan.js';
import type { DataPatch } from '$lib/crdt/data.js';
import type { BlockId, BlockSpec } from '$lib/crdt/placement/model.js';
import type { DocumentOperations } from '$lib/crdt/operations.js';
import type { Prepared } from '$lib/crdt/doc/types.js';

/** One column of a table's `data.columns`. */
type TableColumn = { id: string; width?: number };

/** A document's operations: an `EdytorDocument`, a view's facade, a room's `transact` callback's. */
type Doc = Omit<DocumentOperations, 'transact'>;

const REFUSED = refused(null);

type Adopted = {
	/** The columns the table lists (deduplicated), after the adoption. */
	columns: TableColumn[];
	/** The column each entry of the stored `data.columns` names, in order (`null`: none). */
	raw: (string | null)[];
	/** The cells' column writes of an adoption. */
	adopt: Prepared[];
	/** The adoption's write of the whole `columns` array (none when the table lists them). */
	first: DataPatch[];
	/** The grid: the listed columns, then those it shows unlisted (`table.cell`). */
	grid: NonNullable<ReturnType<DocumentOperations['tableGrid']>>;
	/** The table's row and cell kinds, as its shown blocks are (a shown table shows a row, a row a cell). */
	row: string;
	cell: string;
};

/**
 * The table's columns and grid. A table listing none gets one column
 * per column of its widest row, with ids from their positions (`c1`,
 * `c2`, … as `tableBlock`'s), and `adopt` names each shown cell's column:
 * two peers adopting one table write the same array items and the same
 * cells' columns. The op then writes that array first, in its plan
 * ({@link columnsParts}).
 */
const adopted = (doc: Doc, table: BlockId): Adopted | null => {
	const grid = doc.tableGrid(table);
	const head = grid?.rows[0];
	const sample = head?.cells.find((cell) => cell !== null);
	if (!grid || !head || !sample) return null;
	const kinds = { row: doc.blockTypeOf(head.id)!, cell: doc.blockTypeOf(sample)! };
	const listed = doc.tableColumns(table);
	if (listed !== null)
		return {
			columns: listed,
			raw: columnIds(doc.blockDataOf(table))!,
			adopt: [],
			first: [],
			grid,
			...kinds
		};
	const columns = grid.columns.map((_, i) => ({ id: `c${i + 1}` }));
	return {
		columns,
		raw: columns.map((col) => col.id),
		adopt: grid.rows.flatMap((row) =>
			row.cells.flatMap((cell, i) =>
				cell === null
					? []
					: [doc.prepare.patchData(cell, [{ path: ['column'], value: columns[i]!.id }])]
			)
		),
		first: [{ path: ['columns'], value: columns }],
		grid: { columns: columns.map((col) => col.id), rows: grid.rows },
		...kinds
	};
};

/** The adoption's plans, then `patches` of the table's `data.columns` (one plan, empty without any). */
const columnsParts = (
	doc: Doc,
	table: BlockId,
	a: Adopted,
	patches: DataPatch[] = []
): Prepared[] => [...a.adopt, doc.prepare.patchData(table, [...a.first, ...patches])];

/** `parts` as one plan answering `ids` (a composed plan answers its parts'). */
const planOf = (doc: Doc, ids: readonly BlockId[], parts: Prepared[]): Prepared => {
	const p = doc.compose(...parts);
	return 'writes' in p ? { ...p, ids } : p;
};

const cellSpec = (a: Adopted, column: string): BlockSpec => ({
	id: newId('b'),
	type: a.cell,
	data: { column }
});

/**
 * The position among the grid's columns of `column`: a position, or an
 * id (a table listing no columns names them by position until it adopts
 * them); `-1` when none.
 */
const positionIn = (a: Adopted, listed: boolean, column: string | number): number => {
	const at =
		typeof column === 'number' ? column : listed ? a.grid.columns.indexOf(column) : Number(column);
	return Number.isInteger(at) && at >= 0 && at < a.grid.columns.length ? at : -1;
};

/**
 * The stored entry (its index in `data.columns`) the listed column at
 * position `at` is: the first naming it; the array's length past them.
 */
const rawIndex = (a: Adopted, at: number): number => {
	const id = a.columns[at]?.id;
	const i = id === undefined ? -1 : a.raw.indexOf(id);
	return i < 0 ? a.raw.length : i;
};

/** Where among `row`'s children a new cell at grid position `at` goes. */
const slotOf = (doc: Doc, cells: readonly (BlockId | null)[], row: BlockId, at: number) =>
	Math.min(cells.slice(0, at).filter((x) => x !== null).length, doc.childrenIds(row).length);

/**
 * Insert a row at `index` among `table`'s rows (`table.insert-row`): one
 * empty cell per column, in one plan. `ids`: the new row.
 */
export const insertTableRow = (
	doc: Omit<DocumentOperations, 'transact'>,
	table: BlockId,
	index: number
): Prepared => {
	table = ref(table);
	const a = adopted(doc, table);
	if (a === null) return REFUSED;
	const at = Math.max(0, Math.min(Math.trunc(index) || 0, doc.childrenIds(table).length));
	const row: BlockSpec = {
		id: newId('b'),
		type: a.row,
		data: {},
		children: a.columns.map((col) => cellSpec(a, col.id))
	};
	return planOf(
		doc,
		[row.id],
		[...columnsParts(doc, table, a), doc.prepare.insertBlocks({ parent: table, index: at }, [row])]
	);
};

/**
 * Delete `rows` with their cells (`table.delete-row`): one plan; a table
 * left with no row goes with them. `ids`: the rows.
 */
export const deleteTableRows = (
	doc: Omit<DocumentOperations, 'transact'>,
	rows: readonly BlockId[]
): Prepared => {
	const ids = [...new Set(rows.map(ref))];
	if (ids.length === 0 || ids.some((id) => !doc.isVisibleBlock(id) || !doc.isTableRow(id)))
		return REFUSED;
	return doc.prepare.deleteBlocks(ids);
};

/**
 * Insert a column at `index` among `table`'s listed columns
 * (`table.insert-column`): a new id in `data.columns` and an empty cell
 * for it in every row the table shows, in one plan. `width`: the new
 * column's. `ids`: the table.
 */
export const insertTableColumn = (
	doc: Omit<DocumentOperations, 'transact'>,
	table: BlockId,
	index: number,
	width?: number
): Prepared => {
	table = ref(table);
	const a = adopted(doc, table);
	if (a === null) return REFUSED;
	const at = Math.max(0, Math.min(Math.trunc(index) || 0, a.columns.length));
	const column: TableColumn =
		typeof width === 'number' && Number.isFinite(width) && width > 0
			? { id: newId('c'), width }
			: { id: newId('c') };
	return planOf(
		doc,
		[table],
		[
			...columnsParts(doc, table, a, [{ path: ['columns'], splice: [rawIndex(a, at), 0, column] }]),
			...a.grid.rows.map((row) =>
				doc.prepare.insertBlocks({ parent: row.id, index: slotOf(doc, row.cells, row.id, at) }, [
					cellSpec(a, column.id)
				])
			)
		]
	);
};

/**
 * Delete a column (`table.delete-column`, by id or position among the
 * grid's): it leaves `data.columns` (every entry naming it) and every
 * shown cell of it is deleted, in one plan; a table left with no column
 * goes with it. A column the table shows but no longer lists
 * (`table.cell`) loses its cells. `ids`: the table.
 */
export const deleteTableColumn = (
	doc: Omit<DocumentOperations, 'transact'>,
	table: BlockId,
	column: string | number
): Prepared => {
	table = ref(table);
	const listed = doc.tableColumns(table) !== null;
	const a = adopted(doc, table);
	if (a === null) return REFUSED;
	const at = positionIn(a, listed, column);
	if (at < 0) return REFUSED;
	if (a.grid.columns.length === 1) return doc.prepare.deleteBlock(table, { keepChildren: false });
	const id = a.grid.columns[at]!;
	const items = listed ? doc.dataItemIds(table, ['columns']) : [];
	const gone = a.grid.rows.flatMap((row) => row.cells[at] ?? []);
	return planOf(
		doc,
		[table],
		[
			...columnsParts(
				doc,
				table,
				a,
				listed
					? a.raw.flatMap((c, i) =>
							c === id && items[i] ? [{ path: ['columns', items[i]!] }] : []
						)
					: [{ path: ['columns'], splice: [at, 1] }]
			),
			doc.prepare.deleteBlocks(gone)
		]
	);
};

/**
 * Move a listed column to position `to` among them (`table.move-column`):
 * one `order` patch of `data.columns`; no cell moves, every row shows its
 * cells in the new order. `ids`: the table.
 */
export const moveTableColumn = (
	doc: Omit<DocumentOperations, 'transact'>,
	table: BlockId,
	column: string | number,
	to: number
): Prepared => {
	table = ref(table);
	const listed = doc.tableColumns(table) !== null;
	const a = adopted(doc, table);
	if (a === null) return REFUSED;
	const from = positionIn(a, listed, column);
	const dest = Math.trunc(to);
	if (from < 0 || from >= a.columns.length || !(dest >= 0 && dest < a.columns.length))
		return REFUSED;
	if (from === dest) return planOf(doc, [table], columnsParts(doc, table, a));
	const moved = a.columns.map((_, i) => i);
	moved.splice(from, 1);
	moved.splice(dest, 0, from);
	// Over the stored entries: the listed ones in their new order, then the rest as they were.
	const firsts = moved.map((i) => rawIndex(a, i));
	const rest = a.raw.map((_, i) => i).filter((i) => !firsts.includes(i));
	return planOf(
		doc,
		[table],
		columnsParts(doc, table, a, [{ path: ['columns'], order: [...firsts, ...rest] }])
	);
};

/**
 * Move rows to position `to` among their table's rows
 * (`table.move-row`): a move. Refused unless every one is a row of the
 * same table. `ids`: the rows.
 */
export const moveTableRows = (
	doc: Omit<DocumentOperations, 'transact'>,
	rows: readonly BlockId[],
	to: number
): Prepared => {
	const ids = rows.map(ref);
	const table = ids.length > 0 ? doc.parentOf(ids[0]!) : null;
	if (table === null || ids.some((id) => !doc.isTableRow(id) || doc.parentOf(id) !== table))
		return REFUSED;
	const at = Math.max(0, Math.min(Math.trunc(to) || 0, doc.childrenIds(table).length));
	return doc.prepare.moveBlocks(ids, { parent: table, index: at });
};

/**
 * Create the cell `row` shows none of for `column` (an id, or a
 * position among the grid's; `table.pad`: the first edit in a padded
 * cell), empty, in one plan. A column the table shows but no longer
 * lists (`table.cell`) is listed again, last. `ids`: the new cell.
 */
export const fillTableCell = (
	doc: Omit<DocumentOperations, 'transact'>,
	row: BlockId,
	column: string | number
): Prepared => {
	row = ref(row);
	if (!doc.isTableRow(row)) return REFUSED;
	const table = doc.parentOf(row)!;
	const listed = doc.tableColumns(table) !== null;
	const a = adopted(doc, table);
	if (a === null) return REFUSED;
	const at = positionIn(a, listed, column);
	const shown = a.grid.rows.find((r) => r.id === row);
	if (at < 0 || shown === undefined || shown.cells[at] !== null) return REFUSED;
	const id = a.grid.columns[at]!;
	const spec = cellSpec(a, id);
	return planOf(
		doc,
		[spec.id],
		[
			...columnsParts(
				doc,
				table,
				a,
				at < a.columns.length ? [] : [{ path: ['columns'], splice: [a.raw.length, 0, { id }] }]
			),
			doc.prepare.insertBlocks({ parent: row, index: slotOf(doc, shown.cells, row, at) }, [spec])
		]
	);
};
