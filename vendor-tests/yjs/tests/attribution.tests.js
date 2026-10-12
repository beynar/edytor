/**
 * Testing if encoding/decoding compatibility and integration compatibility is given.
 * We expect that the document always looks the same, even if we upgrade the integration algorithm, or add additional encoding approaches.
 *
 * The v1 documents were generated with Yjs v13.2.0 based on the randomisized tests.
 *
 * YP16: the fork ships no delta layer, so the RDT tests of upstream (`bind`, the `'delta'`
 * channel, the maintained `node.delta` cache and its fingerprint memos, `$rdt`) are removed with
 * their subject; the tests of kept behaviour (the `'destroy'` event, writes to a deleted node,
 * observers through a deleted parent, undo scope) stay, reading and writing deltas through the
 * test-only port (`src/tests/crdt/harness/delta.js`).
 */

import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as t from 'lib0-v14/testing'
import * as delta from 'lib0-v14/delta'
import { applyDelta, toDelta } from '../../../src/tests/crdt/harness/delta.js'
import { UndoManager } from '../../../src/tests/crdt/harness/undo.js'

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
  const um = new UndoManager(rootQ)
  applyDelta(rootQ, delta.create().delete(1).done()) // local delete → captured
  t.assert(um.undoStack.length === 1)
  // remote change inside the deleted paragraph with an untracked origin: in scope via the
  // deleted-parent bubble, but not captured
  applyDelta(docP.get('prosemirror'), delta.create().modify(delta.create().retain(2).insert('XY')).done())
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP), 'remote-origin')
  t.assert(um.undoStack.length === 1, 'untracked-origin remote change is not captured')
}
