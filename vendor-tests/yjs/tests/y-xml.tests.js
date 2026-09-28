import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import { init, compare } from './testHelper.js'
import * as t from 'lib0-v14/testing'
import * as delta from 'lib0-v14/delta'

export const testCustomTypings = () => {
  const ydoc = new Y.Doc()
  const ymap = ydoc.get()
  /**
   * @type {Y.Node<{ attrs: { num: number, str: string, [k:string]: number|string } }>}
   */
  const yxml = ymap.setAttr('yxml', new Y.Node('test'))
  /**
   * @type {number|undefined}
   */
  const num = yxml.getAttr('num')
  /**
   * @type {string|undefined}
   */
  const str = yxml.getAttr('str')
  /**
   * @type {object|number|string|undefined}
   */
  const dtrn = yxml.getAttr('dtrn')
  const attrs = yxml.getAttrs()
  /**
   * @type {object|number|string|undefined}
   */
  const any = attrs.shouldBeAny
  console.log({ num, str, dtrn, attrs, any })
}

/**
 * @param {t.TestCase} tc
 */
export const testSetProperty = tc => {
  const { testConnector, users, xml0, xml1 } = init(tc, { users: 2 })
  xml0.setAttr('height', '10')
  t.assert(xml0.getAttr('height') === '10', 'Simple set+get works')
  testConnector.flushAllMessages()
  t.assert(xml1.getAttr('height') === '10', 'Simple set+get works (remote)')
  compare(users)
}

/**
 * @param {t.TestCase} tc
 */
export const testHasProperty = tc => {
  const { testConnector, users, xml0, xml1 } = init(tc, { users: 2 })
  xml0.setAttr('height', '10')
  t.assert(xml0.hasAttr('height'), 'Simple set+has works')
  testConnector.flushAllMessages()
  t.assert(xml1.hasAttr('height'), 'Simple set+has works (remote)')
  xml0.deleteAttr('height')
  t.assert(!xml0.hasAttr('height'), 'Simple set+remove+has works')
  testConnector.flushAllMessages()
  t.assert(!xml1.hasAttr('height'), 'Simple set+remove+has works (remote)')
  compare(users)
}

/**
 * @param {t.TestCase} _tc
 */
export const testYtextAttributes = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('')
  ytext.observe(event => {
    t.assert(event.delta.attrs.test?.type === 'insert')
  })
  ytext.setAttr('test', 42)
  t.compare(ytext.getAttr('test'), 42)
  t.compare(ytext.getAttrs(), { test: 42 })
}

/**
 * @param {t.TestCase} _tc
 */
export const testSiblings = _tc => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get()
  const first = new Y.Node()
  const second = new Y.Node('p')
  yxml.insert(0, [first, second])
  t.assert(first.parent === /** @type {Y.Node<any>} */ (yxml))
  t.assert(yxml.parent === null)
}

/**
 * @param {t.TestCase} _tc
 */
export const testClone = _tc => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get()
  const first = new Y.Node('text')
  const second = new Y.Node('p')
  const third = new Y.Node('p')
  yxml.push([first, second, third])
  t.compareArrays(yxml.toArray(), [first, second, third])
  const cloneYxml = yxml.clone()
  ydoc.get('copyarr').insert(0, [cloneYxml])
  t.assert(cloneYxml.length === 3)
  t.compare(cloneYxml.toJSON(), yxml.toJSON())
}

/**
 * @param {t.TestCase} _tc
 */
export const testFormattingBug = _tc => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get()
  const q = delta.create()
    .insert('A', { em: {}, strong: {} })
    .insert('B', { em: {} })
    .insert('C', { em: {}, strong: {} })
  yxml.applyDelta(q)
  t.compare(yxml.toDelta(), q)
}

/**
 * @param {t.TestCase} _tc
 */
export const testElement = _tc => {
  const ydoc = new Y.Doc()
  const yxmlel = ydoc.get()
  const text1 = new Y.Node('text1')
  const text2 = new Y.Node('text2')
  yxmlel.insert(0, [text1, text2])
  t.compareArrays(yxmlel.toArray(), [text1, text2])
}

