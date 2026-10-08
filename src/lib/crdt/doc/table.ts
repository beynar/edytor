/**
 * Table ops (`table.*`): a table (a kind whose role says `table`) holds
 * rows, a row cells, each cell names its column (`data.column`) and the
 * table lists its columns in order (`data.columns`: `{ id, width? }`). The
 * columns are data: inserting, deleting or moving one writes the table's
 * `columns` array (and the cells of the rows it shows) in one plan, and
 * the index shows every row's cells in that order (`table.columns`); a
 * cell of no listed column does not display (`table.cell`), and the view
 * pads a row that shows fewer cells than the table's columns
 * (`table.pad`). Rows are blocks: a row moves among its table's rows by
 * placement.
 */
import { id as newId } from '../../utils.js';
import type { BlockId, BlockSpec } from '../placement/model.js';
import type { DataPatch } from '../data.js';
import { ref } from './plan.js';
import type { DataTarget, PlanStep, Prepared } from './types.js';
import type { OpsContext } from './steps.js';

/** One column of a table's `data.columns`. */
export type TableColumn = { id: string; width?: number };

/** The table ops of one facade, prepared. */
export const tableOps = (
	c: OpsContext & {
		dataSteps: (target: DataTarget, patches: DataPatch[]) => PlanStep[] | null;
	}
) => {
	const {
		roles,
		childrenIds,
		positionOf,
		live,
		isTable,
		isTableRow,
		rowKindOf,
		tableColumns,
		tableGrid,
		blockDataOf,
		dataItemIds,
		REFUSED,
		plan,
		ranksFor,
		move,
		remove,
		emptied,
		dataSteps
	} = c;

	/** The cell kind of `table`'s rows. */
	const cellKindOf = (table: BlockId): string => roles.defaultChild(rowKindOf(table)!);
	const cellSpec = (table: BlockId, column: string): BlockSpec => ({
		id: newId('b'),
		type: cellKindOf(table),
		data: { column }
	});

	type Adopted = {
		/** The columns the table lists (deduplicated), after the adoption. */
		columns: TableColumn[];
		/** The column each entry of the stored `data.columns` names, in order (`null`: none). */
		raw: (string | null)[];
		/** The cells' column writes of an adoption. */
		adopt: PlanStep[];
		/** The adoption's write of the whole `columns` array (none when the table lists them). */
		first: DataPatch[];
		/** The grid: the listed columns, then those it shows unlisted (`table.cell`). */
		grid: NonNullable<ReturnType<typeof tableGrid>>;
	};
	/**
	 * The table's columns and grid. A table listing none gets one column
	 * per column of its widest row, with ids from their positions (`c1`,
	 * `c2`, … as `tableBlock`'s), and `adopt` names each shown
	 * cell's column: two peers adopting one table write the same array
	 * items and the same cells' columns. The op then writes that array
	 * first, in its plan ({@link columnsSteps}).
	 */
	const adopted = (table: BlockId): Adopted | null => {
		const grid = tableGrid(table);
		if (grid === null) return null;
		const listed = tableColumns(table);
		if (listed !== null) {
			const stored = blockDataOf(table)?.columns as unknown[];
			const raw = stored.map((col) => {
				const id = (col as { id?: unknown } | null)?.id;
				return typeof id === 'string' ? id : null;
			});
			return { columns: listed, raw, adopt: [], first: [], grid };
		}
		const columns = grid.columns.map((_, i) => ({ id: `c${i + 1}` }));
		const adopt: PlanStep[] = [];
		for (const row of grid.rows)
			row.cells.forEach((cell, i) => {
				if (cell === null) return;
				const steps = dataSteps(cell, [{ path: ['column'], value: columns[i]!.id }]);
				if (steps) adopt.push(...steps);
			});
		return {
			columns,
			raw: columns.map((col) => col.id),
			adopt,
			first: [{ path: ['columns'], value: columns }],
			grid: { columns: columns.map((col) => col.id), rows: grid.rows }
		};
	};

	/** The adoption's steps, then `patches` of the table's `data.columns`. */
	const columnsSteps = (
		table: BlockId,
		a: Adopted,
		patches: DataPatch[] = []
	): PlanStep[] | null => {
		const all = [...a.first, ...patches];
		const steps = all.length === 0 ? [] : dataSteps(table, all);
		return steps === null ? null : [...a.adopt, ...steps];
	};

	/**
	 * The position among the grid's columns of `column`: a position, or an
	 * id (a table listing no columns names them by position until it adopts
	 * them); `-1` when none.
	 */
	const positionIn = (a: Adopted, listed: boolean, column: string | number): number => {
		const at =
			typeof column === 'number'
				? column
				: listed
					? a.grid.columns.indexOf(column)
					: Number(column);
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

	/**
	 * Insert a row at `index` among `table`'s rows (`table.insert-row`): one
	 * empty cell per column, in one plan. An insert's rank (it extends this
	 * client's run, `order.insert.run`). `ids`: the new row.
	 */
	const insertTableRow = (table: BlockId, index: number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const rows = childrenIds(table);
		const at = Math.max(0, Math.min(Math.trunc(index) || 0, rows.length));
		const row: BlockSpec = {
			id: newId('b'),
			type: rowKindOf(table)!,
			data: {},
			children: a.columns.map((col) => cellSpec(table, col.id))
		};
		const ranks = ranksFor(table, at, 1, [], true);
		const data = columnsSteps(table, a);
		if (data === null) return REFUSED;
		return plan(
			[row.id],
			[...data, { op: 'insertBlocks', parent: table, index: at, specs: [row], ranks }]
		);
	};

	/**
	 * Delete `rows` with their cells (`table.delete-row`): one plan; a table
	 * left with no row goes with them.
	 */
	const deleteTableRows = (rows: readonly BlockId[]): Prepared => {
		const ids = [...new Set(rows.map(ref))];
		if (ids.length === 0 || ids.some((id) => !live(id) || !isTableRow(id))) return REFUSED;
		return plan(
			ids,
			emptied(
				ids,
				ids.map((id) => remove(id))
			)
		);
	};

	/**
	 * Insert a column at `index` among `table`'s listed columns
	 * (`table.insert-column`): a new id in `data.columns` and an empty cell
	 * for it in every row the table shows, in one plan. `width`: the new
	 * column's. `ids`: the table.
	 */
	const insertTableColumn = (table: BlockId, index: number, width?: number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const at = Math.max(0, Math.min(Math.trunc(index) || 0, a.columns.length));
		const column: TableColumn =
			typeof width === 'number' && Number.isFinite(width) && width > 0
				? { id: newId('c'), width }
				: { id: newId('c') };
		const data = columnsSteps(table, a, [
			{ path: ['columns'], splice: [rawIndex(a, at), 0, column] }
		]);
		if (data === null) return REFUSED;
		const cells: PlanStep[] = a.grid.rows.map((row) => {
			const kids = childrenIds(row.id);
			const slot = Math.min(row.cells.slice(0, at).filter((x) => x !== null).length, kids.length);
			return {
				op: 'insertBlocks',
				parent: row.id,
				index: slot,
				specs: [cellSpec(table, column.id)],
				ranks: ranksFor(row.id, slot, 1)
			};
		});
		return plan([table], [...data, ...cells]);
	};

	/**
	 * Delete a column (`table.delete-column`, by id or position among the
	 * grid's): it leaves `data.columns` (every entry naming it) and every
	 * shown cell of it is deleted, in one plan; a table left with no column
	 * goes with it. A column the table shows but no longer lists
	 * (`table.cell`) loses its cells. `ids`: the table.
	 */
	const deleteTableColumn = (table: BlockId, column: string | number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const listed = tableColumns(table) !== null;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const at = positionIn(a, listed, column);
		if (at < 0) return REFUSED;
		if (a.grid.columns.length === 1) return plan([table], [remove(table)]);
		const id = a.grid.columns[at]!;
		const items = listed ? dataItemIds(table, ['columns']) : [];
		const entries = listed
			? a.raw.flatMap((c, i) => (c === id && items[i] ? [items[i]!] : []))
			: [];
		const data = columnsSteps(
			table,
			a,
			listed
				? entries.map((item) => ({ path: ['columns', item] }))
				: [{ path: ['columns'], splice: [at, 1] }]
		);
		if (data === null) return REFUSED;
		const gone = a.grid.rows.flatMap((row) => {
			const cell = row.cells[at];
			return cell === null || cell === undefined ? [] : [cell];
		});
		return plan([table], emptied(gone, [...data, ...gone.map((cell) => remove(cell))]));
	};

	/**
	 * Move a listed column to position `to` among them (`table.move-column`):
	 * one `order` patch of `data.columns`; no cell moves, every row shows its
	 * cells in the new order. `ids`: the table.
	 */
	const moveTableColumn = (table: BlockId, column: string | number, to: number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const listed = tableColumns(table) !== null;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const from = positionIn(a, listed, column);
		const dest = Math.trunc(to);
		if (from < 0 || from >= a.columns.length || !(dest >= 0 && dest < a.columns.length))
			return REFUSED;
		if (from === dest) {
			const same = columnsSteps(table, a);
			return same === null ? REFUSED : plan([table], same);
		}
		const moved = a.columns.map((_, i) => i);
		moved.splice(from, 1);
		moved.splice(dest, 0, from);
		// Over the stored entries: the listed ones in their new order, then the rest as they were.
		const firsts = moved.map((i) => rawIndex(a, i));
		const rest = a.raw.map((_, i) => i).filter((i) => !firsts.includes(i));
		const data = columnsSteps(table, a, [{ path: ['columns'], order: [...firsts, ...rest] }]);
		return data === null ? REFUSED : plan([table], data);
	};

	/**
	 * Move rows to position `to` among their table's rows
	 * (`table.move-row`): a move (plain ranks). Refused unless every one is
	 * a row of `table`. `ids`: the rows.
	 */
	const moveTableRows = (rows: readonly BlockId[], to: number): Prepared => {
		const ids = rows.map(ref);
		const table = ids.length > 0 ? positionOf(ids[0]!)?.parent : null;
		if (table == null || ids.some((id) => !isTableRow(id) || positionOf(id)!.parent !== table))
			return REFUSED;
		const at = Math.max(0, Math.min(Math.trunc(to) || 0, childrenIds(table).length));
		return plan(ids, move(ids, table, at));
	};

	/**
	 * Create the cell `row` shows none of for `column` (an id, or a
	 * position among the grid's; `table.pad`: the first edit in a padded
	 * cell), empty, in one plan. A column the table shows but no longer
	 * lists (`table.cell`) is listed again, last. `ids`: the new cell.
	 */
	const fillTableCell = (row: BlockId, column: string | number): Prepared => {
		row = ref(row);
		if (!isTableRow(row) || !live(row)) return REFUSED;
		const table = positionOf(row)!.parent!;
		const listed = tableColumns(table) !== null;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const at = positionIn(a, listed, column);
		const shown = a.grid.rows.find((r) => r.id === row);
		if (at < 0 || shown === undefined || shown.cells[at] !== null) return REFUSED;
		const kids = childrenIds(row);
		const slot = Math.min(shown.cells.slice(0, at).filter((x) => x !== null).length, kids.length);
		const id = a.grid.columns[at]!;
		const spec = cellSpec(table, id);
		const data = columnsSteps(
			table,
			a,
			at < a.columns.length ? [] : [{ path: ['columns'], splice: [a.raw.length, 0, { id }] }]
		);
		if (data === null) return REFUSED;
		return plan(
			[spec.id],
			[
				...data,
				{
					op: 'insertBlocks',
					parent: row,
					index: slot,
					specs: [spec],
					ranks: ranksFor(row, slot, 1)
				}
			]
		);
	};

	return {
		insertTableRow,
		deleteTableRows,
		insertTableColumn,
		deleteTableColumn,
		moveTableColumn,
		moveTableRows,
		fillTableCell
	};
};
