import * as t from 'lib0-v14/testing'

import {
  contentRefs,
  readContentDeleted,
  readContentBinary,
  readContentString,
  readContentType,
  readContentFormat,
  readContentAny
} from '../../../src/lib/crdt/vendor/yjs/src/ynode.js'


/**
 * @param {t.TestCase} _tc
 */
export const testStructReferences = _tc => {
  t.assert(contentRefs.length === 11)
  t.assert(contentRefs[1] === readContentDeleted)
  // YP19: JSON (2), embed (5) and subdocument (9) contents are refused
  t.assert(contentRefs[2] === contentRefs[0] && contentRefs[5] === contentRefs[0] && contentRefs[9] === contentRefs[0])
  t.assert(contentRefs[3] === readContentBinary)
  t.assert(contentRefs[4] === readContentString)
  t.assert(contentRefs[6] === readContentFormat)
  t.assert(contentRefs[7] === readContentType)
  t.assert(contentRefs[8] === readContentAny)
  // contentRefs[10] is reserved for Skip structs
}

