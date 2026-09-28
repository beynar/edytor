import * as t from 'lib0-v14/testing'
import * as s from 'lib0-v14/schema'
import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'

/**
 * A `ContentIds` (`{inserts, deletes}` IdSets) — P8 pruned `Y.createContentIds`.
 *
 * @return {ContentIds}
 */
const contentIds = () => ({ inserts: Y.createIdSet(), deletes: Y.createIdSet() })

/**
 * Every schema on the public surface, paired with a value it must accept.
 *
 * The explicit return annotation is required: without it the mixed tuples infer a union element
 * type and destructuring `$schema` loses `.check`.
 *
 * @return {Array<[string, s.Schema<any>, any]>}
 */
const $schemas = () => [
  ['$idSet', Y.$idSet, Y.createIdSet()],
  ['$idMapAny', Y.$idMapAny, Y.createIdMap()],
  ['$contentIds', Y.$contentIds, contentIds()],
  ['$contentMap', Y.$contentMap, Y.createContentMap()],
  ['$doc', Y.$doc, new Y.Doc()],
  ['$nodeAny', Y.$nodeAny, new Y.Doc().get('n')]
]

/**
 * @param {t.TestCase} _tc
 */
export const testSchemasAcceptTheirOwnInstance = _tc => {
  $schemas().forEach(([name, $schema, instance]) => {
    t.group(name, () => {
      t.assert($schema.check(instance))
    })
  })
}

/**
 * No schema accepts a foreign value, and none throws. `s.$object` returns false for null and reads
 * its shape's keys off the value, so primitives / arrays / Maps fail on the `undefined` fields.
 *
 * @param {t.TestCase} _tc
 */
export const testSchemasRejectJunk = _tc => {
  const junk = [null, undefined, {}, 0, 1, '', 'idSet', [], true, false, new Map(), new Set(), () => {}]
  $schemas().forEach(([name, $schema]) => {
    t.group(name, () => {
      junk.forEach(j => {
        t.assert(!$schema.check(j), `must reject ${typeof j} ${String(j)}`)
      })
    })
  })
}

/**
 * The nominal tags discriminate IdSet from IdMap in both directions. Structurally an IdSet
 * (`{clients}`) is a *subset* of an IdMap (`{clients, attrsH, attrs}`), and `s.$object` always
 * permits excess properties - so only a nominal check can tell them apart.
 *
 * @param {t.TestCase} _tc
 */
export const testIdSetIdMapDiscrimination = _tc => {
  t.assert(!Y.$idSet.check(Y.createIdMap()), '$idSet rejects an IdMap')
  t.assert(!Y.$idMapAny.check(Y.createIdSet()), '$idMapAny rejects an IdSet')
}

/**
 * @param {t.TestCase} _tc
 */
export const testContentIdsVsContentMap = _tc => {
  const cIds = contentIds()
  const cMap = Y.createContentMap()
  t.group('positive', () => {
    t.assert(Y.$contentIds.check(cIds))
    t.assert(Y.$contentMap.check(cMap))
  })
  t.group('both directions', () => {
    t.assert(!Y.$contentIds.check(cMap), '$contentIds rejects a ContentMap')
    t.assert(!Y.$contentMap.check(cIds), '$contentMap rejects a ContentIds')
  })
  t.group('mixed shapes', () => {
    const a = { inserts: Y.createIdSet(), deletes: Y.createIdMap() }
    const b = { inserts: Y.createIdMap(), deletes: Y.createIdSet() }
    t.assert(!Y.$contentIds.check(a))
    t.assert(!Y.$contentIds.check(b))
    t.assert(!Y.$contentMap.check(a))
    t.assert(!Y.$contentMap.check(b))
  })
  t.group('missing fields', () => {
    t.assert(!Y.$contentIds.check({ inserts: Y.createIdSet() }), 'deletes missing')
    t.assert(!Y.$contentIds.check({ deletes: Y.createIdSet() }), 'inserts missing')
  })
  t.group('excess properties are allowed - s.$object reads the shape keys', () => {
    t.assert(Y.$contentIds.check({ ...contentIds(), extra: 1 }))
  })
}

/**
 * The tags are interned in a global cross-install registry, so re-declaring a name returns the very
 * same schema object. That is what makes `$type` sound across duplicate yjs installations, and what
 * an `x.$type === $idMapAny` dispatch would rely on.
 *
 * Identity (`===`), never `.equals()` - `$Type#equals` compares an unset `.shape`, so any two
 * `$Type`s compare equal.
 *
 * @param {t.TestCase} _tc
 */
export const testTagInterning = _tc => {
  t.assert(s.$type('y:idSet', null) === Y.$idSet)
  t.assert(s.$type('y:idMap', null) === Y.$idMapAny)
  t.assert(s.$type('y:node', null) === Y.$nodeAny)
  t.assert(s.$type('y:doc', null) === Y.$doc)
  t.assert(s.$type('y:renderer', null) === Y.$renderer)
}

/**
 * The prototype stamps are what `check()` reads.
 *
 * @param {t.TestCase} _tc
 */
export const testPrototypeStamps = _tc => {
  t.assert(Y.IdSet.prototype.$type === Y.$idSet)
  t.assert(Y.IdMap.prototype.$type === Y.$idMapAny)
  t.assert(Y.Node.prototype.$type === Y.$nodeAny)
  t.assert(Y.Doc.prototype.$type === Y.$doc)
  t.group('instances carry the tag', () => {
    t.assert(Y.createIdSet().$type === Y.$idSet)
    t.assert(Y.createIdMap().$type === Y.$idMapAny)
    t.assert(new Y.Doc().get('n').$type === Y.$nodeAny)
    t.assert(new Y.Doc().$type === Y.$doc)
  })
}
