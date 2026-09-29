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
 *
 * The runner (`random/runner.ts`) and the p1 harness (`arch-v2/p1-harness.ts`)
 * both feed {@link wellFormedProblems}; each backend supplies the inputs it
 * can answer, and a check whose input is absent is skipped.
 */

export type WfBlock = { id: string; type?: unknown; children?: readonly WfBlock[] };

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
	}
};

/** Every enabled check's problems, each prefixed with the check's name. */
export const wellFormedProblems = (input: WellFormedInput): string[] => {
	const visible = indexTree(input.roots);
	return Object.entries(WELL_FORMED_CHECKS).flatMap(([name, check]) =>
		check.enabled && !check.enabled() ? [] : check.run(input, visible).map((p) => `${name}: ${p}`)
	);
};
