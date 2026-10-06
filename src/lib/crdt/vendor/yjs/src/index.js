/// <reference types="../global.d.ts" />
/** eslint-env browser */

// Order matters: follows internals.js ordering to avoid circular dependency issues

export { IdSet, equalIdSets, createDeleteSetFromStructStore, diffIdSet, createIdSet, mergeIdSets, insertIntoIdSet, iterateStructsByIdSet, readIdSet, writeIdSet, IdMap, createIdMap, createContentAttribute, ContentAttribute, encodeIdMap, insertIntoIdMap, readIdMap, writeIdMap, decodeIdMap, intersectSets, $idSet, $idMapAny } from './utils/ids.js'
export { Doc } from './utils/Doc.js'
export { $doc } from './utils/schemas.js'
export { UpdateDecoderV1, UpdateDecoderV2 } from './utils/UpdateDecoder.js'
export { UpdateEncoderV1, UpdateEncoderV2 } from './utils/UpdateEncoder.js'
export { applyUpdate, applyUpdateV2, readUpdateV2, encodeStateAsUpdate, encodeStateAsUpdateV2, encodeStateVector, decodeStateVector, diffUpdateV2, mergeUpdates, mergeUpdatesV2 } from './utils/encoding.js'
export { ID, createID, compareIDs, findRootTypeKey } from './utils/ID.js'
export { isParentOf } from './utils/isParentOf.js'
export { createRelativePositionFromTypeIndex, createRelativePositionFromJSON, createAbsolutePositionFromRelativePosition, AbsolutePosition, RelativePosition, relativePositionToJSON } from './utils/RelativePosition.js'
export { findIndexSS, getItemCleanStart, getItemCleanEnd, isKeptReplaced } from './utils/transaction-helpers.js' // P14: isKeptReplaced
export { Transaction, transact, cleanupYTextFormatting } from './utils/Transaction.js'
export { UndoManager } from './utils/UndoManager.js'
export { redoItem } from './utils/UndoManager.js' // P11
export { decodeUpdate, decodeUpdateV2, convertUpdateFormatV2ToV1 } from './utils/updates.js'
export { YEvent } from './utils/YEvent.js'
export { AbstractRenderer, $renderer } from './utils/renderer-helpers.js'
export { RangeCursor } from './utils/RangeCursor.js'
export { YNode as Node, $nodeAny } from './ynode.js'
export { AbstractStruct } from './structs/AbstractStruct.js'
export { GC } from './structs/GC.js'
export { Item, ContentBinary, ContentDeleted, ContentDoc, ContentEmbed, ContentFormat, ContentJSON, ContentAny, ContentString, ContentType } from './structs/Item.js'
export { Skip } from './structs/Skip.js'

export * from './utils/meta.js'

/**
 * @typedef {import('./utils/ids.js').ContentIds} ContentIds
 */
/**
 * @typedef {import('./utils/ids.js').ContentMap} ContentMap
 */

const glo = /** @type {any} */ (typeof globalThis !== 'undefined'
  ? globalThis
  : typeof window !== 'undefined'
    ? window
    // @ts-ignore
    : typeof global !== 'undefined' ? global : {})

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
