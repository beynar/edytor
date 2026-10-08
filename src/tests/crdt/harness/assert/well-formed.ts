/**
 * `wellFormed` — the named semantic invariants a replica must hold after
 * every step (review 2026-09-29, oracle wave). Convergence alone cannot see
 * a *convergent-but-wrong* state; each check here names one such state:
 *
 * - `registered-type` — every visible block has a defined type the schema
 *   registers (never `''`, never `'unknown'`; UW-01: undo of a raced retype
 *   left the attr undefined and bricked rendering).
 * - `merge-order` — a merge's survivor (the target, or the source when a
 *   concurrent delete of the target revived it) is ranked before the
 *   source's former children (UW-20).
 * - `void-children` — no void kind has visible children: nothing renders
 *   them (UW-21; a concurrent child displays in the void's slot, UW-21b).
 * - `seed-displacement` — a block id keeps the registry node it was first
 *   seen with: a seed never displaces pre-existing content (UW-03).
 * - `island-kind` — an island's default child kind displays only under a
 *   block of that island kind (RW-01: a code line a peer adds under a code
 *   block another peer deletes or merges shows as its new parent's default
 *   child, and keeps doing so when it is retyped, moved, nested or split).
 *   An island holds only its default child kind, and that kind holds no
 *   children (FW-01: undo of an island delete once sealed a peer's block
 *   under a code line, where nothing renders or reaches it).
 * - `sealed-line` — a block shows in a `lines` island only when it is
 *   stored there (XW-10: deleting a line once pulled the block the FW-01
 *   rule had displaced back into the island, as a line nothing could move).
 * - `promotion-hidden` — no unmarked block hides under a delete-marked
 *   holder (UW-08: read-time promotion puts it in the holder's slot). On
 *   by default; `DST_PROMOTION_ORACLE=0` turns it off for a local bisect.
 * - `report-kind` — a view that follows only the change reports (`added`
 *   subtrees and `meta` kinds) shows every visible block with the kind the
 *   model shows (XW-08, YW-08: a derived kind the report missed left a
 *   mounted view on a stale kind).
 * - `layout-shape` — a displayed layout holds two or more displayed items
 *   of its item kind and nothing else, no displayed item is empty, and no
 *   item displays outside a layout of its kind (`layout.*` in
 *   `docs/editor-delete-contract.md`: the read-time rules own the display,
 *   so this holds after every step, races and undo included).
 * - `table-shape` — a displayed table holds displayed rows of its row kind
 *   only (one or more), a displayed row cells of its cell kind only (one
 *   or more), each of a column the table lists, once, in the table's
 *   column order; no row displays outside a table of its kind, no cell
 *   outside a row of one (`table.*`: the read-time rules own the display).
 *
 * The runner (`random/runner.ts`) and the p1 harness (`arch-v2/p1-harness.ts`)
 * both feed {@link wellFormedProblems}; each backend supplies the inputs it
 * can answer, and a check whose input is absent is skipped.
 */

export type WfBlock = {
	id: string;
	type?: unknown;
	data?: unknown;
	children?: readonly WfBlock[];
};

/** One applied merge: `from`'s content went to `into`; `kids` were `from`'s children. */
export type MergeRecord = { from: string; into: string; kids: readonly string[] };

export type WellFormedInput = {
	/** The visible tree (a projection or `toJSON().children`). */
	roots: readonly WfBlock[];
	/** Registered block types; absent → any non-empty type but `'unknown'`. */
	registered?: ReadonlySet<string>;
	/** The role answer for void kinds; absent → no roles configured. */
	isVoid?: (id: string) => boolean;
	/** Line kind → the `lines` island kind whose children it is (`island-kind`); absent → no such islands. */
	islandKinds?: ReadonlyMap<string, string>;
	/** The display owner of `id`'s stored parent (`sealed-line`); absent → the backend has no registry. */
	storedParentOf?: (id: string) => string | null;
	/** Merges whose order still holds (the caller drops ones a later move made moot). */
	merges?: readonly MergeRecord[];
	/** Registry-node identity of `id`; absent → the backend has no registry. */
	identityOf?: (id: string) => string | null;
	/** Whether node `later` was written after node `earlier` on the id's key (a redo). */
	succeeds?: (later: string, earlier: string) => boolean;
	/** First identity seen per id — the check records into it. */
	identities?: Map<string, string>;
	/** Unmarked, self-owned blocks hidden under a delete-marked holder. */
	hiddenUnderDeleted?: () => readonly string[];
	/** The kind a report-fed view holds for `id` (`report-kind`); absent → no such view. */
	reportedKind?: (id: string) => string | undefined;
	/** Layout kind → its item kind (`layout-shape`); absent → no layout kinds. */
	layouts?: ReadonlyMap<string, string>;
	/** Table kind → its row and cell kinds (`table-shape`); absent → no table kinds. */
	tables?: ReadonlyMap<string, { row: string; cell: string }>;
};

type Check = {
	enabled?: () => boolean;
	run: (input: WellFormedInput, visible: ReadonlyMap<string, WfBlock>) => string[];
};

/** Pre-order index of every visible block. */
const indexTree = (roots: readonly WfBlock[]): Map<string, WfBlock> => {
	const out = new Map<string, WfBlock>();
	const visit = (b: WfBlock) => {
		out.set(b.id, b);
		for (const c of b.children ?? []) visit(c);
	};
	for (const b of roots) visit(b);
	return out;
};

export const WELL_FORMED_CHECKS: Record<string, Check> = {
	'registered-type': {
		run: ({ registered }, visible) =>
			[...visible.values()].flatMap((b) =>
				typeof b.type !== 'string' ||
				b.type === '' ||
				(registered ? !registered.has(b.type) : b.type === 'unknown')
					? [`${b.id} has type ${JSON.stringify(b.type)}`]
					: []
			)
	},
	'merge-order': {
		run: ({ merges }, visible) => {
			if (!merges) return [];
			const at = new Map([...visible.keys()].map((id, i) => [id, i]));
			return merges.flatMap(({ from, into, kids }) => {
				const survivor = at.has(into) ? into : at.has(from) ? from : null;
				if (survivor === null) return [];
				return kids.flatMap((kid) =>
					at.has(kid) && at.get(kid)! < at.get(survivor)!
						? [`${kid} (child of merged ${from}) ranks before ${survivor}`]
						: []
				);
			});
		}
	},
	'void-children': {
		run: ({ isVoid }, visible) =>
			isVoid
				? [...visible.values()].flatMap((b) =>
						b.children?.length && isVoid(b.id) ? [`void ${b.id} has visible children`] : []
					)
				: []
	},
	'island-kind': {
		run: ({ islandKinds, roots }) => {
			if (!islandKinds?.size) return [];
			const out: string[] = [];
			const lineOf = new Map([...islandKinds].map(([line, island]) => [island, line]));
			const visit = (b: WfBlock, parent: WfBlock | null) => {
				const island = typeof b.type === 'string' ? islandKinds.get(b.type) : undefined;
				const line = typeof parent?.type === 'string' ? lineOf.get(parent.type) : undefined;
				if (island !== undefined && parent?.type !== island)
					out.push(`${b.id} shows ${String(b.type)} outside a ${island}`);
				if (typeof parent?.type === 'string' && islandKinds.has(parent.type))
					out.push(`${b.id} sits under the ${parent.type} ${parent.id}`);
				if (line !== undefined && b.type !== line)
					out.push(`${b.id} shows ${String(b.type)} inside a ${String(parent!.type)}`);
				for (const c of b.children ?? []) visit(c, b);
			};
			for (const b of roots) visit(b, null);
			return out;
		}
	},
	'sealed-line': {
		run: ({ islandKinds, storedParentOf }, visible) => {
			if (!islandKinds?.size || !storedParentOf) return [];
			const lined = new Set(islandKinds.values());
			return [...visible.values()].flatMap((island) =>
				typeof island.type === 'string' && lined.has(island.type)
					? (island.children ?? []).flatMap((b) => {
							const stored = storedParentOf(b.id);
							return stored === island.id
								? []
								: [
										`${b.id} shows in the ${island.type} ${island.id} but is stored under ${stored}`
									];
						})
					: []
			);
		}
	},
	'seed-displacement': {
		run: ({ identityOf, identities, succeeds = () => false }, visible) => {
			if (!identityOf || !identities) return [];
			const out: string[] = [];
			for (const id of visible.keys()) {
				const now = identityOf(id);
				if (now === null) continue;
				const first = identities.get(id);
				if (first === undefined) identities.set(id, now);
				else if (first !== now && !succeeds(now, first))
					out.push(`${id} was node ${first}, now ${now}`);
			}
			return out;
		}
	},
	'promotion-hidden': {
		enabled: () => process.env.DST_PROMOTION_ORACLE !== '0',
		run: ({ hiddenUnderDeleted }) =>
			(hiddenUnderDeleted?.() ?? []).map((id) => `${id} hidden under a deleted holder`)
	},
	'layout-shape': {
		run: ({ layouts, roots }) => {
			if (!layouts?.size) return [];
			const items = new Set(layouts.values());
			const out: string[] = [];
			const visit = (b: WfBlock, parent: WfBlock | null) => {
				const type = typeof b.type === 'string' ? b.type : '';
				const item = layouts.get(type);
				const kids = b.children ?? [];
				if (item !== undefined) {
					if (kids.length < 2) out.push(`layout ${b.id} shows ${kids.length} item(s)`);
					for (const k of kids)
						if (k.type !== item) out.push(`${k.id} shows ${String(k.type)} in the layout ${b.id}`);
				}
				if (items.has(type)) {
					if (kids.length === 0) out.push(`item ${b.id} shows no child`);
					const holder = typeof parent?.type === 'string' ? layouts.get(parent.type) : undefined;
					if (holder !== type) out.push(`item ${b.id} shows outside a layout`);
				}
				for (const c of kids) visit(c, b);
			};
			for (const b of roots) visit(b, null);
			return out;
		}
	},
	'table-shape': {
		run: ({ tables, roots }) => {
			if (!tables?.size) return [];
			const rows = new Map([...tables].map(([table, k]) => [k.row, table]));
			const cells = new Map([...tables].map(([, k]) => [k.cell, k.row]));
			const out: string[] = [];
			const typeOf = (b: WfBlock | null) => (typeof b?.type === 'string' ? b.type : '');
			const columnsOf = (b: WfBlock): string[] | null => {
				const columns = (b.data as { columns?: unknown } | undefined)?.columns;
				return Array.isArray(columns)
					? columns.map((c) => String((c as { id?: unknown } | null)?.id))
					: null;
			};
			const visit = (b: WfBlock, parent: WfBlock | null, grand: WfBlock | null) => {
				const type = typeOf(b);
				const kids = b.children ?? [];
				const table = tables.get(type);
				if (table !== undefined) {
					if (kids.length === 0) out.push(`table ${b.id} shows no row`);
					for (const k of kids)
						if (k.type !== table.row)
							out.push(`${k.id} shows ${String(k.type)} in the table ${b.id}`);
				}
				if (rows.has(type)) {
					if (typeOf(parent) !== rows.get(type)) out.push(`row ${b.id} shows outside a table`);
					if (kids.length === 0) out.push(`row ${b.id} shows no cell`);
					const cell = tables.get(rows.get(type)!)!.cell;
					for (const k of kids)
						if (k.type !== cell) out.push(`${k.id} shows ${String(k.type)} in the row ${b.id}`);
					const listed = parent === null ? null : columnsOf(parent);
					if (listed !== null) {
						const at = kids.map((k) =>
							listed.indexOf(String((k.data as { column?: unknown } | undefined)?.column))
						);
						if (at.some((i) => i < 0)) out.push(`row ${b.id} shows a cell of no listed column`);
						if (at.some((i, j) => j > 0 && i <= at[j - 1]!))
							out.push(`row ${b.id} shows its cells out of column order or twice`);
					}
				}
				if (cells.has(type) && (typeOf(parent) !== cells.get(type) || !tables.has(typeOf(grand))))
					out.push(`cell ${b.id} shows outside a table’s row`);
				for (const c of kids) visit(c, b, parent);
			};
			for (const b of roots) visit(b, null, null);
			return out;
		}
	},
	'report-kind': {
		run: ({ reportedKind }, visible) =>
			reportedKind
				? [...visible.values()].flatMap((b) => {
						const view = reportedKind(b.id);
						return view === b.type ? [] : [`${b.id}: view ${view}, model ${String(b.type)}`];
					})
				: []
	}
};

/** Every enabled check's problems, each prefixed with the check's name. */
export const wellFormedProblems = (input: WellFormedInput): string[] => {
	const visible = indexTree(input.roots);
	return Object.entries(WELL_FORMED_CHECKS).flatMap(([name, check]) =>
		check.enabled && !check.enabled() ? [] : check.run(input, visible).map((p) => `${name}: ${p}`)
	);
};
