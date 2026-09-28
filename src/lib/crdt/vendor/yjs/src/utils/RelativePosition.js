import * as error from 'lib0-v14/error'

import { Item, followRedone, ContentType } from '../structs/Item.js'
import { findMarker } from '../ynode.js'
import { findRootTypeKey, createID } from './ID.js'
import { rendererContentLength } from './renderer-helpers.js'

/**
 * A relative position is based on the Yjs model and is not affected by document changes.
 * E.g. If you place a relative position before a certain character, it will always point to this character.
 * If you place a relative position at the end of a type, it will always point to the end of the type.
 *
 * A numeric position is often unsuited for user selections, because it does not change when content is inserted
 * before or after.
 *
 * ```Insert(0, 'x')('a|bc') = 'xa|bc'``` Where | is the relative position.
 *
 * One of the properties must be defined.
 *
 * @example
 *   // Current cursor position is at position 10
 *   const relativePosition = createRelativePositionFromIndex(yText, 10)
 *   // modify yText
 *   yText.insert(0, 'abc')
 *   yText.delete(3, 10)
 *   // Compute the cursor position
 *   const absolutePosition = createAbsolutePositionFromRelativePosition(y, relativePosition)
 *   absolutePosition.type === yText // => true
 *   console.log('cursor location is ' + absolutePosition.index) // => cursor location is 3
 *
 */
export class RelativePosition {
  /**
   * @param {ID|null} type
   * @param {string|null} tname
   * @param {ID|null} item
   * @param {number} assoc
   */
  constructor (type, tname, item, assoc = 0) {
    /**
     * @type {ID|null}
     */
    this.type = type
    /**
     * @type {string|null}
     */
    this.tname = tname
    /**
     * @type {ID | null}
     */
    this.item = item
    /**
     * A relative position is associated to a specific character. By default
     * assoc >= 0, the relative position is associated to the character
     * after the meant position.
     * I.e. position 1 in 'ab' is associated to character 'b'.
     *
     * If assoc < 0, then the relative position is associated to the character
     * before the meant position.
     *
     * @type {number}
     */
    this.assoc = assoc
  }
}

/**
 * @param {RelativePosition} rpos
 * @return {any}
 */
export const relativePositionToJSON = rpos => {
  const json = {}
  if (rpos.type) {
    json.type = rpos.type
  }
  if (rpos.tname) {
    json.tname = rpos.tname
  }
  if (rpos.item) {
    json.item = rpos.item
  }
  if (rpos.assoc != null) {
    json.assoc = rpos.assoc
  }
  return json
}

/**
 * @param {any} json
 * @return {RelativePosition}
 *
 * @function
 */
export const createRelativePositionFromJSON = json => new RelativePosition(json.type == null ? null : createID(json.type.client, json.type.clock), json.tname ?? null, json.item == null ? null : createID(json.item.client, json.item.clock), json.assoc == null ? 0 : json.assoc)

export class AbsolutePosition {
  /**
   * @param {YNode<any>} type
   * @param {number} index
   * @param {number} [assoc]
   */
  constructor (type, index, assoc = 0) {
    /**
     * @type {YNode<any>}
     */
    this.type = type
    /**
     * @type {number}
     */
    this.index = index
    this.assoc = assoc
  }
}

/**
 * @param {YNode<any>} type
 * @param {number} index
 * @param {number} [assoc]
 *
 * @function
 */
export const createAbsolutePosition = (type, index, assoc = 0) => new AbsolutePosition(type, index, assoc)

/**
 * @param {YNode<any>} type
 * @param {ID|null} item
 * @param {number} [assoc]
 *
 * @function
 */
export const createRelativePosition = (type, item, assoc) => {
  let typeid = null
  let tname = null
  if (type._item === null) {
    tname = findRootTypeKey(type)
  } else {
    typeid = createID(type._item.id.client, type._item.id.clock)
  }
  return new RelativePosition(typeid, tname, item, assoc)
}

/**
 * Create a relativePosition based on a absolute position.
 *
 * @param {YNode} type The base type (e.g. YText or YArray).
 * @param {number} index The absolute position.
 * @param {number} [assoc]
 * @param {import('./renderer-helpers.js').AbstractRenderer?} renderer
 * @return {RelativePosition}
 *
 * @function
 */
export const createRelativePositionFromTypeIndex = (type, index, assoc = 0, renderer = null) => {
  let t = type._start
  if (assoc < 0) {
    // associated to the left character or the beginning of a type, increment index if possible.
    if (index === 0) {
      return createRelativePosition(type, null, assoc)
    }
    index--
  }
  // Seed the walk from a search marker — under `renderer === null` the loop
  // below counts countable/non-deleted length, exactly the space
  // `marker.index` records, so `findMarker`'s (item, left-edge-index) result
  // is a valid cursor. With no markers this falls back to the `_start` walk.
  if (renderer === null && index > 0 && type._searchMarker !== null && type._searchMarker.length > 0) {
    const m = findMarker(type, index)
    if (m !== null && m.index <= index) {
      t = m.p
      index -= m.index
    }
  }
  while (t !== null) {
    const len = rendererContentLength(renderer, t)
    if (len > index) {
      // case 1: found position somewhere in the linked list
      return createRelativePosition(type, createID(t.id.client, t.id.clock + index), assoc)
    }
    index -= len
    if (t.right === null && assoc < 0) {
      // left-associated position, return last available id
      return createRelativePosition(type, t.lastId, assoc)
    }
    t = t.right
  }
  return createRelativePosition(type, null, assoc)
}

/**
 * @param {StructStore} store
 * @param {ID} id
 */
const getItemWithOffset = (store, id) => {
  const item = store.getItem(id)
  const diff = id.clock - item.id.clock
  return {
    item, diff
  }
}

/**
 * Transform a relative position to an absolute position.
 *
 * If you want to share the relative position with other users, you should set
 * `followUndoneDeletions` to false to get consistent results across all clients.
 *
 * When calculating the absolute position, we try to follow the "undone deletions". This yields
 * better results for the user who performed undo. However, only the user who performed the undo
 * will get the better results, the other users don't know which operations recreated a deleted
 * range of content. There is more information in this ticket: https://github.com/yjs/yjs/issues/638
 *
 * @param {RelativePosition} rpos
 * @param {Doc} doc
 * @param {boolean} followUndoneDeletions - whether to follow undone deletions - see https://github.com/yjs/yjs/issues/638
 * @param {import('./renderer-helpers.js').AbstractRenderer?} renderer
 * @return {AbsolutePosition|null}
 *
 * @function
 */
export const createAbsolutePositionFromRelativePosition = (rpos, doc, followUndoneDeletions = true, renderer = null) => {
  const store = doc.store
  const rightID = rpos.item
  const typeID = rpos.type
  const tname = rpos.tname
  const assoc = rpos.assoc
  let type = null
  let index = 0
  if (rightID !== null) {
    if (store.getClock(rightID.client) <= rightID.clock) {
      return null
    }
    const res = followUndoneDeletions ? followRedone(store, rightID) : getItemWithOffset(store, rightID)
    const right = res.item
    if (!(right instanceof Item)) {
      return null
    }
    type = /** @type {YNode<any>} */ (right.parent)
    // an index into a deleted type is meaningless - unless a renderer still renders the type
    // (e.g. a deleted-but-rendered suggestion-mode subtree)
    if (type._item === null || !type._item.deleted || rendererContentLength(renderer, type._item) > 0) {
      index = rendererContentLength(renderer, right) === 0 ? 0 : (res.diff + (assoc >= 0 ? 0 : 1)) // adjust position based on left association if necessary
      let n = right.left
      if (renderer === null && type._searchMarker !== null && type._searchMarker.length > 0) {
        // Marker-assisted left walk: under `renderer === null` this loop
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
              index += m.index + rendererContentLength(renderer, n)
              n = null
              break
            }
          }
          index += rendererContentLength(renderer, n)
          n = n.left
        }
      } else {
        while (n !== null) {
          index += rendererContentLength(renderer, n)
          n = n.left
        }
      }
    }
  } else {
    if (tname !== null) {
      type = doc.get(tname)
    } else if (typeID !== null) {
      if (store.getClock(typeID.client) <= typeID.clock) {
        // type does not exist yet
        return null
      }
      const { item } = followUndoneDeletions ? followRedone(store, typeID) : { item: store.getItem(typeID) }
      if (item instanceof Item && item.content instanceof ContentType) {
        type = item.content.type
      } else {
        // struct is garbage collected
        return null
      }
    } else {
      throw error.unexpectedCase()
    }
    if (assoc >= 0) {
      index = type._length
    } else {
      index = 0
    }
  }
  return createAbsolutePosition(type, index, rpos.assoc)
}

