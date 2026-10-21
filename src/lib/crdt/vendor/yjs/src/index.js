/// <reference types="../global.d.ts" />
/** eslint-env browser */

// Order matters: follows internals.js ordering to avoid circular dependency issues

export { IdSet, createDeleteSetFromStructStore, diffIdSet, createIdSet, mergeIdSets, insertIntoIdSet, iterateStructsByIdSet, readIdSet, writeIdSet, intersectSets } from './utils/ids.js'
export { Doc } from './utils/Doc.js'
export { UpdateDecoder } from './utils/UpdateDecoder.js'
export { UpdateEncoder } from './utils/UpdateEncoder.js'
export { applyUpdate, encodeStateAsUpdate, encodeStateVector, decodeStateVector, diffUpdate, clipUpdate, mergeUpdates } from './utils/encoding.js' // YP34: clipUpdate
export { ID, createID, compareIDs, findRootTypeKey } from './utils/ID.js'
export { isParentOf } from './utils/isParentOf.js'
export { idAtIndex, indexOfId } from './utils/positions.js' // YP19
export { findIndexSS, getItemCleanStart, getItemCleanEnd, isKeptReplaced } from './utils/transaction-helpers.js' // YP14: isKeptReplaced
export { Transaction, transact } from './utils/Transaction.js'
export { redoItem, keepItem } from './utils/redo.js' // YP11, YP18
export { decodeUpdate } from './utils/updates.js'
export { RangeCursor } from './utils/RangeCursor.js'
export { YNode as Node } from './ynode.js'
export { AbstractStruct } from './structs/AbstractStruct.js'
export { GC } from './structs/GC.js'
export { Item, followRedone, ContentBinary, ContentDeleted, ContentFormat, ContentAny, ContentString, ContentType, ContentMove, unhide } from './structs/Item.js' // YP22: ContentMove; YP32: unhide
export { Skip } from './structs/Skip.js'

/**
 * @typedef {import('./utils/ids.js').ContentIds} ContentIds
 */

const glo = /** @type {any} */ (globalThis) // YP18: Baseline 2024 has `globalThis`

const importIdentifier = '__ $YJS14$ __'

if (glo[importIdentifier] === true) {
  /**
   * Dear reader of this message. Please take this seriously.
   *
   * If you see this message, make sure that you only import one version of Yjs. In many cases,
   * your package manager installs two versions of Yjs that are used by different packages within your project.
   * Another reason for this message is that some parts of your project use the commonjs version of Yjs
   * and others use the EcmaScript version of Yjs.
   *
   * This often leads to issues that are hard to debug. We often need to perform constructor checks,
   * e.g. `struct instanceof GC`. If you imported different versions of Yjs, it is impossible for us to
   * do the constructor checks anymore - which might break the CRDT algorithm.
   *
   * https://github.com/yjs/yjs/issues/438
   */
  console.error('Yjs was already imported. This breaks constructor checks and will lead to issues! - https://github.com/yjs/yjs/issues/438')
}
glo[importIdentifier] = true
