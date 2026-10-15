import * as error from 'lib0-v14/error'
import * as binary from 'lib0-v14/binary'

import { AbstractStruct, addStructToIdSet } from '../structs/AbstractStruct.js'

import { ID, createID, compareIDs, findRootTypeKey } from '../utils/ID.js'
import { GC } from '../structs/GC.js'
import { sortsBefore, pairedRole, markClass } from '../utils/marks.js' // YP13, YP21

import * as math from 'lib0-v14/math' // YP20

import {
  replaceStruct,
  getItemCleanEnd,
  getItemCleanStart, // YP20
  findIndexSS, // YP20
  addChangedTypeToTransaction,
  isKeptReplaced // YP14
} from '../utils/transaction-helpers.js'

/**
 * @todo This should return several items
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {{item:Item, diff:number}}
 */
export const followRedone = (store, id) => {
  /**
   * @type {ID|null}
   */
  let nextID = id
  let diff = 0
  let item
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff)
    }
    item = store.getItem(nextID)
    diff = nextID.clock - item.id.clock
    nextID = item.redone
  } while (nextID !== null && item.isItem)
  return {
    item, diff
  }
}

/**
 * Abstract class that represents any content.
 */
export class Item extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {Item | null} left
   * @param {ID | null} origin
   * @param {Item | null} right
   * @param {ID | null} rightOrigin
   * @param {YNode|ID|string|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it, is string if child of top-level-parent
   * @param {string | null} parentSub
   * @param {AbstractContent} content
   */
  constructor (id, left, origin, right, rightOrigin, parent, parentSub, content) {
    super(id, content.getLength())
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    this.origin = origin
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    this.left = left
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    this.right = right
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    this.rightOrigin = rightOrigin
    /**
     * @type {YNode|ID|string|null}
     */
    this.parent = parent
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     */
    this.parentSub = parentSub
    /**
     * If this type's effect is redone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    this.redone = null
    /**
     * @type {AbstractContent}
     */
    this.content = content
    /**
     * bit1: keep
     * bit2: countable
     * bit3: deleted
     * bit4: mark - mark node as fast-search-marker
     * @type {number} byte
     */
    this.info = this.content.isCountable() ? binary.BIT2 : 0
    /**
     * YP20: how many live hold records (`ContentHold`) name this item. A
     * held item reads as deleted; the count is local, never encoded (each
     * replica counts the records it integrated).
     * @type {number}
     */
    this.holds = 0
  }

  /**
   * This is used to mark the item as an indexed fast-search marker
   *
   * @type {boolean}
   */
  set marker (isMarked) {
    if (((this.info & binary.BIT4) > 0) !== isMarked) {
      this.info ^= binary.BIT4
    }
  }

  get marker () {
    return (this.info & binary.BIT4) > 0
  }

  /**
   * If true, do not garbage collect this Item.
   */
  get keep () {
    return (this.info & binary.BIT1) > 0
  }

  set keep (doKeep) {
    if (this.keep !== doKeep) {
      this.info ^= binary.BIT1
    }
  }

  get countable () {
    return (this.info & binary.BIT2) > 0
  }

  /**
   * Whether this item is hidden: removed, or held by a live hold record (YP20).
   * @type {Boolean}
   */
  get deleted () {
    return (this.info & binary.BIT3) > 0 || this.holds > 0
  }

  /**
   * Whether the engine deleted this item (the delete set's fact; YP20: a held
   * item is hidden, not removed).
   * @type {Boolean}
   */
  get removed () {
    return (this.info & binary.BIT3) > 0
  }

  markDeleted () {
    this.info |= binary.BIT3
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset
      this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1))
      this.origin = this.left.lastId
      this.content = this.content.splice(offset)
      this.length -= offset
    }

    if (this.parent) {
      if ((!this.left && (!this.right || this.right.left !== null)) || (this.left && this.left.right !== this.right)) {
        /**
         * @type {Item|null}
         */
        let left = this.left

        /**
         * @type {Item|null}
         */
        let o
        // set o to the first conflicting item
        if (left !== null) {
          o = left.right
        } else if (this.parentSub !== null) {
          o = /** @type {YNode} */ (this.parent)._map.get(this.parentSub) || null
          while (o !== null && o.left !== null) {
            o = o.left
          }
        } else {
          o = /** @type {YNode} */ (this.parent)._start
        }
        // TODO: use something like DeleteSet here (a tree implementation would be best)
        // @todo use global set definitions
        /**
         * @type {Set<Item>}
         */
        const conflictingItems = new Set()
        /**
         * @type {Set<Item>}
         */
        const itemsBeforeOrigin = new Set()
        // Let c in conflictingItems, b in itemsBeforeOrigin
        // ***{origin}bbbb{this}{c,b}{c,b}{o}***
        // Note that conflictingItems is a subset of itemsBeforeOrigin
        while (o !== null && o !== this.right) {
          itemsBeforeOrigin.add(o)
          conflictingItems.add(o)
          if (compareIDs(this.origin, o.origin)) {
            // case 1
            if (sortsBefore(o, this)) { // YP13: paired marks sort by side, then by client id
              left = o
              conflictingItems.clear()
            } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
              // this and o are conflicting and point to the same integration points. The id decides which item comes first.
              // Since this is to the left of o, we can break here
              break
            } // else, o might be integrated before an item that this conflicts with. If so, we will find it in the next iterations
          } else if (o.origin !== null && itemsBeforeOrigin.has(transaction.doc.store.getItem(o.origin))) { // use getItem instead of getItemCleanEnd because we don't want / need to split items.
            // case 2
            if (!conflictingItems.has(transaction.doc.store.getItem(o.origin))) {
              left = o
              conflictingItems.clear()
            }
          } else {
            break
          }
          o = o.right
        }
        this.left = left
      }
      // reconnect left/right + update parent map/start if necessary
      if (this.left !== null) {
        const right = this.left.right
        this.right = right
        this.left.right = this
      } else {
        let r
        if (this.parentSub !== null) {
          r = /** @type {YNode} */ (this.parent)._map.get(this.parentSub) || null
          while (r !== null && r.left !== null) {
            r = r.left
          }
        } else {
          r = /** @type {YNode} */ (this.parent)._start
          ;/** @type {YNode} */ (this.parent)._start = this
        }
        this.right = r
      }
      if (this.right !== null) {
        this.right.left = this
      } else if (this.parentSub !== null) {
        // set as current parent value if right === null and this is parentSub
        /** @type {YNode} */ (this.parent)._map.set(this.parentSub, this)
        if (this.left !== null) {
          // this is the current attribute value of parent. delete the previous value
          this.left.delete(transaction)
        }
      }
      // adjust length of parent
      if (this.parentSub === null && this.countable && !this.deleted) {
        /** @type {YNode} */ (this.parent)._length += this.length
      }
      addStructToIdSet(transaction.insertSet, this)
      transaction.doc.store.add(this)
      this.content.integrate(transaction, this)
      // add parent to transaction.changed
      addChangedTypeToTransaction(transaction, /** @type {YNode} */ (this.parent), this.parentSub)
      const parentItem = /** @type {YNode} */ (this.parent)._item
      // YP14: a node a concurrent value replaced keeps its subtree: what lands in it stays
      if ((parentItem !== null && parentItem.removed && !isKeptReplaced(parentItem)) || (this.parentSub !== null && this.right !== null)) { // YP20: a held parent is alive
        // delete if parent is deleted or if this is not the current attribute value of parent
        this.delete(transaction)
      }
    } else {
      // parent is not defined. Integrate GC struct instead
      new GC(this.id, this.length).integrate(transaction, 0)
    }
  }

  /**
   * Computes the last content address of this Item.
   */
  get lastId () {
    // allocating ids is pretty costly because of the amount of ids created, so we try to reuse whenever possible
    return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1)
  }

  /**
   * Try to merge two items
   *
   * @param {Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (
      this.constructor === right.constructor &&
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.removed === right.removed &&
      this.holds === right.holds && // YP20
      this.redone === null &&
      right.redone === null &&
      this.content.constructor === right.content.constructor &&
      this.content.mergeWith(right.content)
    ) {
      const searchMarker = /** @type {YNode} */ (this.parent)._searchMarker
      if (searchMarker) {
        searchMarker.forEach(marker => {
          if (marker.p === right) {
            // right is going to be "forgotten" so we need to update the marker
            marker.p = this
            // adjust marker index
            if (!this.deleted && this.countable) {
              marker.index -= this.length
            }
            // the anchor moved left — a snapshot taken at the old position is
            // stale at the new one (WU9 format-aware markers)
            marker.formats = null
          }
        })
      }
      if (right.keep) {
        this.keep = true
      }
      this.right = right.right
      if (this.right !== null) {
        this.right.left = this
      }
      this.length += right.length
      return true
    }
    return false
  }

  /**
   * Mark this Item as deleted.
   *
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (!this.removed) {
      const parent = /** @type {YNode} */ (this.parent)
      // adjust the length of parent
      if (this.holds > 0) {
        // YP20: already hidden — the delete set counts it again, the log gives it back
        logHold(transaction, this, this.length)
      } else if (this.countable && this.parentSub === null) {
        parent._length -= this.length
      }
      // WU9 format-aware markers: tombstoning a format item changes the format
      // state at every position at-or-right of it — cached `marker.formats`
      // snapshots may have folded it. Invalidate all snapshots in this parent;
      // they repopulate at quiescent points (end of applyDelta, findMarker).
      if (this.content.constructor === ContentFormat && parent._searchMarker !== null) {
        for (let i = 0; i < parent._searchMarker.length; i++) {
          parent._searchMarker[i].formats = null
        }
      }
      this.markDeleted()
      transaction.deleteSet.add(this.id.client, this.id.clock, this.length)
      addChangedTypeToTransaction(transaction, parent, this.parentSub)
      // YP14: a node a concurrent value replaced keeps its subtree (the document asked)
      if (!isKeptReplaced(this)) this.content.delete(transaction)
    }
  }

  /**
   * @param {Transaction} tr
   * @param {boolean} parentGCd
   */
  gc (tr, parentGCd) {
    if (!this.removed) { // YP20
      throw error.unexpectedCase()
    }
    this.content.gc(tr)
    if (parentGCd) {
      replaceStruct(tr, this, new GC(this.id, this.length))
    } else if (markClass(this) === 1) {
      // YP13, YP21: a paired mark item or a claim item keeps its content: its
      // class orders concurrent inserts (`markClass`) on every replica,
      // collected or not.
      this.content = new ContentDeleted(this.length)
    }
  }

  /**
   * Split this into two items
   * @param {Transaction?} transaction
   * @param {number} diff
   * @return {Item}
   */
  split (transaction, diff) {
    // create rightItem
    const { client, clock } = this.id
    const rightItem = new Item(
      createID(client, clock + diff),
      this,
      createID(client, clock + diff - 1),
      this.right,
      this.rightOrigin,
      this.parent,
      this.parentSub,
      this.content.splice(diff)
    )
    if (this.removed) { // YP20
      rightItem.markDeleted()
    }
    rightItem.holds = this.holds // YP20
    if (this.keep) {
      rightItem.keep = true
    }
    if (this.redone !== null) {
      rightItem.redone = createID(this.redone.client, this.redone.clock + diff)
    }
    if (transaction != null) {
      // update left (do not set leftItem.rightOrigin as it will lead to problems when syncing)
      this.right = rightItem
      // update right
      if (rightItem.right !== null) {
        rightItem.right.left = rightItem
      }
      // right is more specific.
      transaction._mergeStructs.push(rightItem)
      // update parent._map
      if (rightItem.parentSub !== null && rightItem.right === null) {
        /** @type {YNode} */ (rightItem.parent)._map.set(rightItem.parentSub, rightItem)
      }
    } else {
      rightItem.left = null
      rightItem.right = null
    }
    this.length = diff
    return rightItem
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoder} encoder The encoder to write data to.
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin
    const rightOrigin = this.rightOrigin
    const parentSub = this.parentSub
    const info = (this.content.getRef() & binary.BITS5) |
      (origin === null ? 0 : binary.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary.BIT6) // parentSub is non-null
    encoder.writeInfo(info)
    if (origin !== null) {
      encoder.writeLeftID(origin)
    }
    if (rightOrigin !== null) {
      encoder.writeRightID(rightOrigin)
    }
    if (origin === null && rightOrigin === null) {
      const parent = /** @type {YNode} */ (this.parent)
      if (parent._item !== undefined) {
        const parentItem = parent._item
        if (parentItem === null) {
          // parent type on y._map
          // find the correct key
          const ykey = findRootTypeKey(parent)
          encoder.writeParentInfo(true) // write parentYKey
          encoder.writeString(ykey)
        } else {
          encoder.writeParentInfo(false) // write parent id
          encoder.writeLeftID(parentItem.id)
        }
      } else if (parent.constructor === String) { // this edge case was added by differential updates
        encoder.writeParentInfo(true) // write parentYKey
        encoder.writeString(parent)
      } else if (parent.constructor === ID) {
        encoder.writeParentInfo(false) // write parent id
        encoder.writeLeftID(parent)
      } else {
        error.unexpectedCase()
      }
      if (parentSub !== null) {
        encoder.writeString(parentSub)
      }
    }
    this.content.write(encoder, offset, offsetEnd)
  }

  get ref () {
    return this.content.getRef()
  }
}

/**
 * @type {true}
 */
Item.prototype.isItem = true

/**
 * Do not implement this class!
 */
export class AbstractContent {
  /**
   * @return {number}
   */
  getLength () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    throw error.methodUnimplemented()
  }

  /**
   * Should return false if this Item is some kind of meta information
   * (e.g. format information).
   *
   * * Whether this Item should be addressable via `yarray.get(i)`
   * * Whether this Item should be counted when computing yarray.length
   *
   * @return {boolean}
   */
  isCountable () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {AbstractContent}
   */
  copy () {
    throw error.methodUnimplemented()
  }

  /**
   * @param {number} _offset
   * @return {AbstractContent}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {AbstractContent} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   */
  gc (_transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {UpdateEncoder} _encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (_encoder, _offset, _offsetEnd) {
    throw error.methodUnimplemented()
  }

  /**
   * @return {1|2|3|4|5|6|7|8|9|11}
   */
  getRef () { // YP20: 11, a hold record
    throw error.methodUnimplemented()
  }
}

export class ContentAny {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     */
    this.arr = arr
    // YP15: no development-mode deep freeze (a Uint8Array value cannot be frozen)
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentAny}
   */
  copy () {
    return new ContentAny(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentAny}
   */
  splice (offset) {
    const right = new ContentAny(this.arr.slice(offset))
    this.arr = this.arr.slice(0, offset)
    return right
  }

  /**
   * @param {ContentAny} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.arr = this.arr.concat(right.arr)
    return true
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoder} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const end = this.arr.length - offsetEnd
    encoder.writeLen(end - offset)
    for (let i = offset; i < end; i++) {
      const c = this.arr[i]
      encoder.writeAny(c)
    }
  }

  /**
   * @return {8}
   */
  getRef () {
    return 8
  }
}

export class ContentBinary {
  /**
   * @param {Uint8Array} content
   */
  constructor (content) {
    this.content = content
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.content]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentBinary}
   */
  copy () {
    return new ContentBinary(this.content)
  }

  /**
   * @param {number} _offset
   * @return {ContentBinary}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentBinary} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoder} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeBuf(this.content)
  }

  /**
   * @return {3}
   */
  getRef () {
    return 3
  }
}

export class ContentDeleted {
  /**
   * @param {number} len
   */
  constructor (len) {
    this.len = len
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.len
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentDeleted}
   */
  copy () {
    return new ContentDeleted(this.len)
  }

  /**
   * @param {number} offset
   * @return {ContentDeleted}
   */
  splice (offset) {
    const right = new ContentDeleted(this.len - offset)
    this.len = offset
    return right
  }

  /**
   * @param {ContentDeleted} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.len += right.len
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    transaction.deleteSet.add(item.id.client, item.id.clock, this.len)
    item.markDeleted()
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoder} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    encoder.writeLen(this.len - offset - offsetEnd)
  }

  /**
   * @return {1}
   */
  getRef () {
    return 1
  }
}

// YP20 begin (edytor fork: hold records — see UPSTREAM.md YP20)
/**
 * Log that a hold changed `item`'s visibility (`len > 0`: shown, `< 0`:
 * hidden) in `tr.holds`, in order, and its parent as changed.
 *
 * @param {Transaction} tr
 * @param {Item} item
 * @param {number} len
 */
const logHold = (tr, item, len) => {
  tr.holds.push(item.id.client, item.id.clock, len)
  addChangedTypeToTransaction(tr, /** @type {YNode} */ (item.parent), item.parentSub)
}

/**
 * Add `delta` (1: hold, -1: release) to `item`'s holds; an item that is not
 * removed and starts or stops being held moves its parent's length, drops
 * its search markers and is logged.
 *
 * @param {Transaction} tr
 * @param {Item} item
 * @param {number} delta
 */
const holdItem = (tr, item, delta) => {
  const was = item.deleted
  item.holds += delta
  if (was !== item.deleted) {
    const parent = /** @type {YNode} */ (item.parent)
    const len = was ? item.length : -item.length
    if (item.countable && item.parentSub === null) parent._length += len
    // the indices the search markers counted moved (a held delete moves them itself)
    if (parent._searchMarker) parent._searchMarker.length = 0
    logHold(tr, item, len)
  }
}

/**
 * A hold this replica cannot apply yet (its items have not arrived): it waits
 * in `store.pendingHolds` (`client → [clock, len, delta, …]`).
 *
 * @param {import('../utils/StructStore.js').StructStore} store
 * @param {number} client
 * @param {number} from
 * @param {number} to
 * @param {number} delta
 */
const pendHold = (store, client, from, to, delta) => {
  const pending = store.pendingHolds ?? (store.pendingHolds = new Map())
  const list = pending.get(client)
  if (list === undefined) pending.set(client, [from, to - from, delta])
  else list.push(from, to - from, delta)
}

/**
 * Hold (`delta` 1) or release (-1) the ids `client:clock … clock+len-1`: the
 * items here take it now, split at the edges; what this replica lacks (past
 * its clock, or a Skip) waits until it integrates (`applyPendingHolds`). A GC
 * struct takes nothing (it is gone everywhere).
 *
 * @param {Transaction} tr
 * @param {number} client
 * @param {number} clock
 * @param {number} len
 * @param {number} delta
 */
const holdRange = (tr, client, clock, len, delta) => {
  const store = tr.doc.store
  const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
  const end = clock + len
  const state = store.getClock(client)
  if (end > state) pendHold(store, client, math.max(clock, state), end, delta)
  for (let k = clock; k < math.min(end, state);) {
    let struct = structs[findIndexSS(structs, k)]
    const to = math.min(struct.id.clock + struct.length, end)
    if (struct.isItem) {
      if (struct.id.clock < k) struct = getItemCleanStart(tr, createID(client, k))
      if (struct.id.clock + struct.length > to) getItemCleanStart(tr, createID(client, to))
      holdItem(tr, /** @type {Item} */ (struct), delta)
    } else if (!struct.deleted) {
      pendHold(store, client, k, to, delta) // a Skip
    }
    k = to
  }
}

/**
 * Hold or release (`delta`) the items `ids` names (`client, clock, len` triples).
 *
 * @param {Transaction} tr
 * @param {Array<number>} ids
 * @param {number} delta
 */
const holdIds = (tr, ids, delta) => {
  for (let i = 0; i < ids.length; i += 3) holdRange(tr, ids[i], ids[i + 1], ids[i + 2], delta)
}

/**
 * Apply the holds that waited for items of `clients` an update just
 * integrated (what is still missing waits on).
 *
 * @param {Transaction} tr
 * @param {Array<number>} clients
 */
export const applyPendingHolds = (tr, clients) => {
  const store = tr.doc.store
  for (const client of clients) {
    const list = store.pendingHolds?.get(client)
    if (list === undefined) continue
    /** @type {Map<number, Array<number>>} */ (store.pendingHolds).delete(client)
    for (let i = 0; i < list.length; i += 3) holdRange(tr, client, list[i], list[i + 1], list[i + 2])
  }
  if (store.pendingHolds?.size === 0) store.pendingHolds = null
}

/**
 * A hold record: one unit per held id range (`client, clock, len`). While the
 * record is live, the items it names read as deleted; deleting the record
 * shows them again (an undo), unless another live record holds them. A record
 * integrates at once; what it names that has not arrived takes its hold when
 * it does (`applyPendingHolds`).
 */
export class ContentHold {
  /**
   * @param {Array<number>} ids
   */
  constructor (ids) {
    this.ids = ids
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.ids.length / 3
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    const out = []
    for (let i = 0; i < this.ids.length; i += 3) out.push(this.ids.slice(i, i + 3))
    return out
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentHold}
   */
  copy () {
    return new ContentHold(this.ids)
  }

  /**
   * @param {number} offset
   * @return {ContentHold}
   */
  splice (offset) {
    const right = new ContentHold(this.ids.slice(offset * 3))
    this.ids = this.ids.slice(0, offset * 3)
    return right
  }

  /**
   * @param {ContentHold} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.ids = this.ids.concat(right.ids)
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} _item
   */
  integrate (transaction, _item) {
    holdIds(transaction, this.ids, 1)
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    holdIds(transaction, this.ids, -1)
  }

  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}

  /**
   * @param {UpdateEncoder} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const end = this.ids.length - offsetEnd * 3
    encoder.writeLen(end / 3 - offset)
    for (let i = offset * 3; i < end; i += 3) {
      encoder.writeLeftID(createID(this.ids[i], this.ids[i + 1]))
      encoder.writeLen(this.ids[i + 2])
    }
  }

  /**
   * @return {11}
   */
  getRef () {
    return 11
  }
}
// YP20 end

/**
 * @private
 */
export class ContentFormat {
  /**
   * @param {string} key
   * @param {Object} value
   */
  constructor (key, value) {
    this.key = key
    this.value = value
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentFormat}
   */
  copy () {
    return new ContentFormat(this.key, this.value)
  }

  /**
   * @param {number} _offset
   * @return {ContentFormat}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentFormat} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} item
   */
  integrate (_transaction, item) {
    // Format items are non-countable: no marker index shifts (YP4).
    // YP13: a paired mark's start carries its Lamport timestamp; the document
    // keeps the greatest it saw, so the next mark it writes wins over it.
    if (pairedRole(this) === 0) {
      const doc = /** @type {any} */ (_transaction.doc)
      const l = /** @type {Array<any>} */ (this.value)[1]
      if (l > doc._markClock) doc._markClock = l
    }
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoder} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeKey(this.key)
    encoder.writeJSON(this.value)
  }

  /**
   * @return {6}
   */
  getRef () {
    return 6
  }
}

/**
 * @private
 */
export class ContentString {
  /**
   * @param {string} str
   */
  constructor (str) {
    /**
     * @type {string}
     */
    this.str = str
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.str.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.str.split('')
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentString}
   */
  copy () {
    return new ContentString(this.str)
  }

  /**
   * @param {number} offset
   * @return {ContentString}
   */
  splice (offset) {
    const right = new ContentString(this.str.slice(offset))
    this.str = this.str.slice(0, offset)

    // Prevent encoding invalid documents because of splitting of surrogate pairs: https://github.com/yjs/yjs/issues/248
    const firstCharCode = this.str.charCodeAt(offset - 1)
    if (firstCharCode >= 0xD800 && firstCharCode <= 0xDBFF) {
      // Last character of the left split is the start of a surrogate utf16/ucs2 pair.
      // We don't support splitting of surrogate pairs because this may lead to invalid documents.
      // Replace the invalid character with a unicode replacement character (� / U+FFFD)
      this.str = this.str.slice(0, offset - 1) + '�'
      // replace right as well
      right.str = '�' + right.str.slice(1)
    }
    return right
  }

  /**
   * @param {ContentString} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.str += right.str
    return true
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoder} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    encoder.writeString((offset === 0 && offsetEnd === 0) ? this.str : this.str.slice(offset, this.str.length - offsetEnd))
  }

  /**
   * @return {4}
   */
  getRef () {
    return 4
  }
}

export const YArrayRefID = 0
export const YMapRefID = 1
export const YTextRefID = 2
export const YXmlElementRefID = 3
export const YXmlFragmentRefID = 4
export const YXmlHookRefID = 5
export const YXmlTextRefID = 6

/**
 * @private
 */
export class ContentType {
  /**
   * @param {import('../ynode.js').YNode} type
   */
  constructor (type) {
    /**
     * @type {import('../ynode.js').YNode}
     */
    this.type = type
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.type]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentType}
   */
  copy () {
    return new ContentType(this.type._copy())
  }

  /**
   * @param {number} _offset
   * @return {ContentType}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentType} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    this.type._integrate(transaction.doc, item)
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    let item = this.type._start
    while (item !== null) {
      if (!item.removed) { // YP20: a held child goes with its node
        item.delete(transaction)
      } else if (!transaction.insertSet.hasId(item.id)) {
        // This will be gc'd later and we want to merge it if possible
        // We try to merge all deleted items after each transaction,
        // but we have no knowledge about that this needs to be merged
        // since it is not in transaction.ds. Hence we add it to transaction._mergeStructs
        transaction._mergeStructs.push(item)
      }
      item = item.right
    }
    this.type._map.forEach(item => {
      if (!item.removed) { // YP20
        item.delete(transaction)
      } else if (!transaction.insertSet.hasId(item.id)) {
        // same as above
        transaction._mergeStructs.push(item)
      }
    })
  }

  /**
   * @param {Transaction} tr
   */
  gc (tr) {
    let item = this.type._start
    while (item !== null) {
      item.gc(tr, true)
      item = item.right
    }
    this.type._start = null
    this.type._map.forEach(/** @param {Item | null} item */ (item) => {
      while (item !== null) {
        item.gc(tr, true)
        item = item.left
      }
    })
    this.type._map = new Map()
  }

  /**
   * @param {UpdateEncoder} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    this.type._write(encoder)
  }

  /**
   * @return {7}
   */
  getRef () {
    return 7
  }
}
