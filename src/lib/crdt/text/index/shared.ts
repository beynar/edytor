/**
 * The index's module-level helpers: the facets a changed attr enters
 * through, payload reads, run equality, the role shape a retype compares,
 * and the self-check switch.
 */
import { cloneJsonSafe } from '../../../utils/json.js';
import type { EngineNode } from '../../engine-api.js';
import type { BlockId, BlockRec } from '../../placement/model.js';
import { CONTENT, DATA, DATA_LEAF_PREFIX, ID, LAST_CHANGED_ATTR, TYPE } from '../../schema.js';
import type { ContentRun, DisplayRoles } from '../runs.js';
import type { SelfChecks } from './state.js';

/**
 * The facet name of a block's registry entry itself (inserted or removed) —
 * every other facet is named by the block attr it entered through.
 */
export const ENTRY_FACET = '';

/** The facet name of a write to a block's `content` attr itself (a streamless block's own text). */
export const CONTENT_ATTR = '#content';
/**
 * The facet name of a write to a block's sequence (fork patch YP22): its
 * children's home slots, its data arrays' item slots and its move records.
 */
export const SEQ_FACET = '#seq';
/** The facet the fold adds when a sequence write changed the block's data (its arrays' items). */
export const DATA_SEQ_FACET = '#data';

/**
 * Facets of a block node that can change derived state: `content` (a
 * sequence edit of the block's own text), `structure` (claims, delete marks,
 * the nonce, the `content` attr, unknown attrs), `seq` (its sequence: slots
 * and records — placements and order, or its arrays' items) and `meta`
 * (type/data — metadata only).
 */
export type Facet = 'content' | 'structure' | 'seq' | 'meta' | 'ignore';

export const facetOf = (attr: string): Facet => {
	if (attr === CONTENT) return 'content';
	if (attr === SEQ_FACET) return 'seq';
	if (attr === DATA_SEQ_FACET) return 'ignore';
	if (attr === ID || attr === TYPE || attr === DATA || attr.startsWith(DATA_LEAF_PREFIX))
		return 'meta';
	// The `l` lastChangedBy stamp is attribution bookkeeping only.
	if (attr === LAST_CHANGED_ATTR) return 'ignore';
	// `claims`, `n`, `#content`, delete marks and unknown attrs.
	return 'structure';
};

/** A record's `data` as the projection publishes it: a total JSON clone, `undefined` when absent. */
export const dataOf = (rec: BlockRec): Record<string, unknown> | undefined =>
	rec.data == null ? undefined : (cloneJsonSafe(rec.data) as Record<string, unknown>);

/** A block node's stored kind (`'unknown'` when the attr is missing or not a string). */
export const typeAttr = (node: EngineNode): string => {
	const type = node.getAttr(TYPE);
	return typeof type === 'string' ? type : 'unknown';
};

export const runEquals = (a: ContentRun, b: ContentRun): boolean => {
	if (a === b) return true;
	if (a.kind !== b.kind) return false;
	if (a.kind === 'text' && b.kind === 'text') {
		return a.text === b.text && a.marks === b.marks;
	}
	if (a.kind === 'inline' && b.kind === 'inline') {
		return a.id === b.id && a.type === b.type && a.data === b.data;
	}
	return false;
};

/** Shared empty snapshot — returned for absent/hidden blocks. */
export const EMPTY_RUNS = Object.freeze([]) as readonly ContentRun[];
/** Shared frozen empty child list for a report's emptied-parent `order` entries. */
export const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

/**
 * What a cached display read: the homes of the texts it walked, and the blocks
 * it walked or whose claim it read (followed or skipped) — any structural
 * change to one of them invalidates the display.
 */
export type Deps = { texts: Set<BlockId>; lists: Set<BlockId> };

export type Cached = { runs: readonly ContentRun[]; deps: Deps };

/**
 * Whether two kinds shape the display alike — both show children or
 * neither, both seal an island or neither, both hold the same lines, and
 * both are line kinds or neither (a line kind shows as its slot's kind, so
 * the block joins or leaves the ones a retype re-reads). A retype
 * between kinds of different shape re-places (and re-kinds) the block and
 * its children.
 */
export const sameShape = (roles: DisplayRoles, a: string, b: string): boolean => {
	const { lines, items, rows, cells } = roles.declared();
	const shape = (t: string) => {
		const k = roles.of(t);
		return JSON.stringify([
			k.childless,
			k.island,
			k.container,
			k.line,
			lines.has(t),
			k.layout,
			items.has(t),
			k.table,
			rows.has(t),
			cells.has(t)
		]);
	};
	return shape(a) === shape(b);
};

/**
 * The index's self-checks, off in production: a test lane's setup installs
 * `of`, which builds an index's checker (on its first check), and turns them
 * `on`. After every fold the index checks each fact it keeps incrementally
 * against a rebuild from the replicated state and throws on the first
 * difference; after every report, the published tree.
 */
export const indexChecks: { on: boolean; of?: (ix: never) => SelfChecks } = { on: false };

/** `ix`'s checker ({@link indexChecks}), built on its first check. */
export const checksOf = (ix: { checks: SelfChecks | null }): SelfChecks =>
	(ix.checks ??= indexChecks.of!(ix as never));

/** Add `value` to `key`'s set in `index`. */
export const addTo = <K, V>(index: Map<K, Set<V>>, key: K, value: V): void => {
	let set = index.get(key);
	if (set === undefined) index.set(key, (set = new Set()));
	set.add(value);
};
/** Remove `value` from `key`'s set in `index` (the set goes once empty). */
export const dropFrom = <K, V>(index: Map<K, Set<V>>, key: K, value: V): void => {
	const set = index.get(key);
	set?.delete(value);
	if (set?.size === 0) index.delete(key);
};

/** A total JSON key of `v` (what the report and the self-checks compare). */
export const keyOf = (v: unknown): string => {
	try {
		return JSON.stringify(v ?? null);
	} catch {
		return JSON.stringify(cloneJsonSafe(v ?? null));
	}
};
