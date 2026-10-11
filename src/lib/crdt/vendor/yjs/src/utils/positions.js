// YP19: a position as an item id and back — what upstream's relative
// positions resolve, without the `RelativePosition`/`AbsolutePosition`
// objects, their JSON form, root-key types or the redone-chain option
// (edytor follows no undone deletion: every replica resolves an id alike).

import { Item } from '../structs/Item.js'
import { findMarker } from '../ynode.js'
import { createID } from './ID.js'
import { liveLength } from './transaction-helpers.js'

/**
 * The id at live index `index` of `type`: with `assoc >= 0` the unit at
 * `index` (`null` at the end), with `assoc < 0` the unit before it (`null`
 * at the start).
 *
 * @param {YNode} type
 * @param {number} index
 * @param {number} [assoc]
 * @return {ID|null}
 */
export const idAtIndex = (type, index, assoc = 0) => {
  let t = type._start
  if (assoc < 0) {
    // associated to the left character or the beginning of a type, increment index if possible.
    if (index === 0) {
      return null
    }
    index--
  }
  // Seed the walk from a search marker — the loop below counts
  // countable/non-deleted length, exactly the space `marker.index` records,
  // so `findMarker`'s (item, left-edge-index) result is a valid cursor. With
  // no markers this falls back to the `_start` walk.
  if (index > 0 && type._searchMarker !== null && type._searchMarker.length > 0) {
    const m = findMarker(type, index)
    if (m !== null && m.index <= index) {
      t = m.p
      index -= m.index
    }
  }
  while (t !== null) {
    const len = liveLength(t)
    if (len > index) {
      return createID(t.id.client, t.id.clock + index)
    }
    index -= len
    if (t.right === null && assoc < 0) {
      // left-associated position, return last available id
      return t.lastId
    }
    t = t.right
  }
  return null
}

/**
 * The live index of the position bound to unit `id` (`assoc >= 0`: before
 * it, `assoc < 0`: after it) and the node holding it; `null` when `id` is
 * not integrated here or was collected. A position in a deleted node is
 * index `0`.
 *
 * @param {Doc} doc
 * @param {ID} id
 * @param {number} [assoc]
 * @return {{ type: YNode, index: number }|null}
 */
export const indexOfId = (doc, id, assoc = 0) => {
  const store = doc.store
  if (store.getClock(id.client) <= id.clock) {
    return null
  }
  const right = store.getItem(id)
  if (!(right instanceof Item)) {
    return null
  }
  const type = /** @type {YNode} */ (right.parent)
  let index = 0
  // an index into a deleted type is meaningless
  if (type._item === null || !type._item.deleted) {
    index = liveLength(right) === 0 ? 0 : (id.clock - right.id.clock + (assoc >= 0 ? 0 : 1)) // adjust position based on left association if necessary
    let n = right.left
    if (type._searchMarker !== null && type._searchMarker.length > 0) {
      // Marker-assisted left walk: this loop
      // accumulates countable/non-deleted length — the same space
      // `marker.index` records — so the first marked item reached supplies
      // the sum of everything left of it and the walk can stop early.
      // Items whose flag outlived their record (wholesale marker clears
      // leave the flag set) are simply walked past.
      const markers = type._searchMarker
      while (n !== null) {
        if (n.marker) {
          let m = null
          for (let i = 0; i < markers.length; i++) {
            if (markers[i].p === n) { m = markers[i]; break }
          }
          if (m !== null) {
            // m.index is the left edge of n — the count of rendered units
            // strictly before it — so n's own contribution is added too.
            index += m.index + liveLength(n)
            n = null
            break
          }
        }
        index += liveLength(n)
        n = n.left
      }
    } else {
      while (n !== null) {
        index += liveLength(n)
        n = n.left
      }
    }
  }
  return { type, index }
}
