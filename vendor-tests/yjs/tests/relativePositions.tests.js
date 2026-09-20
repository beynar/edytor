import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as t from 'lib0-v14/testing'
import * as dpos from 'lib0-v14/delta/position'

/**
 * @param {Y.Node<{text:true}>} ytext
 */
const checkRelativePositions = ytext => {
  // test if all positions are encoded and restored correctly
  for (let i = 0; i < ytext.length; i++) {
    // for all types of associations..
    for (let assoc = -1; assoc < 2; assoc++) {
      const rpos = Y.createRelativePositionFromTypeIndex(ytext, i, assoc)
      const encodedRpos = Y.encodeRelativePosition(rpos)
      const decodedRpos = Y.decodeRelativePosition(encodedRpos)
      const absPos = /** @type {Y.AbsolutePosition} */ (Y.createAbsolutePositionFromRelativePosition(decodedRpos, /** @type {Y.Doc} */ (ytext.doc)))
      t.assert(absPos.index === i)
      t.assert(absPos.assoc === assoc)
    }
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase1 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, '1')
  ytext.insert(0, 'abc')
  ytext.insert(0, 'z')
  ytext.insert(0, 'y')
  ytext.insert(0, 'x')
  checkRelativePositions(ytext)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase2 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'abc')
  checkRelativePositions(ytext)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase3 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'abc')
  ytext.insert(0, '1')
  ytext.insert(0, 'xyz')
  checkRelativePositions(ytext)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase4 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, '1')
  checkRelativePositions(ytext)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase5 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, '2')
  ytext.insert(0, '1')
  checkRelativePositions(ytext)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase6 = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  checkRelativePositions(ytext)
}

/**
 * Testing https://github.com/yjs/yjs/issues/657
 *
 * @param {t.TestCase} _tc
 */
export const testRelativePositionCase7 = _tc => {
  const docA = new Y.Doc()
  const textA = docA.get('text')
  textA.insert(0, 'abcde')
  // Create a relative position at index 2 in 'textA'
  const relativePosition = Y.createRelativePositionFromTypeIndex(textA, 2)
  // Verify that the absolutes positions on 'docA' are the same
  const absolutePositionWithFollow =
    Y.createAbsolutePositionFromRelativePosition(relativePosition, docA, true)
  const absolutePositionWithoutFollow =
    Y.createAbsolutePositionFromRelativePosition(relativePosition, docA, false)
  t.assert(absolutePositionWithFollow?.index === 2)
  t.assert(absolutePositionWithoutFollow?.index === 2)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionAssociationDifference = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, '2')
  ytext.insert(0, '1')
  const rposRight = Y.createRelativePositionFromTypeIndex(ytext, 1, 0)
  const rposLeft = Y.createRelativePositionFromTypeIndex(ytext, 1, -1)
  ytext.insert(1, 'x')
  const posRight = Y.createAbsolutePositionFromRelativePosition(rposRight, ydoc)
  const posLeft = Y.createAbsolutePositionFromRelativePosition(rposLeft, ydoc)
  t.assert(posRight != null && posRight.index === 2)
  t.assert(posLeft != null && posLeft.index === 1)
}

/**
 * @param {t.TestCase} _tc
 */
export const testRelativePositionWithUndo = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'hello world')
  const rpos = Y.createRelativePositionFromTypeIndex(ytext, 1)
  const um = new Y.UndoManager(ytext)
  ytext.delete(0, 6)
  t.assert(Y.createAbsolutePositionFromRelativePosition(rpos, ydoc)?.index === 0)
  um.undo()
  t.assert(Y.createAbsolutePositionFromRelativePosition(rpos, ydoc)?.index === 1)
  const posWithoutFollow = Y.createAbsolutePositionFromRelativePosition(rpos, ydoc, false)
  console.log({ posWithoutFollow })
  t.assert(Y.createAbsolutePositionFromRelativePosition(rpos, ydoc, false)?.index === 6)
  const ydocClone = new Y.Doc()
  Y.applyUpdate(ydocClone, Y.encodeStateAsUpdate(ydoc))
  t.assert(Y.createAbsolutePositionFromRelativePosition(rpos, ydocClone)?.index === 6)
  t.assert(Y.createAbsolutePositionFromRelativePosition(rpos, ydocClone, false)?.index === 6)
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsFlatTextRoundtrip = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'hello world')
  const positions = [dpos.create([0]), dpos.create([5]), dpos.create([5], -1), dpos.create([11])]
  const rposs = Y.createRelativePositionsFromDeltaPositions(ytext, positions)
  t.assert(rposs.every(rpos => rpos !== null))
  const back = Y.createDeltaPositionsFromRelativePositions(ytext, rposs)
  positions.forEach((pos, i) => {
    const b = back[i]
    t.assert(b !== null && dpos.equals(b, pos))
  })
  // the singular wrappers behave like a one-element batch
  const rpos = Y.createRelativePositionFromDeltaPosition(ytext, dpos.create([5]))
  t.assert(Y.compareRelativePositions(rpos, rposs[1]))
  const single = Y.createDeltaPositionFromRelativePosition(ytext, rpos)
  t.assert(single !== null && dpos.equals(single, positions[1]))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsNested = _tc => {
  const ydoc = new Y.Doc()
  const yroot = ydoc.get('arr')
  yroot.insert(0, ['a', new Y.Node(), 'b'])
  const child = /** @type {Y.Node<any>} */ (yroot.get(1))
  child.insert(0, 'xyz')
  const positions = [dpos.create([1, 2]), dpos.create([0])]
  const rposs = Y.createRelativePositionsFromDeltaPositions(yroot, positions)
  t.assert(rposs.every(rpos => rpos !== null))
  const back = Y.createDeltaPositionsFromRelativePositions(yroot, rposs)
  positions.forEach((pos, i) => {
    const b = back[i]
    t.assert(b !== null && dpos.equals(b, pos))
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsAttrDescent = _tc => {
  const ydoc = new Y.Doc()
  const ymap = ydoc.get('map')
  const child = ymap.setAttr('k', new Y.Node())
  child.insert(0, 'ab')
  const pos = dpos.create(['k', 1])
  const rpos = Y.createRelativePositionFromDeltaPosition(ymap, pos)
  t.assert(rpos !== null)
  const back = Y.createDeltaPositionFromRelativePosition(ymap, rpos)
  t.assert(back !== null && dpos.equals(back, pos))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsAttrLeaf = _tc => {
  const ydoc = new Y.Doc()
  const ymap = ydoc.get('map')
  ymap.setAttr('k', 42)
  const pos = dpos.create(['k'])
  const rpos = Y.createRelativePositionFromDeltaPosition(ymap, pos)
  t.assert(rpos !== null && rpos.item !== null)
  t.assert(dpos.equals(/** @type {dpos.Pos} */ (Y.createDeltaPositionFromRelativePosition(ymap, rpos)), pos))
  // the attribute-leaf anchor survives overwriting the attribute
  ymap.setAttr('k', 43)
  t.assert(dpos.equals(/** @type {dpos.Pos} */ (Y.createDeltaPositionFromRelativePosition(ymap, rpos)), pos))
  // .. but not deleting it
  ymap.deleteAttr('k')
  t.assert(Y.createDeltaPositionFromRelativePosition(ymap, rpos) === null)
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsDocRooted = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  ytext.insert(0, 'hello')
  // doc-rooted paths start with a root-type name; numeric or terminal-string steps at doc level are unresolvable
  const positions = [dpos.create(['text', 3]), dpos.create([0]), dpos.create(['text'])]
  const rposs = Y.createRelativePositionsFromDeltaPositions(ydoc, positions)
  t.assert(rposs[0] !== null && rposs[1] === null && rposs[2] === null)
  const back = Y.createDeltaPositionFromRelativePosition(ydoc, rposs[0])
  t.assert(back !== null && dpos.equals(back, positions[0]))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsAssocThroughEdit = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, '2')
  ytext.insert(0, '1')
  const rposs = Y.createRelativePositionsFromDeltaPositions(ytext, [dpos.create([1]), dpos.create([1], -1)])
  ytext.insert(1, 'x')
  const back = Y.createDeltaPositionsFromRelativePositions(ytext, rposs)
  t.assert(back[0] !== null && dpos.equals(back[0], dpos.create([2])))
  t.assert(back[1] !== null && dpos.equals(back[1], dpos.create([1], -1)))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsSurviveConcurrentEdit = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  ytext.insert(0, 'hello')
  const rpos = Y.createRelativePositionFromDeltaPosition(ytext, dpos.create([2]))
  t.assert(rpos !== null)
  const encoded = Y.encodeRelativePosition(/** @type {Y.RelativePosition} */ (rpos))
  const ydoc2 = new Y.Doc()
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc))
  const ytext2 = ydoc2.get('text')
  ytext2.insert(0, 'abc')
  const back = Y.createDeltaPositionFromRelativePosition(ytext2, Y.decodeRelativePosition(encoded))
  t.assert(back !== null && dpos.equals(back, dpos.create([5])))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsWithRenderer = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'hello world')
  const v1 = Y.cloneDoc(ydoc)
  ytext.delete(1, 6)
  ytext.insert(1, 'x')
  const renderer = Y.createDiffRenderer(v1, ydoc)
  const pos = dpos.create([9]) // pos after "hello wo" in the rendered diff
  const rpos = Y.createRelativePositionFromDeltaPosition(ytext, pos, { renderer })
  t.assert(rpos !== null)
  const backWith = Y.createDeltaPositionFromRelativePosition(ytext, rpos, { renderer })
  t.assert(backWith !== null && dpos.equals(backWith, pos))
  const backWithout = Y.createDeltaPositionFromRelativePosition(ytext, rpos)
  t.assert(backWithout !== null && dpos.equals(backWithout, dpos.create([3])))
  // the node's own renderer is the default - matching toDelta / node.delta
  ytext.useRenderer(renderer)
  const rpos2 = Y.createRelativePositionFromDeltaPosition(ytext, pos)
  t.assert(Y.compareRelativePositions(rpos, rpos2))
  const backDefault = Y.createDeltaPositionFromRelativePosition(ytext, rpos2)
  t.assert(backDefault !== null && dpos.equals(backDefault, pos))
  // explicit renderer: null overrides the node's renderer
  const backNull = Y.createDeltaPositionFromRelativePosition(ytext, rpos2, { renderer: null })
  t.assert(backNull !== null && dpos.equals(backNull, dpos.create([3])))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsUnresolvable = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'abc')
  const positions = [
    dpos.create([0, 0]), // descend into a scalar
    dpos.create(['missing', 0]), // missing attribute
    dpos.create([]), // a node reference doesn't round-trip
    dpos.create([10, 0]), // out-of-range non-terminal index
    dpos.create([1]) // resolvable - other entries must not affect it
  ]
  const rposs = Y.createRelativePositionsFromDeltaPositions(ytext, positions)
  t.assert(rposs[0] === null && rposs[1] === null && rposs[2] === null && rposs[3] === null)
  t.assert(rposs[4] !== null)
  const back = Y.createDeltaPositionsFromRelativePositions(ytext, rposs)
  t.assert(back[0] === null && back[1] === null && back[2] === null && back[3] === null)
  t.assert(back[4] !== null && dpos.equals(back[4], positions[4]))
}

/**
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsEndOfNode = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get()
  ytext.insert(0, 'hello')
  const rpos = Y.createRelativePositionFromDeltaPosition(ytext, dpos.create([5]))
  t.assert(rpos !== null && rpos.item === null)
  t.assert(dpos.equals(/** @type {dpos.Pos} */ (Y.createDeltaPositionFromRelativePosition(ytext, rpos)), dpos.create([5])))
  // an end-of-node position sticks to the end
  ytext.insert(5, ' world')
  t.assert(dpos.equals(/** @type {dpos.Pos} */ (Y.createDeltaPositionFromRelativePosition(ytext, rpos)), dpos.create([11])))
  // empty node
  const yempty = ydoc.get('empty')
  const rposE = Y.createRelativePositionFromDeltaPosition(yempty, dpos.create([0]))
  t.assert(rposE !== null && rposE.item === null)
  t.assert(dpos.equals(/** @type {dpos.Pos} */ (Y.createDeltaPositionFromRelativePosition(yempty, rposE)), dpos.create([0])))
}

/**
 * Positions inside a nested node that is deleted but still rendered (e.g. a suggestion-mode
 * subtree delete). Requires gc: false - with gc enabled, the deleted subtree's content is
 * destroyed and such positions are unresolvable.
 *
 * @param {t.TestCase} _tc
 */
export const testDeltaPositionsInDeletedRenderedSubtree = _tc => {
  const ydoc = new Y.Doc({ gc: false })
  const yroot = ydoc.get('r')
  yroot.insert(0, [new Y.Node(), 'x'])
  const mid = /** @type {Y.Node<any>} */ (yroot.get(0))
  mid.insert(0, ['q', new Y.Node()])
  const leaf = /** @type {Y.Node<any>} */ (mid.get(1))
  leaf.insert(0, 'hello')
  const v1 = Y.cloneDoc(ydoc)
  yroot.delete(0, 1) // delete the whole `mid` subtree - the diff renderer still renders it
  const renderer = Y.createDiffRenderer(v1, ydoc)
  // the underlying primitive resolves indexes inside the deleted-but-rendered type
  const rposLeaf = Y.createRelativePositionFromTypeIndex(leaf, 3, 0, renderer)
  t.assert(Y.createAbsolutePositionFromRelativePosition(rposLeaf, ydoc, true, renderer)?.index === 3)
  // .. and delta positions round-trip through the deleted subtree
  const positions = [dpos.create([0, 1, 3]), dpos.create([0, 0]), dpos.create([1])]
  const rposs = Y.createRelativePositionsFromDeltaPositions(yroot, positions, { renderer })
  t.assert(rposs.every(rpos => rpos !== null))
  const back = Y.createDeltaPositionsFromRelativePositions(yroot, rposs, { renderer })
  positions.forEach((pos, i) => {
    const b = back[i]
    t.assert(b !== null && dpos.equals(b, pos))
  })
}
