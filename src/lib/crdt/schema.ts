/**
 * Schema attribute names — the dependency-free leaf the model layers share.
 *
 * `edytor-doc.ts`'s `SCHEMA` object is the public manifest of every
 * semantic node role, root key and attr name a document carries; the names
 * themselves live here so `placement`/`text`/`attribution` modules can read
 * them WITHOUT importing the facade module (the import cycle the literal
 * redeclarations worked around). The two declarations must carry identical
 * values — `SCHEMA` is the record a reader consults, this module is the
 * write-side source the layers code against.
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
/** Presence = explicitly deleted (deletion-wins flag). */
export const DEL = 'del';
/** U1 `lastChangedBy` LWW attr (`SCHEMA.blockAttrs.lastChanged`). */
export const LAST_CHANGED_ATTR = 'l';
export const CONTENT = 'content';
export const SLICES = 'slices';
export const AT = 'at';

/** `b/<blockId>` record-key prefix on the `blockattr` root. */
export const REC_PREFIX = 'b/';
