import * as binary from 'lib0-v14/binary'
import * as array from 'lib0-v14/array'
import * as delta from 'lib0-v14/delta'
import * as error from 'lib0-v14/error'
import * as iterator from 'lib0-v14/iterator'
import * as log from 'lib0-v14/logging'
import * as map from 'lib0-v14/map'
import * as set from 'lib0-v14/set'
import * as math from 'lib0-v14/math'
import * as object from 'lib0-v14/object'
import * as s from 'lib0-v14/schema'
import * as traits from 'lib0-v14/traits'
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
import { AttributedContent, rendererContentLength, readItemPieces } from './utils/renderer-helpers.js'
import { removeEventHandlerListener, callEventHandlerListeners, addEventHandlerListener, createEventHandler } from './utils/EventHandler.js'
import { createID } from './utils/ID.js'
import { createIdSet, iterateStructsByIdSetWithoutSplits } from './utils/ids.js'
import { getItemCleanStart, cleanupFormattingGap } from './utils/transaction-helpers.js'
import { transact } from './utils/Transaction.js'
import { YEvent } from './utils/YEvent.js'
import { $doc } from './utils/schemas.js'
import { foldPaired, formatValue, pairedRole, markClass, MARK_START, MARK_END, SIDE_LEFT } from './utils/marks.js' // P13

/**
 * @typedef {Object<string,any>|Array<any>|number|null|string|Uint8Array|BigInt|YNode<any>} YValue
 */

/**
 * https://docs.yjs.dev/getting-started/working-with-shared-types#caveats
 */
export const warnPrematureAccess = () => { log.warn('Invalid access: Add Yjs type to a document before reading data.') }

const maxSearchMarker = 80

/**
 * @todo SHOULD NOT RETURN AN OBJECT!
 * @param {Array<ContentAttribute<any>>?} attrs
 * @param {boolean} deleted - whether the attributed item is deleted
 * @return {Attribution|undefined} `undefined` when there is no attribution — under lib0's tri-state
 * that means "skip / inherit the builder's attribution context" (NOT `null`, which would clear it).
 */
export const createAttributionFromAttributionItems = (attrs, deleted) => {
  if (attrs == null) {
    return undefined
  }
  /**
   * @type {Attribution}
   */
  const attribution = {}
  if (deleted) {
    attribution.delete = []
  } else {
    attribution.insert = []
  }
  attrs.forEach(attr => {
    switch (attr.name) {
      // eslint-disable-next-line no-fallthrough
      case 'insert':
      case 'delete': {
        // needs to be non-ambiguous: don't add existing attr if it doesn't match the actual status
        attribution[attr.name]?.push(attr.val)
        break
      }
      default: {
        if (attr.name[0] !== '_') {
          /** @type {any} */ (attribution)[attr.name] = attr.val
        }
      }
    }
  })
  return attribution
}

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
   * @param {AbstractRenderer?} renderer
   */
  constructor (left, right, index, currentFormats, renderer) {
    this.left = left
    this.right = right
    this.index = index
    this.currentFormats = currentFormats
    this.renderer = renderer
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
        this.index += rendererContentLength(this.renderer, this.right)
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
          ((this.right.deleted && rendererContentLength(this.renderer, this.right) === 0) || this.right.content.constructor === ContentFormat)
        )
      )
    ) {
      switch (this.right.content.constructor) {
        case ContentFormat: {
          if (!this.right.deleted && pairedRole(/** @type {ContentFormat} */ (this.right.content)) >= 0) {
            // P13: a paired mark is folded, never rewritten by a plain format
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
          const rightLen = rendererContentLength(this.renderer, item)
          if (length < rightLen) {
            if (this.renderer !== null && this.renderer.hasItem(item)) {
              /**
               * @type {Array<AttributedContent<any>>}
               */
              const contents = []
              this.renderer.readContent(contents, item.id.client, item.id.clock, item.deleted, item.content, 0)
              let i = 0
              for (; i < contents.length && length > 0; i++) {
                const c = contents[i]
                if ((!c.deleted || c.attrs != null) && c.content.isCountable()) {
                  length -= c.content.getLength()
                }
              }
              if (length < 0 || (length === 0 && i !== contents.length)) {
                const c = contents[--i]
                getItemCleanStart(transaction, createID(item.id.client, c.clock + c.content.getLength() + length))
              }
            } else {
              // plain content: split directly at the offset
              getItemCleanStart(transaction, createID(item.id.client, item.id.clock + length))
              length = 0
            }
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
      (currPos.right.deleted && rendererContentLength(currPos.renderer, currPos.right) === 0) || (
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
  if (foldPaired(currentFormats, format)) return // P13
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
    } else if (currPos.right.deleted ? (rendererContentLength(currPos.renderer, currPos.right) === 0) : (!currPos.right.deleted && currPos.right.content.constructor === ContentFormat && equalFormats(formats[(/** @type {ContentFormat} */ (currPos.right.content)).key] ?? null, /** @type {ContentFormat} */ (currPos.right.content).value))) {
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

// P13 begin (edytor fork: paired marks — see UPSTREAM.md P13)
/**
 * The contents an array insert writes (as `insertContentHelper` splits it).
 *
 * @param {Array<any>} insert
 * @return {Array<import('./structs/Item.js').AbstractContent>}
 */
const contentsOf = insert => {
  insert = insert.map(ins => delta.$deltaAny.check(ins) ? YNode.from(ins) : ins)
  /** @type {Array<import('./structs/Item.js').AbstractContent>} */
  const out = []
  for (let i = 0; i < insert.length;) {
    const first = insert[i]
    if (first instanceof YNode) {
      out.push(new ContentType(first))
      i++
    } else if ($doc.check(first)) {
      out.push(createContentDocFromDoc(first))
      i++
    } else {
      let j = i + 1
      for (; j < insert.length && !(insert[j] instanceof YNode || $doc.check(insert[j])); j++) { /* nop */ }
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
// P13 end

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
  if (s.$string.check(insert)) {
    insertContent(transaction, parent, currPos, new ContentString(insert), formats)
  } else {
    insert = insert.map(ins => delta.$deltaAny.check(ins) ? YNode.from(ins) : ins)
    for (let i = 0; i < insert.length;) {
      const first = insert[i]
      if (first instanceof YNode) {
        insertContent(transaction, parent, currPos, new ContentType(first), formats)
        i++
      } else if ($doc.check(first)) {
        insertContent(transaction, parent, currPos, createContentDocFromDoc(first), formats)
        i++
      } else {
        // insert "any" content
        // compute slice len
        let j = i + 1
        for (; j < insert.length && !(insert[j] instanceof YNode || $doc.check(insert[j])); j++) { /* nop */ }
        insertContent(transaction, parent, currPos, new ContentAny((i === 0 && j === insert.length) ? insert : insert.slice(i, j)), formats)
        i = j
      }
    }
  }
}

// P7 begin (edytor fork: insertAtGapEnd — see UPSTREAM.md P7)
/**
 * Insert `content` at the END of the gap at live index `index`: walk `index`
 * countable live units, then pass every deleted item and every format item
 * before the next live content item, and integrate `content` there. The
 * content takes exactly the formats in effect at that point — no format item
 * is added. The walk ignores any renderer: indices are live-content space.
 *
 * @param {Transaction} transaction
 * @param {YNode} parent
 * @param {number} index
 * @param {import('./structs/Item.js').AbstractContent} content
 */
export const insertAtGapEndHelper = (transaction, parent, index, content) => {
  const currPos = new ItemTextListPosition(null, parent._start, 0, new Map(), null)
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
// P7 end

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
    } else if (currPos.renderer !== null && currPos.renderer.hasItem(item)) {
      /**
       * @type {Array<AttributedContent<any>>}
       */
      const contents = []
      currPos.renderer.readContent(contents, item.id.client, item.id.clock, true, item.content, 0)
      let splitClock = -1
      for (let i = 0; i < contents.length; i++) {
        const c = contents[i]
        if (c.content.isCountable() && c.attrs != null) {
          if (length === 0) {
            // the delete is exhausted but this item renders more content — split so the cursor
            // advances only past the consumed part (mirrors formatText's renderer branch);
            // otherwise every following op of the same delta targets too far right
            splitClock = c.clock
            break
          }
          // deleting already deleted content. store that information in a meta property, but do
          // nothing
          const pieceLen = c.content.getLength()
          const contentLen = math.min(pieceLen, length)
          map.setIfUndefined(transaction.meta, 'attributedDeletes', createIdSet).add(item.id.client, c.clock, contentLen)
          length -= contentLen
          if (contentLen < pieceLen) {
            splitClock = c.clock + contentLen
            break
          }
        }
      }
      if (splitClock >= 0) {
        getItemCleanStart(transaction, createID(item.id.client, splitClock))
      } else {
        const lastContent = contents.length > 0 ? contents[contents.length - 1] : null
        const nextItemClock = item.id.clock + item.length
        const nextContentClock = lastContent != null ? lastContent.clock + lastContent.content.getLength() : nextItemClock
        if (nextContentClock < nextItemClock) {
          getItemCleanStart(transaction, createID(item.id.client, nextContentClock))
        }
      }
    }
    currPos.forward()
  }
  if (start) {
    cleanupFormattingGap(transaction, start, currPos.right, startFormats, currPos.currentFormats)
  }
  const parent = /** @type {YNode<any>} */ (/** @type {Item} */ (currPos.left || currPos.right).parent)
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
 * @param {YNode<any>} parent
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
 * @param {YNode<any>} parent
 * @param {ItemTextListPosition} currPos
 */
const plantMarker = (parent, currPos) => {
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
 * counterpart of {@link plantMarker} (UPSTREAM.md P5), used by
 * `RangeCursor`'s bounded reads to leave sparse checkpoints behind cold
 * walks. Unlike `plantMarker` this takes the position directly (no
 * `ItemTextListPosition` — a read cursor carries `{p, index,
 * currentFormats}` instead), dedupes same-index records the same way, and
 * copies the caller's format map.
 *
 * The marker's `index` is `p`'s left edge in the raw countable space — the
 * same space every marker consumer records — so callers must only plant
 * while walking the generic (`renderer === null`) interpretation.
 *
 * @param {YNode<any>} parent
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
  * @param {YEvent<any>} event
 */
export const callTypeObservers = (type, transaction, event) => {
  const changedType = type
  const changedParentTypes = transaction.changedParentTypes
  // track the event unconditionally — also for deleted types: the walk carries changes inside a
  // deleted type (e.g. a suggestion-deleted tombstone that a custom renderer still renders) up to
  // the deep-event / 'delta' / cache consumers on live ancestors.
  while (true) {
    // @ts-ignore
    map.setIfUndefined(changedParentTypes, type, () => []).push(event)
    if (type._item === null) {
      break
    }
    type = /** @type {YNode} */ (type._item.parent)
  }
  // a deleted type's own observers stay silent (deleted content is invisible) — unless a
  // renderer is attached to it, which may still render the type (mirrors the fire-time rule for
  // `changedParentTypes` targets in `cleanupTransactions`).
  if (changedType._item === null || !changedType._item.deleted || changedType._renderer !== null) {
    callEventHandlerListeners(/** @type {any} */ (changedType._eH), event, transaction)
  }
}

/**
 * Abstract Yjs Type class.
 *
 * A `YNode` is a {@link https://github.com/dmonad/lib0 lib0} `RDT` ("replicated data type", see
 * `lib0-v14/delta/rdt.js`): it emits a `'delta'` event whenever its state changes (carrying the change
 * and the origin of the transaction that caused it), accepts foreign
 * changes via {@link YNode#applyDelta}, exposes its delta {@link YNode#$delta schema}, and can be
 * torn down via {@link YNode#destroy}. This lets a `YNode` be `bind()`-ed to any other RDT (another
 * `YNode`, an in-memory delta, a DOM subtree, …). The legacy {@link YNode#observe `observe`} /
 * {@link YNode#observeDeep `observeDeep`} `YEvent` API continues to work alongside the `'delta'`
 * channel.
 *
 * @template {delta.DeltaConf} [DConf=any]
 * @extends {ObservableV2<{ delta: (delta: delta.Delta<DConf>, origin: any) => void, destroy: (type: YNode<DConf>) => void }>}
 */
export class YNode extends ObservableV2 {
  /**
   * @param {delta.DeltaConfGetName<DConf>?} name
   */
  constructor (name = null) {
    super()
    /**
     * @type {delta.DeltaConfGetName<DConf>}
     */
    this.name = /** @type {delta.DeltaConfGetName<DConf>} */ (name)
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
     * @type {EventHandler<YEvent<DeltaToYNode<DConf>>,Transaction>}
     */
    this._eH = createEventHandler()
    /**
     * Deep event handlers
     * @type {EventHandler<YEvent<DConf>,Transaction>}
     */
    this._dEH = createEventHandler()
    /**
     * @type {null | Array<ArraySearchMarker>}
     */
    this._searchMarker = null
    /**
     * Maintained deep-delta cache backing {@link YNode#delta}. `null` until `delta` is first
     * accessed; thereafter kept current on every event of this type (incrementally, by applying the
     * deep change) and re-diffed by {@link YNode#useRenderer}. Cleared by {@link YNode#clearCache}.
     *
     * INVARIANT (fingerprint-memo safety): consumers (e.g. y-sync) diff against this LIVE object
     * via {@link YNode#delta}, which memoizes `_fingerprint` on its delta/op nodes at every depth.
     * Every in-place patch — the per-transaction `apply` in `cleanupTransactions` and the
     * renderer-overlay `apply` in {@link typeApplyRendererChange} — MUST route through the lib0
     * delta builder API (`apply`), which invalidates those memos. NEVER write delta/op fields
     * directly: a direct write leaves stale memos, corrupting every subsequent fingerprint read
     * and diff. Pinned by the `testRdtFingerprintMemo*CacheDrift` tests.
     * @type {delta.DeltaBuilderAny | null}
     */
    this._delta = null
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
     * The active default renderer. Used by `toDelta`, `applyDelta`, and the events whenever no
     * explicit renderer is passed. `null` = no renderer: content renders as-is via the generic
     * fast path. Change it via {@link YNode#useRenderer}.
     * @type {AbstractRenderer?}
     */
    this._renderer = null
    /**
     * Bound listener on the active renderer's `'change'` event — attribution corrections that
     * happen without a Y transaction on this doc (e.g. a suggestion is accepted and the
     * renderer's attribution overlay updates). `null` while no renderer is active.
     * Managed by {@link YNode#useRenderer}; see {@link typeApplyRendererChange}.
     * @type {((changes: IdSet, origin: any, local: boolean) => void) | null}
     */
    this._rendererChangeHandler = null
  }

  /**
   * Schema of the deltas this type produces — part of the lib0 `RDT` interface.
   *
   * @type {s.Schema<delta.Delta<DConf>>}
   */
  get $delta () {
    return /** @type {any} */ (delta.$deltaAny)
  }

  /**
   * The deep delta of this type (the full nested content tree, children rendered as their own
   * deltas).
   *
   * The returned value is the type's **live** maintained cache: it is materialized on first access
   * and then kept current on every event fired on this type (and re-diffed by
   * {@link YNode#useRenderer}), so a reference held across edits keeps updating in place. Clone it
   * (e.g. `type.delta.clone()`) if you need a stable snapshot, and call {@link YNode#clearCache} to
   * drop the cache.
   *
   * Consider the returned delta **done** — it must not be edited from the outside. It is
   * deliberately typed as a `Delta` (not a `DeltaBuilder`) so the mutating builder API is not
   * reachable; editing it anyway would corrupt the cache without changing the CRDT. The proper way
   * to change this type is {@link YNode#applyDelta}.
   *
   * @type {delta.Delta<DConf>}
   */
  get delta () {
    if (this._delta === null) {
      this._delta = this._renderDelta()
    }
    return /** @type {any} */ (this._delta)
  }

  /**
   * Render the full deep current state into a fresh `isFinal` builder (so subsequent `.apply`s of
   * deep changes update content in place). Uses this type's active renderer.
   *
   * @return {delta.DeltaBuilderAny}
   */
  _renderDelta () {
    const state = /** @type {delta.DeltaBuilderAny} */ (delta.create(this.name))
    state.isFinal = true
    state.apply(this.toDelta({ deep: true }))
    return state
  }

  /**
   * Discard the cached deep delta backing {@link YNode#delta}.
   *
   * After `delta` is first accessed, the cache is updated on every event fired on this type (and
   * re-diffed by {@link YNode#useRenderer}). Call this to drop it — e.g. to reclaim memory, or to
   * force an exact recomputation after editing while a non-base renderer is active (the incremental
   * updates can drift from a fresh deep render in that case).
   */
  clearCache () {
    this._delta = null
  }

  /**
   * Change the default renderer used by this type. After calling `useRenderer(renderer)`, the
   * `toDelta`, `applyDelta`, and event methods all use `renderer` whenever no explicit renderer is
   * passed (an explicit `{ renderer }` argument still overrides it per call).
   *
   * If the deep-delta cache ({@link YNode#delta}) is being maintained, or a `'delta'` listener is
   * attached, the content is re-rendered with the new renderer and the difference is emitted on the
   * `'delta'` channel only (a renderer switch is not a CRDT change, so no `YEvent` is produced, and
   * the emitted origin is `null` as no transaction is involved).
   *
   * @param {AbstractRenderer?} renderer - `null` detaches: content renders as-is again
   * @return {this}
   */
  useRenderer (renderer) {
    const prev = this._renderer
    if (renderer === prev) return this
    if (this._rendererChangeHandler !== null) {
      /** @type {AbstractRenderer} */ (prev).off('change', this._rendererChangeHandler)
      this._rendererChangeHandler = null
    }
    if (renderer !== null && this._rendererChangeHandler === null) {
      // attribution corrections (e.g. accepting a suggestion) reach the renderer without a Y
      // transaction on this doc — subscribe so the RDT surface (maintained cache + 'delta'
      // channel) stays current. Without a renderer there are no attributions, hence no
      // subscription. Not gated on `renderer !== prev`: after `destroy()` the handler is removed
      // while `_renderer` keeps pointing at the renderer, so re-activating with the same renderer
      // must re-subscribe.
      this._rendererChangeHandler = (changes, origin) => typeApplyRendererChange(this, changes, origin)
      renderer.on('change', this._rendererChangeHandler)
    }
    const hasDeltaListeners = (this._observers.get('delta')?.size ?? 0) > 0
    if (this._delta !== null || hasDeltaListeners) {
      const oldState = this._delta ?? this._renderDelta()
      this._renderer = renderer
      const newState = this._renderDelta()
      if (this._delta !== null) this._delta = newState
      if (hasDeltaListeners) {
        const d = /** @type {any} */ (delta.diff(/** @type {any} */ (oldState), /** @type {any} */ (newState)))
        if (!d.isEmpty()) this.emit('delta', [d, null])
      }
    } else {
      this._renderer = renderer
    }
    return this
  }

  /**
   * Tear down this type as an `RDT`: emit the `'destroy'` event, unregister all `'delta'` /
   * `'destroy'` listeners, and reset the RDT surface (active renderer detached, the
   * maintained {@link YNode#delta} cache dropped). The CRDT content and the
   * `observe`/`observeDeep` handlers are left untouched — this only releases the RDT/binding
   * observers. Without the reset, a still-materialized cache would keep being maintained through
   * the transaction path but no longer receive the renderer's attribution corrections — reading
   * `delta` after `destroy()` would silently drift. Re-activating is fully supported:
   * `useRenderer(renderer)` re-subscribes and `delta` re-materializes.
   */
  destroy () {
    if (this._rendererChangeHandler !== null) {
      /** @type {AbstractRenderer} */ (this._renderer).off('change', this._rendererChangeHandler)
      this._rendererChangeHandler = null
    }
    this._renderer = null
    this._delta = null
    this.emit('destroy', [this])
    super.destroy()
  }

  /**
   * @template {delta.DeltaConf} DC
   * @param {delta.Delta<DC>} d
   * @return {YNode<DC>}
   */
  static from (d) {
    const yt = new YNode(d.name)
    yt.applyDelta(d)
    return yt
  }

  get length () {
    this.doc ?? warnPrematureAccess()
    return this._length
  }

  /**
   * Returns a fresh delta that can be used to change this YNode.
   * @type {delta.DeltaBuilder<DeltaToYNode<DConf>>}
   */
  get change () {
    return /** @type {any} */ (delta.create())
  }

  /**
   * @return {YNode<any>?}
   */
  get parent () {
    return /** @type {YNode<any>?} */ (this._item ? this._item.parent : null)
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
    if (this._prelim) {
      this.applyDelta(this._prelim)
      this._prelim = null
    }
  }

  /**
   * @return {YNode<DConf>}
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
    const event = new YEvent(/** @type {any} */ (this), transaction, parentSubs)
    callTypeObservers(/** @type {any} */ (this), transaction, event)
    // Note: the RDT `'delta'` channel (and the deep-delta cache) is driven in the transaction
    // cleanup's `changedParentTypes` loop (see Transaction.js) so it bubbles to ancestors like
    // `observeDeep`, not here where only the directly-changed type is visible.
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
   * @template {(target: YEvent<DeltaToYNode<DConf>>, tr: Transaction) => void} F
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
   * @template {function(YEvent<DConf>,Transaction):void} F
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
   * @param {(type:YEvent<DeltaToYNode<DConf>>,tr:Transaction)=>void} f Observer function
   */
  unobserve (f) {
    removeEventHandlerListener(this._eH, f)
  }

  /**
   * Unregister an observer function.
   *
   * @param {function(YEvent<DConf>,Transaction):void} f Observer function
   */
  unobserveDeep (f) {
    removeEventHandlerListener(this._dEH, f)
  }

  /**
   * Render the difference to another ydoc (which can be empty) and highlight the differences with
   * attributions.
   *
   * Note that deleted content that was not deleted in prevYdoc is rendered as an insertion with the
   * attribution `{ isDeleted: true, .. }`.
   *
   * @template {boolean} [Deep=false]
   *
   * @param {Object} [opts]
   * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
   * @param {IdSet?} [opts.itemsToRender]
   * @param {boolean} [opts.retainInserts] - if true, retain rendered inserts with attributions
   * @param {boolean} [opts.retainDeletes] - if true, retain rendered+attributed deletes only
   * @param {IdSet?} [opts.insertedItems] - ids inserted by the change being rendered; content that is both in `insertedItems` and deleted renders as a *fresh* insert even under `retainDeletes` (it was never part of the consuming state)
   * @param {Map<YNode,Set<string|null>>|null} [opts.modified] - set of types that should be rendered as modified children
   * @param {Deep} [opts.deep] - render child types as delta
   * @return {Deep extends true ? delta.Delta<DConf> : delta.Delta<DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
   *
   * @public
   */
  toDelta (opts = {}) {
    const { renderer = this._renderer, itemsToRender = null, retainInserts = false, retainDeletes = false, insertedItems = null, deep = false } = opts
    const { modified = (deep && itemsToRender) ? computeModifiedFromItems(/** @type {Doc} */ (this.doc).store, itemsToRender) : null } = opts
    const renderAttrs = modified?.get(this) || null
    const renderChildren = modified == null || !modified.has(this) || /** @type {Set<string|null>} */ (modified.get(this)).has(null)
    /**
     * @type {delta.DeltaBuilderAny}
     */
    const d = /** @type {any} */ (delta.create(this.name))
    const optsAll = object.assign({}, opts, { renderer, modified })
    // opts has been re-computed - do not use opts after this point!
    nodeMapGetDelta(d, /** @type {any} */ (this), renderAttrs, renderer, deep, modified, itemsToRender, optsAll, optsAll)
    if (renderChildren) {
      /**
       * @type {delta.Formats}
       */
      let currentFormats = {} // saves all current formats for insert
      /**
       * P13: the open paired mark operations, by mark.
       * @type {Map<string,any>}
       */
      const pairedFormats = new Map()
      let usingCurrentFormats = false
      /**
       * @type {delta.Formats}
       */
      let changedFormats = {} // saves changed formats for retain
      let usingChangedFormats = false
      /**
       * Logic for format attribution
       * Everything that comes after a format is formatted by the user that created it.
       * Two exceptions:
       * - the user resets formatting to the previously known formatting that is not attributed
       * - the user deletes a format and hence restores the previously known formatting
       *   that is not attributed.
       * @type {delta.Formats}
       */
      const previousUnattributedFormats = {} // contains previously known unattributed formatting
      /**
       * @type {delta.Formats}
       */
      const previousFormats = {} // The value before changes
      /**
       * Per-key provenance of `currentFormats`: `true` iff the marker currently governing the key
       * opened a *pending attributed* range (the attributor-push branch below). Consulted only at
       * deleted markers in change renders (`isDeletedFormatClear`) to distinguish a re-exposed
       * committed enclosing value (must clear the stale attribution from the cache) from a
       * re-exposed pending suggested value (must preserve it — the re-bolding case).
       * @type {{ [key: string]: boolean }}
       */
      const currentFormatsAttributed = {}
      /**
       * Attribution argument for a change-render retain whose content lost its *own* attribution.
       * `null` clears everything — correct in an attribution-free context — but inside an ambient
       * format attribution (installed via `useAttribution` by a surrounding format marker) the
       * fresh render still stamps that ambient format on this content. An object argument merges
       * over the ambient context (lib0 `combineInstr`), so emit per-key removals instead: they
       * clear only the op's own insert/delete attribution while re-asserting the ambient format.
       */
      const clearedOwnAttribution = () => d.usedAttribution == null ? null : /** @type {any} */ ({ insert: null, insertAt: null, delete: null, deleteAt: null })
      /**
       * Format keys touched by a *rendered* format marker during an attributing change render. A
       * merely retained attributed marker normally must not emit ops — but when a rendered
       * same-key marker preceded it in this walk, the change is what made the retained boundary
       * reset-to-previous (e.g. a base-doc format arriving under a same-key format suggestion),
       * and the spans it governs must drop their now-stale attribution from the cache. Per-key
       * tracking is required (a plain "any format rendered" flag would over-clear other keys),
       * but the set is only ever consulted at format markers — never per character — and stays
       * `null` on all hot paths: full renders, base-renderer renders, and change renders without
       * format markers never allocate it.
       * @type {Set<string>?}
       */
      let renderedFormatKeys = null
      /**
       * Renderer output for a single item — a renderer may split an item into multiple
       * attributed pieces.
       * @type {Array<AttributedContent<any>>}
       */
      const cs = []
      /**
       * Reusable trivial piece for the `readItemPieces` current-state walk —
       * `cs` is drained per item, so a single allocation (captured lazily
       * from the first emitted piece) serves the whole render.
       * @type {AttributedContent<any>?}
       */
      let csScratch = null
      /**
       * Process one piece of (possibly attributed) content — the shared op-emission and format
       * state machine. The renderer path feeds it every piece produced by `readContent`; the
       * generic path feeds it `ContentFormat` markers only (the state machine must see every
       * marker, attributed or not — a plain marker can e.g. close a formerly attributed range)
       * and emits ops for plain content directly.
       * @param {AttributedContent<any>} c
       */
      const processContent = c => {
        // render (attributed) content even if it was deleted
        const renderContent = c.render && (!c.deleted || c.attrs != null)
        // content that was just deleted. It is not rendered as an insertion, because it doesn't
        // have any formats.
        const renderDelete = c.render && c.deleted
        // existing content that should be retained, only adding changed formats
        const retainContent = !c.render && (!c.deleted || c.attrs != null)
        const attribution = (renderContent || c.content.constructor === ContentFormat) ? createAttributionFromAttributionItems(c.attrs, c.deleted) : undefined
        switch (c.content.constructor) {
          case ContentDeleted: {
            // fresh (mode 3) content renders as nothing here: the consuming state never saw it,
            // and gc'd content cannot render as an insert — a delete op would misapply
            if (renderDelete && !c.fresh) d.delete(c.content.getLength())
            break
          }
          case ContentString:
            if (renderContent) {
              if (c.deleted ? (retainDeletes && !c.fresh) : retainInserts) {
                // a retain expresses the format *diff* against existing (cached) content, so use
                // `changedFormats`: a format removed this change (e.g. its marker was deleted)
                // is present there as a `null` clear, whereas `currentFormats` (absolute) can
                // only re-assert present formats and would silently keep a stale one.
                // (`c.fresh` content is exempt from `retainDeletes`: it was inserted *and*
                // deleted by this very change, so the consuming state holds nothing to retain —
                // it renders as an insert below, carrying its attribution.)
                d.useFormats(changedFormats)
                usingChangedFormats = true
                // change render: a retained item with no attribution means its attribution was
                // removed → emit a clear rather than `{}` (skip). Present attribution merges.
                d.retain(/** @type {ContentString} */ (c.content).str.length, undefined, attribution ?? clearedOwnAttribution())
              } else {
                d.useFormats(currentFormats)
                usingCurrentFormats = true
                d.insert(/** @type {ContentString} */ (c.content).str, undefined, attribution)
              }
            } else if (renderDelete) {
              d.delete(c.content.getLength())
            } else if (retainContent) {
              d.useFormats(changedFormats)
              usingChangedFormats = true
              d.retain(c.content.getLength())
            }
            break
          case ContentEmbed:
          case ContentAny:
          case ContentJSON:
          case ContentType:
          case ContentBinary:
          case ContentDoc:
            if (renderContent) {
              if (c.deleted ? (retainDeletes && !c.fresh) : retainInserts) {
                // a retain expresses the format *diff* → use `changedFormats` (see ContentString)
                d.useFormats(changedFormats)
                usingChangedFormats = true
                if (c.deleted && c.content.constructor === ContentType) {
                  // @todo use current transaction instead
                  d.modify(/** @type {any} */ (c.content).type.toDelta(optsAll), undefined, attribution ?? null)
                } else if (c.content.constructor === ContentType && modified?.has(/** @type {ContentType} */ (c.content).type)) {
                  // a de/re-attributed node the renderer still claims (e.g. a partial accept):
                  // merge/clear its own attribution and descend so the nested walk heals exactly
                  // the child ids in `itemsToRender` — other children keep their attribution
                  d.modify(/** @type {any} */ (c.content).type.toDelta(optsAll), undefined, attribution ?? clearedOwnAttribution())
                } else {
                  d.retain(c.content.getLength(), undefined, attribution ?? clearedOwnAttribution())
                }
              } else if (deep && c.content.constructor === ContentType) {
                d.useFormats(currentFormats)
                usingCurrentFormats = true
                d.insert([/** @type {any} */(c.content).type.toDelta(optsAll)], undefined, attribution)
              } else {
                d.useFormats(currentFormats)
                usingCurrentFormats = true
                d.insert(c.content.getContent(), undefined, attribution)
              }
            } else if (renderDelete) {
              d.delete(1)
            } else if (retainContent) {
              if (c.content.constructor === ContentType && modified?.has(/** @type {ContentType} */ (c.content).type)) {
                // @todo use current transaction instead
                d.modify(/** @type {any} */ (c.content).type.toDelta(optsAll))
              } else {
                d.useFormats(changedFormats)
                usingChangedFormats = true
                d.retain(1)
              }
            }
            break
          case ContentFormat: {
            let { key, value } = /** @type {ContentFormat} */ (c.content)
            // P13: a live paired mark item renders as its mark's winning value there
            if (pairedRole(/** @type {ContentFormat} */ (c.content)) >= 0) {
              if (c.deleted) break
              foldPaired(pairedFormats, /** @type {ContentFormat} */ (c.content))
              key = key.slice(1)
              value = formatValue(pairedFormats.get(key) ?? null)
            }
            const currFormatVal = currentFormats[key] ?? null
            if (attribution != null && (c.deleted || !object.hasProperty(previousUnattributedFormats, key))) {
              previousUnattributedFormats[key] = c.deleted ? value : currFormatVal
            }
            // @todo write a function "updateCurrentFormats" and "updateChangedFormats"
            // # Update Formats
            if (renderContent || renderDelete) {
              // create fresh references
              if (usingCurrentFormats) {
                currentFormats = object.assign({}, currentFormats)
                usingCurrentFormats = false
              }
              if (usingChangedFormats) {
                usingChangedFormats = false
                changedFormats = object.assign({}, changedFormats)
              }
            }
            if (renderContent || renderDelete) {
              if (itemsToRender !== null && renderer !== null) {
                // only attributing change renders consult this (see the reset branch below)
                if (renderedFormatKeys === null) renderedFormatKeys = new Set()
                renderedFormatKeys.add(key)
              }
              // `previousFormats` tracks the value governing the current walk position in the
              // *consuming cache state*, so the retain diff below stays a plain cache → new-state
              // comparison. Contributors: markers deleted by this change in event renders (their
              // value governed the cache until now; heal-rendered deletes are PRE-deleted markers
              // whose removal the cache already rendered — they must not contribute), alive
              // markers re-rendered by heal renders (`retainInserts` — their value was in the
              // cache), and retained alive markers (the branch below). A gated update here is not
              // enough: a marker deleted by the change whose value coincides with the walk's
              // current value would silently drop out of the cache-reference tracking, and a later
              // marker would be misread as a restore-to-previous, swallowing a needed format diff.
              if (c.deleted) {
                if (itemsToRender !== null && !retainInserts) previousFormats[key] = value
              } else { // !c.deleted
                if (retainInserts) previousFormats[key] = value
                if (value == null) {
                  delete currentFormats[key]
                } else {
                  currentFormats[key] = value
                }
                currentFormatsAttributed[key] = false
              }
              // the retain diff for following spans is exactly cache (previousFormats) → new
              // state (currentFormats), recomputed per key at every rendered marker
              if (equalFormats(currentFormats[key] ?? null, previousFormats[key] ?? null)) {
                delete changedFormats[key]
              } else {
                changedFormats[key] = currentFormats[key] ?? null
              }
            } else if (retainContent && !c.deleted) {
              // fresh reference to currentFormats only
              if (usingCurrentFormats) {
                currentFormats = object.assign({}, currentFormats)
                usingCurrentFormats = false
              }
              if (usingChangedFormats && changedFormats[key] !== undefined) {
                usingChangedFormats = false
                changedFormats = object.assign({}, changedFormats)
              }
              if (value == null) {
                delete currentFormats[key]
              } else {
                currentFormats[key] = value
              }
              currentFormatsAttributed[key] = false
              delete changedFormats[key]
              previousFormats[key] = value
            }
            // # Update Attributions
            // A format marker deleted in a change render under an *attributing* renderer nets to no
            // attribution (its insert+delete suggestion cancels → `attribution == null`), yet it ends
            // the attributed range it opened: the following retained content must drop the stale
            // `{ format: { [key]: [] } }` the marker's insertion wrote to the cache. Emit an explicit
            // `null` leaf for the key (a context-wide `useAttribution(null)` cannot carry a per-key
            // clear). Conditions: only an attributing render (`renderer !== null`; without a
            // renderer there are no attributions to clear), and only when the deletion reverts to
            // a value that is not itself governed by a pending suggestion: either no value at all
            // (`currFormatVal == null`) or a *committed* enclosing value (provenance tracked in
            // `currentFormatsAttributed` — e.g. an accept/reject deleting a marker re-exposes the
            // enclosing committed `bold:true`, and the span's stale suggested-format attribution
            // must be cleared). If it reverts to a still-pending *attributed* value (deleting a
            // `bold:null` marker re-exposes an enclosing attributed `bold:true`, as when
            // re-bolding), the attribution is preserved. Suppressed entirely while an attributed
            // same-key range is open (`previousUnattributedFormats` has the key): there the fresh
            // render skips this marker — its governance belongs to the still-open attributed
            // range, whose ambient context re-stamps the correct attribution on the following
            // retains — mirroring the identical guard on `isAcceptedFormatClear`.
            const isDeletedFormatClear = attribution == null && renderer !== null && renderDelete && c.deleted && itemsToRender != null && (currFormatVal == null || currentFormatsAttributed[key] !== true) && !equalFormats(value, currFormatVal) && !object.hasProperty(previousUnattributedFormats, key)
            // The alive-marker analogue of `isDeletedFormatClear`: a format marker whose
            // *attribution* was removed while the marker survives — its suggestion was accepted
            // (the marker's id arrives via the renderer's `'change'` event). The original change
            // render stamped `{ format: { [key]: [] } }` on the spans this marker governs, so the
            // heal render must emit a per-key `null` leaf over those spans (a blunt
            // `attribution: null` would also wipe unrelated attributions such as a co-located
            // `{ delete: [] }`). Gated on `retainInserts` — the diff-against-existing-content
            // mode used by attribution-heal renders: in a plain event render an unattributed
            // alive marker is just new unattributed content and must not emit spurious clears.
            // When the key is tracked as an open attributed range (`previousUnattributedFormats`)
            // the accepted marker instead defers to the regular branch chain below, which mirrors
            // the fresh render exactly: mid-range it *keeps* the ambient attribution (relative to
            // the base doc the span's format is still a suggested change), and at the range end
            // (`sameAsPreviousAttributions`) it closes the attribution context.
            const isAcceptedFormatClear = attribution == null && renderer !== null && renderContent && !c.deleted && itemsToRender != null && retainInserts && !object.hasProperty(previousUnattributedFormats, key)
            if (attribution != null || isDeletedFormatClear || isAcceptedFormatClear || object.hasProperty(previousUnattributedFormats, key)) {
              /**
                 * @type {Attribution}
                 */
              const formattingAttribution = object.assign({}, d.usedAttribution)
              const changedAttributedFormats = /** @type {{ [key: string]: Array<any>|null }} */ (formattingAttribution.format = object.assign({}, formattingAttribution.format ?? {}))
              const sameAsPreviousAttributions = equalFormats(previousUnattributedFormats[key], currentFormats[key] ?? null)
              // An *unattributed* marker rendered by this change (e.g. a fresh base-doc marker)
              // that closes an open attributed same-key range by restoring the previous
              // unattributed value: the spans it governs must drop their stale attribution from
              // the cache, exactly like the attributed range-end below. Mirrors the fresh render
              // precisely: there, the reset only closes the ambient attribution when removing the
              // key leaves the format context empty (the `useAttribution(null)` case below) —
              // while another attributed key holds the context open, the removal happens on a
              // copy that is never installed, so the key survives on the following spans and the
              // change render must NOT clear it.
              const isRangeEndClear = attribution == null && sameAsPreviousAttributions && renderContent && !c.deleted && itemsToRender != null && renderer !== null && object.hasProperty(previousUnattributedFormats, key) && object.every(changedAttributedFormats, (_v, k) => k === key)
              if (isDeletedFormatClear || (isAcceptedFormatClear && changedAttributedFormats[key] == null)) {
                // uniformly emit the per-key clear — also for a marker that *ends* a formerly
                // attributed range: the attributed render emits a trailing per-key `null` past
                // the closing marker as well (see the `attribution != null` case below), so the
                // heal render mirrors that exact span; where the cache holds no stale
                // attribution the clear merges as a no-op.
                changedAttributedFormats[key] = null
                delete previousUnattributedFormats[key]
              } else if (isAcceptedFormatClear) {
                // accepted marker inside a *still-attributed* (pending) range for the same key —
                // the ambient context holds an attributor list, not a clear. Relative to the base
                // doc the effective format of this span is still a suggested change, so the fresh
                // render keeps attributing it (the `skip` case below): keep the ambient
                // attribution rather than clearing it.
              } else if (attribution == null && !sameAsPreviousAttributions) {
                // skip
              } else if (attribution == null || sameAsPreviousAttributions) {
                // an unattributed format was found or an attributed format
                // was found that resets to the previous status. When this format item is
                // itself rendered this transaction (`renderContent || renderDelete`) in a change/diff
                // render (`itemsToRender != null`), it is the END of an attributed format range:
                // emit an explicit clear (a `null` leaf) so the retained content drops any stale
                // `{ format: { [key]: [] } }` from the maintained `delta` cache — a bare context-skip
                // (`delete`) would leave it in place. The same applies to a *retained* attributed
                // boundary when a rendered same-key marker preceded it in this walk
                // (`renderedFormatKeys`): the boundary only resets-to-previous *because of* the
                // rendered change (e.g. a base-doc format arriving under an equal same-key format
                // suggestion — which marker comes first depends on client ids), so the spans it
                // governs must drop their now-stale attribution too. For a merely-retained boundary
                // with no rendered same-key marker, or a full insert render (removal is already
                // modeled as absence in `currentFormats`), just drop the key: a change render must
                // not emit ops for unchanged ranges, and inserts must stay free of a spurious
                // `{ format: { [key]: null } }`.
                // `c.fresh`: a marker inserted (and possibly auto-deleted) by this very change —
                // e.g. a base-doc format clear arriving inside a suggestion-deleted paragraph —
                // stays on the retained path (mode 0, the fresh-format exemption), but when it
                // resets-to-previous it is the range END of the attributed run in the new state
                // and must clear the stale attribution from the cache like a rendered marker.
                if (isRangeEndClear || (attribution != null && itemsToRender != null && (renderContent || renderDelete || c.fresh || renderedFormatKeys?.has(key) === true))) {
                  changedAttributedFormats[key] = null
                } else {
                  delete changedAttributedFormats[key]
                  // pending per-key clears force this copy to install (the all-null disjunct
                  // below); installing after silently dropping this key would close its
                  // governance without the clear the fresh render's context-close implies,
                  // leaving a stale `{ format: { [key]: [] } }` on the following retained
                  // spans — re-add the key as an explicit clear. Inert outside attributing
                  // change renders: null leaves cannot exist in fresh contexts.
                  if (itemsToRender != null && !object.isEmpty(changedAttributedFormats) && object.every(changedAttributedFormats, v => v == null)) {
                    changedAttributedFormats[key] = null
                  }
                }
                delete previousUnattributedFormats[key]
              } else {
                // an attributed marker opens pending governance for the key — a deleted attributed
                // marker never writes `currentFormats`, hence the alive gate; an attributed marker
                // that value-equals the previous unattributed value takes the reset branch above
                // and correctly yields committed governance
                if (!c.deleted) currentFormatsAttributed[key] = true
                const by = changedAttributedFormats[key] = (changedAttributedFormats[key]?.slice() ?? [])
                by.push(...((c.deleted ? attribution.delete : attribution.insert) ?? []))
                const attributedAt = (c.deleted ? attribution.deleteAt : attribution.insertAt)
                if (attributedAt) formattingAttribution.formatAt = attributedAt
              }
              if (object.isEmpty(changedAttributedFormats)) {
                d.useAttribution(null)
              } else if (attribution != null || isDeletedFormatClear || isAcceptedFormatClear || isRangeEndClear || (itemsToRender != null && object.every(changedAttributedFormats, v => v == null))) {
                // the last disjunct: a change-render copy whose remaining leaves are ALL per-key
                // null clears is the analogue of the fresh render's empty copy (fresh contexts
                // never contain null leaves — they are produced only by the change-render-only
                // predicates above) — install it, so an unattributed close marker's key deletion
                // closes the governance while the pending cache clears still propagate; discarding
                // it would re-merge the stale key into the cache from the surviving ambient
                const attributedAt = (c.deleted ? attribution?.deleteAt : attribution?.insertAt)
                if (attributedAt != null) formattingAttribution.formatAt = attributedAt
                d.useAttribution(formattingAttribution)
              }
            }
            break
          }
        }
      }
      for (let item = this._start; item !== null; item = item.right) {
        const content = item.content
        if (itemsToRender === null && !retainInserts) {
          // Current-state render — the same physical-sequence interpretation
          // `RangeCursor`'s bounded reads consume (UPSTREAM.md P5):
          // `readItemPieces` produces the item's AttributedContent pieces
          // (renderer-claimed → readContent mode 1; ContentFormat → one
          // marker piece; tombstoned → nothing; live → whole item) and the
          // shared state machine folds formats + emits ops for them —
          // op-identical to the inlined fast-path dispatch it replaces.
          cs.length = 0
          readItemPieces(cs, renderer, item, csScratch)
          if (csScratch === null) csScratch = cs[0] ?? null
          for (let i = 0; i < cs.length; i++) {
            processContent(cs[i])
          }
          continue
        }
        if (renderer === null || !renderer.hasItem(item)) {
          // generic fast path: content the renderer doesn't claim renders as-is — no attribution
          // lookups, no AttributedContent wrappers and, in the common full-coverage case, no
          // content slicing
          if (content.constructor === ContentFormat) {
            // format markers always flow through the shared state machine
            processContent(new AttributedContent(content, item.id.clock, item.deleted, null,
              itemsToRender == null ? 1 : (itemsToRender.has(item.id.client, item.id.clock) ? 2 : 0)))
          } else if (item.deleted) {
            // plain deleted content is invisible; in a change render, the ranges deleted by this
            // change emit `delete` ops — position-only, the content itself is not needed
            if (itemsToRender !== null && itemsToRender.intersects(item.id.client, item.id.clock, item.length)) {
              const rslice = itemsToRender.slice(item.id.client, item.id.clock, item.length)
              for (let ir = 0; ir < rslice.length; ir++) {
                const idrange = rslice[ir]
                if (idrange.exists) {
                  // mirror the piece-wise op sizes of the renderer path: string-ish content
                  // deletes by length, other content deletes one element per piece
                  d.delete((content.constructor === ContentString || content.constructor === ContentDeleted) ? idrange.len : 1)
                }
              }
            }
          } else if (itemsToRender == null) {
            if (retainInserts) {
              // attribution-overlay render (e.g. `toDelta({ renderer, retainInserts: true })`):
              // existing content is retained, clearing any formerly cached own-attribution
              d.useFormats(changedFormats)
              usingChangedFormats = true
              d.retain(content.getLength(), undefined, clearedOwnAttribution())
            } else {
              // full render: a plain insert of the whole item
              d.useFormats(currentFormats)
              usingCurrentFormats = true
              if (deep && content.constructor === ContentType) {
                d.insert([/** @type {any} */(content).type.toDelta(optsAll)])
              } else if (content.constructor === ContentString) {
                d.insert(/** @type {ContentString} */ (content).str)
              } else {
                d.insert(content.getContent())
              }
            }
          } else {
            // change render on alive plain content: inserted ranges become inserts, everything
            // else retains (position-only). `retainInserts` (attribution-heal renders) retains
            // previously inserted content while clearing its former attribution.
            const rslice = itemsToRender.slice(item.id.client, item.id.clock, item.length)
            let itemContent = rslice.length > 1 ? content.copy() : content
            for (let ir = 0; ir < rslice.length; ir++) {
              const idrange = rslice[ir]
              const c = itemContent
              if (ir !== rslice.length - 1) {
                itemContent = itemContent.splice(idrange.len)
              }
              if (!idrange.exists) {
                if (content.constructor === ContentType && modified?.has(/** @type {ContentType} */ (content).type)) {
                  // @todo use current transaction instead
                  d.modify(/** @type {ContentType} */ (content).type.toDelta(optsAll))
                } else {
                  d.useFormats(changedFormats)
                  usingChangedFormats = true
                  // mirror the piece-wise op sizes of the renderer path (see the delete branch)
                  d.retain(content.constructor === ContentString ? idrange.len : 1)
                }
              } else if (retainInserts) {
                if (content.constructor === ContentType && modified?.has(/** @type {ContentType} */ (content).type)) {
                  // a de/re-attributed node (e.g. its insert-suggestion was accepted): clear its
                  // own attribution and descend so the nested walk heals exactly the child ids
                  // present in `itemsToRender` — children outside the change set keep their
                  // attribution (id-scoped, never a blanket subtree clear)
                  d.modify(/** @type {ContentType} */ (content).type.toDelta(optsAll), undefined, clearedOwnAttribution())
                } else {
                  d.useFormats(changedFormats)
                  usingChangedFormats = true
                  d.retain(idrange.len, undefined, clearedOwnAttribution())
                }
              } else {
                d.useFormats(currentFormats)
                usingCurrentFormats = true
                if (deep && content.constructor === ContentType) {
                  d.insert([/** @type {any} */(content).type.toDelta(optsAll)])
                } else if (content.constructor === ContentString) {
                  d.insert(/** @type {ContentString} */ (c).str)
                } else {
                  d.insert(c.getContent())
                }
              }
            }
          }
        } else {
          cs.length = 0
          if (itemsToRender != null) {
            const rslice = itemsToRender.slice(item.id.client, item.id.clock, item.length)
            // fresh content deleted by the very change being rendered gets mode 3: it renders as
            // an insert even under `retainDeletes` — the consuming state (e.g. the maintained
            // `delta` cache) has never seen it, so there is nothing to retain. Freshness is
            // decided per id range, NOT per item: structs merge across cleanups (e.g. a queued
            // transaction's render runs after an earlier finally-block merged its fresh item into
            // an older neighbor), so one item can span fresh and pre-existing ids. ContentFormat
            // markers are exempt and keep mode 0 (the retained-marker path; they never merge, so
            // the whole-item check is exact): the format state machine treats fresh-deleted
            // markers exactly like before this change rendered.
            const checkFresh = item.deleted && insertedItems !== null && content.constructor !== ContentFormat
            const freshFormat = item.deleted && insertedItems !== null && content.constructor === ContentFormat && insertedItems.hasId(item.id)
            let itemContent = rslice.length > 1 ? content.copy() : content
            for (let ir = 0; ir < rslice.length; ir++) {
              const idrange = rslice[ir]
              let c = itemContent
              if (ir !== rslice.length - 1) {
                itemContent = itemContent.splice(idrange.len)
              }
              if (!idrange.exists || !checkFresh) {
                renderer.readContent(cs, item.id.client, idrange.clock, item.deleted, c,
                  idrange.exists ? (freshFormat ? 0 : 2) : 0)
              } else {
                // an exists range may itself straddle fresh and pre-existing ids (ranges from
                // different sources merge in `itemsToRender`) — split it against `insertedItems`
                const fslice = insertedItems.slice(item.id.client, idrange.clock, idrange.len)
                let subContent = fslice.length > 1 ? c.copy() : c
                for (let fi = 0; fi < fslice.length; fi++) {
                  const frange = fslice[fi]
                  c = subContent
                  if (fi !== fslice.length - 1) {
                    subContent = subContent.splice(frange.len)
                  }
                  renderer.readContent(cs, item.id.client, frange.clock, item.deleted, c, frange.exists ? 3 : 2)
                }
              }
            }
            if (freshFormat) {
              // fresh format markers stay on the retained path (mode 0, see `checkFresh`), but
              // the format state machine must still see their freshness: a fresh clear marker
              // that resets-to-previous ends an attributed range and must emit the per-key
              // attribution clear (`cs` is reset per item; a freshFormat item is a single
              // len-1 ContentFormat, so this marks exactly its pieces)
              for (let i = 0; i < cs.length; i++) { cs[i].fresh = true }
            }
          } else {
            renderer.readContent(cs, item.id.client, item.id.clock, item.deleted, content, 1)
          }
          for (let i = 0; i < cs.length; i++) {
            processContent(cs[i])
          }
        }
      }
    }
    return /** @type {any} */ (d.done(false))
  }

  /**
   * Render the difference to another ydoc (which can be empty) and highlight the differences with
   * attributions.
   *
   * @param {Object} [opts]
   * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
   * @return {delta.Delta<DConf>}
   */
  toDeltaDeep (opts = {}) {
    return /** @type {any} */ (this.toDelta({ ...opts, deep: true }))
  }

  /**
   * Apply a {@link Delta} on this shared type.
   *
   * @param {delta.DeltaAny} d The changes to apply on this element.
   * @param {any} [origin] Origin of the transaction that applies this delta (stored on
   * `transaction.origin` and forwarded verbatim on the emitted `'delta'` event, so listeners can
   * recognize — and skip — changes they produced themselves; see the lib0 `RDT` spec). Defaults to `null`.
   * @param {Object} [opts]
   * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
   * @return {delta.DeltaBuilder<any>?} The lib0 `RDT` "fix" of this apply — a change measured against the
   * caller's expected state (`old.apply(d)`) that transforms it into the actual state, or `null`
   * when `d` applied cleanly. A fix is produced when `d` (or a nested `modify`/`modifyAttr`)
   * addresses a *deleted but rendered* node (e.g. a suggestion-deleted paragraph under a
   * DiffRenderer): that part of the change is not applied to the document, and its inverse
   * (`lib0-v14/delta` `inverse` against the node's rendered state) is returned — the change is
   * immediately reverted.
   *
   * @public
   */
  applyDelta (d, origin = null, { renderer = this._renderer } = {}) {
    if (d.isEmpty()) return null
    if (this.doc == null) {
      (this._prelim || (this._prelim = /** @type {any} */ (delta.create()))).apply(d)
      return null
    }
    const titem = this._item
    if (titem !== null && titem.deleted) {
      if (rendererContentLength(renderer, titem) > 0) {
        // deleted, but still rendered (e.g. a suggestion-deleted node): apply nothing — revert the
        // whole change and return its inverse (against the rendered state the caller addressed)
        const inv = delta.inverse(d, /** @type {any} */ (this.toDeltaDeep({ renderer })))
        return inv.isEmpty() ? null : /** @type {any} */ (inv)
      }
      return null // invisible deleted type: the caller's view shows nothing here — silently drop
    }
    // @todo this was moved here from ytext. Make this more generic
    return transact(this.doc, transaction => {
      /**
       * The accumulated fix. Its coordinates live in the caller's *expected* space, so they are
       * tracked from `d`'s own ops (`expectedIndex`) — not `currPos.index`, which also counts
       * content that a delete over attributed-deleted ranges leaves rendered.
       *
       * @type {delta.DeltaBuilder<any>?}
       */
      let fix = null
      let fixLen = 0
      let expectedIndex = 0
      /**
       * @param {delta.DeltaAny?} childFix
       * @param {{ [k:string]: any }} [invFormat]
       */
      const appendModifyFix = (childFix, invFormat) => {
        const f = fix ?? (fix = /** @type {any} */ (delta.create()))
        expectedIndex > fixLen && f.retain(expectedIndex - fixLen)
        f.modify(/** @type {any} */ (childFix ?? delta.create().done(false)), invFormat)
        fixLen = expectedIndex + 1
      }
      const currPos = new ItemTextListPosition(null, this._start, 0, new Map(), renderer)
      /**
       * Seed the cursor from a format-aware search marker when the first op
       * retains a distant position. When a marker at-or-left of the target
       * carries a formats snapshot the cursor can start there directly, and
       * the leading retain is shortened by the seeded index — the only op
       * needing adjustment, since every later op is position-relative anyway.
       * Seeding is restricted to `renderer === null`, where
       * `rendererContentLength` counts countable/non-deleted length — exactly
       * the space `marker.index` records.
       */
      let firstRetainAdjust = 0
      const op0 = d.children[Symbol.iterator]().next().value
      if (
        // `op0.format == null && op0.attribution == null`: only a *pure*
        // positioning retain may be shortened (lib0's `_isPlainRetain`
        // convention) — a retain carrying formats/attribution applies them
        // across its whole traversed range, so skipping its head would
        // silently drop that work for `[0, seededIndex)`.
        renderer === null && op0 !== undefined && delta.$retainOp.check(op0) && op0.retain > 0 &&
        op0.format == null && op0.attribution == null && this._searchMarker !== null
      ) {
        // Best format-aware checkpoint at-or-left of the retained position.
        // A marker anchored *right* of the target can still seed if the gap is
        // crossed by stepping left over countable/non-deleted items only —
        // format state doesn't change across pure content (a format marker or
        // tombstone in the gap stops the walk and rejects the marker). Anchor
        // linkage is verified because records can outlive their items.
        let best = null
        let bestP = null
        let bestIndex = 0
        for (let i = 0; i < this._searchMarker.length; i++) {
          const m = this._searchMarker[i]
          if (m.formats === null || m.index <= 0) continue
          // step left over pure content until at-or-below the target
          let p = m.p
          let idx = m.index
          let steps = 0
          while (idx > op0.retain && p.left !== null && !p.left.deleted && p.left.countable && steps < 64) {
            p = p.left
            idx -= p.length
            steps++
          }
          if (
            idx <= op0.retain && (best === null || idx > bestIndex) &&
            (p.left === null ? this._start === p : p.left.right === p) &&
            (p.right === null || p.right.left === p) &&
            // `p` must be the *first* item at its index: upstream's walk
            // stops on the first unprocessed item at the target — including
            // format markers and deleted items sharing the index — so an
            // anchor after same-index non-countable/deleted items would seed
            // a different list position (correct state, wrong item order).
            (p.left === null || (!p.left.deleted && p.left.countable))
          ) {
            best = m
            bestP = p
            bestIndex = idx
          }
        }
        if (best !== null) {
          currPos.left = (/** @type {Item} */ (bestP)).left
          currPos.right = bestP
          currPos.index = bestIndex
          currPos.currentFormats = map.copy(/** @type {Map<string,any>} */ (best.formats))
          firstRetainAdjust = bestIndex
        }
      }
      for (const op of d.children) {
        if (delta.$textOp.check(op)) {
          insertContent(transaction, /** @type {any} */ (this), currPos, new ContentString(op.insert), op.format || {})
          expectedIndex += op.length
        } else if (delta.$insertOp.check(op)) {
          insertContentHelper(transaction, this, currPos, op.insert, op.format || {})
          expectedIndex += op.length
        } else if (delta.$retainOp.check(op)) {
          currPos.formatText(transaction, /** @type {any} */ (this), op.retain - firstRetainAdjust, op.format || {})
          firstRetainAdjust = 0
          expectedIndex += op.length
          // quiescent point at a positioning boundary — plant a marker so a
          // subsequent delta targeting this position can seed its cursor
          if (renderer === null) plantMarker(/** @type {any} */ (this), currPos)
        } else if (delta.$deleteOp.check(op)) {
          deleteText(transaction, currPos, op.delete)
        } else if (delta.$modifyOp.check(op)) {
          let item = currPos.right
          while (item !== null && rendererContentLength(renderer, item) === 0) { item = item.right }
          if (item == null || item.content.constructor !== ContentType) { error.unexpectedCase() }
          if (item.deleted) {
            // deleted but rendered: revert instead of apply. Advance the cursor first (populating
            // `currentFormats` with any markers up to the node) without applying `op.format`, then
            // recurse — the child's deleted-guard applies nothing and returns the inverse.
            currPos.formatText(transaction, /** @type {any} */ (this), 1, {})
            /** @type {{ [k:string]: any }|undefined} */
            let invFormat
            for (const k in op.format) {
              (invFormat ?? (invFormat = {}))[k] = currPos.currentFormats.get(k) ?? null
            }
            const childFix = /** @type {ContentType} */ (item.content).type.applyDelta(op.value, origin, { renderer })
            if (childFix !== null || invFormat !== undefined) {
              appendModifyFix(childFix, invFormat)
            }
          } else {
            const childFix = /** @type {ContentType} */ (item.content).type.applyDelta(op.value, origin, { renderer })
            currPos.formatText(transaction, /** @type {any} */ (this), 1, op.format || {})
            if (childFix !== null) {
              appendModifyFix(childFix)
            }
          }
          expectedIndex += 1
        } else {
          error.unexpectedCase()
        }
      }
      // Leave a format-aware marker at the deepest position this delta
      // reached — subsequent deltas targeting nearby positions seed their
      // cursor from it.
      if (renderer === null) plantMarker(/** @type {any} */ (this), currPos)
      for (const op of d.attrs) {
        if (delta.$setAttrOp.check(op)) {
          nodeMapSet(transaction, /** @type {any} */ (this), /** @type {any} */ (op.key), op.value)
        } else if (delta.$deleteAttrOp.check(op)) {
          nodeMapDelete(transaction, /** @type {any} */ (this), /** @type {any} */ (op.key))
        } else {
          // modifyAttr — locate the target renderer-aware: a deleted map value may still be rendered
          const mapItem = this._map.get(/** @type {any} */ (op.key))
          const sub = mapItem === undefined
            ? undefined
            : (mapItem.deleted
                ? (mapItem.content.constructor === ContentType && rendererContentLength(renderer, mapItem) > 0
                    ? /** @type {ContentType} */ (mapItem.content).type
                    : undefined)
                : mapItem.content.getContent()[mapItem.length - 1])
          if (!(sub instanceof YNode)) {
            error.unexpectedCase()
          }
          const subFix = sub.applyDelta(op.value, origin, { renderer })
          if (subFix !== null) {
            const f = fix ?? (fix = /** @type {any} */ (delta.create()))
            f.modifyAttr(/** @type {any} */ (op.key), /** @type {any} */ (subFix))
          }
        }
      }
      return fix !== null && !(/** @type {delta.DeltaBuilder<any>} */ (fix).done(false).isEmpty()) ? fix : null
    }, origin)
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YNode<DConf>}
   */
  clone () {
    const cpy = this._copy()
    cpy.applyDelta(this.toDeltaDeep())
    return cpy
  }

  /**
   * Removes all elements from this YMap.
   */
  clearAttrs () {
    const d = delta.create()
    this.forEachAttr((_, key) => {
      d.deleteAttr(/** @type {any} */ (key))
    })
    this.applyDelta(d)
  }

  /**
   * Removes an attribute from this YXmlElement.
   *
   * @param {string} attributeName The attribute name that is to be removed.
   *
   * @public
   */
  deleteAttr (attributeName) {
    this.applyDelta(delta.create().deleteAttr(attributeName).done())
  }

  /**
   * Sets or updates an attribute.
   *
   * @template {Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol>} KEY
   * @template {delta.DeltaConfGetAttrs<DConf>[KEY]} VAL
   *
   * @param {KEY} attributeName The attribute name that is to be set.
   * @param {VAL} attributeValue The attribute value that is to be set.
   * @return {VAL}
   *
   * @public
   */
  setAttr (attributeName, attributeValue) {
    this.applyDelta(delta.create().setAttr(attributeName, attributeValue).done())
    return attributeValue
  }

  /**
   * Returns an attribute value that belongs to the attribute name.
   *
   * @template {Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol|number>} KEY
   * @param {KEY} attributeName The attribute name that identifies the queried value.
   * @return {delta.DeltaConfGetAttrs<DConf>[KEY]|undefined} The queried attribute value.
   * @public
   */
  getAttr (attributeName) {
    return /** @type {any} */ (nodeMapGet(this, attributeName))
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
    return /** @type {any} */ (nodeMapHas(this, attributeName))
  }

  /**
   * Returns all attribute name/value pairs in a JSON Object.
   *
   * @return {{ [Key in Extract<keyof delta.DeltaConfGetAttrs<DConf>,string>]?: delta.DeltaConfGetAttrs<DConf>[Key]}} A JSON Object that describes the attributes.
   *
   * @public
   */
  getAttrs () {
    return /** @type {any} */ (nodeMapGetAll(this))
  }

  /**
   * Inserts new content at an index.
   *
   * Important: This function expects an array of content. Not just a content
   * object. The reason for this "weirdness" is that inserting several elements
   * is very efficient when it is done as a single operation.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  yarray.insert(0, ['a'])
   *  // Insert numbers 1, 2 at position 1
   *  yarray.insert(1, [1, 2])
   *
   * @param {number} index The index to insert content at.
   * @param {Array<delta.DeltaConfGetChildren<DConf>>|delta.DeltaConfGetText<DConf>} content Array of content to append.
   * @param {delta.Formats} [format]
   */
  insert (index, content, format) {
    this.applyDelta(delta.create().retain(index).insert(/** @type {any} */ (content), format).done())
  }

  // P7 begin (edytor fork: insertAtGapEnd — see UPSTREAM.md P7)
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
  // P7 end

  // P13 begin (edytor fork: paired marks — see UPSTREAM.md P13, utils/marks.js)
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
  // P13 end

  /**
   * Inserts new content at an index.
   *
   * Important: This function expects an array of content. Not just a content
   * object. The reason for this "weirdness" is that inserting several elements
   * is very efficient when it is done as a single operation.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  yarray.insert(0, ['a'])
   *  // Insert numbers 1, 2 at position 1
   *  yarray.insert(1, [1, 2])
   *
   * @param {number} index The index to insert content at.
   * @param {number} length The index to insert content at.
   * @param {delta.Formats} formats
   *
   */
  format (index, length, formats) {
    this.applyDelta(delta.create().retain(index).retain(length, formats))
  }

  /**
   * Appends content to this YArray.
   *
   * @param {Array<delta.DeltaConfGetChildren<DConf>>|delta.DeltaConfGetText<DConf>} content Array of content to append.
   *
   * @todo Use the following implementation in all types.
   */
  push (content) {
    this.insert(this.length, content)
  }

  /**
   * Prepends content to this YArray.
   *
   * @param {delta.DeltaConfGetText<DConf>} content Array of content to prepend.
   */
  unshift (content) {
    this.insert(0, content)
  }

  /**
   * Deletes elements starting from an index.
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} length The number of elements to remove. Defaults to 1.
   */
  delete (index, length = 1) {
    this.applyDelta(delta.create().retain(index).delete(length))
  }

  /**
   * Returns the i-th element from a YArray.
   *
   * @param {number} index The index of the element to return from the YArray
   * @return {delta.DeltaConfGetChildren<DConf>}
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
   * @return {Array<delta.DeltaConfGetChildren<DConf>>}
   */
  slice (start = 0, end = this.length) {
    return typeListSlice(this, start, end)
  }

  /**
   * @todo refactor this, this should use getContent only!
   *
   * Transforms this YArray to a JavaScript Array.
   *
   * @return {Array<delta.DeltaConfGetChildren<DConf> | delta.DeltaConfGetText<DConf>>}
   */
  toArray () {
    const dcontent = this.toDelta()
    /**
     * @type {Array<any>}
     */
    const children = []
    for (const child of dcontent.children) {
      if (delta.$insertOp.check(child)) {
        for (let i = 0; i < child.insert.length; i++) {
          children.push(child.insert[i])
        }
      } else if (delta.$textOp.check(child)) {
        children.push(child.insert)
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
    const children = this.toArray().map(c => s.$string.check(c) ? c : (c instanceof YNode ? c.toString({ forceTag: true }) : JSON.stringify(c))).join('')
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
   * @param {(child:delta.DeltaConfGetChildren<DConf>|delta.DeltaConfGetText<DConf>,index:number)=>M} f Function that produces an element of the new Array
   * @return {Array<M>} A new array with each element being the result of the
   *                 callback function
   */
  map (f) {
    return this.toArray().map(f)
  }

  /**
   * Executes a provided function once on every element of this YArray.
   *
   * @param {(child:delta.DeltaConfGetChildren<DConf>|delta.DeltaConfGetText<DConf>,index:number)=>any} f Function that produces an element of the new Array
   */
  forEach (f) {
    return this.toArray().forEach(f)
  }

  /**
   * Executes a provided function on once on every key-value pair.
   *
   * @param {(val:delta.DeltaConfGetAttrs<DConf>[any],key:Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol>,ynode:this)=>any} f
   */
  forEachAttr (f) {
    this._map.forEach((item, key) => {
      if (!item.deleted) {
        f(item.content.getContent()[item.length - 1], /** @type {any} */ (key), this)
      }
    })
  }

  /**
   * Returns the keys for each element in the YMap Type.
   *
   * @return {IterableIterator<import('lib0-v14/ts').KeyOf<delta.DeltaConfGetAttrs<DConf>>>}
   */
  attrKeys () {
    return iterator.iteratorMap(createMapIterator(this), /** @param {any} v */ v => v[0])
  }

  /**
   * Returns the values for each element in the YMap Type.
   *
   * @return {IterableIterator<delta.DeltaConfGetAttrs<DConf>[any]>}
   */
  attrValues () {
    return iterator.iteratorMap(createMapIterator(this), /** @param {any} v */ v => v[1].content.getContent()[v[1].length - 1])
  }

  /**
   * Returns an Iterator of [key, value] pairs
   *
   * @return {IterableIterator<{ [K in keyof delta.DeltaConfGetAttrs<DConf>]: [K,delta.DeltaConfGetAttrs<DConf>[K]] }[any]>}
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
   * @param {this} other
   */
  [traits.EqualityTraitSymbol] (other) {
    return this.toDelta().equals(other.toDelta())
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
        encoder.writeKey(this.name)
        break
      }
    }
  }
}

/**
 * Schema of a {@link YNode} with any delta configuration. This is where the nominal `y:node` tag
 * lives - {@link $node} builds on it. Mirrors lib0's `$deltaAny` / `$delta` split.
 */
export const $nodeAny = /** @type {s.Schema<YNode<any>>} */ (YNode.prototype.$type = s.$type('y:node', YNode))

/**
 * @param {StructStore} store
 * @param {IdSet} items
 */
export const computeModifiedFromItems = (store, items) => {
  /**
   * @type {Map<YNode,Set<null|string>>}
   */
  const modified = new Map()
  iterateStructsByIdSetWithoutSplits(store, items, /** @param {Item | GC | Skip | null} item */ item => {
    while (item instanceof Item) {
      const parent = /** @type {YNode} */ (item.parent)
      const conf = map.setIfUndefined(modified, parent, set.create)
      if (conf.has(item.parentSub)) break // has already been marked as modified
      conf.add(item.parentSub)
      item = parent._item
    }
  })
  return modified
}

/**
 * The active renderer's attribution overlay changed (e.g. a suggestion was accepted or rejected)
 * without a Y transaction on the type's doc, so no `YEvent` fires. Re-render the affected id
 * ranges and keep the RDT surface current, mirroring the per-transaction upkeep in
 * `cleanupTransactions`: patch the maintained {@link YNode#delta} cache and emit the change on
 * the `'delta'` channel. Wired to the renderer's `'change'` event by {@link YNode#useRenderer}.
 *
 * Ranges in `changes` that the doc has not (yet) integrated — e.g. a base-doc edit whose update
 * flows in only after the renderer event — simply render to nothing here; the later transaction
 * covers them through the regular event path.
 *
 * The cache patch must stay on the builder `apply` — see the {@link YNode#_delta}
 * fingerprint-memo invariant.
 *
 * @param {YNode<any>} type
 * @param {IdSet} changes
 * @param {any} origin
 *
 * @private
 * @function
 */
export const typeApplyRendererChange = (type, changes, origin) => {
  const hasDeltaListeners = (type._observers.get('delta')?.size ?? 0) > 0
  // no deleted-type guard: this handler only exists while a custom renderer is attached (see
  // `useRenderer`), and a custom renderer may still render a deleted type — its cache and 'delta'
  // channel must stay current through accept/reject overlay changes.
  if ((type._delta === null && !hasDeltaListeners) || type.doc == null) return
  const change = type.toDelta({ renderer: type._renderer, deep: true, itemsToRender: changes, retainInserts: true, retainDeletes: true })
  if (!change.isEmpty()) {
    type._delta?.apply(change)
    if (hasDeltaListeners) type.emit('delta', [change, origin])
  }
}

/**
 * @param {any} a
 * @param {any} b
 * @return {boolean}
 */
export const equalFormats = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a && b && object.equalFlat(a, b))

/**
 * @template {delta.DeltaConf} DConf
 * @typedef {delta.DeltaConfOverwrite<DConf, {
 *     attrs: { [K in keyof delta.DeltaConfGetAttrs<DConf>]: DeltaToYNode<delta.DeltaConfGetAttrs<DConf>[K]> },
 *     children: DeltaToYNode<delta.DeltaConfGetChildren<DConf>>
 *   }>
 * } DeltaConfDeltaToYNode
 */

/**
 * @template {any} Data
 * @typedef {Exclude<Data,delta.DeltaAny> | (Extract<Data,delta.DeltaAny> extends delta.Delta<infer DConf> ? (unknown extends DConf ? YNode<DConf> : never) : never)} DeltaToYNode
 */

/**
 * @param {YNode<any>} type
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
        if ($doc.check(value)) {
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
 * @param {YNode<any>} parent
 * @param {string} key
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|YNode<any>|undefined}
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
 * @param {YNode<any>} parent
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|YNode<any>|undefined>}
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
 * @todo move this to getContent/getDelta
 *
 * Render the difference to another ydoc (which can be empty) and highlight the differences with
 * attributions.
 *
 * Note that deleted content that was not deleted in prevYdoc is rendered as an insertion with the
 * attribution `{ isDeleted: true, .. }`.
 *
 * @template {delta.DeltaBuilderAny} TypeDelta
 * @param {TypeDelta} d
 * @param {YNode} parent
 * @param {Set<string|null>?} attrsToRender
 * @param {AbstractRenderer?} renderer
 * @param {boolean} deep
 * @param {Set<YNode>|Map<YNode,any>|null} [modified] - set of types that should be rendered as modified children
 * @param {IdSet?} [itemsToRender]
 * @param {any} [opts]
 * @param {any} [optsAll]
 *
 * @private
 * @function
 */
export const nodeMapGetDelta = (d, parent, attrsToRender, renderer, deep, modified, itemsToRender, opts, optsAll) => {
  // @todo support modified ops!
  /**
   * @param {Item} item
   * @param {string} key
   */
  const renderAttrs = (item, key) => {
    /**
     * @type {{ deleted: boolean, attrs: Array<ContentAttribute<any>>?, content: AbstractContent }}
     */
    let piece
    if (renderer === null || !renderer.hasItem(item)) {
      // generic fast path — the item's own fields, no renderer involved
      piece = { deleted: item.deleted, attrs: null, content: item.content }
    } else {
      /**
       * @type {Array<AttributedContent<any>>}
       */
      const cs = []
      renderer.readContent(cs, item.id.client, item.id.clock, item.deleted, item.content, 1)
      if (cs.length === 0) return // the renderer surfaces nothing for this attribute (e.g. a diff renderer hiding an unchanged delete)
      piece = cs[cs.length - 1]
    }
    const { deleted, attrs, content } = piece
    const attribution = createAttributionFromAttributionItems(attrs, deleted)
    let c = array.last(content.getContent())
    if (deleted) {
      if (attribution != null) {
        // Item surfaced under attribution (suggestion view / diff renderer, either in snapshot mode
        // or in an event-driven render). The attribute is still observable in the rendered state, so
        // emit a positive `SetAttrOp` carrying the attribution metadata - matching how content
        // children are rendered for the same case (positive `InsertOp` with attribution, never
        // `DeleteOp`).
        // also re-emit when the change happened *inside* the still-rendered value (`modified`
        // contains the value type but the attr's own map item is not part of the change) — the
        // deleted value has no modifyAttr path, and a full-state `setAttr` replace is idempotent
        if (itemsToRender == null || itemsToRender.hasId(item.lastId) || (c instanceof YNode && modified != null && modified.has(c))) {
          if (deep && c instanceof YNode) {
            // full-state value render: a positive `setAttr` *replaces* the attr value on the
            // consuming side, so the nested type must render as its full attributed state
            // (change-scoped opts like `itemsToRender` would render bare retains here)
            c = /** @type {any} */(c).toDelta({ renderer, deep: true })
          }
          d.setAttr(key, c, attribution)
        }
      } else if (itemsToRender != null && itemsToRender.hasId(item.lastId)) {
        // Hard-deleted attribute within a change render: emit the `deleteAttr` op so consumers (the
        // `YEvent` delta, RDT bindings, the maintained `delta` cache) can apply the removal. In
        // full-state mode (`itemsToRender == null`) the attribute is simply omitted (above renders
        // run with `render === false` for such items, so nothing was emitted before either).
        d.deleteAttr(key, attribution)
      }
    } else if (deep && c instanceof YNode && modified?.has(c)) {
      d.modifyAttr(key, c.toDelta(opts))
    } else {
      if (deep && c instanceof YNode) {
        c = /** @type {any} */(c).toDelta(optsAll)
      }
      d.setAttr(key, c, attribution)
    }
  }
  if (attrsToRender == null) {
    parent._map.forEach(renderAttrs)
  } else {
    attrsToRender.forEach(key => key != null && renderAttrs(/** @type {Item} */ (parent._map.get(key)), key))
  }
}

/**
 * @param {YNode<any>} parent
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
 * @param {YNode<any> & { _map: Map<string, Item> }} type
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
