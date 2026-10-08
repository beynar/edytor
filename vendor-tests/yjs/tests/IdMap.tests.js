import * as t from 'lib0-v14/testing'
import * as ids from '../../../src/lib/crdt/vendor/yjs/src/utils/ids.js'
import * as prng from 'lib0-v14/prng'
import * as math from 'lib0-v14/math'
import { compareIdmaps as compareIdMaps, createIdMap, createRandomIdMap, createContentAttribute } from './testHelper.js'
import * as YY from '../../../src/lib/crdt/vendor/yjs/src/index.js'
import * as time from 'lib0-v14/time'

/**
 * @template T
 * @param {Array<[number, number, number, Array<T>]>} ops
 */
const simpleConstructAttrs = ops => {
  const attrs = createIdMap()
  ops.forEach(op => {
    attrs.add(op[0], op[1], op[2], op[3].map(v => createContentAttribute('', v)))
  })
  return attrs
}

/**
 * @param {t.TestCase} _tc
 */
export const testAmMerge = _tc => {
  const attrs = [42]
  t.group('filter out empty items (1))', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 0, attrs]]),
      simpleConstructAttrs([])
    )
  })
  t.group('filter out empty items (2))', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 0, attrs], [0, 2, 0, attrs]]),
      simpleConstructAttrs([])
    )
  })
  t.group('filter out empty items (3 - end))', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 1, attrs], [0, 2, 0, attrs]]),
      simpleConstructAttrs([[0, 1, 1, attrs]])
    )
  })
  t.group('filter out empty items (4 - middle))', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 1, attrs], [0, 2, 0, attrs], [0, 3, 1, attrs]]),
      simpleConstructAttrs([[0, 1, 1, attrs], [0, 3, 1, attrs]])
    )
  })
  t.group('filter out empty items (5 - beginning))', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 0, attrs], [0, 2, 1, attrs], [0, 3, 1, attrs]]),
      simpleConstructAttrs([[0, 2, 1, attrs], [0, 3, 1, attrs]])
    )
  })
  t.group('merge of overlapping id ranges', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 2, attrs], [0, 0, 2, attrs]]),
      simpleConstructAttrs([[0, 0, 3, attrs]])
    )
  })
  t.group('construct without hole', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 2, attrs], [0, 3, 1, attrs]]),
      simpleConstructAttrs([[0, 1, 3, attrs]])
    )
  })
  t.group('no merge of overlapping id ranges with different attributes', () => {
    compareIdMaps(
      simpleConstructAttrs([[0, 1, 2, [1]], [0, 0, 2, [2]]]),
      simpleConstructAttrs([[0, 0, 1, [2]], [0, 1, 1, [1, 2]], [0, 2, 1, [1]]])
    )
  })
}

/**
 * YP8 keeps the IdMap wire codec (the inverse of the `readIdMap` that decodes legacy
 * attribution records) and prunes the IdMap set algebra (`mergeIdMaps`, `diffIdMap`,
 * `intersectMaps`): the codec roundtrip of upstream's diffing tests stays.
 *
 * @param {t.TestCase} tc
 */
export const testRepeatRandomIdMapEncoding = tc => {
  const idmap = createRandomIdMap(tc.prng, 4, 100, [1, 2, 3])
  const copy = YY.decodeIdMap(YY.encodeIdMap(idmap))
  compareIdMaps(idmap, copy)
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatRandomDeletes = tc => {
  const clients = 1
  const clockRange = 100
  const idset = createRandomIdMap(tc.prng, clients, clockRange, [])
  const client = Array.from(idset.clients.keys())[0]
  const clock = prng.int31(tc.prng, 0, clockRange)
  const len = prng.int31(tc.prng, 0, math.round((clockRange - clock) * 1.2)) // allow exceeding range to cover more edge cases
  // YP8: `diffIdMap` is pruned — compare against membership taken before the delete instead
  const before = Array.from({ length: clockRange * 2 }, (_, c) => idset.has(client, c))
  idset.delete(client, clock, len)
  for (let c = 0; c < before.length; c++) {
    t.assert(idset.has(client, c) === (before[c] && (c < clock || c >= clock + len)))
  }
}

/**
 * @param {t.TestCase} tc
 */
export const testUserAttributionEncodingBenchmark = tc => {
  /**
   * @todo debug why this approach needs 30 bytes per item
   * @todo it should be possible to only use a single idmap and, in each attr entry, encode the diff
   * to the previous entries (e.g. remove a,b, insert c,d)
   */
  const attributions = createIdMap()
  const currentTime = time.getUnixTime()
  const ydoc = new YY.Doc()
  ydoc.on('afterTransaction', tr => {
    // YP8: `createIdMapFromIdSet` is pruned — add the ranges directly
    tr.insertSet.forEach((r, client) => attributions.add(client, r.clock, r.len, [createContentAttribute('insert', 'userX'), createContentAttribute('insertAt', currentTime)]))
    tr.deleteSet.forEach((r, client) => attributions.add(client, r.clock, r.len, [createContentAttribute('delete', 'userX'), createContentAttribute('deleteAt', currentTime)]))
  })
  const ytext = ydoc.get()
  const N = 10000
  t.measureTime(`time to attribute ${N / 1000}k changes`, () => {
    for (let i = 0; i < N; i++) {
      if (i % 2 > 0 && ytext.length > 0) {
        const pos = prng.int31(tc.prng, 0, ytext.length)
        const delLen = prng.int31(tc.prng, 0, ytext.length - pos)
        ytext.delete(pos, delLen)
      } else {
        ytext.insert(prng.int31(tc.prng, 0, ytext.length), prng.word(tc.prng))
      }
    }
  })
  t.measureTime('time to encode attributions map', () => {
    /**
     * @todo I can optimize size by encoding only the differences to the prev item.
     */
    const encAttributions = ids.encodeIdMap(attributions)
    t.info('encoded size: ' + encAttributions.byteLength)
    t.info('size per change: ' + math.floor((encAttributions.byteLength / N) * 100) / 100 + ' bytes')
  })
}
