import * as binary from 'lib0-v14/binary'
import * as error from 'lib0-v14/error'
import * as iterator from 'lib0-v14/iterator'
import * as map from 'lib0-v14/map'
import * as math from 'lib0-v14/math'
import * as object from 'lib0-v14/object'
import * as traits from 'lib0-v14/traits'
import { equalityDeep } from 'lib0-v14/function'
import { ObservableV2 } from 'lib0-v14/observable'
import {
  Item,
  ContentAny,
  ContentBinary,
  ContentDeleted,
  ContentEmbed,
  ContentFormat,
  ContentJSON,
  ContentString,
  ContentType,
  YXmlFragmentRefID,
  YXmlElementRefID,
  YXmlHookRefID,
  ContentDoc,
  createContentDocFromDoc
} from './structs/Item.js'
import { removeEventHandlerListener, callEventHandlerListeners, addEventHandlerListener, createEventHandler } from './utils/EventHandler.js'
import { createID } from './utils/ID.js'
import { getItemCleanStart, cleanupFormattingGap, liveLength } from './utils/transaction-helpers.js'
import { transact } from './utils/Transaction.js'
import { YEvent } from './utils/YEvent.js'
import { isDoc } from './utils/schemas.js'
import { foldPaired, formatValue, pairedRole, markClass, MARK_START, MARK_END, SIDE_LEFT } from './utils/marks.js' // YP13

/**
 * @typedef {Object<string,any>|Array<any>|number|null|string|Uint8Array|BigInt|YNode} YValue
 */

/**
 * https://docs.yjs.dev/getting-started/working-with-shared-types#caveats
 */
export const warnPrematureAccess = () => { console.warn('Invalid access: Add Yjs type to a document before reading data.') }

const maxSearchMarker = 80

/**
 * A unique timestamp that identifies each marker.
 *
 * Time is relative,.. this is more like an ever-increasing clock.
 *
 * @type {number}
 */
let globalSearchMarkerTimestamp = 0

export class ItemTextListPosition {
  /**
   * @param {Item|null} left
   * @param {Item|null} right
   * @param {number} index
   * @param {Map<string,any>} currentFormats
   */
  constructor (left, right, index, currentFormats) {
    this.left = left
    this.right = right
    this.index = index
    this.currentFormats = currentFormats
  }

  /**
   * Only call this if you know that this.right is defined
   */
  forward () {
    if (this.right === null) {
      error.unexpectedCase()
    }
    switch (this.right.content.constructor) {
      case ContentFormat:
        if (!this.right.deleted) {
          updateCurrentFormats(this.currentFormats, /** @type {ContentFormat} */ (this.right.content))
        }
        break
      default:
        this.index += liveLength(this.right)
        break
    }
    this.left = this.right
    this.right = this.right.right
  }

  /**
   * @param {Transaction} transaction
   * @param {YNode} parent
   * @param {number} length
   * @param {Object<string,any>} formats
   *
   * @function
   */
  formatText (transaction, parent, length, formats) {
    minimizeFormatChanges(this, formats)
    const negatedFormats = insertFormats(transaction, parent, this, formats)
    // iterate until first non-format or null is found
    // delete all formats with formats[format.key] != null
    // also check the formats after the first non-format as we do not want to insert redundant negated formats there
    // eslint-disable-next-line no-labels
    iterationLoop: while (
      this.right !== null &&
      (length > 0 ||
        (
          negatedFormats.size > 0 &&
          (this.right.deleted || this.right.content.constructor === ContentFormat)
        )
      )
    ) {
      switch (this.right.content.constructor) {
        case ContentFormat: {
          if (!this.right.deleted && pairedRole(/** @type {ContentFormat} */ (this.right.content)) >= 0) {
            // YP13: a paired mark is folded, never rewritten by a plain format
            updateCurrentFormats(this.currentFormats, /** @type {ContentFormat} */ (this.right.content))
          } else if (!this.right.deleted) {
            const { key, value } = /** @type {ContentFormat} */ (this.right.content)
            const attr = formats[key]
            if (attr !== undefined) {
              if (equalFormats(attr, value)) {
                negatedFormats.delete(key)
              } else {
                if (length === 0) {
                  // no need to further extend negatedFormats
                  // eslint-disable-next-line no-labels
                  break iterationLoop
                }
                negatedFormats.set(key, value)
              }
              this.right.delete(transaction)
            } else {
              this.currentFormats.set(key, value)
            }
          }
          break
        }
        default: {
          const item = this.right
          const rightLen = liveLength(item)
          if (length < rightLen) {
            // split at the offset
            getItemCleanStart(transaction, createID(item.id.client, item.id.clock + length))
            length = 0
          } else {
            length -= rightLen
          }
          break
        }
      }
      this.forward()
    }
    if (length > 0) {
      throw new Error('Exceeded content range')
    }
    insertNegatedFormats(transaction, parent, this, negatedFormats)
  }
}

/**
 * Negate applied formats
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 * @param {Map<string,any>} negatedFormats
 *
 * @private
 * @function
 */
const insertNegatedFormats = (transaction, parent, currPos, negatedFormats) => {
  // check if we really need to remove formats
  while (
    currPos.right !== null && (
      currPos.right.deleted || (
        currPos.right.content.constructor === ContentFormat &&
        equalFormats(negatedFormats.get(/** @type {ContentFormat} */ (currPos.right.content).key), /** @type {ContentFormat} */ (currPos.right.content).value)
      )
    )
  ) {
    if (!currPos.right.deleted) {
      negatedFormats.delete(/** @type {ContentFormat} */ (currPos.right.content).key)
    }
    currPos.forward()
  }
  const doc = transaction.doc
  const ownClientId = doc.clientID
  negatedFormats.forEach((val, key) => {
    const left = currPos.left
    const right = currPos.right
    const nextFormat = new Item(createID(ownClientId, doc.store.getClock(ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val))
    nextFormat.integrate(transaction, 0)
    currPos.right = nextFormat
    currPos.forward()
    updateMarkerFormats(parent, currPos, /** @type {ContentFormat} */ (nextFormat.content))
  })
}

/**
 * @param {Map<string,any>} currentFormats
 * @param {ContentFormat} format
 *
 * @private
 * @function
 */
const updateCurrentFormats = (currentFormats, format) => {
  if (foldPaired(currentFormats, format)) return // YP13
  const { key, value } = format
  if (value === null) {
    currentFormats.delete(key)
  } else {
    currentFormats.set(key, value)
  }
}

/**
 * @param {ItemTextListPosition} currPos
 * @param {Object<string,any>} formats
 *
 * @private
 * @function
 */
const minimizeFormatChanges = (currPos, formats) => {
  // go right while formats[right.key] === right.value (or right is deleted)
  while (true) {
    if (currPos.right === null) {
      break
    } else if (currPos.right.deleted || (currPos.right.content.constructor === ContentFormat && equalFormats(formats[(/** @type {ContentFormat} */ (currPos.right.content)).key] ?? null, /** @type {ContentFormat} */ (currPos.right.content).value))) {
      //
    } else {
      break
    }
    currPos.forward()
  }
}

/**
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 * @param {Object<string,any>} formats
 * @return {Map<string,any>}
 *
 * @private
 * @function
 **/
const insertFormats = (transaction, parent, currPos, formats) => {
  const doc = transaction.doc
  const ownClientId = doc.clientID
  const negatedFormats = new Map()
  // insert format-start items
  for (const key in formats) {
    const val = formats[key]
    const currentVal = currPos.currentFormats.get(key) ?? null
    if (!equalFormats(currentVal, val)) {
      // save negated format (set null if currentVal undefined)
      negatedFormats.set(key, currentVal)
      const { left, right } = currPos
      currPos.right = new Item(createID(ownClientId, doc.store.getClock(ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val))
      currPos.right.integrate(transaction, 0)
      currPos.forward()
      updateMarkerFormats(parent, currPos, /** @type {ContentFormat} */ ((/** @type {Item} */ (currPos.left)).content))
    }
  }
  return negatedFormats
}

// YP13 begin (edytor fork: paired marks — see UPSTREAM.md YP13)
/**
 * The contents an array insert writes (as `insertContentHelper` splits it).
 *
 * @param {Array<any>} insert
 * @return {Array<import('./structs/Item.js').AbstractContent>}
 */
const contentsOf = insert => {
  /** @type {Array<import('./structs/Item.js').AbstractContent>} */
  const out = []
  for (let i = 0; i < insert.length;) {
    const first = insert[i]
    if (first instanceof YNode) {
      out.push(new ContentType(first))
      i++
    } else if (isDoc(first)) {
      out.push(createContentDocFromDoc(first))
      i++
    } else {
      let j = i + 1
      for (; j < insert.length && !(insert[j] instanceof YNode || isDoc(insert[j])); j++) { /* nop */ }
      out.push(new ContentAny((i === 0 && j === insert.length) ? insert : insert.slice(i, j)))
      i = j
    }
  }
  return out
}

/**
 * The gap at live index `index`: `right` is the first live countable item
 * at or after it (split there; `null` at the end), `left` the last live
 * countable item before it (`null` at the start); between them only
 * deleted items and format items.
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @return {{ left: Item|null, right: Item|null, last: Item|null }}
 */
const gapAt = (transaction, parent, index) => {
  /** @type {Item|null} */
  let p = parent._start
  let pindex = 0
  const marker = findMarker(parent, index)
  if (marker !== null) {
    p = marker.p
    pindex = marker.index
  }
  /** @type {Item|null} */
  let last = p === null ? null : p.left
  while (p !== null) {
    if (!p.deleted && p.countable) {
      if (index < pindex + p.length) {
        if (index > pindex) p = getItemCleanStart(transaction, createID(p.id.client, p.id.clock + index - pindex))
        break
      }
      pindex += p.length
    }
    last = p
    p = p.right
  }
  if (p === null && pindex < index) throw new Error('Exceeded content range')
  // `last`: the item right before the gap's end (`p`), whatever it is
  if (p !== null) last = p.left
  let left = last
  while (left !== null && (left.deleted || !left.countable)) left = left.left
  return { left, right: p, last }
}

/**
 * Whether `item` is a right-side paired mark item (attached to what follows it).
 *
 * @param {Item} item
 */
const rightSided = item => item.content.constructor === ContentFormat && markClass(item) === 2

/**
 * @param {YNode} parent
 */
const dropMarkerFormats = parent => {
  const ms = parent._searchMarker
  if (ms !== null) for (let i = 0; i < ms.length; i++) ms[i].formats = null
}

/**
 * Integrate `content` between `left` and `right` (adjacent: YATA's origins).
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {Item|null} left
 * @param {Item|null} right
 * @param {import('./structs/Item.js').AbstractContent} content
 */
const integrateBetween = (transaction, parent, left, right, content) => {
  const doc = transaction.doc
  new Item(createID(doc.clientID, doc.store.getClock(doc.clientID)), left, left && left.lastId, right, right && right.id, parent, null, content).integrate(transaction, 0)
}

/**
 * Content goes at the end of its gap, before the gap's trailing right-side
 * mark items (those attached to the content after it): after every
 * left-side mark item and every deleted item of the gap.
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @param {import('./structs/Item.js').AbstractContent} content
 */
const insertInGapHelper = (transaction, parent, index, content) => {
  const gap = gapAt(transaction, parent, index)
  let right = gap.right
  let left = gap.last
  while (left !== null && left !== gap.left && rightSided(left)) {
    right = left
    left = left.left
  }
  if (parent._searchMarker) updateMarkerChanges(parent._searchMarker, index, content.getLength())
  integrateBetween(transaction, parent, left, right, content)
}

/**
 * A mark operation's item in the gap at `index`: a left-side item right
 * after the gap's left content, a right-side one right before its right
 * content.
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @param {number} side
 * @param {ContentFormat} content
 */
const insertMarkItem = (transaction, parent, index, side, content) => {
  const gap = gapAt(transaction, parent, index)
  if (side === SIDE_LEFT) {
    integrateBetween(transaction, parent, gap.left, gap.left === null ? parent._start : gap.left.right, content)
  } else {
    integrateBetween(transaction, parent, gap.last, gap.right, content)
  }
}

/**
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @param {number} length
 * @param {string} mark
 * @param {any} value
 * @param {number} startSide
 * @param {number} endSide
 */
const markHelper = (transaction, parent, index, length, mark, value, startSide, endSide) => {
  const doc = transaction.doc
  const client = doc.clientID
  const l = /** @type {any} */ (doc)._markClock + 1
  const k = doc.store.getClock(client)
  insertMarkItem(transaction, parent, index, startSide, new ContentFormat(MARK_START + mark, [value, l, client, k, startSide]))
  insertMarkItem(transaction, parent, index + length, endSide, new ContentFormat(MARK_END + mark, [client, k, endSide]))
  dropMarkerFormats(parent)
}
// YP13 end

/**
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 * @param {import('./structs/Item.js').AbstractContent} content
 * @param {Object<string,any>} formats
 *
 * @private
 * @function
 **/
export const insertContent = (transaction, parent, currPos, content, formats) => {
  currPos.currentFormats.forEach((_val, key) => {
    if (formats[key] === undefined) {
      formats[key] = null
    }
  })
  const doc = transaction.doc
  const ownClientId = doc.clientID
  minimizeFormatChanges(currPos, formats)
  const negatedFormats = insertFormats(transaction, parent, currPos, formats)
  let { left, right, index } = currPos
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength())
  }
  right = new Item(createID(ownClientId, doc.store.getClock(ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, content)
  right.integrate(transaction, 0)
  currPos.right = right
  currPos.index = index
  currPos.forward()
  insertNegatedFormats(transaction, parent, currPos, negatedFormats)
}

/**
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 * @param {Array<any>|string} insert
 * @param {Object<string,any>} formats
 */
export const insertContentHelper = (transaction, parent, currPos, insert, formats) => {
  if (typeof insert === 'string') {
    insertContent(transaction, parent, currPos, new ContentString(insert), formats)
  } else {
    for (let i = 0; i < insert.length;) {
      const first = insert[i]
      if (first instanceof YNode) {
        insertContent(transaction, parent, currPos, new ContentType(first), formats)
        i++
      } else if (isDoc(first)) {
        insertContent(transaction, parent, currPos, createContentDocFromDoc(first), formats)
        i++
      } else {
        // insert "any" content
        // compute slice len
        let j = i + 1
        for (; j < insert.length && !(insert[j] instanceof YNode || isDoc(insert[j])); j++) { /* nop */ }
        insertContent(transaction, parent, currPos, new ContentAny((i === 0 && j === insert.length) ? insert : insert.slice(i, j)), formats)
        i = j
      }
    }
  }
}

// YP7 begin (edytor fork: insertAtGapEnd — see UPSTREAM.md YP7)
/**
 * Insert `content` at the END of the gap at live index `index`: walk `index`
 * countable live units, then pass every deleted item and every format item
 * before the next live content item, and integrate `content` there. The
 * content takes exactly the formats in effect at that point — no format item
 * is added. Indices are live-content space.
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @param {import('./structs/Item.js').AbstractContent} content
 */
export const insertAtGapEndHelper = (transaction, parent, index, content) => {
  const currPos = new ItemTextListPosition(null, parent._start, 0, new Map())
  let n = index
  while (n > 0 && currPos.right !== null) {
    const item = currPos.right
    if (!item.deleted && item.countable) {
      if (n < item.length) getItemCleanStart(transaction, createID(item.id.client, item.id.clock + n))
      n -= item.length
    }
    currPos.forward()
  }
  if (n > 0) throw new Error('Exceeded content range')
  while (currPos.right !== null && (currPos.right.deleted || currPos.right.content.constructor === ContentFormat)) {
    currPos.forward()
  }
  if (parent._searchMarker) updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength())
  const doc = transaction.doc
  const { left, right } = currPos
  const item = new Item(createID(doc.clientID, doc.store.getClock(doc.clientID)), left, left && left.lastId, right, right && right.id, parent, null, content)
  item.integrate(transaction, 0)
}
// YP7 end

/**
 * @param {Transaction} transaction
 * @param {ItemTextListPosition} currPos
 * @param {number} length
 * @return {ItemTextListPosition}
 *
 * @private
 * @function
 */
export const deleteText = (transaction, currPos, length) => {
  const startLength = length
  const startFormats = map.copy(currPos.currentFormats)
  const start = currPos.right
  while (length > 0 && currPos.right !== null) {
    const item = currPos.right
    if (!item.deleted && item.countable) {
      if (length < item.length) {
        getItemCleanStart(transaction, createID(item.id.client, item.id.clock + length))
      }
      length -= item.length
      item.delete(transaction)
    }
    currPos.forward()
  }
  if (start) {
    cleanupFormattingGap(transaction, start, currPos.right, startFormats, currPos.currentFormats)
  }
  const parent = /** @type {YNode} */ (/** @type {Item} */ (currPos.left || currPos.right).parent)
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, currPos.index, -startLength + length)
  }
  return currPos
}

export class ArraySearchMarker {
  /**
   * @param {Item} p
   * @param {number} index
   */
  constructor (p, index) {
    p.marker = true
    this.p = p
    this.index = index
    /**
     * Snapshot of an `ItemTextListPosition` cursor's `currentFormats` map at
     * this marker's position (the left edge of `p`), or `null` when unknown.
     * Written only at *quiescent* points — the end of `YNode#applyDelta`
     * (post-op cursor state) and `findMarker`'s read walks — never mid-
     * mutation: `formatText`'s in-flight `currentFormats` is transient and
     * proved able to capture state invalidated later in the same operation.
     * Consumed by `YNode#applyDelta` to seed a formatting-aware cursor
     * without re-walking the list from `_start`.
     *
     * Validity: the snapshot is the format state at a fixed list position, so
     * it stays correct across content inserts/deletes anywhere (they never
     * change format state; `updateMarkerChanges` keeps `index` aligned).
     * Every mutation that could change it is covered: format-item inserts
     * fold into it via `updateMarkerFormats` (list-order aware AND bounded by
     * the next live same-key format item — a marker beyond that boundary still
     * draws the key from the intervening item, so folding would corrupt it;
     * unreachable anchors get `formats = null` instead), format-item
     * tombstones clear all snapshots in `Item#delete`, and re-anchored or
     * overwritten markers clear it in `overwriteMarker`/`updateMarkerChanges`/
     * `Item#mergeWith`. Wholesale clears (`_searchMarker.length = 0`) cover
     * remote integration and undo.
     *
     * @type {Map<string,any>?}
     */
    this.formats = null
    this.timestamp = globalSearchMarkerTimestamp++
  }
}

/**
 * @param {ArraySearchMarker} marker
 */
const refreshMarkerTimestamp = marker => { marker.timestamp = globalSearchMarkerTimestamp++ }

/**
 * After a format marker item is integrated at `currPos` (it is `currPos.left`;
 * `currPos.right` is the item right of it), fold it into the format snapshot of
 * every search marker positioned at-or-right of the insertion — exactly what a
 * cursor passing the marker would do.
 *
 * Positions compare in *list order*, not just index space: markers anchored
 * at items sharing `currPos.index` but sitting left of the insertion (a
 * same-index run of non-countable/deleted items ending at `currPos.left`)
 * must NOT observe the new format — index equality alone is ambiguous there.
 *
 * Same-key boundary (R1 repair): a marker's `formats` snapshot is the fold of
 * the live format items left of its anchor. The new item changes that fold
 * only while it is the LAST live item setting its key before the anchor — a
 * later live format item that sets the same key again shadows it, so the
 * snapshot's value for that key still comes from that later marker and must
 * not be overwritten. The fold therefore walks right from the insertion and
 * stops at the first live same-key `ContentFormat`: markers anchored
 * at-or-before it are updated, everything past it keeps its (still valid)
 * snapshot.
 *
 * Candidates whose anchor the walk never reaches (stale record — anchor
 * unlinked/merged, or index lying about the real position) are invalidated
 * (`formats = null`) instead of trusting a position that can't be verified.
 *
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 * @param {ContentFormat} format
 */
const updateMarkerFormats = (parent, currPos, format) => {
  const ms = parent._searchMarker
  if (ms === null) return
  /**
   * Anchors of the same-index run ending at `currPos.left`: deleted or
   * non-countable items sharing `currPos.index` but sitting left of the
   * insertion (the run always starts with the new format item itself, which
   * is non-countable). Built lazily — only needed when a marker shares the
   * insertion index.
   *
   * @type {Set<Item>?}
   */
  let leftRun = null
  /**
   * Snapshots at-or-right of the insertion — candidates for the fold.
   *
   * @type {Array<ArraySearchMarker>?}
   */
  let cands = null
  let maxIndex = -1
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]
    if (m.formats === null || m.index < currPos.index) continue
    if (m.index === currPos.index) {
      if (leftRun === null) {
        leftRun = new Set()
        for (let p = currPos.left; p !== null && (p.deleted || !p.countable); p = p.left) {
          leftRun.add(p)
        }
      }
      // fold only if m.p is at-or-right of currPos.right — i.e. not part of
      // the same-index run terminating at currPos.left
      if (leftRun.has(m.p)) continue
    }
    ;(cands ?? (cands = [])).push(m)
    if (m.index > maxIndex) maxIndex = m.index
  }
  if (cands === null) return
  let pindex = currPos.index
  for (let p = currPos.right; p !== null; p = p.right) {
    if (p.marker) {
      for (let i = cands.length - 1; i >= 0; i--) {
        if (cands[i].p === p) {
          updateCurrentFormats(/** @type {Map<string,any>} */ (cands[i].formats), format)
          cands.splice(i, 1)
        }
      }
      if (cands.length === 0) return
    }
    if (!p.deleted && p.content.constructor === ContentFormat && /** @type {ContentFormat} */ (p.content).key === format.key) {
      // Same-key boundary: snapshots past this item still draw this key from
      // it — the new marker's reach ends here. (Markers anchored ON it were
      // already updated: their snapshot is the state at their left edge,
      // which precedes the item's own effect.)
      return
    }
    if (!p.deleted && p.countable) {
      pindex += p.length
      if (pindex > maxIndex) break // every remaining anchor lies behind us — stale records
    }
  }
  // Candidates never reached by the walk can't be verified at-or-right of the
  // insertion — drop their snapshots rather than risk a stale read.
  for (let i = 0; i < cands.length; i++) cands[i].formats = null
}

/**
 * This is rather complex so this function is the only thing that should overwrite a marker
 *
 * @param {ArraySearchMarker} marker
 * @param {Item} p
 * @param {number} index
 */
const overwriteMarker = (marker, p, index) => {
  marker.p.marker = false
  marker.p = p
  p.marker = true
  marker.index = index
  // the position changed — a previous format snapshot no longer applies
  marker.formats = null
  marker.timestamp = globalSearchMarkerTimestamp++
}

/**
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {Item} p
 * @param {number} index
 */
const markPosition = (searchMarker, p, index) => {
  if (searchMarker.length >= maxSearchMarker) {
    // override oldest marker (we don't want to create more objects)
    const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b)
    overwriteMarker(marker, p, index)
    return marker
  } else {
    // create new marker
    const pm = new ArraySearchMarker(p, index)
    searchMarker.push(pm)
    return pm
  }
}

/**
 * Plant a format-aware marker at the cursor's current position, reusing an
 * existing record at the same index when present (avoids duplicates). Only
 * call at quiescent points of an applyDelta walk — after an op completes —
 * where `currPos.currentFormats` is the authoritative state at the left edge
 * of `currPos.right`. Never mid-mutation: in-flight `currentFormats` is
 * transient.
 *
 * @param {YNode} parent
 * @param {ItemTextListPosition} currPos
 */
export const plantMarker = (parent, currPos) => {
  const ms = parent._searchMarker
  if (ms === null) return
  let p = currPos.right
  let index = currPos.index
  if (p === null) {
    // Tail position — the sequential-append case, where every quiescent
    // point sits at the end of the list. Anchor on the last item instead:
    // a marker's index is the left edge of `p`, and a countable non-deleted
    // item doesn't change format state, so `currentFormats` at the tail is
    // also the state at that item's left edge. Format/deleted anchors are
    // rejected (state at their left edge isn't derivable from here).
    p = currPos.left
    if (p === null || p.deleted || !p.countable) return
    index -= p.length
  }
  let m = null
  for (let i = 0; i < ms.length; i++) {
    if (ms[i].index === index) { m = ms[i]; break }
  }
  if (m === null) {
    m = markPosition(ms, p, index)
  } else {
    overwriteMarker(m, p, index)
  }
  m.formats = map.copy(currPos.currentFormats)
}

/**
 * Plant a format-aware marker at an exact list position — the read-side
 * counterpart of {@link plantMarker} (UPSTREAM.md YP5), used by
 * `RangeCursor`'s bounded reads to leave sparse checkpoints behind cold
 * walks. Unlike `plantMarker` this takes the position directly (no
 * `ItemTextListPosition` — a read cursor carries `{p, index,
 * currentFormats}` instead), dedupes same-index records the same way, and
 * copies the caller's format map.
 *
 * The marker's `index` is `p`'s left edge in the raw countable space — the
 * same space every marker consumer records — so callers must only plant
 * while walking the live (countable, non-deleted) interpretation.
 *
 * @param {YNode} parent
 * @param {Item} p - item the marker anchors on (the marker's `index` is its left edge)
 * @param {number} index
 * @param {Map<string,any>} formats - format state at `p`'s left edge (copied)
 */
export const plantSearchMarker = (parent, p, index, formats) => {
  const ms = parent._searchMarker
  if (ms === null) return
  let m = null
  for (let i = 0; i < ms.length; i++) {
    if (ms[i].index === index) { m = ms[i]; break }
  }
  if (m === null) {
    m = markPosition(ms, p, index)
  } else {
    overwriteMarker(m, p, index)
  }
  m.formats = map.copy(formats)
}

/**
 * Search marker help us to find positions in the associative array faster.
 *
 * They speed up the process of finding a position without much bookkeeping.
 *
 * A maximum of `maxSearchMarker` objects are created.
 *
 * This function always returns a refreshed marker (updated timestamp)
 *
 * @param {YNode} yarray
 * @param {number} index
 */
export const findMarker = (yarray, index) => {
  if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
    return null
  }
  const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => math.abs(index - a.index) < math.abs(index - b.index) ? a : b)
  let p = yarray._start
  let pindex = 0
  /**
   * Format state folded forward while walking right from a marker carrying a
   * snapshot — lets the returned marker record the format state at its new
   * position (consumed by `applyDelta`'s cursor seeding). `null` when the
   * start marker has no snapshot or the walk went left: format state is not
   * reconstructable walking backwards.
   *
   * @type {Map<string,any>?}
   */
  let walkFormats = marker === null ? map.create() : (marker.formats === null ? null : map.copy(marker.formats))
  if (marker !== null) {
    p = marker.p
    pindex = marker.index
    refreshMarkerTimestamp(marker) // we used it, we might need to use it again
  }
  // iterate to right if possible
  while (p.right !== null && pindex < index) {
    if (!p.deleted && p.countable) {
      if (index < pindex + p.length) {
        break
      }
      pindex += p.length
    }
    if (walkFormats !== null && !p.deleted && p.content.constructor === ContentFormat) {
      updateCurrentFormats(walkFormats, /** @type {ContentFormat} */ (p.content))
    }
    p = p.right
  }
  // iterate to left if necessary (might be that pindex > index)
  while (p.left !== null && pindex > index) {
    p = p.left
    walkFormats = null // position moved left — snapshot no longer derivable
    if (!p.deleted && p.countable) {
      pindex -= p.length
    }
  }
  // we want to make sure that p can't be merged with left, because that would screw up everything
  // in that cas just return what we have (it is most likely the best marker anyway)
  // iterate to left until p can't be merged with left
  while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
    p = p.left
    walkFormats = null // position moved left — snapshot no longer derivable
    if (!p.deleted && p.countable) {
      pindex -= p.length
    }
  }
  if (marker !== null && math.abs(marker.index - pindex) < /** @type {any} */ (p.parent).length / maxSearchMarker) {
    // adjust existing marker
    overwriteMarker(marker, p, pindex)
    marker.formats = walkFormats
    return marker
  } else {
    // create new marker
    const m = markPosition(yarray._searchMarker, p, pindex)
    m.formats = walkFormats
    return m
  }
}

/**
 * Update markers when a change happened.
 *
 * This should be called before doing a deletion!
 *
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {number} index
 * @param {number} len If insertion, len is positive. If deletion, len is negative.
 */
export const updateMarkerChanges = (searchMarker, index, len) => {
  for (let i = searchMarker.length - 1; i >= 0; i--) {
    const m = searchMarker[i]
    if (len > 0) {
      /**
       * @type {Item|null}
       */
      let p = m.p
      p.marker = false
      // Ideally we just want to do a simple position comparison, but this will only work if
      // search markers don't point to deleted items for formats.
      // Iterate marker to prev undeleted countable position so we know what to do when updating a position
      while (p && (p.deleted || !p.countable)) {
        p = p.left
        if (p && !p.deleted && p.countable) {
          // adjust position. the loop should break now
          m.index -= p.length
        }
      }
      if (p === null || p.marker === true) {
        // remove search marker if updated position is null or if position is already marked
        searchMarker.splice(i, 1)
        continue
      }
      if (p !== m.p) {
        // the anchor moved to a different position — its format snapshot is stale
        m.formats = null
      }
      m.p = p
      p.marker = true
    }
    if (index < m.index || (len > 0 && index === m.index)) { // a simple index <= m.index check would actually suffice
      m.index = math.max(index, m.index + len)
    }
  }
}

/**
 * Call event listeners with an event. This will also add an event to all
 * parents (for `.observeDeep` handlers).
 *
 * @param {YNode} type
 * @param {Transaction} transaction
  * @param {YEvent} event
 */
export const callTypeObservers = (type, transaction, event) => {
  const changedType = type
  const changedParentTypes = transaction.changedParentTypes
  // track the event unconditionally — also for deleted types: the walk carries changes inside a
  // deleted type up to the deep-event consumers on live ancestors.
  while (true) {
    // @ts-ignore
    map.setIfUndefined(changedParentTypes, type, () => []).push(event)
    if (type._item === null) {
      break
    }
    type = /** @type {YNode} */ (type._item.parent)
  }
  // a deleted type's own observers stay silent (deleted content is invisible; mirrors the
  // fire-time rule for `changedParentTypes` targets in `cleanupTransactions`).
  if (changedType._item === null || !changedType._item.deleted) {
    callEventHandlerListeners(/** @type {any} */ (changedType._eH), event, transaction)
  }
}

// YP15 begin (edytor fork: writes without the delta layer — see UPSTREAM.md YP15)
/**
 * One run of a node's current content: a string (text) or the elements of an array insert, under
 * the formats in effect there (`null`: none) — the shape a current-state `toDelta` op had.
 *
 * @typedef {{ insert: string|Array<any>, format: Object<string,any>|null }} ContentRun
 */

/**
 * What a detached node was given, replayed when it integrates: its content runs (adjacent runs of
 * one kind and equal formats merged — the normal form the pre-integration delta had) and its attrs
 * in first-write order (`null`: removed).
 *
 * @typedef {{ runs: Array<ContentRun>, attrs: Object<string,{ value: any }|null> }} Prelim
 */

/**
 * The formats an insert writes: `null` and `undefined` values dropped, `null` when none remain.
 *
 * @param {Object<string,any>|null|undefined} format
 * @return {Object<string,any>|null}
 */
const dataFormat = format => {
  /** @type {Object<string,any>|null} */
  let r = null
  if (format != null) {
    for (const k in format) {
      const v = format[k]
      if (v != null) (r ??= {})[k] = v
    }
  }
  return r
}

/**
 * The formats a `format` call applies: `null` clears every format of a detached node's content,
 * `undefined` (no key) does nothing, a `null` value removes its key.
 *
 * @param {Object<string,any>|null|undefined} formats
 * @return {Object<string,any>|null|undefined}
 */
const formatUpdate = formats => {
  if (formats === null) return null
  /** @type {Object<string,any>|undefined} */
  let r
  if (formats !== undefined) {
    for (const k in formats) {
      const v = formats[k]
      if (v !== undefined) (r ??= {})[k] = v
    }
  }
  return r
}

/**
 * @param {YNode} node
 * @return {Prelim}
 */
const prelimOf = node => node._prelim ?? (node._prelim = { runs: [], attrs: Object.create(null) })

/**
 * Split `runs` so that a run starts at `index`; returns that run's position.
 *
 * @param {Array<ContentRun>} runs
 * @param {number} index
 * @return {number}
 */
const splitRuns = (runs, index) => {
  let i = 0
  for (; i < runs.length && index > 0; i++) {
    const run = runs[i]
    const len = run.insert.length
    if (index < len) {
      runs.splice(i + 1, 0, { insert: run.insert.slice(index), format: run.format })
      run.insert = run.insert.slice(0, index)
      return i + 1
    }
    index -= len
  }
  if (index > 0) throw new Error('Exceeded content range')
  return i
}

/**
 * Drop empty runs and merge adjacent runs of one kind and equal formats.
 *
 * @param {Array<ContentRun>} runs
 */
const mergeRuns = runs => {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].insert.length === 0) runs.splice(i, 1)
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const a = runs[i - 1]
    const b = runs[i]
    if (typeof a.insert === typeof b.insert && equalityDeep(a.format, b.format)) {
      a.insert = typeof a.insert === 'string' ? a.insert + b.insert : a.insert.concat(b.insert)
      runs.splice(i, 1)
    }
  }
}

/**
 * The current content of `node` as runs (formats folded like the cursor folds them; a paired mark
 * shows its winning value under its mark name).
 *
 * @param {YNode} node
 * @return {Array<ContentRun>}
 */
const readRuns = node => {
  /** @type {Array<ContentRun>} */
  const runs = []
  /** @type {Map<string,any>} */
  const current = new Map()
  /** @type {Map<string,any>} */
  const paired = new Map()
  /** @type {Object<string,any>|null|undefined} */
  let format = null
  for (let item = node._start; item !== null; item = item.right) {
    if (item.deleted) continue
    const content = item.content
    if (content.constructor === ContentFormat) {
      let { key, value } = /** @type {ContentFormat} */ (content)
      if (pairedRole(/** @type {ContentFormat} */ (content)) >= 0) {
        foldPaired(paired, /** @type {ContentFormat} */ (content))
        key = key.slice(1)
        value = formatValue(paired.get(key) ?? null)
      }
      if (value == null) {
        current.delete(key)
      } else {
        current.set(key, value)
      }
      format = undefined
      continue
    }
    if (format === undefined) {
      format = null
      current.forEach((v, k) => { (format ??= {})[k] = v })
    }
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (content.constructor === ContentString) {
      const str = /** @type {ContentString} */ (content).str
      if (last !== null && typeof last.insert === 'string' && equalityDeep(last.format, format)) {
        last.insert += str
      } else {
        runs.push({ insert: str, format })
      }
    } else {
      const elems = content.getContent()
      if (last !== null && typeof last.insert !== 'string' && equalityDeep(last.format, format)) {
        for (let i = 0; i < elems.length; i++) last.insert.push(elems[i])
      } else {
        runs.push({ insert: elems.slice(), format })
      }
    }
  }
  return runs
}

/**
 * The live attrs of `node` as an object (no premature-access warning: a detached node has none).
 *
 * @param {YNode} node
 * @return {Object<string,any>}
 */
const liveAttrs = node => {
  /** @type {Object<string,any>} */
  const res = {}
  node._map.forEach((item, key) => {
    if (!item.deleted) res[key] = item.content.getContent()[item.length - 1]
  })
  return res
}

/**
 * A cursor at live index `index` of `node` — the positioning step of every write. A distant index
 * seeds the cursor from a format-aware search marker (UPSTREAM.md YP4): a marker at-or-left of the
 * target carrying a formats snapshot starts the walk there, provided its anchor is the first item
 * at its index (the walk from `_start` stops on the first unprocessed item at the target, format
 * markers and deleted items included).
 *
 * @param {Transaction} transaction
 * @param {YNode} node
 * @param {number} index
 * @return {ItemTextListPosition}
 */
export const cursorAt = (transaction, node, index) => {
  const currPos = new ItemTextListPosition(null, node._start, 0, new Map())
  if (!(index > 0)) return currPos
  let adjust = 0
  const ms = node._searchMarker
  if (ms !== null) {
    // A marker anchored right of the target can still seed when the gap is crossed by stepping
    // left over countable/non-deleted items only — format state does not change across pure
    // content (a format marker or tombstone in the gap stops the walk and rejects the marker).
    // Anchor linkage is verified because records can outlive their items.
    let best = null
    /** @type {Item|null} */
    let bestP = null
    let bestIndex = 0
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      if (m.formats === null || m.index <= 0) continue
      let p = m.p
      let idx = m.index
      let steps = 0
      while (idx > index && p.left !== null && !p.left.deleted && p.left.countable && steps < 64) {
        p = p.left
        idx -= p.length
        steps++
      }
      if (
        idx <= index && (best === null || idx > bestIndex) &&
        (p.left === null ? node._start === p : p.left.right === p) &&
        (p.right === null || p.right.left === p) &&
        (p.left === null || (!p.left.deleted && p.left.countable))
      ) {
        best = m
        bestP = p
        bestIndex = idx
      }
    }
    if (best !== null) {
      currPos.left = /** @type {Item} */ (bestP).left
      currPos.right = bestP
      currPos.index = bestIndex
      currPos.currentFormats = map.copy(/** @type {Map<string,any>} */ (best.formats))
      adjust = bestIndex
    }
  }
  currPos.formatText(transaction, node, index - adjust, {})
  // quiescent point at a positioning boundary — a later write near it seeds from this marker
  plantMarker(node, currPos)
  return currPos
}

/**
 * Write the content and attrs a detached node was given, in the order the pre-integration delta
 * applied them: the content runs with one cursor, then the attrs.
 *
 * @param {Transaction} transaction
 * @param {YNode} node
 * @param {Prelim} prelim
 */
const writePrelim = (transaction, node, prelim) => {
  const currPos = new ItemTextListPosition(null, node._start, 0, new Map())
  for (const run of prelim.runs) {
    const formats = run.format === null ? {} : object.assign({}, run.format)
    if (typeof run.insert === 'string') {
      insertContent(transaction, node, currPos, new ContentString(run.insert), formats)
    } else {
      insertContentHelper(transaction, node, currPos, run.insert, formats)
    }
  }
  plantMarker(node, currPos)
  for (const key in prelim.attrs) {
    const attr = prelim.attrs[key]
    if (attr === null) {
      nodeMapDelete(transaction, node, key)
    } else {
      nodeMapSet(transaction, node, key, attr.value)
    }
  }
}
// YP15 end

/**
 * The engine's node: a sequence (text, elements, nested nodes) and a map of attributes.
 *
 * @extends {ObservableV2<{ destroy: (type: YNode) => void }>}
 */
export class YNode extends ObservableV2 {
  /**
   * @param {string?} name
   */
  constructor (name = null) {
    super()
    /**
     * @type {string|null}
     */
    this.name = name
    /**
     * @type {Item|null}
     */
    this._item = null
    /**
     * @type {Map<string,Item>}
     */
    this._map = new Map()
    /**
     * @type {Item|null}
     */
    this._start = null
    /**
     * @type {Doc|null}
     */
    this.doc = null
    this._length = 0
    /**
     * Event handlers
     * @type {EventHandler<YEvent,Transaction>}
     */
    this._eH = createEventHandler()
    /**
     * Deep event handlers
     * @type {EventHandler<YEvent,Transaction>}
     */
    this._dEH = createEventHandler()
    this._legacyTypeRef = this.name == null ? YXmlFragmentRefID : YXmlElementRefID
    /**
     * @type {Array<ArraySearchMarker>|null}
     */
    this._searchMarker = []
    /**
     * Whether this YText contains formats.
     * This flag is updated when a formatting item is integrated (see ContentFormat.integrate)
     */
    this._hasFormatting = false
    /**
     * The writes made while this node is detached, replayed when it integrates (YP15).
     * @type {Prelim|null}
     */
    this._prelim = null
  }

  /**
   * Emit the `'destroy'` event and unregister its listeners. The content and the
   * `observe`/`observeDeep` handlers are left untouched.
   */
  destroy () {
    this.emit('destroy', [this])
    super.destroy()
  }

  get length () {
    this.doc ?? warnPrematureAccess()
    return this._length
  }

  /**
   * @return {YNode?}
   */
  get parent () {
    return /** @type {YNode?} */ (this._item ? this._item.parent : null)
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item|null} item
   */
  _integrate (y, item) {
    this.doc = y
    this._item = item
    const prelim = this._prelim
    if (prelim !== null) {
      this._prelim = null
      if ((prelim.runs.length > 0 || !object.isEmpty(prelim.attrs)) && (item === null || !item.deleted)) {
        transact(y, transaction => writePrelim(transaction, this, prelim))
      }
    }
  }

  /**
   * @return {YNode}
   */
  _copy () {
    const ynode = new YNode(this.name)
    ynode._legacyTypeRef = this._legacyTypeRef
    return ynode
  }

  /**
   * Creates YEvent and calls all type observers.
   * Must be implemented by each type.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    const event = new YEvent(this, transaction, parentSubs)
    callTypeObservers(this, transaction, event)
    if (!transaction.local && this._searchMarker) {
      this._searchMarker.length = 0
    }
    // If a remote change happened, we try to cleanup potential formatting duplicates.
    if (!transaction.local && this._hasFormatting) {
      transaction._needFormattingCleanup = true
    }
  }

  /**
   * Observe all events that are created on this type.
   *
   * @template {(target: YEvent, tr: Transaction) => void} F
   * @param {F} f Observer function
   * @return {F}
   */
  observe (f) {
    addEventHandlerListener(this._eH, f)
    return f
  }

  /**
   * Observe all events that are created by this type and its children.
   *
   * @template {(target: YEvent, tr: Transaction) => void} F
   * @param {F} f Observer function
   * @return {F}
   */
  observeDeep (f) {
    addEventHandlerListener(this._dEH, f)
    return f
  }

  /**
   * Unregister an observer function.
   *
   * @param {(type: YEvent, tr: Transaction) => void} f Observer function
   */
  unobserve (f) {
    removeEventHandlerListener(this._eH, f)
  }

  /**
   * Unregister an observer function.
   *
   * @param {(type: YEvent, tr: Transaction) => void} f Observer function
   */
  unobserveDeep (f) {
    removeEventHandlerListener(this._dEH, f)
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YNode}
   */
  clone () {
    const cpy = this._copy()
    this._map.forEach((item, key) => {
      if (!item.deleted) {
        const value = item.content.getContent()[item.length - 1]
        cpy.setAttr(key, value instanceof YNode ? value.clone() : value)
      }
    })
    let index = 0
    for (const run of readRuns(this)) {
      const insert = typeof run.insert === 'string' ? run.insert : run.insert.map(c => c instanceof YNode ? c.clone() : c)
      cpy.insert(index, insert, run.format ?? undefined)
      index += insert.length
    }
    return cpy
  }

  /**
   * Removes all attributes.
   */
  clearAttrs () {
    /** @type {Array<string>} */
    const keys = []
    this.forEachAttr((_, key) => { keys.push(key) })
    if (keys.length === 0 || this.doc == null || (this._item !== null && this._item.deleted)) return
    transact(this.doc, transaction => {
      for (const key of keys) nodeMapDelete(transaction, this, key)
    })
  }

  /**
   * Removes an attribute. A deleted node is left as it is.
   *
   * @param {string} attributeName The attribute name that is to be removed.
   *
   * @public
   */
  deleteAttr (attributeName) {
    if (this.doc == null) {
      prelimOf(this).attrs[attributeName] = null
    } else if (this._item === null || !this._item.deleted) {
      transact(this.doc, transaction => nodeMapDelete(transaction, this, attributeName))
    }
  }

  /**
   * Sets or updates an attribute. A deleted node is left as it is.
   *
   * @template VAL
   * @param {string} attributeName The attribute name that is to be set.
   * @param {VAL} attributeValue The attribute value that is to be set.
   * @return {VAL}
   *
   * @public
   */
  setAttr (attributeName, attributeValue) {
    if (this.doc == null) {
      prelimOf(this).attrs[attributeName] = { value: attributeValue }
    } else if (this._item === null || !this._item.deleted) {
      transact(this.doc, transaction => nodeMapSet(transaction, this, attributeName, /** @type {any} */ (attributeValue)))
    }
    return attributeValue
  }

  /**
   * Returns an attribute value that belongs to the attribute name.
   *
   * @param {string} attributeName The attribute name that identifies the queried value.
   * @return {any} The queried attribute value.
   * @public
   */
  getAttr (attributeName) {
    return nodeMapGet(this, attributeName)
  }

  /**
   * Returns whether an attribute exists
   *
   * @param {string} attributeName The attribute name to check for existence.
   * @return {boolean} whether the attribute exists.
   *
   * @public
   */
  hasAttr (attributeName) {
    return nodeMapHas(this, attributeName)
  }

  /**
   * Returns all attribute name/value pairs in a JSON Object.
   *
   * @return {Object<string,any>} A JSON Object that describes the attributes.
   *
   * @public
   */
  getAttrs () {
    return nodeMapGetAll(this)
  }

  /**
   * Inserts new content at an index: a string, or an array of elements (JSON values, nodes,
   * documents). A deleted node is left as it is.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  yarray.insert(0, ['a'])
   *  // Insert numbers 1, 2 at position 1
   *  yarray.insert(1, [1, 2])
   *
   * @param {number} index The index to insert content at.
   * @param {Array<any>|string} content Array of content to append.
   * @param {Object<string,any>} [format]
   */
  insert (index, content, format) {
    if ((typeof content !== 'string' && !Array.isArray(content)) || content.length === 0) return
    if (this.doc == null) {
      const runs = prelimOf(this).runs
      runs.splice(splitRuns(runs, index), 0, { insert: typeof content === 'string' ? content : content.slice(), format: dataFormat(format) })
      mergeRuns(runs)
      return
    }
    if (this._item !== null && this._item.deleted) return
    transact(this.doc, transaction => {
      const currPos = cursorAt(transaction, this, index)
      const formats = dataFormat(format) ?? {}
      if (typeof content === 'string') {
        insertContent(transaction, this, currPos, new ContentString(content), formats)
      } else {
        insertContentHelper(transaction, this, currPos, content.slice(), formats)
      }
      plantMarker(this, currPos)
    })
  }

  // YP7 begin (edytor fork: insertAtGapEnd — see UPSTREAM.md YP7)
  /**
   * Insert `content` (an array of JSON values, one countable unit each) at the end of the gap at
   * live index `index`: after every deleted item and every format item that precedes the next live
   * content item, with the formats in effect there and no format item added.
   *
   * @param {number} index
   * @param {Array<any>} content
   */
  insertAtGapEnd (index, content) {
    if (this.doc == null) throw new Error('insertAtGapEnd: node is not integrated')
    transact(this.doc, transaction => {
      insertAtGapEndHelper(transaction, this, index, new ContentAny(content))
    })
  }
  // YP7 end

  // YP13 begin (edytor fork: paired marks — see UPSTREAM.md YP13, utils/marks.js)
  /**
   * Insert `content` (a string, or an array of JSON values and nodes) at
   * live index `index` with no format item: its origin is the gap's last
   * content item, its right origin the gap's next live content item, and
   * the integration places it after the gap's left-side mark items and
   * before its right-side ones.
   *
   * @param {number} index
   * @param {string|Array<any>} content
   */
  insertInGap (index, content) {
    if (this.doc == null) throw new Error('insertInGap: node is not integrated')
    transact(this.doc, transaction => {
      const parts = typeof content === 'string' ? [new ContentString(content)] : contentsOf(content)
      let at = index
      for (const part of parts) {
        insertInGapHelper(transaction, this, at, part)
        at += part.getLength()
      }
    })
  }

  /**
   * Write one paired mark operation over live `[index, index + length)`:
   * `mark` takes `value` there (`null`: removed) with a Lamport timestamp
   * above every mark this document saw. `startSide`/`endSide` (`0` left,
   * `1` right) decide whether a concurrent insert at each edge lands inside.
   *
   * @param {number} index
   * @param {number} length
   * @param {string} mark
   * @param {any} value
   * @param {number} startSide
   * @param {number} endSide
   */
  mark (index, length, mark, value, startSide, endSide) {
    if (this.doc == null) throw new Error('mark: node is not integrated')
    if (length <= 0) return
    transact(this.doc, transaction => {
      markHelper(transaction, this, index, length, mark, value, startSide, endSide)
    })
  }
  // YP13 end

  /**
   * Formats `[index, index + length)`: each key of `formats` takes its value there (`null`
   * removes it). A deleted node is left as it is.
   *
   * @param {number} index
   * @param {number} length
   * @param {Object<string,any>} formats
   */
  format (index, length, formats) {
    const update = formatUpdate(formats)
    if (update === undefined || !(length > 0)) return
    if (this.doc == null) {
      const runs = prelimOf(this).runs
      const from = splitRuns(runs, index)
      const to = splitRuns(runs, index + length)
      for (let i = from; i < to; i++) {
        const run = runs[i]
        if (update === null) {
          run.format = null
        } else {
          /** @type {Object<string,any>} */
          const f = object.assign({}, run.format)
          for (const k in update) {
            if (update[k] === null) {
              delete f[k]
            } else {
              f[k] = update[k]
            }
          }
          run.format = object.isEmpty(f) ? null : f
        }
      }
      mergeRuns(runs)
      return
    }
    if (this._item !== null && this._item.deleted) return
    transact(this.doc, transaction => {
      const currPos = cursorAt(transaction, this, index)
      currPos.formatText(transaction, this, length, update ?? {})
      plantMarker(this, currPos)
    })
  }

  /**
   * Appends content to this YArray.
   *
   * @param {Array<any>|string} content Array of content to append.
   */
  push (content) {
    this.insert(this.length, content)
  }

  /**
   * Prepends content to this YArray.
   *
   * @param {Array<any>|string} content Array of content to prepend.
   */
  unshift (content) {
    this.insert(0, content)
  }

  /**
   * Deletes elements starting from an index. A deleted node is left as it is.
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} length The number of elements to remove. Defaults to 1.
   */
  delete (index, length = 1) {
    if (!(length > 0)) return
    if (this.doc == null) {
      const runs = prelimOf(this).runs
      const from = splitRuns(runs, index)
      let n = length
      for (let i = from; i < runs.length && n > 0; i++) {
        const run = runs[i]
        if (run.insert.length > n) {
          run.insert = run.insert.slice(n)
          n = 0
        } else {
          n -= run.insert.length
          run.insert = run.insert.slice(0, 0)
        }
      }
      mergeRuns(runs)
      return
    }
    if (this._item !== null && this._item.deleted) return
    transact(this.doc, transaction => {
      const currPos = cursorAt(transaction, this, index)
      deleteText(transaction, currPos, length)
      plantMarker(this, currPos)
    })
  }

  /**
   * Returns the i-th element from a YArray.
   *
   * @param {number} index The index of the element to return from the YArray
   * @return {any}
   */
  get (index) {
    return typeListGet(this, index)
  }

  /**
   * Returns a portion of this YXmlFragment into a JavaScript Array selected
   * from start to end (end not included).
   *
   * @param {number} [start]
   * @param {number} [end]
   * @return {Array<any>}
   */
  slice (start = 0, end = this.length) {
    return typeListSlice(this, start, end)
  }

  /**
   * Transforms this YArray to a JavaScript Array: each element, and each run of text under one set
   * of formats as one string.
   *
   * @return {Array<any>}
   */
  toArray () {
    /**
     * @type {Array<any>}
     */
    const children = []
    for (const run of readRuns(this)) {
      if (typeof run.insert === 'string') {
        children.push(run.insert)
      } else {
        for (let i = 0; i < run.insert.length; i++) children.push(run.insert[i])
      }
    }
    return children
  }

  /**
   * Transforms this Shared Type to a JSON object.
   * @return {{ name?: string, attrs?: { [K:string|number]: any }, children?: Array<any>  }}
   */
  toJSON () {
    /**
     * @type {{[K:string]:any}}
     */
    const attrs = this.getAttrs()
    for (const k in attrs) {
      const attr = attrs[k]
      attrs[k] = attr instanceof YNode ? attr.toJSON() : attr
    }
    const children = this.toArray().map(child => child instanceof YNode ? /** @type {any} */ (child.toJSON()) : child)
    /**
     * @type {any}
     */
    const res = {}
    if (this.name != null) {
      res.name = this.name
    }
    if (this.length > 0) {
      res.children = children
    }
    if (this.attrSize > 0) {
      res.attrs = attrs
    }
    return res
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.forceTag] enforce creating a surrouning <name /> tag, even if it is null.
   * @return {string}
   */
  toString ({ forceTag = false } = {}) {
    /**
     * @type {Array<[string|number,string]>}
     */
    const attrs = []
    this.forEachAttr((attr, key) => {
      attrs.push([(key), /** @type {any} */ (attr) instanceof YNode ? attr.toString({ forceTag: true }) : JSON.stringify(attr)])
    })
    const attrsString = (attrs.length > 0 ? ' ' : '') + attrs.sort((a, b) => a[0].toString() < b[0].toString() ? -1 : 1).map(attr => attr[0] + '=' + attr[1]).join(' ')
    /**
     * @type {string}
     */
    const children = this.toArray().map(c => typeof c === 'string' ? c : (c instanceof YNode ? c.toString({ forceTag: true }) : JSON.stringify(c))).join('')
    if (this.name == null && !forceTag && attrs.length === 0) {
      return children
    }
    if (this.length === 0) {
      return `<${this.name ?? ''}${attrsString} />`
    }
    return `<${this.name ?? ''}${attrsString}>${children}</${this.name ?? ''}>`
  }

  /**
   * Returns an Array with the result of calling a provided function on every
   * child-element.
   *
   * @template M
   * @param {(child:any,index:number)=>M} f Function that produces an element of the new Array
   * @return {Array<M>} A new array with each element being the result of the
   *                 callback function
   */
  map (f) {
    return this.toArray().map(f)
  }

  /**
   * Executes a provided function once on every element of this YArray.
   *
   * @param {(child:any,index:number)=>any} f Function that produces an element of the new Array
   */
  forEach (f) {
    return this.toArray().forEach(f)
  }

  /**
   * Executes a provided function on once on every key-value pair.
   *
   * @param {(val:any,key:string,ynode:this)=>any} f
   */
  forEachAttr (f) {
    this._map.forEach((item, key) => {
      if (!item.deleted) {
        f(item.content.getContent()[item.length - 1], key, this)
      }
    })
  }

  /**
   * Returns the keys for each element in the YMap Type.
   *
   * @return {IterableIterator<string>}
   */
  attrKeys () {
    return iterator.iteratorMap(createMapIterator(this), /** @param {any} v */ v => v[0])
  }

  /**
   * Returns the values for each element in the YMap Type.
   *
   * @return {IterableIterator<any>}
   */
  attrValues () {
    return iterator.iteratorMap(createMapIterator(this), /** @param {any} v */ v => v[1].content.getContent()[v[1].length - 1])
  }

  /**
   * Returns an Iterator of [key, value] pairs
   *
   * @return {IterableIterator<[string, any]>}
   */
  attrEntries () {
    return iterator.iteratorMap(createMapIterator(this), /** @param {any} v */ v => /** @type {any} */ ([v[0], v[1].content.getContent()[v[1].length - 1]]))
  }

  /**
   * Returns the number of stored attributes (count of key/value pairs)
   *
   * @return {number}
   */
  get attrSize () {
    return [...createMapIterator(this)].length
  }

  /**
   * Two nodes are equal when their names, attrs and content runs are.
   *
   * @param {this} other
   */
  [traits.EqualityTraitSymbol] (other) {
    return this.name === other.name && equalityDeep(liveAttrs(this), liveAttrs(other)) && equalityDeep(readRuns(this), readRuns(other))
  }

  /**
   * @todo this doesn't need to live in a method.
   *
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   */
  _write (encoder) {
    encoder.writeTypeRef(this._legacyTypeRef)
    switch (this._legacyTypeRef) {
      case YXmlElementRefID:
      case YXmlHookRefID: {
        encoder.writeKey(/** @type {string} */ (this.name))
        break
      }
    }
  }
}

/**
 * @param {any} a
 * @param {any} b
 * @return {boolean}
 */
export const equalFormats = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a && b && object.equalFlat(a, b))

/**
 * @param {YNode} type
 * @param {number} start
 * @param {number} end
 * @return {Array<any>}
 *
 * @private
 * @function
 */
export const typeListSlice = (type, start, end) => {
  type.doc ?? warnPrematureAccess()
  if (start < 0) {
    start = type._length + start
  }
  if (end < 0) {
    end = type._length + end
  }
  let len = end - start
  const cs = []
  let n = type._start
  while (n !== null && len > 0) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent()
      if (c.length <= start) {
        start -= c.length
      } else {
        for (let i = start; i < c.length && len > 0; i++) {
          cs.push(c[i])
          len--
        }
        start = 0
      }
    }
    n = n.right
  }
  return cs
}

/**
 * @todo remove / inline this
 *
 * @param {YNode} type
 * @param {number} index
 * @return {any}
 *
 * @private
 * @function
 */
export const typeListGet = (type, index) => {
  type.doc ?? warnPrematureAccess()
  const marker = findMarker(type, index)
  let n = type._start
  if (marker !== null) {
    n = marker.p
    index -= marker.index
  }
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        return n.content.getContent()[index]
      }
      index -= n.length
    }
  }
}

/**
 * @todo inline this code
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {string} key
 *
 * @private
 * @function
 */
export const nodeMapDelete = (transaction, parent, key) => {
  const c = parent._map.get(key)
  if (c !== undefined) {
    c.delete(transaction)
  }
}

/**
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {string} key
 * @param {YValue} value
 *
 * @private
 * @function
 */
export const nodeMapSet = (transaction, parent, key, value) => {
  const left = parent._map.get(key) || null
  const doc = transaction.doc
  const ownClientId = doc.clientID
  let content
  if (value == null) {
    content = new ContentAny([value])
  } else {
    switch (value.constructor) {
      case Number:
      case Object:
      case Boolean:
      case Array:
      case String:
      case Date:
      case BigInt:
        content = new ContentAny([value])
        break
      case Uint8Array:
        content = new ContentBinary(/** @type {Uint8Array} */ (value))
        break
      default:
        if (isDoc(value)) {
          content = createContentDocFromDoc(/** @type {Doc} */ (value))
        } else if (value instanceof YNode) {
          content = new ContentType(/** @type {any} */ (value))
        } else {
          throw new Error('Unexpected content type')
        }
    }
  }
  new Item(createID(ownClientId, doc.store.getClock(ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0)
}

/**
 * @param {YNode} parent
 * @param {string} key
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|YNode|undefined}
 *
 * @private
 * @function
 */
export const nodeMapGet = (parent, key) => {
  parent.doc ?? warnPrematureAccess()
  const val = parent._map.get(key)
  return val !== undefined && !val.deleted ? val.content.getContent()[val.length - 1] : undefined
}

/**
 * @param {YNode} parent
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|YNode|undefined>}
 *
 * @private
 * @function
 */
export const nodeMapGetAll = (parent) => {
  /**
   * @type {Object<string,any>}
   */
  const res = {}
  parent.doc ?? warnPrematureAccess()
  parent._map.forEach((value, key) => {
    if (!value.deleted) {
      res[key] = value.content.getContent()[value.length - 1]
    }
  })
  return res
}

/**
 * @param {YNode} parent
 * @param {string} key
 * @return {boolean}
 *
 * @private
 * @function
 */
export const nodeMapHas = (parent, key) => {
  parent.doc ?? warnPrematureAccess()
  const val = parent._map.get(key)
  return val !== undefined && !val.deleted
}

/**
 * @param {YNode & { _map: Map<string, Item> }} type
 * @return {IterableIterator<Array<any>>}
 *
 * @private
 * @function
 */
export const createMapIterator = type => {
  type.doc ?? warnPrematureAccess()
  return iterator.iteratorFilter(type._map.entries(), /** @param {any} entry */ entry => !entry[1].deleted)
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentType}
 */
export const readContentType = decoder => new ContentType(readYNode(decoder))

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentString}
 */
export const readContentString = decoder => new ContentString(decoder.readString())

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentJSON}
 */
export const readContentJSON = decoder => {
  const len = decoder.readLen()
  const cs = []
  for (let i = 0; i < len; i++) {
    const c = decoder.readString()
    if (c === 'undefined') {
      cs.push(undefined)
    } else {
      cs.push(JSON.parse(c))
    }
  }
  return new ContentJSON(cs)
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentFormat}
 */
export const readContentFormat = decoder => new ContentFormat(decoder.readKey(), decoder.readJSON())

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentEmbed}
 */
export const readContentEmbed = decoder => new ContentEmbed(decoder.readJSON())

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentDoc}
 */
export const readContentDoc = decoder => new ContentDoc(decoder.readString(), decoder.readAny())

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentAny}
 */
export const readContentAny = decoder => {
  const len = decoder.readLen()
  const cs = []
  for (let i = 0; i < len; i++) {
    cs.push(decoder.readAny())
  }
  return new ContentAny(cs)
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2 } decoder
 * @return {ContentBinary}
 */
export const readContentBinary = decoder => new ContentBinary(decoder.readBuf())

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2 } decoder
 * @return {ContentDeleted}
 */
export const readContentDeleted = decoder => new ContentDeleted(decoder.readLen())

/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractContent>}
 */
export const contentRefs = [
  () => { error.unexpectedCase() }, // GC is not ItemContent
  readContentDeleted, // 1
  readContentJSON, // 2
  readContentBinary, // 3
  readContentString, // 4
  readContentEmbed, // 5
  readContentFormat, // 6
  readContentType, // 7
  readContentAny, // 8
  readContentDoc, // 9
  () => { error.unexpectedCase() } // 10 - Skip is not ItemContent
]

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @param {number} info
 */
export const readItemContent = (decoder, info) => contentRefs[info & binary.BITS5](decoder)

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {YNode}
 *
 * @private
 * @function
 */
export const readYNode = decoder => {
  const typeRef = decoder.readTypeRef()
  const ynode = new YNode(typeRef === YXmlElementRefID || typeRef === YXmlHookRefID ? decoder.readKey() : null)
  ynode._legacyTypeRef = typeRef
  return ynode
}
