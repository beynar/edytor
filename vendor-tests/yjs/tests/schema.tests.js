import * as t from 'lib0-v14/testing'
import * as s from 'lib0-v14/schema'
import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'

/**
 * @param {any} val
 * @return {ContentAttribute<any>}
 */
const attr = val => Y.createContentAttribute('u', val)

/**
 * An IdMap holding one attribute value per range, all on client 1.
 *
 * @param {Array<any>} vals
 * @return {IdMap<any>}
 */
const idMapOf = vals => {
  const m = Y.createIdMap()
  vals.forEach((v, i) => m.add(1, i * 10, 10, [attr(v)]))
  return m
}

/**
 * @return {IdSet}
 */
const idSetOf = () => {
  const set = Y.createIdSet()
  set.add(1, 0, 10)
  return set
}

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
  ['$idMap($string)', Y.$idMap(s.$string), idMapOf(['a'])],
  ['$contentIds', Y.$contentIds, Y.createContentIds()],
  ['$contentMap', Y.$contentMap, Y.createContentMap()],
  ['$doc', Y.$doc, new Y.Doc()],
  ['$nodeAny', Y.$nodeAny, new Y.Doc().get('n')],
  ['$node({name:"p"})', Y.$node({ name: 'p' }), new Y.Doc().get('n', 'p')]
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
  t.assert(!Y.$idMap(s.$string).check(Y.createIdSet()), '$idMap rejects an IdSet')
}

/**
 * @param {t.TestCase} _tc
 */
export const testContentIdsVsContentMap = _tc => {
  const cIds = Y.createContentIds()
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
    t.assert(Y.$contentIds.check({ ...Y.createContentIds(), extra: 1 }))
  })
}

/**
 * $idMap($attrs) checks the mapped values, not merely the nominal type.
 *
 * @param {t.TestCase} _tc
 */
export const testIdMapValueSchema = _tc => {
  t.group('accepts the matching value type, rejects the other', () => {
    t.assert(Y.$idMap(s.$string).check(idMapOf(['a', 'b'])))
    t.assert(!Y.$idMap(s.$string).check(idMapOf([1, 2])))
    t.assert(Y.$idMap(s.$number).check(idMapOf([1, 2])))
    t.assert(!Y.$idMap(s.$number).check(idMapOf(['a', 'b'])))
  })
  t.group('a single mismatching value is enough to reject', () => {
    t.assert(!Y.$idMap(s.$string).check(idMapOf(['a', 1])))
    t.assert(!Y.$idMap(s.$number).check(idMapOf([1, 'a'])))
  })
  t.group('an empty map holds no values, so it satisfies every $attrs', () => {
    t.assert(Y.$idMap(s.$string).check(Y.createIdMap()))
    t.assert(Y.$idMap(s.$number).check(Y.createIdMap()))
  })
  t.group('$idMapAny ignores the value type', () => {
    t.assert(Y.$idMapAny.check(idMapOf(['a'])))
    t.assert(Y.$idMapAny.check(idMapOf([1])))
  })
}

/**
 * `check()` must not mutate its argument. `AttrRanges#getIds` sorts and splices in place, so a check
 * built on it would silently reorder the caller's map; `everyAttr` iterates the raw ranges instead.
 *
 * @param {t.TestCase} _tc
 */
export const testIdMapCheckDoesNotMutate = _tc => {
  const m = Y.createIdMap()
  // deliberately out of clock order, so a sort would be observable
  m.add(1, 10, 5, [attr('b')])
  m.add(1, 0, 10, [attr('a')])
  const ranges = /** @type {any} */ (m.clients.get(1))
  t.assert(ranges.sorted === false, 'precondition: not yet sorted')
  t.assert(Y.$idMap(s.$string).check(m))
  t.assert(ranges.sorted === false, 'check() must not have sorted the ranges')
}

/**
 * Every real IdMap producer yields a map that $idMap validates correctly.
 *
 * Every producer fed only string values must be accepted by `$idMap($string)`. The `keepsValues`
 * flag drives the far more important negative assertion: `$idMap($number)` must *reject* it. Only
 * the three genuinely-emptying producers are exempt - they hold nothing, so they satisfy every
 * `$attrs` vacuously and cannot discriminate. Without the negative, `$idMap($string).check` would
 * pass just as happily on a producer that silently dropped every attribute.
 *
 * @param {t.TestCase} _tc
 */
export const testIdMapProducers = _tc => {
  /**
   * @type {Array<[string, () => IdMap<any>, boolean]>}
   */
  const producers = [
    ['createIdMap', () => Y.createIdMap(), false],
    ['add', () => idMapOf(['k']), true],
    ['mergeIdMaps', () => Y.mergeIdMaps([idMapOf(['k']), idMapOf(['j'])]), true],
    ['diffIdMap (exclude all)', () => Y.diffIdMap(idMapOf(['k']), idSetOf()), false],
    ['diffIdMap (partial)', () => {
      const exclude = Y.createIdSet()
      exclude.add(1, 0, 5)
      return Y.diffIdMap(idMapOf(['k']), exclude)
    }, true],
    ['intersectMaps', () => Y.intersectMaps(idMapOf(['k']), idMapOf(['k'])), true],
    ['createIdMapFromIdSet', () => Y.createIdMapFromIdSet(idSetOf(), [attr('k')]), true],
    ['filterIdMap (keep)', () => Y.filterIdMap(idMapOf(['k']), () => true), true],
    ['filterIdMap (drop)', () => Y.filterIdMap(idMapOf(['k']), () => false), false],
    ['decodeIdMap(encodeIdMap)', () => Y.decodeIdMap(Y.encodeIdMap(idMapOf(['k']))), true],
    ['insertIntoIdMap(dest, IdMap)', () => {
      const dest = Y.createIdMap()
      Y.insertIntoIdMap(dest, idMapOf(['k']))
      return dest
    }, true]
  ]
  producers.forEach(([name, produce, keepsValues]) => {
    t.group(name, () => {
      const m = produce()
      t.assert(Y.$idMapAny.check(m), 'is an IdMap')
      t.assert(Y.$idMap(s.$string).check(m), 'holds only string values (vacuously so when empty)')
      if (keepsValues) {
        t.assert(!Y.$idMap(s.$number).check(m), 'carries its value through, so it rejects $number')
      }
    })
  })
}

/**
 * `insertIntoIdMap`'s `src` may be an IdSet, which puts attribute-less `IdRanges` into an `IdMap`.
 * `$idMap` must not throw on those - `IdRange#attrs` is `[]` by design, so they are vacuously fine.
 *
 * @param {t.TestCase} _tc
 */
export const testIdMapWithIdRanges = _tc => {
  t.group('an IdSet merged into an IdMap', () => {
    const dest = Y.createIdMap()
    Y.insertIntoIdMap(dest, idSetOf())
    t.assert(Y.$idMap(s.$string).check(dest), 'no attributes present, so nothing can violate $attrs')
    t.assert(Y.$idMap(s.$number).check(dest))
  })
  t.group('a map holding both AttrRanges and IdRanges still checks its values', () => {
    const dest = idMapOf(['k']) // client 1 -> AttrRanges
    const other = Y.createIdSet()
    other.add(2, 0, 10) // client 2 -> IdRanges
    Y.insertIntoIdMap(dest, other)
    t.assert(Y.$idMap(s.$string).check(dest))
    t.assert(!Y.$idMap(s.$number).check(dest), 'client 1 still holds a string')
  })
  t.group('an IdRanges container that later receives AttrRanges on the SAME client', () => {
    // `_insertIntoIdSet` picks the container class from whichever `src` reaches a client first, and
    // its append branch copies elements without checking their class. So an IdSet-first / IdMap-
    // second sequence leaves real AttrRanges inside an `IdRanges`. `IdRanges#everyAttr` must
    // iterate rather than shortcut to `true`, or these attributes become invisible to `$idMap`.
    const dest = Y.createIdMap()
    const set = Y.createIdSet()
    set.add(1, 0, 10)
    Y.insertIntoIdMap(dest, set) // client 1 -> IdRanges container
    Y.insertIntoIdMap(dest, idMapOf([42])) // same client -> AttrRange(42) appended into it
    t.assert(/** @type {any} */ (dest.clients.get(1)).constructor.name === 'IdRanges', 'precondition: still an IdRanges')
    t.assert(!Y.$idMap(s.$string).check(dest), 'the leaked number 42 must be seen')
    t.assert(!Y.$idMap(s.$never).check(dest), '$never must reject a map that holds a value')
    t.assert(Y.$idMap(s.$number).check(dest), 'and accepted for the matching schema')
    t.group('the verdict agrees with an encode round-trip', () => {
      const rt = Y.decodeIdMap(Y.encodeIdMap(dest))
      t.assert(Y.$idMap(s.$string).check(rt) === Y.$idMap(s.$string).check(dest))
      t.assert(Y.$idMap(s.$number).check(rt) === Y.$idMap(s.$number).check(dest))
    })
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testNodeSchemas = _tc => {
  const ydoc = new Y.Doc()
  const unnamed = ydoc.get('unnamed')
  const para = ydoc.get('para', 'p')
  t.group('$nodeAny', () => {
    t.assert(Y.$nodeAny.check(unnamed))
    t.assert(Y.$nodeAny.check(para))
    t.assert(!Y.$nodeAny.check(ydoc), 'a Doc is not a Node')
    t.assert(!Y.$doc.check(para), 'a Node is not a Doc')
  })
  t.group('$node(conf) checks the name', () => {
    t.assert(Y.$node({ name: 'p' }).check(para))
    t.assert(!Y.$node({ name: 'h1' }).check(para), 'discriminates between named nodes')
  })
  t.group('a conf without a name accepts any node', () => {
    t.assert(Y.$node({ text: true }).check(para))
    t.assert(Y.$node({ text: true }).check(unnamed))
    t.assert(Y.$node({}).check(unnamed))
  })
  t.group('every ReadableDeltaConf name form', () => {
    t.assert(Y.$node({ name: ['p', 'h1'] }).check(para), 'array form')
    t.assert(!Y.$node({ name: ['h1', 'h2'] }).check(para))
    t.assert(Y.$node({ name: s.$string }).check(para), 'schema form')
  })
  t.group('a named conf rejects a nameless node', () => {
    // Deliberately stricter than lib0's $Delta.check, which skips the name when name == null: a
    // nameless *node* is definitively a fragment, whereas a nameless *delta* asserts nothing.
    t.assert(unnamed.name === null, 'precondition')
    t.assert(!Y.$node({ name: 'p' }).check(unnamed))
    t.assert(!Y.$node({ name: s.$string }).check(unnamed))
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
