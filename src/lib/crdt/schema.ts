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

/** Named node roles (`SCHEMA.nodes`). */
export const BLOCK_NODE = 'block';
export const CONTENT_NODE = 'content';
export const SLICES_NODE = 'slices';
export const AT_NODE = 'at';
export const INLINE_NODE = 'inline';

/** Attr keys on a block node (`SCHEMA.blockAttrs`). */
export const ID = 'id';
export const TYPE = 'type';
export const DATA = 'data';
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
export const SLICES = 'slices';
export const AT = 'at';

/** `b/<blockId>` record-key prefix on the `blockattr` root. */
export const REC_PREFIX = 'b/';

/** The schema generation stamped on the `meta` root (`v`) and its manifest name (`schema`). */
export const SCHEMA = {
	version: 1,
	name: 'edytor-doc',
	roots: { registry: REGISTRY_KEY, meta: META_ROOT_KEY },
	metaAttrs: { version: 'v', schema: 'schema' }
} as const;
