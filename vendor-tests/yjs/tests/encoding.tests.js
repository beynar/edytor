import * as t from 'lib0-v14/testing'

import {
  contentRefs,
  readContentDeleted,
  readContentBinary,
  readContentString,
  readContentType,
  readContentFormat,
  readContentAny,
  readContentHold,
  readContentMove
} from '../../../src/lib/crdt/vendor/yjs/src/ynode.js'


/**
 * @param {t.TestCase} _tc
 */
export const testStructReferences = _tc => {
  t.assert(contentRefs.length === 13) // YP20: 11, a hold record; YP22: 12, a move record
  t.assert(contentRefs[1] === readContentDeleted)
  // YP19: JSON (2), embed (5) and subdocument (9) contents are refused
  t.assert(contentRefs[2] === contentRefs[0] && contentRefs[5] === contentRefs[0] && contentRefs[9] === contentRefs[0])
  t.assert(contentRefs[3] === readContentBinary)
  t.assert(contentRefs[4] === readContentString)
  t.assert(contentRefs[6] === readContentFormat)
  t.assert(contentRefs[7] === readContentType)
  t.assert(contentRefs[8] === readContentAny)
  // contentRefs[10] is reserved for Skip structs
  t.assert(contentRefs[11] === readContentHold) // YP20
  t.assert(contentRefs[12] === readContentMove) // YP22
}

