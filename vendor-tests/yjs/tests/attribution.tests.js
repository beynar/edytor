/**
 * Testing if encoding/decoding compatibility and integration compatibility is given.
 * We expect that the document always looks the same, even if we upgrade the integration algorithm, or add additional encoding approaches.
 *
 * The v1 documents were generated with Yjs v13.2.0 based on the randomisized tests.
 *
 * YP15: the fork ships no delta layer, so the RDT tests of upstream (`bind`, the `'delta'`
 * channel, the maintained `node.delta` cache and its fingerprint memos, `$rdt`) are removed with
 * their subject; the tests of kept behaviour (the `'destroy'` event, writes to a deleted node,
 * observers through a deleted parent, undo scope) stay, reading and writing deltas through the
 * test-only port (`src/tests/crdt/harness/delta.js`).
 */

import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as t from 'lib0-v14/testing'
import * as delta from 'lib0-v14/delta'
import { applyDelta, toDelta } from '../../../src/tests/crdt/harness/delta.js'

/**
 * `destroy()` emits the `'destroy'` event, and top-level types are destroyed with their Doc.
 */
export const testRdtDestroy = () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  let destroyed = 0
  ytext.on('destroy', () => { destroyed++ })
  ytext.destroy()
  t.assert(destroyed === 1)
  // a top-level type is torn down when its Doc is destroyed
  const ydoc2 = new Y.Doc()
  const ytext2 = ydoc2.get('text')
  let destroyed2 = 0
  ytext2.on('destroy', () => { destroyed2++ })
  ydoc2.destroy()
  t.assert(destroyed2 === 1)
}

/**
 * A deleted type takes no write: an apply (and each of the node's own writes) is silently
 * dropped.
 */
export const testRdtApplyDeltaInvisibleDeletedSilentNull = () => {
  const doc = new Y.Doc({ gc: false })
  doc.clientID = 1
  const root = doc.get('prosemirror')
  applyDelta(root, delta.create().insert([delta.create('paragraph', {}, 'hello')]).done())
  const par = /** @type {Y.Node} */ (root.get(0))
  applyDelta(root, delta.create().delete(1).done())
  const before = Y.encodeStateAsUpdate(doc)
  applyDelta(par, delta.create().retain(2).insert('XY').done())
  par.insert(2, 'XY')
  par.format(0, 2, { bold: true })
  par.delete(0, 1)
  par.setAttr('k', 'v')
  par.deleteAttr('k')
  t.compare(Y.encodeStateAsUpdate(doc), before, 'nothing was written')
  t.assert(toDelta(root, { deep: true }).isEmpty(), 'nothing was applied')
}

/**
 * Plain docs: deleted content is invisible, so a remote change inside a deleted paragraph leaves
 * v1 `observe` on the root silent. Deep listeners on live ancestors ARE notified (the event is
 * tracked through the deleted parent) — that is the chosen semantics.
 */
export const testRdtNoDeltaThroughDeletedParentPlainDoc = () => {
  const docP = new Y.Doc({ gc: false })
  docP.clientID = 3
  const docQ = new Y.Doc({ gc: false })
  docQ.clientID = 4
  applyDelta(docP.get('prosemirror'),
    delta.create().insert([delta.create('paragraph', {}, 'hello world')]).done()
  )
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  const rootQ = docQ.get('prosemirror')
  let deepFired = 0
  let observeFired = 0
  rootQ.observeDeep(() => { deepFired++ })
  rootQ.observe(() => { observeFired++ })
  // plain-delete the paragraph on Q — a visible change, fires normally
  applyDelta(rootQ, delta.create().delete(1).done())
  t.assert(observeFired === 1)
  deepFired = 0
  observeFired = 0
  // remote edit inside the (invisible) deleted paragraph
  applyDelta(docP.get('prosemirror'), delta.create().modify(delta.create().retain(2).insert('XY')).done())
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  t.assert(observeFired === 0, 'v1 observe on the root is unaffected')
  t.assert(deepFired === 1, 'deep listeners on live ancestors are notified')
  t.assert(toDelta(rootQ, { deep: true }).isEmpty(), 'the deleted paragraph stays invisible')
}

/**
 * Type-scoped UndoManager: tombstone-subtree transactions reach `changedParentTypes` (the
 * scope check), but origin gating still decides capture — an untracked-origin remote change is
 * not captured.
 */
export const testRdtDeletedSubtreeUndoScope = () => {
  const docP = new Y.Doc({ gc: false })
  docP.clientID = 5
  const docQ = new Y.Doc({ gc: false })
  docQ.clientID = 6
  applyDelta(docP.get('prosemirror'),
    delta.create().insert([delta.create('paragraph', {}, 'hello world')]).done()
  )
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  const rootQ = docQ.get('prosemirror')
  const um = new Y.UndoManager(rootQ)
  applyDelta(rootQ, delta.create().delete(1).done()) // local delete → captured
  t.assert(um.undoStack.length === 1)
  // remote change inside the deleted paragraph with an untracked origin: in scope via the
  // deleted-parent bubble, but not captured
  applyDelta(docP.get('prosemirror'), delta.create().modify(delta.create().retain(2).insert('XY')).done())
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP), 'remote-origin')
  t.assert(um.undoStack.length === 1, 'untracked-origin remote change is not captured')
}
