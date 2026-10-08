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

	/**
	 * The table's columns and grid. A table listing none gets ids for its
	 * widest row's columns (by position) and `adopt` names each shown
	 * cell's column; the op then writes the whole `columns` array
	 * ({@link columnsSteps}): what every column op starts from.
	 */
	const adopted = (
		table: BlockId
	): {
		columns: TableColumn[];
		listed: boolean;
		adopt: PlanStep[];
		grid: NonNullable<ReturnType<typeof tableGrid>>;
	} | null => {
		const grid = tableGrid(table);
		if (grid === null) return null;
		const listed = tableColumns(table);
		if (listed !== null) return { columns: listed, listed: true, adopt: [], grid };
		const columns = grid.columns.map(() => ({ id: newId('c') }));
		const adopt: PlanStep[] = [];
		for (const row of grid.rows)
			row.cells.forEach((cell, i) => {
				if (cell === null) return;
				const steps = dataSteps(cell, [{ path: ['column'], value: columns[i]!.id }]);
				if (steps) adopt.push(...steps);
			});
		return {
			columns,
			listed: false,
			adopt,
			grid: { columns: columns.map((col) => col.id), rows: grid.rows }
		};
	};

	/** The table's `data.columns` as `whole`: by `patch` where it lists them, else written whole. */
	const columnsSteps = (
		table: BlockId,
		a: { listed: boolean; adopt: PlanStep[] },
		whole: TableColumn[],
		patch?: DataPatch
	): PlanStep[] | null => {
		const steps =
			a.listed && patch !== undefined
				? dataSteps(table, [patch])
				: a.listed
					? []
					: dataSteps(table, [{ path: ['columns'], value: whole }]);
		return steps === null ? null : [...a.adopt, ...steps];
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
		const data = columnsSteps(table, a, a.columns);
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
	 * Insert a column at `index` among `table`'s columns
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
		const whole = [...a.columns.slice(0, at), column, ...a.columns.slice(at)];
		const data = columnsSteps(table, a, whole, { path: ['columns'], splice: [at, 0, column] });
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

	/** The index of `column` (an id, or a position) among `columns`; `-1` when none. */
	const indexOf = (columns: readonly TableColumn[], column: string | number): number =>
		typeof column === 'number'
			? Number.isInteger(column) && column >= 0 && column < columns.length
				? column
				: -1
			: columns.findIndex((c) => c.id === column);

	/**
	 * Delete a column (`table.delete-column`, by id or position): it leaves
	 * `data.columns` and every shown cell of it is deleted, in one plan; a
	 * table left with no column goes with it. `ids`: the table.
	 */
	const deleteTableColumn = (table: BlockId, column: string | number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const at = indexOf(a.columns, column);
		if (at < 0) return REFUSED;
		if (a.columns.length === 1) return plan([table], [remove(table)]);
		const whole = a.columns.filter((_, i) => i !== at);
		const data = columnsSteps(table, a, whole, { path: ['columns'], splice: [at, 1] });
		if (data === null) return REFUSED;
		const gone = a.grid.rows.flatMap((row) => {
			const cell = row.cells[at];
			return cell === null || cell === undefined ? [] : [cell];
		});
		return plan([table], emptied(gone, [...data, ...gone.map((cell) => remove(cell))]));
	};

	/**
	 * Move a column to position `to` (`table.move-column`): one `order`
	 * patch of `data.columns`; no cell moves, every row shows its cells in
	 * the new order. `ids`: the table.
	 */
	const moveTableColumn = (table: BlockId, column: string | number, to: number): Prepared => {
		table = ref(table);
		if (!isTable(table) || !live(table)) return REFUSED;
		const a = adopted(table);
		if (a === null) return REFUSED;
		const from = indexOf(a.columns, column);
		const dest = Math.trunc(to);
		if (from < 0 || !(dest >= 0 && dest < a.columns.length)) return REFUSED;
		if (from === dest) {
			const same = columnsSteps(table, a, a.columns);
			return same === null ? REFUSED : plan([table], same);
		}
		const order = a.columns.map((_, i) => i);
		order.splice(from, 1);
		order.splice(dest, 0, from);
		const whole = order.map((i) => a.columns[i]!);
		const data = columnsSteps(table, a, whole, { path: ['columns'], order });
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
	 * position; `table.pad`: the first edit in a padded cell), empty, in one
	 * plan. `ids`: the new cell.
	 */
	const fillTableCell = (row: BlockId, column: string | number): Prepared => {
		row = ref(row);
		if (!isTableRow(row) || !live(row)) return REFUSED;
		const table = positionOf(row)!.parent!;
		const a = adopted(table);
		if (a === null) return REFUSED;
		// A table listing no columns names them by position until it adopts them.
		const at =
			typeof column === 'number' || !a.listed
				? indexOf(a.columns, Number(column))
				: indexOf(a.columns, column);
		const shown = a.grid.rows.find((r) => r.id === row);
		if (at < 0 || shown === undefined || shown.cells[at] !== null) return REFUSED;
		const kids = childrenIds(row);
		const slot = Math.min(shown.cells.slice(0, at).filter((x) => x !== null).length, kids.length);
		const spec = cellSpec(table, a.columns[at]!.id);
		const data = columnsSteps(table, a, a.columns);
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
