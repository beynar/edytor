import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as t from 'lib0-v14/testing'
import { UndoManager } from '../../../src/tests/crdt/harness/undo.js'

/**
 * @param {t.TestCase} _tc
 */
export const testAfterTransactionRecursion = _tc => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get('')
  ydoc.on('afterTransaction', tr => {
    if (tr.origin === 'test') {
      yxml.toJSON()
    }
  })
  ydoc.transact(_tr => {
    for (let i = 0; i < 15000; i++) {
      yxml.push([new Y.Node('a')])
    }
  }, 'test')
}

/**
 * @param {t.TestCase} _tc
 */
export const testFindTypeInOtherDoc = _tc => {
  const ydoc = new Y.Doc()
  const ymap = ydoc.get()
  const ytext = ymap.setAttr('ytext', new Y.Node())
  const ydocClone = new Y.Doc()
  Y.applyUpdate(ydocClone, Y.encodeStateAsUpdate(ydoc))
  /**
   * @param {Y.Node} ynode
   * @param {Y.Doc} otherYdoc
   * @return {Y.Node}
   */
  const findTypeInOtherYdoc = (ynode, otherYdoc) => {
    const ydoc = /** @type {Y.Doc} */ (ynode.doc)
    if (ynode._item === null) {
      /**
       * If is a root type, we need to find the root key in the original ydoc
       * and use it to get the type in the other ydoc.
       */
      const rootKey = Array.from(ydoc.share.keys()).find(
        (key) => ydoc.share.get(key) === ynode
      )
      if (rootKey == null) {
        throw new Error('type does not exist in other ydoc')
      }
      return otherYdoc.get(rootKey)
    } else {
      /**
       * If it is a sub type, we use the item id to find the history type.
       */
      const ynodeItem = ynode._item
      const otherStructs = otherYdoc.store.clients.get(ynodeItem.id.client) ?? []
      const itemIndex = Y.findIndexSS(
        otherStructs,
        ynodeItem.id.clock
      )
      const otherItem = /** @type {Y.Item} */ (otherStructs[itemIndex])
      const otherContent = /** @type {Y.ContentType} */ (otherItem.content)
      return /** @type {Y.Node} */ (otherContent.type)
    }
  }
  t.assert(findTypeInOtherYdoc(ymap, ydocClone) != null)
  t.assert(findTypeInOtherYdoc(ytext, ydocClone) != null)
}

/**
 * Client id should be changed when an instance receives updates from another client using the same client id.
 *
 * @param {t.TestCase} _tc
 */
export const testClientIdDuplicateChange = _tc => {
  const doc1 = new Y.Doc()
  doc1.clientID = 0
  const doc2 = new Y.Doc()
  doc2.clientID = 0
  t.assert(doc2.clientID === doc1.clientID)
  doc1.get('a').insert(0, [1, 2])
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
  t.assert(doc2.clientID !== doc1.clientID)
}

/**
 * @param {t.TestCase} _tc
 */
export const testGetTypeEmptyId = _tc => {
  const doc1 = new Y.Doc()
  doc1.get('').insert(0, 'h')
  doc1.get().insert(1, 'i')
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
  t.assert(doc2.get().toString() === 'hi')
  t.assert(doc2.get('').toString() === 'hi')
}

/**
 * @param {t.TestCase} _tc
 */
export const testSubdocsUndo = _tc => {
  const ydoc = new Y.Doc()
  const elems = ydoc.get()
  const undoManager = new UndoManager(elems)
  const subdoc = new Y.Doc()
  // @ts-ignore
  elems.insert(0, [subdoc])
  undoManager.undo()
  undoManager.redo()
  t.assert(elems.length === 1)
}

