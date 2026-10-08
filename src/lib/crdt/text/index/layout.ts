/**
 * The layout rules (`layout.*`) and the table rules (`table.*`) over a
 * children index, and the role table's answers for a block's stored kind
 * they read.
 */
import type { BlockId, ChildSlot } from '../../placement/model.js';
import { encodeRank, RANK_VMAX } from '../../placement/rank.js';
import { unlistedRank } from '../../tables.js';
import type { DisplayRoles } from '../runs.js';
import type { IndexState } from './state.js';

/** The layout rules of one doc's index, over its state. */
export const indexLayout = (ix: IndexState) => {
	const { blocks, kindsOf } = ix;

	/** `ask` of `b`'s stored kind; `undefined` without roles or a record. */
	const role = <T>(b: BlockId, ask: (r: DisplayRoles, type: string) => T): T | undefined => {
		const type = blocks.get(b)?.type;
		return ix.roles === null || type === undefined ? undefined : ask(ix.roles, type);
	};
	/** The line kind of `b` when it is an island declared `lines`. */
	const lineKind = (b: BlockId): string | undefined => role(b, (r, type) => r.line(type));
	/** The item kind of `b` when it is a layout. */
	const itemKind = (b: BlockId): string | undefined => role(b, (r, type) => r.layout(type));
	/** The item kinds the roles declare. */
	const declaredItems = (): Set<string> => {
		const items = new Set<string>();
		for (const type of ix.roles?.layoutKinds() ?? []) items.add(ix.roles!.layout(type)!);
		return items;
	};
	/** The row kind of `b` when it is a table (`table.*`). */
	const rowKind = (b: BlockId): string | undefined => role(b, (r, type) => r.table(type));
	/** `table`'s row kind and that row kind's cell kind, as `[row, cell]`. */
	const rowOfTable = (table: string): [string, string] | undefined => {
		const row = ix.roles?.table(table);
		return row === undefined ? undefined : [row, ix.roles!.defaultChild(row)];
	};
	/** The row kinds (with their cell kinds) the roles declare. */
	const declaredRows = (): Map<string, string> =>
		new Map(
			[...(ix.roles?.tableKinds() ?? [])]
				.flatMap((type) => rowOfTable(type) ?? [])
				.map(([row, cell]) => [row, cell] as const)
		);
	/** The cell kind of `b` when it is a row of a table kind. */
	const cellKind = (b: BlockId): string | undefined => ix.rowKinds.get(blocks.get(b)?.type ?? '');
	/**
	 * The column ids of table `table` in their order, each with its
	 * position (`data.columns[i].id`), or `null` when it is no table or
	 * holds no `columns` array: its cells then show in their own order.
	 * Read from the record's data, memoized per data object.
	 */
	const columnsMemo = new WeakMap<object, Map<string, number> | null>();
	const columnsOf = (table: BlockId): Map<string, number> | null => {
		if (rowKind(table) === undefined) return null;
		const data = blocks.get(table)?.data;
		if (data === null || typeof data !== 'object') return null;
		let index = columnsMemo.get(data);
		if (index !== undefined) return index;
		const columns = (data as { columns?: unknown }).columns;
		index = null;
		if (Array.isArray(columns)) {
			index = new Map();
			for (const c of columns) {
				const id = (c as { id?: unknown } | null)?.id;
				if (typeof id === 'string' && !index.has(id)) index.set(id, index.size);
			}
		}
		columnsMemo.set(data, index);
		return index;
	};
	/** The column a cell names (`data.column`), if any. */
	const columnOf = (cell: BlockId): string | undefined => {
		const c = (blocks.get(cell)?.data as { column?: unknown } | null | undefined)?.column;
		return typeof c === 'string' ? c : undefined;
	};
	/**
	 * What of `b`'s data the table rules read, as one key: a table's column
	 * ids, a cell's column (`''` for any other block). A change of it
	 * re-places the table's cells.
	 */
	const tableFacts = (b: BlockId, data: unknown): string => {
		const k = kindsOf.get(b);
		if (data === null || typeof data !== 'object') return '';
		if (k?.table) {
			const columns = (data as { columns?: unknown }).columns;
			return Array.isArray(columns)
				? JSON.stringify(columns.map((c) => (c as { id?: unknown } | null)?.id ?? null))
				: '';
		}
		if (k?.cell) {
			const c = (data as { column?: unknown }).column;
			return typeof c === 'string' ? c : '';
		}
		return '';
	};
	/**
	 * The rank cell `id` displays at in row `row` (`table.columns`): its
	 * column's position in the table holding the row, so every row shows its
	 * cells in the table's column order whatever their placements (a rank
	 * of one segment, the position, ties by block id); a withdrawn cell of a
	 * column the table no longer lists after them, its column's place among
	 * those fixed by its id (`unlistedRank`); any other cell of no listed
	 * column last (it does not display, `table.cell`).
	 * `undefined`: no table with columns holds the row — its placement rank.
	 */
	const cellRank = (row: BlockId, id: BlockId): string | undefined => {
		const cell = cellKind(row);
		if (cell === undefined || blocks.get(id)?.type !== cell) return undefined;
		const table = ix.placementsMap.get(row)?.parent;
		const index = typeof table === 'string' ? columnsOf(table) : null;
		if (index === null) return undefined;
		const column = columnOf(id);
		const at = column === undefined ? undefined : index.get(column);
		if (at === undefined && column !== undefined && ix.shells.has(id))
			return encodeRank([
				{ v: RANK_VMAX - 1, t: 0 },
				{ v: unlistedRank(column), t: 0 }
			]);
		return encodeRank([{ v: at ?? RANK_VMAX, t: 0 }]);
	};
	/**
	 * The layout rules over a children index (`layout.*`): the live blocks
	 * they do not display, found in one post-order pass. A layout shows
	 * only its items (`layout.only-items`, already in the index: the
	 * layout sheds the others, `own.sheds`); an item that shows no child,
	 * or shows outside a layout, does not display and hands its children
	 * its slot (`layout.empty-item`, `layout.bare-item`); a layout showing
	 * one item or none does not display, nor does that item
	 * (`layout.single`). Each decision reads the children a node shows
	 * once its own children's were made, so one pass is the fixpoint:
	 * what a dissolve hands up is never an item (an item shows only in a
	 * layout, and a dissolving layout hands up its item's children). The
	 * decisions under a node read only its subtree and whether its parent
	 * is a layout, so a pass can start at any node (`from`).
	 */
	type Shown = { id: BlockId; kids: BlockId[] };
	/**
	 * Where a visited node stands for the table rules: directly in a table,
	 * or directly in a row of one (with the table's columns and the columns
	 * a cell already took).
	 */
	type TableCtx =
		| { table: BlockId }
		| { row: BlockId; columns: Map<string, number> | null; seen: Set<string> }
		| null;
	/**
	 * The table rules (`table.*`), in the same pass: a cell displays only in
	 * a row of a table, and, when the table lists its columns, only for a
	 * listed column — or, withdrawn by an undo while it holds another
	 * writer's text (`hist.undo.withdraw`), for the column the undo took out
	 * of the list — and as the first of the row's cells for it
	 * (`table.cell`); a row displays only in a table and while it shows a
	 * cell (`table.row`); a table displays while it shows a row
	 * (`table.empty`). What does not display hands up nothing a table rule
	 * shows: a cell's text goes with it.
	 */
	const tableVisit = (
		kids: Map<BlockId | null, ChildSlot[]>,
		out: Set<BlockId>,
		id: BlockId,
		ctx: TableCtx,
		shown: Shown[]
	): void => {
		const k = kindsOf.get(id)!;
		const childIds = (kids.get(id) ?? []).map((c) => c.id);
		const pass = (sub: Shown[]) => {
			out.add(id);
			shown.push(...sub.filter((x) => !isTableish(x.id)));
		};
		if (k.table) {
			const sub = dissolveVisit(kids, out, childIds, false, { table: id });
			if (sub.some((x) => kindsOf.get(x.id)?.row)) shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		} else if (k.row) {
			const table = ctx !== null && 'table' in ctx ? ctx.table : null;
			const sub = dissolveVisit(
				kids,
				out,
				childIds,
				false,
				table === null ? null : { row: id, columns: columnsOf(table), seen: new Set() }
			);
			if (table !== null && sub.some((x) => kindsOf.get(x.id)?.cell))
				shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		} else {
			const sub = dissolveVisit(kids, out, childIds, false, null);
			const row = ctx !== null && 'row' in ctx ? ctx : null;
			let shows = row !== null;
			if (row !== null && row.columns !== null) {
				const column = columnOf(id);
				shows =
					column !== undefined &&
					(row.columns.has(column) || ix.shells.has(id)) &&
					!row.seen.has(column);
				if (shows) row.seen.add(column!);
			}
			if (shows) shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		}
	};
	/** `b`'s kind is a table, a table's row or a row's cell. */
	const isTableish = (b: BlockId): boolean => {
		const k = kindsOf.get(b);
		return k !== undefined && (k.table || k.row || k.cell);
	};
	const dissolveVisit = (
		kids: Map<BlockId | null, ChildSlot[]>,
		out: Set<BlockId>,
		ids: readonly BlockId[],
		layout: boolean,
		ctx: TableCtx = null
	): Shown[] => {
		const isItem = (b: BlockId) => ix.itemKinds.has(blocks.get(b)?.type ?? '');
		const shown: Shown[] = [];
		for (const id of ids) {
			if (isTableish(id)) {
				tableVisit(kids, out, id, ctx, shown);
				continue;
			}
			const own = itemKind(id) !== undefined;
			const sub = dissolveVisit(
				kids,
				out,
				(kids.get(id) ?? []).map((k) => k.id),
				own
			);
			if (own) {
				if (sub.length > 1) shown.push({ id, kids: [] });
				else {
					out.add(id);
					for (const k of sub) {
						out.add(k.id);
						shown.push(...k.kids.map((kid) => ({ id: kid, kids: [] })));
					}
				}
			} else if (isItem(id) && (!layout || sub.length === 0)) {
				out.add(id);
				shown.push(...sub);
			} else shown.push({ id, kids: sub.map((k) => k.id) });
		}
		return shown;
	};
	const dissolve = (kids: Map<BlockId | null, ChildSlot[]>): Set<BlockId> => {
		const out = new Set<BlockId>();
		dissolveVisit(
			kids,
			out,
			(kids.get(null) ?? []).map((k) => k.id),
			false
		);
		return out;
	};
	/**
	 * Re-run the layout rules on the layouts `changed` (blocks whose slot
	 * in `kids0` changed, with their parents) and `kinds` reach: from each
	 * one up through layouts and items, the topmost such ancestor's
	 * subtree. Returns the blocks whose dissolved state flipped.
	 */
	const redissolve = (
		changed: Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>,
		kinds: Iterable<BlockId>
	): Set<BlockId> => {
		const flips = new Set<BlockId>();
		const isLayoutish = (b: BlockId) => {
			const k = kindsOf.get(b);
			return k !== undefined && (k.layout || k.item || k.table || k.row || k.cell);
		};
		const roots = new Set<BlockId>();
		const climb = (b: BlockId | null | undefined): void => {
			let top: BlockId | undefined;
			for (let x = b; typeof x === 'string' && isLayoutish(x); x = ix.slots0.get(x)?.parent)
				top = x;
			if (top !== undefined) roots.add(top);
		};
		for (const [id, [from, to]] of changed) {
			climb(id);
			climb(from);
			climb(to);
		}
		for (const id of kinds) {
			// Its kind decides its own rule, its parent's count and its children's (`layout`).
			climb(id);
			climb(ix.slots0.get(id)?.parent);
			for (const k of ix.kids0.get(id) ?? []) climb(k.id);
			// Only a layout, an item or a table's block dissolves: one that left those kinds shows again.
			if (!isLayoutish(id) && ix.dissolved.delete(id)) flips.add(id);
		}
		for (const root of roots) {
			if (!ix.slots0.has(root)) continue;
			const parent = ix.slots0.get(root)!.parent;
			const nodes: BlockId[] = [];
			const stack = [root];
			for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
				nodes.push(x);
				for (const k of ix.kids0.get(x) ?? []) stack.push(k.id);
			}
			const out = new Set<BlockId>();
			dissolveVisit(ix.kids0, out, [root], parent !== null && itemKind(parent) !== undefined);
			for (const x of nodes) {
				if (out.has(x) === ix.dissolved.has(x)) continue;
				if (out.has(x)) ix.dissolved.add(x);
				else ix.dissolved.delete(x);
				flips.add(x);
			}
		}
		// A block that left the index (hidden, removed) dissolves no more.
		for (const id of changed.keys())
			if (!ix.slots0.has(id) && ix.dissolved.delete(id)) flips.add(id);
		return flips;
	};

	return {
		role,
		lineKind,
		itemKind,
		rowKind,
		rowOfTable,
		declaredRows,
		cellKind,
		cellRank,
		tableFacts,
		declaredItems,
		dissolveVisit,
		dissolve,
		redissolve
	};
};

export type IndexLayout = ReturnType<typeof indexLayout>;
