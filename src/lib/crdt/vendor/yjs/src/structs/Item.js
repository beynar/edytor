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
    /**
     * YP22: the live move records (`ContentMove`) naming this item, the
     * strongest first — the greatest `(priority, client, clock)` — or `null`.
     * The first is its mover: the item shows there, hidden at home. Local,
     * never encoded.
     * @type {Array<Item>|null}
     */
    this.movers = null
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
   * Whether this item is hidden at home: removed, held by a live hold record
   * (YP20), or moved by a live move record (YP22: it shows at its mover).
   * @type {Boolean}
   */
  get deleted () {
    return (this.info & binary.BIT3) > 0 || this.holds > 0 || this.movers !== null
  }

  /**
   * Whether this item shows nowhere: removed or held (YP22; a moved item
   * shows at its mover).
   * @type {Boolean}
   */
  get gone () {
    return (this.info & binary.BIT3) > 0 || this.holds > 0
  }

  /**
   * YP22: the live move record this item shows at (the strongest of
   * `movers`), or `null` at home.
   * @type {Item|null}
   */
  get mover () {
    return this.movers === null ? null : this.movers[0]
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
            if (sortsBefore(o, this, transaction)) { // YP13: paired marks sort by side, then by client id
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
      // add parent to transaction.changed, and log the units it shows (YP33)
      logItem(transaction, 0, this, this.removed ? 0 : this.length) // YP33
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
      this.movers === null && right.movers === null && // YP22: a moved unit stands alone
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
        logItem(transaction, 1, this, this.length) // YP33
      } else if (this.movers !== null) {
        // YP22: hidden at home already; its mover shows it no more (`gone`)
        logMove(transaction, this, this.mover)
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
      logItem(transaction, 0, this, -this.length) // YP33
      // YP14: a node a concurrent value replaced keeps its subtree (the document asked)
      if (!isKeptReplaced(this)) this.content.delete(transaction, this) // YP22: a move record drops itself from its units' movers
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
    } else {
      // YP13, YP21, YP22, YP29: an item of another class than content keeps
      // what orders concurrent inserts at its origin (`markClass`) on every
      // replica, collected or not: a paired mark item or a claim item its
      // class, a move record its content (its sort reads its chain). A block
      // slot a split made keeps its split key the same way (`splitKey`),
      // trimmed to it.
      const cls = markClass(this)
      const arr = /** @type {any} */ (this.content).arr
      if (cls === 1) {
        const keys = arr?.map((/** @type {any} */ v) => (Array.isArray(v?.s) ? { s: v.s } : null))
        this.content = keys?.some((/** @type {any} */ k) => k !== null) ? new ContentAny(keys) : new ContentDeleted(this.length)
      } else if (cls < 3 || (cls === 3 && arr?.every((/** @type {any} */ v) => typeof v?.m === 'string'))) {
        // every unit of the item has its class (a mark is one unit; merged claims all are claims)
        this.content = new ContentDeleted(this.length, cls)
      }
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
    rightItem.movers = this.movers?.slice() ?? null // YP22
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
    const parent = /** @type {any} */ (this.parent)
    // YP27: an item written with its parent says in bit 5 whether the parent is
    // a root (its name follows) or an item (its id follows): no parentInfo column
    const named = origin === null && rightOrigin === null && (parent.constructor === String || parent._item === null)
    const info = (this.content.getRef() & binary.BITS4) | // YP27: content refs fit four bits
      (origin === null ? 0 : binary.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary.BIT6) | // parentSub is non-null
      (named ? binary.BIT5 : 0) // YP27: the parent is a root, by name
    encoder.writeInfo(info)
    if (origin !== null) {
      encoder.writeLeftID(origin)
    }
    if (rightOrigin !== null) {
      encoder.writeRightID(rightOrigin)
    }
    if (origin === null && rightOrigin === null) {
      if (named) {
        // a root's name (a string parent: an edge case of differential updates)
        encoder.writeKey(parent.constructor === String ? /** @type {string} */ (parent) : findRootTypeKey(parent)) // YP24
      } else if (parent.constructor === ID) {
        encoder.writeLeftID(parent)
      } else if (parent._item) {
        encoder.writeLeftID(parent._item.id)
      } else {
        error.unexpectedCase()
      }
      if (parentSub !== null) {
        encoder.writeKey(parentSub) // YP24
      }
    }
    this.content.write(encoder, offset, offsetEnd, this) // YP25: a format item reads its own id
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
   * @param {Item} [_item] the item deleted (YP22: a move record reads it)
   */
  delete (_transaction, _item) {
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
   * @param {Item} [_item] the item written (YP25: a format item reads its id)
   */
  write (_encoder, _offset, _offsetEnd, _item) {
    throw error.methodUnimplemented()
  }

  /**
   * @return {1|2|3|4|5|6|7|8|9|11|12|13}
   */
  getRef () { // YP20: 11, a hold record; YP22: 12, a move record; YP29: 13, a collected mark's class
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
   * @param {number} [cls] YP29: a collected mark's or claim's sort class
   */
  constructor (len, cls) {
    this.len = len
    /**
     * YP29: what a collected paired mark item or claim item keeps, for each
     * of its units: its sort class (`markClass`: `0` a left-side mark, `2` a
     * right-side one, `3` a claim), which orders concurrent inserts at its
     * origin on every replica (`undefined`: none, any other deleted content).
     *
     * @type {number|undefined}
     */
    this.cls = cls
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
    return this.cls === 3 // YP29: a claim is a unit of its text
  }

  /**
   * @return {ContentDeleted}
   */
  copy () {
    return new ContentDeleted(this.len, this.cls)
  }

  /**
   * @param {number} offset
   * @return {ContentDeleted}
   */
  splice (offset) {
    const right = new ContentDeleted(this.len - offset, this.cls)
    this.len = offset
    return right
  }

  /**
   * @param {ContentDeleted} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (right.cls !== this.cls) return false // YP29
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
    const len = this.len - offset - offsetEnd
    encoder.writeLen(this.cls === undefined ? len : len * 4 + this.cls) // YP29
  }

  /**
   * @return {1|13}
   */
  getRef () {
    return this.cls === undefined ? 1 : 13 // YP29: 13, a collected mark or claim
  }
}

// YP20 begin (edytor fork: hold records — see UPSTREAM.md YP20)
// YP33 begin (edytor fork: one log of what a transaction did to items — see UPSTREAM.md YP33)
/**
 * Log `len` units of `item` as `kind` (0 an edit, 1 a hold, 2 a move) in
 * `tr.log`, in order, and its parent as changed. An entry the last one
 * continues (its kind, its client, the next clock, its sign) extends it, so
 * a run of one writer's items is one entry; `len` 0 logs none.
 *
 * @param {Transaction} tr
 * @param {number} kind
 * @param {Item} item
 * @param {number} len
 */
const logItem = (tr, kind, item, len) => {
  const log = tr.log
  const n = log.length
  const { client, clock } = item.id
  if (log[n - 4] === kind && log[n - 3] === client && log[n - 2] + math.abs(log[n - 1]) === clock && log[n - 1] * len > 0) log[n - 1] += len
  else if (len !== 0) log.push(kind, client, clock, len)
  addChangedTypeToTransaction(tr, /** @type {YNode} */ (item.parent), item.parentSub)
}
// YP33 end

/**
 * Add `delta` (1, or -1: release) of a hold record (`record` null: `holds`)
 * or of the move record `record` (its `movers`, YP22; a record never moves a
 * record) to `item`. An item that is not removed and starts or stops being
 * hidden moves its parent's length and drops its search markers; a hold that
 * does is logged (`tr.log`, YP33), and so is a unit whose mover changed.
 *
 * @param {Transaction} tr
 * @param {Item} item
 * @param {number} delta
 * @param {Item|null} record
 */
const holdItem = (tr, item, delta, record) => {
  const was = item.deleted
  const before = item.mover
  if (record === null) item.holds += delta
  else if (item.content.constructor === ContentMove) return
  else if (delta > 0) {
    const m = (item.movers ??= [])
    const i = m.findIndex(r => stronger(record, r))
    m.splice(i < 0 ? m.length : i, 0, record)
  }
  else if (item.movers !== null) {
    const i = item.movers.indexOf(record)
    if (i >= 0) item.movers.splice(i, 1)
    if (item.movers.length === 0) item.movers = null
  }
  if (was !== item.deleted) {
    const parent = /** @type {YNode} */ (item.parent)
    const len = was ? item.length : -item.length
    if (item.countable && item.parentSub === null) parent._length += len
    // the indices the search markers counted moved (a held delete moves them itself)
    if (parent._searchMarker) parent._searchMarker.length = 0
    if (record === null) logItem(tr, 1, item, len) // YP33
  }
  const after = item.mover
  if (before !== after) {
    logMove(tr, item, after)
    if (before !== null) addChangedTypeToTransaction(tr, /** @type {YNode} */ (before.parent), null)
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
 * Hold (`delta` 1) or release (-1) the ids `client:clock … clock+len-1`, or
 * add or drop the move record `record` on them (YP22): the items here take
 * it now, split at the edges; what this replica lacks (past its clock, or a
 * Skip) waits until it integrates (`applyPending`) — a hold's only: a move
 * record integrates once every unit it names has, and no Skip stands for
 * one (`getMissing`). A GC struct takes nothing (it is gone everywhere).
 *
 * @param {Transaction} tr
 * @param {number} client
 * @param {number} clock
 * @param {number} len
 * @param {number} delta
 * @param {Item|null} [record]
 */
const holdRange = (tr, client, clock, len, delta, record = null) => {
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
      holdItem(tr, /** @type {Item} */ (struct), delta, record)
    } else if (!struct.deleted) {
      pendHold(store, client, k, to, delta) // a Skip
    }
    k = to
  }
}

/**
 * Hold or release (`delta`) the items `ids` names (`client, clock, len`
 * triples), or add or drop the move record `record` on them.
 *
 * @param {Transaction} tr
 * @param {Array<number>} ids
 * @param {number} delta
 * @param {Item|null} [record]
 */
const holdIds = (tr, ids, delta, record = null) => {
  for (let i = 0; i < ids.length; i += 3) holdRange(tr, ids[i], ids[i + 1], ids[i + 2], delta, record)
}

/**
 * Write the id ranges `ids[from … to)` (`client, clock, len` triples): their
 * count, then each as a left id and a length (a hold record's and a move
 * record's ranges).
 *
 * @param {UpdateEncoder} encoder
 * @param {Array<number>} ids
 * @param {number} from
 * @param {number} to
 */
const writeIds = (encoder, ids, from, to) => {
  encoder.writeLen((to - from) / 3)
  for (let i = from; i < to; i += 3) {
    encoder.writeLeftID(createID(ids[i], ids[i + 1]))
    encoder.writeLen(ids[i + 2])
  }
}

/**
 * A hold record: one unit per held id range (`client, clock, len`). While the
 * record is live, the items it names read as deleted; deleting the record
 * shows them again (an undo), unless another live record holds them. A record
 * integrates at once; what it names that has not arrived takes its hold when
 * it does (`applyPending`).
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
   * @param {Item} item
   */
  integrate (transaction, item) {
    if (holding(item)) holdIds(transaction, this.ids, 1) // YP31
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  delete (transaction, item) {
    if (holding(item)) holdIds(transaction, this.ids, -1) // YP31
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
    writeIds(encoder, this.ids, offset * 3, this.ids.length - offsetEnd * 3)
  }

  /**
   * @return {11}
   */
  getRef () {
    return 11
  }
}
// YP20 end

// YP31 begin (edytor fork: id lists — see UPSTREAM.md YP31)
/**
 * Whether the hold record `item` holds what it names: one in a root's
 * sequence does (the document's records list, YP20); one in a nested node's
 * sequence is a list of ids, the same codec, that holds nothing.
 *
 * @param {Item} item
 * @return {boolean}
 */
const holding = item => /** @type {YNode} */ (item.parent)._item === null
// YP31 end

// YP32 begin (edytor fork: a delete that proposes — see UPSTREAM.md YP32)
/**
 * Hide the units `ids` names until `unhide` (a suggestion's proposed
 * deletion, which the rest of its plan reads gone): a hold without a
 * record, kept in `tr.hidden`.
 *
 * @param {Transaction} tr
 * @param {Array<number>} ids
 */
export const hideIds = (tr, ids) => {
  holdIds(tr, ids, 1)
  ;/** @type {any} */ (tr).hidden = (/** @type {any} */ (tr).hidden ?? []).concat(ids)
}

/**
 * Show again what `hideIds` hid in `tr`.
 *
 * @param {Transaction} tr
 */
export const unhide = tr => {
  const hidden = /** @type {any} */ (tr).hidden
  if (hidden) holdIds(tr, hidden, -1)
  ;/** @type {any} */ (tr).hidden = null
}
// YP32 end

// YP22 begin (edytor fork: move records — see UPSTREAM.md YP22)
/**
 * Whether move record `a` beats `b`: the greater `(priority, client, clock)`
 * (a unit's `movers` are kept in that order, the strongest first).
 *
 * @param {Item} a
 * @param {Item} b
 * @return {boolean}
 */
const stronger = (a, b) =>
  (/** @type {ContentMove} */ (a.content).priority - /** @type {ContentMove} */ (b.content).priority || a.id.client - b.id.client || a.id.clock - b.id.clock) > 0

/**
 * Log that `item`'s mover changed (or it left its mover: removed) in
 * `tr.log` (YP33), and its home and its new mover's sequences as changed.
 *
 * @param {Transaction} tr
 * @param {Item} item
 * @param {Item|null} mover
 */
const logMove = (tr, item, mover) => {
  logItem(tr, 2, item, item.length) // YP33
  if (mover !== null) addChangedTypeToTransaction(tr, /** @type {YNode} */ (mover.parent), null)
}

/**
 * Apply the holds (YP20) that waited for items of `clients` an update just
 * integrated (what is still missing waits on).
 *
 * @param {Transaction} tr
 * @param {Array<number>} clients
 */
export const applyPending = (tr, clients) => {
  const store = tr.doc.store
  for (const client of clients) {
    const holds = store.pendingHolds?.get(client)
    if (holds !== undefined) {
      /** @type {Map<number, Array<number>>} */ (store.pendingHolds).delete(client)
      for (let i = 0; i < holds.length; i += 3) holdRange(tr, client, holds[i], holds[i + 1], holds[i + 2])
    }
  }
  if (store.pendingHolds?.size === 0) store.pendingHolds = null
}

/**
 * A move record: one countable unit at its destination, naming the units
 * it moves (`client, clock, len` ranges, in the order they show) with a
 * Lamport `priority`, a `side` (`0`: it stands after what precedes it,
 * `1`: before what follows it — its sort class among the items of one
 * origin, `markClass`), and for the sort of two records at one origin
 * (`utils/marks.js` `sourceOrder`) the chain of units it stands at (`at`:
 * the home slots from the root sequence down to that unit, else the first
 * unit it names) and its `part` there. While the record is live, each named unit shows at
 * the record that wins its movers and is hidden at home; deleting the
 * record (an undo) hands the unit to the next record, else home. A record
 * waits for the units it names as an item waits for its origin
 * (`getMissing`), so two records at one origin sort by their units' home
 * order on every replica (`sourceOrder`). Immutable once written, so
 * replicas converge in any order. The record's item is the one integrating
 * or deleting it (it is what the units' `movers` hold).
 */
export class ContentMove {
  /**
   * @param {number} priority
   * @param {number} side
   * @param {Array<number>} ids
   * @param {number} [part] the writer's order among the records standing at one unit (0–7)
   * @param {Array<ID>|null} [at] the chain the record stands at, outermost first (`null`: the first unit it names)
   */
  constructor (priority, side, ids, part = 0, at = null) {
    this.priority = priority
    this.side = side
    this.ids = ids
    this.part = part
    this.at = at
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
    return [this]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentMove}
   */
  copy () {
    return new ContentMove(this.priority, this.side, this.ids, this.part, this.at)
  }

  /**
   * @param {number} _offset
   * @return {ContentMove}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentMove} _right
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
    const doc = /** @type {any} */ (transaction.doc)
    // A peer's record raises the clock; this writer's own leave it, so its
    // next records stay level with these until it sees a peer's.
    if (!transaction.local && this.priority > doc._clock) doc._clock = this.priority
    holdIds(transaction, this.ids, 1, item)
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  delete (transaction, item) {
    holdIds(transaction, this.ids, -1, item)
  }

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
    // One varint: the priority, whether an anchor chain follows, the part, the side.
    encoder.writeLen(this.priority * 32 + (this.at === null ? 0 : 16) + this.part * 2 + this.side)
    if (this.at !== null) {
      encoder.writeLen(this.at.length)
      for (const id of this.at) encoder.writeLeftID(id)
    }
    writeIds(encoder, this.ids, 0, this.ids.length)
  }

  /**
   * @return {12}
   */
  getRef () {
    return 12
  }
}
// YP22 end

/**
 * @private
 */
// YP25 begin (edytor fork: paired marks written natively — see UPSTREAM.md YP25)
/**
 * Whether `x` is a non-negative integer (a clock, a client id, a stamp).
 *
 * @param {any} x
 * @return {boolean}
 */
const natural = x => Number.isInteger(x) && x >= 0

/**
 * Write a format item's value. A paired mark's (YP13) is written in parts: a
 * flags length — bit 0 its side; bit 1 a start's operation id is the item's
 * own, an end's start is the item's own client (its clock follows as a
 * distance); bit 2 a start's value is `true`, bit 3 `null` — then a start's
 * Lamport stamp, the operation id where the flags do not imply it, and a
 * start's value where it is neither `true` nor `null`. Any other value (a
 * plain format, a value of another shape) is flagged `16` and written whole.
 *
 * @param {UpdateEncoder} encoder
 * @param {ContentFormat} content
 * @param {Item} [item]
 */
const writeFormatValue = (encoder, content, item) => {
  const v = /** @type {any} */ (content.value)
  const role = pairedRole(content)
  if (role === 0 && Array.isArray(v) && v.length === 5 && natural(v[1]) && natural(v[2]) && natural(v[3]) && (v[4] === 0 || v[4] === 1)) {
    const own = item !== undefined && v[2] === item.id.client && v[3] === item.id.clock
    const tail = v[0] === true ? 4 : v[0] === null ? 8 : 0
    encoder.writeLen(v[4] | (own ? 2 : 0) | tail)
    encoder.writeLen(v[1])
    if (!own) encoder.writeLeftID(createID(v[2], v[3]))
    if (tail === 0) encoder.writeJSON(v[0])
  } else if (role === 1 && Array.isArray(v) && v.length === 3 && natural(v[0]) && natural(v[1]) && (v[2] === 0 || v[2] === 1)) {
    const near = item !== undefined && v[0] === item.id.client && v[1] <= item.id.clock
    encoder.writeLen(v[2] | (near ? 2 : 0))
    if (near) encoder.writeLen(/** @type {Item} */ (item).id.clock - v[1])
    else encoder.writeLeftID(createID(v[0], v[1]))
  } else {
    encoder.writeLen(16)
    encoder.writeJSON(v)
  }
}

/**
 * Read a format item's value (`writeFormatValue`): `id` is the item's.
 *
 * @param {UpdateDecoder} decoder
 * @param {string} key
 * @param {ID} id
 * @return {any}
 */
export const readFormatValue = (decoder, key, id) => {
  const flags = decoder.readLen()
  if ((flags & 16) !== 0) return decoder.readJSON()
  const side = flags & 1
  const role = pairedRole({ key })
  if (role === 0) {
    const l = decoder.readLen()
    const at = (flags & 2) !== 0 ? id : decoder.readLeftID()
    const v = (flags & 4) !== 0 ? true : (flags & 8) !== 0 ? null : decoder.readJSON()
    return [v, l, at.client, at.clock, side]
  }
  if (role !== 1) error.unexpectedCase()
  const at = (flags & 2) !== 0 ? createID(id.client, id.clock - decoder.readLen()) : decoder.readLeftID()
  return [at.client, at.clock, side]
}
// YP25 end

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
    // keeps the greatest it saw (YP22: one clock with the move records), so the
    // next mark or move it writes wins over it.
    if (pairedRole(this) === 0) {
      const doc = /** @type {any} */ (_transaction.doc)
      const l = /** @type {Array<any>} */ (this.value)[1]
      if (l > doc._clock) doc._clock = l
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
   * @param {Item} [item] YP25: the item, whose id a mark's operation id usually is
   */
  write (encoder, _offset, _offsetEnd, item) {
    encoder.writeKey(this.key)
    writeFormatValue(encoder, this, item) // YP25
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
