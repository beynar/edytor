/**
 * Testing if encoding/decoding compatibility and integration compatibility is given.
 * We expect that the document always looks the same, even if we upgrade the integration algorithm, or add additional encoding approaches.
 *
 * The v1 documents were generated with Yjs v13.2.0 based on the randomisized tests.
 */

import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as t from 'lib0-v14/testing'
import * as delta from 'lib0-v14/delta'
import * as prng from 'lib0-v14/prng'
import * as math from 'lib0-v14/math'
import { bind, $rdt } from 'lib0-v14/delta/rdt'

/**
 * A YNode implements the lib0 `RDT` interface, so two types can be kept in sync with `bind`.
 */
export const testRdtBinding = () => {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const a = docA.get('text')
  const b = docB.get('text')
  const binding = bind(a, b)
  // edit A -> propagates to B
  a.insert(0, 'hello')
  t.assert(b.toString() === 'hello')
  // edit B -> propagates back to A (no echo loop)
  b.insert(5, ' world')
  t.assert(a.toString() === 'hello world')
  t.assert(b.toString() === 'hello world')
  // after the binding is destroyed, changes no longer propagate
  binding.destroy()
  a.insert(0, 'x')
  t.assert(a.toString() === 'xhello world')
  t.assert(b.toString() === 'hello world')
}

/**
 * Local changes are emitted on the `'delta'` channel as the deep delta.
 */
export const testRdtDeltaEvent = () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  /**
   * @type {any}
   */
  let captured = null
  ytext.on('delta', d => { captured = d })
  ytext.insert(0, 'hello')
  t.compare(captured, delta.create().insert('hello').done())
}

/**
 * The `'delta'` event carries the transaction origin as its second argument.
 */
export const testRdtDeltaEventOrigin = () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  /**
   * @type {any}
   */
  let capturedOrigin = null
  ytext.on('delta', (_d, origin) => { capturedOrigin = origin })
  const myOrigin = {}
  ydoc.transact(() => {
    ytext.insert(0, 'hello')
  }, myOrigin)
  t.assert(capturedOrigin === myOrigin)
  // without an explicit origin, `null` is emitted
  capturedOrigin = myOrigin
  ytext.insert(5, ' world')
  t.assert(capturedOrigin === null)
  // the origin passed to `applyDelta` becomes the transaction origin and is forwarded on the event
  const applyOrigin = {}
  ytext.applyDelta(delta.create().retain(11).insert('!').done(), applyOrigin)
  t.assert(capturedOrigin === applyOrigin)
  // `applyDelta` without an explicit origin emits `null`
  capturedOrigin = applyOrigin
  ytext.applyDelta(delta.create().retain(12).insert('?').done())
  t.assert(capturedOrigin === null)
}

/**
 * `destroy()` emits the RDT `'destroy'` event, and top-level types are destroyed with their Doc.
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
 * The `'delta'` event bubbles to ancestors on nested changes, like `observeDeep`. A listener on a
 * container fires (with the container-rooted delta) when a nested child is edited.
 */
export const testRdtDeltaBubblesLikeObserveDeep = () => {
  const ydoc = new Y.Doc()
  const yarray = ydoc.get('arr')
  const child = new Y.Node()
  yarray.insert(0, [child])
  let containerFired = 0
  let childFired = 0
  /**
   * @type {any}
   */
  let captured = null
  yarray.on('delta', d => { containerFired++; captured = d })
  child.on('delta', () => { childFired++ })
  child.insert(0, 'hi')
  // both the edited child and its ancestor container received a 'delta'
  t.assert(childFired === 1)
  t.assert(containerFired === 1)
  // the container-rooted delta is a non-empty (nested modify) change
  t.assert(captured !== null && !captured.isEmpty())
}

/**
 * `get delta()` returns the deep delta and keeps it current on every event of this type, including
 * nested-child edits (which apply as a nested `modify`). The returned value is the live cache.
 */
export const testRdtDeltaCacheMaintenance = () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  ytext.insert(0, 'hello')
  // first access materializes the cache
  t.assert(ytext.delta.equals(delta.create().insert('hello').done()))
  // a later edit updates the live cache in place
  const live = ytext.delta
  ytext.insert(5, ' world')
  t.assert(live === ytext.delta) // same maintained object
  t.assert(ytext.delta.equals(delta.create().insert('hello world').done()))
  t.assert(ytext.delta.equals(ytext.toDeltaDeep())) // matches a fresh deep render

  // nested: editing a child updates the container's cached deep delta via a nested modify apply
  const yarray = ydoc.get('arr')
  const child = new Y.Node()
  yarray.insert(0, [child])
  child.insert(0, 'a')
  const before = yarray.delta // materialize under base renderer
  child.insert(1, 'b') // nested edit after materialization
  t.assert(before === yarray.delta)
  t.assert(yarray.delta.equals(yarray.toDeltaDeep()))
}

/**
 * `clearCache()` drops the maintained deep delta; the next `delta` access re-materializes it.
 */
export const testRdtClearCache = () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  ytext.insert(0, 'hello')
  const d1 = ytext.delta
  t.assert(ytext._delta !== null)
  ytext.clearCache()
  t.assert(ytext._delta === null)
  const d2 = ytext.delta // re-materialized, a fresh builder
  t.assert(d2 !== d1)
  t.assert(d2.equals(delta.create().insert('hello').done()))
}

/**
 * `YNode` conforms to the lib0 `RDT` interface — verified at runtime with `$rdt.check` (replaces the
 * old compile-time `_assertYNodeIsRdt`).
 */
export const testRdtConformsToRdtSchema = () => {
  t.assert($rdt.check(new Y.Doc().get()))
  t.assert($rdt.check(new Y.Node()))
  t.assert(!$rdt.check({}))
  t.assert(!$rdt.check(null))
}

/**
 * Collect a type and all of its (non-deleted) nested `YNode` descendants.
 *
 * @param {Y.Node<any>} root
 * @return {Array<Y.Node<any>>}
 */
const collectTypes = root => {
  /**
   * @type {Array<Y.Node<any>>}
   */
  const out = [root]
  for (let i = 0; i < out.length; i++) {
    out[i].forEach(c => { if (c instanceof Y.Node) out.push(c) })
    out[i].forEachAttr(v => { if (v instanceof Y.Node) out.push(v) })
  }
  return out
}

/**
 * Apply one random mutation to a random type in the tree rooted at `root`.
 *
 * @param {prng.PRNG} gen
 * @param {Y.Node<any>} root
 */
const applyRandomYNodeOp = (gen, root) => {
  const target = prng.oneOf(gen, collectTypes(root))
  switch (prng.int32(gen, 0, 4)) {
    case 0: // insert text
      target.insert(prng.int32(gen, 0, target.length), prng.word(gen))
      break
    case 1: // insert a nested type
      target.insert(prng.int32(gen, 0, target.length), [new Y.Node()])
      break
    case 2: // delete a range
      if (target.length > 0) {
        const p = prng.int32(gen, 0, target.length - 1)
        target.delete(p, prng.int32(gen, 1, math.min(3, target.length - p)))
      }
      break
    case 3: // format a range (add or remove bold)
      if (target.length > 0) {
        const p = prng.int32(gen, 0, target.length - 1)
        target.format(p, prng.int32(gen, 1, math.min(3, target.length - p)), { bold: prng.bool(gen) ? true : null })
      }
      break
    case 4: // set / delete a map attribute
      if (prng.bool(gen)) {
        target.setAttr(prng.oneOf(gen, ['a', 'b', 'c']), prng.word(gen))
      } else {
        target.deleteAttr(prng.oneOf(gen, ['a', 'b', 'c']))
      }
      break
  }
}

/**
 * Assert the maintained `.delta` cache of `type` is (a) structurally correct — equals a fresh
 * `toDelta({ deep: true })` — and (b) fingerprint-memo-fresh — its (possibly memoized)
 * `fingerprint` equals a `delta.cloneDeep` recompute (cloneDeep rebuilds every node memo-free,
 * so it is a true recompute oracle at every depth; `clone`/`slice` are not — they share frozen
 * nested deltas by reference).
 *
 * Reading `.fingerprint` also (re)memoizes it on the LIVE cache at every depth — exactly what a
 * y-sync-style consumer does when diffing against `type.delta` — so the NEXT in-place cache patch
 * hits an already-fingerprinted tree and any missing memo invalidation surfaces on the next call.
 *
 * Diagnosis: `equals` fail = cache drift; `equals` pass + fingerprint mismatch = stale memo
 * (a mutation reached the cache without routing through the lib0 builder API — see the
 * `YNode._delta` invariant in src/ynode.js).
 *
 * @param {Y.Node<any>} type
 * @param {string} msg
 */
const assertDeltaCacheFresh = (type, msg) => {
  const cached = type.delta
  const memoFp = cached.fingerprint // reads (and re-populates) the memo on the live cache
  const fresh = type.toDelta({ deep: true })
  if (!cached.equals(fresh)) {
    console.error(`${msg} cached :`, JSON.stringify(cached.toJSON()))
    console.error(`${msg} toDelta:`, JSON.stringify(fresh.toJSON()))
  }
  t.assert(cached.equals(fresh), `${msg}: maintained .delta drifted from toDelta({ deep: true })`)
  t.assert(memoFp === delta.cloneDeep(/** @type {any} */ (cached)).fingerprint,
    `${msg}: stale fingerprint memo on the live .delta cache`)
}

/**
 * Fuzz: after each random mutation, every type's maintained `delta` cache (at every nesting level)
 * must equal a fresh deep render `toDelta({ deep: true })`.
 *
 * @param {t.TestCase} tc
 */
export const testRdtDeltaFuzz = tc => {
  const ydoc = new Y.Doc()
  const root = ydoc.get('root')
  for (let i = 0; i < 300; i++) {
    applyRandomYNodeOp(tc.prng, root)
    collectTypes(root).forEach(type =>
      t.assert(type.delta.equals(type.toDelta({ deep: true })), `iter ${i}`))
  }
}

/**
 * Fuzz pin: fingerprint-memo safety of the maintained `.delta` cache under in-place patching
 * (the per-transaction `type._delta?.apply(change)` path in `cleanupTransactions`).
 * Reading `.fingerprint` each iteration memoizes on the live cache of every type (root deep
 * cache AND each nested type's own cache); the next random transaction then patches
 * already-fingerprinted trees, and the memo must equal a full `delta.cloneDeep` recompute.
 * `testRdtDeltaFuzz` above is the memo-free control: if only this test fails, the drift is a
 * stale fingerprint memo, not a structural one.
 *
 * @param {t.TestCase} tc
 */
export const testRdtFingerprintMemoFuzzCacheDrift = tc => {
  const ydoc = new Y.Doc()
  const root = ydoc.get('root')
  for (let i = 0; i < 300; i++) {
    applyRandomYNodeOp(tc.prng, root)
    collectTypes(root).forEach(type => assertDeltaCacheFresh(type, `iter ${i}`))
  }
}

/**
 * Sanity: the maintained `delta` equals both an explicit expected delta and a fresh deep render —
 * for flat content, nested children, and ongoing edits.
 */
export const testRdtDeltaSanity = () => {
  const ydoc = new Y.Doc()
  const root = ydoc.get('root')
  root.insert(0, 'hello')
  root.setAttr('k', 'v')
  t.assert(root.delta.equals(delta.create().insert('hello').setAttr('k', 'v').done()))
  t.assert(root.delta.equals(root.toDelta({ deep: true })))
  // nested child + ongoing edits keep delta == fresh deep render
  const child = new Y.Node()
  root.insert(5, [child])
  child.insert(0, 'world')
  t.assert(root.delta.equals(root.toDelta({ deep: true })))
  child.insert(5, '!')
  root.delete(0, 1)
  t.assert(root.delta.equals(root.toDelta({ deep: true })))
  // the nested child's own cache is consistent too
  t.assert(child.delta.equals(child.toDelta({ deep: true })))
  t.assert(child.delta.equals(delta.create().insert('world!').done()))
}

/**
 * A plainly deleted (invisible — no renderer claims it) type keeps today's semantics: the apply
 * is silently dropped and `applyDelta` returns `null` (the caller's view shows nothing there, so
 * there is nothing to revert).
 */
export const testRdtApplyDeltaInvisibleDeletedSilentNull = () => {
  const doc = new Y.Doc({ gc: false })
  doc.clientID = 1
  const root = doc.get('prosemirror')
  root.applyDelta(delta.create().insert([delta.create('paragraph', {}, 'hello')]).done())
  const par = /** @type {Y.Node} */ (root.get(0))
  root.applyDelta(delta.create().delete(1).done())
  const res = par.applyDelta(delta.create().retain(2).insert('XY').done())
  t.assert(res === null, 'invisible deleted type: silent drop, no fix')
  t.assert(root.toDelta({ deep: true }).isEmpty(), 'nothing was applied')
}

/**
 * Plain docs (base renderer): deleted content is invisible, so a remote change inside a deleted
 * paragraph emits no 'delta' (the change renders to an empty delta, which is suppressed) and v1
 * `observe` semantics are unchanged. Deep listeners on live ancestors ARE notified now (the event
 * is tracked through the deleted parent) — that is the chosen semantics.
 */
export const testRdtNoDeltaThroughDeletedParentPlainDoc = () => {
  const docP = new Y.Doc({ gc: false })
  docP.clientID = 3
  const docQ = new Y.Doc({ gc: false })
  docQ.clientID = 4
  docP.get('prosemirror').applyDelta(
    delta.create().insert([delta.create('paragraph', {}, 'hello world')]).done()
  )
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  const rootQ = docQ.get('prosemirror')
  t.assert(rootQ.delta != null) // materialize the maintained cache
  let deltaFired = 0
  let deepFired = 0
  let observeFired = 0
  rootQ.on('delta', () => { deltaFired++ })
  rootQ.observeDeep(() => { deepFired++ })
  rootQ.observe(() => { observeFired++ })
  // plain-delete the paragraph on Q — a visible change, fires normally
  rootQ.applyDelta(delta.create().delete(1).done())
  t.assert(deltaFired === 1 && observeFired === 1)
  deltaFired = 0
  deepFired = 0
  observeFired = 0
  // remote edit inside the (invisible) deleted paragraph
  docP.get('prosemirror').applyDelta(delta.create().modify(delta.create().retain(2).insert('XY')).done())
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  t.assert(deltaFired === 0, 'no delta emission for an invisible change')
  t.assert(observeFired === 0, 'v1 observe on the root is unaffected')
  t.assert(deepFired === 1, 'deep listeners on live ancestors are notified')
  t.assert(rootQ.delta.equals(rootQ.toDelta({ deep: true })), 'maintained cache stays equal to a fresh render')
}

/**
 * Type-scoped UndoManager: tombstone-subtree transactions now reach `changedParentTypes` (the
 * scope check), but origin gating still decides capture — an untracked-origin remote change is
 * not captured.
 */
export const testRdtDeletedSubtreeUndoScope = () => {
  const docP = new Y.Doc({ gc: false })
  docP.clientID = 5
  const docQ = new Y.Doc({ gc: false })
  docQ.clientID = 6
  docP.get('prosemirror').applyDelta(
    delta.create().insert([delta.create('paragraph', {}, 'hello world')]).done()
  )
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP))
  const rootQ = docQ.get('prosemirror')
  const um = new Y.UndoManager(rootQ)
  rootQ.applyDelta(delta.create().delete(1).done()) // local delete → captured
  t.assert(um.undoStack.length === 1)
  // remote change inside the deleted paragraph with an untracked origin: in scope via the
  // deleted-parent bubble, but not captured
  docP.get('prosemirror').applyDelta(delta.create().modify(delta.create().retain(2).insert('XY')).done())
  Y.applyUpdate(docQ, Y.encodeStateAsUpdate(docP), 'remote-origin')
  t.assert(um.undoStack.length === 1, 'untracked-origin remote change is not captured')
}

