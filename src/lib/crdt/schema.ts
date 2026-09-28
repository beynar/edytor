/**
 * Schema names — the one table (O20): every root key, node role and attr name
 * a document carries, plus the generation stamp written on `meta`. A
 * dependency-free leaf, so every model layer reads it without importing the
 * facade module.
 */

/** Flat block registry root: blockId → node('block') (`SCHEMA.roots.registry`). */
export const REGISTRY_KEY = 'blocks';
/** Version/manifest record root (`SCHEMA.roots.meta`). */
export const META_ROOT_KEY = 'meta';
/** Attribution metadata root (`SCHEMA.roots.attribution`). */
export const ATTRIBUTION_ROOT = 'attribution';
/** U1 per-block attribution root — `b/<blockId>` records (`SCHEMA.roots.blockAttribution`). */
export const BLOCK_ATTR_ROOT = 'blockattr';
/**
 * Per-writer text delete marks (`text/deletes.ts`): one record per text
 * delete, naming the characters it deleted; its writer is the record's
 * engine client. In the history's scope, so an undo removes the undoer's
 * own mark and a redo writes it again.
 */
export const TEXT_DELETES_ROOT = 'textdel';
/**
 * Restoration records (`text/deletes.ts`): which characters an undo's copies
 * restore, one attr per record (keyed by its writer and clock). Outside the
 * history's scope: a record is never removed.
 */
export const RESTORED_ROOT = 'restored';

/** Named node roles (`SCHEMA.nodes`). */
export const BLOCK_NODE = 'block';
export const CONTENT_NODE = 'content';
export const CLAIMS_NODE = 'claims';
export const AT_NODE = 'at';
export const INLINE_NODE = 'inline';

/** Attr keys on a block node (`SCHEMA.blockAttrs`). */
export const ID = 'id';
export const TYPE = 'type';
export const DATA = 'data';
/**
 * Incarnation nonce (O23, §2.1): which creation of a (recyclable) block id a
 * node is — and which stream boundary `{s, n}` starts the block's stream.
 * Written at creation (random from the `rand` seam, derived from the seed
 * hash for seeded blocks) and re-minted, derived from the dead incarnation,
 * when a streamless block gets its own text; replicated, so an undo/redo copy
 * of the node carries it and every replica agrees on the incarnation.
 */
export const NONCE = 'n';
/**
 * Per-writer delete marks (R3): `del.<writer>: true`. A block is deleted iff
 * any mark is live, so an undo removes only the undoer's own mark.
 */
export const DEL_PREFIX = 'del.';
export const hasDeleteMark = (node: { attrKeys(): IterableIterator<string> }): boolean =>
	[...node.attrKeys()].some((key) => key.startsWith(DEL_PREFIX));
/** U1 `lastChangedBy` LWW attr (`SCHEMA.blockAttrs.lastChanged`). */
export const LAST_CHANGED_ATTR = 'l';
export const CONTENT = 'content';
/** Ordered merge claims `{m: blockId}` (R2). */
export const CLAIMS = 'claims';
export const AT = 'at';

/** `b/<blockId>` record-key prefix on the `blockattr` root. */
export const REC_PREFIX = 'b/';

/** The schema generation stamped on the `meta` root (`v`) and its manifest name (`schema`). */
export const SCHEMA = {
	version: 4,
	name: 'edytor-doc',
	roots: { registry: REGISTRY_KEY, meta: META_ROOT_KEY },
	metaAttrs: { version: 'v', schema: 'schema' }
} as const;
