/**
 * Schema names — the one table: every root key, node role and attr name
 * a document carries, plus the generation stamp written on `meta`. A
 * dependency-free leaf, so every model layer reads it without importing the
 * facade module.
 */
import type { EngineNode } from './engine-api.js';

/** A replicated value that is a node (a block, its content, an atom). */
export const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** Flat block registry root: blockId → node('block') (`SCHEMA.roots.registry`). */
export const REGISTRY_KEY = 'blocks';
/** Version/manifest record root (`SCHEMA.roots.meta`). */
export const META_ROOT_KEY = 'meta';
/** Attribution metadata root (`SCHEMA.roots.attribution`). */
export const ATTRIBUTION_ROOT = 'attribution';
/**
 * The per-block attribution root — one record per block, keyed by the block's
 * id (`SCHEMA.roots.blockAttribution`): the string table writes the id once
 * for its registry entry and its record (fork patch YP24).
 */
export const BLOCK_ATTR_ROOT = 'blockattr';
/**
 * The text hold records (fork patch YP20): a text delete appends one record
 * naming the characters it hides; its writer is the record's engine client.
 * A character shows while no live record holds it. In the history's scope,
 * so an undo deletes the undoer's own record and a redo writes it again.
 */
export const TEXT_DELETES_ROOT = 'textdel';
/**
 * The document's own data (`crdt/data.ts`): its leaves, as a block's. In the
 * history's scope.
 */
export const DOC_DATA_ROOT = 'docdata';

/**
 * The purge horizon: attr {@link HORIZON_ATTR} holds `{ at, sv }`, the
 * time and state vector of the room's epoch before which it purged deleted
 * content. Written only by the room's purge (a client's write is stripped);
 * histories drop the steps below it (`hist.purge.horizon`).
 */
export const HORIZON_ROOT = 'horizon';
export const HORIZON_ATTR = 'h';
/**
 * The ended histories (`hist.release.end`): a list of release records, one
 * item per session whose history ended (its page left for good). A
 * record's engine id names its writer and the clock it ended at: what that
 * writer deleted before it (its delete and withdraw marks, its text hold
 * records) no history can bring back, so the room's purge removes it at
 * its next tick, past the horizon or not. The purge drops a record the
 * horizon covers.
 */
export const RELEASE_ROOT = 'released';

/** Named node roles (`SCHEMA.nodes`). */
export const BLOCK_NODE = 'block';
export const CONTENT_NODE = 'content';
export const INLINE_NODE = 'inline';

/** Attr keys on a block node (`SCHEMA.blockAttrs`); `id` is an atom's own (a block's id is its registry key). */
export const ID = 'id';
export const TYPE = 'type';
/** A block's or atom's whole data, as documents before 0.1.0-next.6 stored it: no longer read; the room's purge deletes it. */
export const DATA = 'data';
/** A data leaf: `d/` and its path, RFC 6901 escaped (`crdt/data.ts`). */
export const DATA_LEAF_PREFIX = 'd/';
/**
 * Incarnation nonce: which creation of a (recyclable) block id a
 * node is — and which stream boundary `{s, n}` starts the block's stream.
 * Written at creation (random from the `rand` seam, derived from the seed
 * hash for seeded blocks) and re-minted, derived from the dead incarnation,
 * when a streamless block gets its own text; replicated, so an undo/redo copy
 * of the node carries it and every replica agrees on the incarnation.
 */
export const NONCE = 'n';
/**
 * Per-writer delete marks: `del.<writer>: true`. A block is deleted iff
 * any mark is live, so an undo removes only the undoer's own mark.
 */
export const DEL_PREFIX = 'del.';
export const hasDeleteMark = (node: { attrKeys(): IterableIterator<string> }): boolean =>
	[...node.attrKeys()].some((key) => key.startsWith(DEL_PREFIX));
/**
 * Per-writer withdraw marks (`hist.undo.withdraw`): `wd.<writer>: true`, what
 * an undo of the block's creation writes instead of deleting the node. A
 * withdrawn block without a delete mark is visible while it holds content
 * (a live unit in its stream, or a visible child), hidden otherwise.
 */
export const WITHDRAW_PREFIX = 'wd.';
export const hasWithdrawMark = (node: { attrKeys(): IterableIterator<string> }): boolean =>
	[...node.attrKeys()].some((key) => key.startsWith(WITHDRAW_PREFIX));
/** The per-block `lastChangedBy` LWW attr (`SCHEMA.blockAttrs.lastChanged`). */
export const LAST_CHANGED_ATTR = 'l';
export const CONTENT = 'content';

/** The schema generation stamped on the `meta` root (`v`) and its manifest name (`schema`). */
export const SCHEMA = {
	// 7: a text delete is a hold record (fork patch YP20) on the wire and in
	// storage; 8: a merge claim is an item `{m}` in a backing text (fork patch
	// YP21), a block has no `claims` list; 9: a block's place is its home slot
	// in its parent's sequence and a move is a move record (fork patch YP22),
	// a block has no `at` map and an array item no rank; 10: the update encoding
	// writes each distinct string once (fork patch YP24). A container or frame
	// of an earlier generation is refused.
	version: 10,
	name: 'edytor-doc',
	roots: { registry: REGISTRY_KEY, meta: META_ROOT_KEY },
	metaAttrs: { version: 'v', schema: 'schema' }
} as const;
