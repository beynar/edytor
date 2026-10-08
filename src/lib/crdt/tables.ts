/**
 * A new table as JSON (`table.*`): the bundled kinds (`tableKinds`), its
 * columns listed in `data.columns` with ids derived from their position
 * (`c1`, `c2`, …: a seed of the same value writes the same table), each
 * cell naming its column. Worker-safe.
 */
import type { JSONBlock, JSONText } from '../utils/json.js';
import { hash32 } from './rand.js';

/**
 * Where a column a table shows but no longer lists stands among those
 * (`table.cell`: a withdrawn cell holding another writer's text keeps the
 * column an undo took out of `data.columns`): after the listed ones, by a
 * hash of its id, then its id. Every replica, row and reader orders them
 * the same.
 */
export const unlistedRank = (column: string): number => hash32(column);

/** The unlisted columns `ids` in their shown order ({@link unlistedRank}). */
export const unlistedOrder = (ids: Iterable<string>): string[] =>
	[...new Set(ids)].sort(
		(a, b) => unlistedRank(a) - unlistedRank(b) || (a < b ? -1 : a > b ? 1 : 0)
	);

/** What {@link tableBlock} builds. */
export type TableBlockOptions = {
	/** Rows (default: the rows of `cells`, else 2). */
	rows?: number;
	/** Columns (default: the widest row of `cells`, else 2). */
	columns?: number;
	/** Each cell's text, by row then column (a string, or rich text). */
	cells?: readonly (readonly (string | readonly JSONText[])[])[];
	/** The first row is a header row. */
	headerRow?: boolean;
	/** The first column is a header column. */
	headerColumn?: boolean;
	/** Column widths in pixels, by position (absent: the default width). */
	widths?: readonly (number | undefined)[];
};

/**
 * A table block in the document JSON: `rows × columns` cells, the table's
 * `columns` and each cell's `column` set. It names no block id, so a value
 * holding it seeds the same table every time.
 *
 * ```ts
 * createDocument({
 * 	value: { children: [tableBlock({ cells: [['Name', 'Role'], ['Ada', 'Eng']], headerRow: true })] }
 * });
 * ```
 */
export const tableBlock = (options: TableBlockOptions = {}): JSONBlock => {
	const { cells = [], headerRow, headerColumn, widths = [] } = options;
	const rows = Math.max(1, Math.trunc(options.rows ?? (cells.length || 2)));
	const count = Math.max(
		1,
		Math.trunc(options.columns ?? (Math.max(0, ...cells.map((r) => r.length)) || 2))
	);
	const columns = Array.from({ length: count }, (_, i): Record<string, string | number> => {
		const width = widths[i];
		return typeof width === 'number' && width > 0
			? { id: `c${i + 1}`, width }
			: { id: `c${i + 1}` };
	});
	const text = (value: string | readonly JSONText[] | undefined): JSONText[] =>
		value === undefined || value === ''
			? []
			: typeof value === 'string'
				? [{ text: value }]
				: value.map((t) => ({ ...t }));
	return {
		type: 'table',
		data: {
			columns,
			...(headerRow === true && { headerRow: true }),
			...(headerColumn === true && { headerColumn: true })
		},
		children: Array.from({ length: rows }, (_, r) => ({
			type: 'tableRow',
			data: {},
			children: columns.map((column, c) => {
				const content = text(cells[r]?.[c]);
				return {
					type: 'tableCell',
					data: { column: column.id },
					...(content.length > 0 && { content })
				};
			})
		}))
	};
};
