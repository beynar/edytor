import * as binary from 'lib0-v14/binary'
import * as error from 'lib0-v14/error'
import * as map from 'lib0-v14/map'
import * as math from 'lib0-v14/math'
import {
  Item,
  ContentAny,
  ContentBinary,
  ContentDeleted,
  ContentFormat,
  ContentString,
  ContentType,
  ContentHold, // YP20
  ContentMove, // YP22
  readFormatValue, // YP25
  YXmlFragmentRefID,
  YXmlElementRefID,
  YXmlHookRefID
} from './structs/Item.js'
import { createID } from './utils/ID.js'
import { getItemCleanStart, liveLength, updateCurrentFormats } from './utils/transaction-helpers.js'
import { transact } from './utils/Transaction.js'
import { markClass, MARK_START, MARK_END, SIDE_LEFT } from './utils/marks.js' // YP13

/**
 * @typedef {Object<string,any>|Array<any>|number|null|string|Uint8Array|BigInt|YNode} YValue
 */

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
   * Move past `length` live units, splitting the item the last one ends in,
   * and past the deleted items around them (YP19: the positioning of every
   * write; mark items are folded, never rewritten).
   *
   * @param {Transaction} transaction
   * @param {number} length
   */
  advance (transaction, length) {
    while (this.right !== null && this.right.deleted) this.forward()
    while (this.right !== null && length > 0) {
      const item = this.right
      const len = liveLength(item)
      if (length < len) {
        getItemCleanStart(transaction, createID(item.id.client, item.id.clock + length))
        length = 0
      } else {
        length -= len
      }
      this.forward()
    }
    if (length > 0) {
      throw new Error('Exceeded content range')
    }
    while (this.right !== null && this.right.deleted) this.forward()
  }
}

// YP13 begin (edytor fork: paired marks — see UPSTREAM.md YP13)
/**
 * The contents an insert writes: a string, or an array split into its nodes and its runs of JSON values.
 *
 * @param {Array<any>|string} insert
 * @return {Array<import('./structs/Item.js').AbstractContent>}
 */
const contentsOf = insert => {
  if (typeof insert === 'string') return [new ContentString(insert)]
  /** @type {Array<import('./structs/Item.js').AbstractContent>} */
  const out = []
  for (let i = 0; i < insert.length;) {
    const first = insert[i]
    if (first instanceof YNode) {
      out.push(new ContentType(first))
      i++
    } else {
      let j = i + 1
      for (; j < insert.length && !(insert[j] instanceof YNode); j++) { /* nop */ }
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
  const l = /** @type {any} */ (doc)._clock + 1 // YP22: one clock with the move records
  const k = doc.store.getClock(client)
  insertMarkItem(transaction, parent, index, startSide, new ContentFormat(MARK_START + mark, [value, l, client, k, startSide]))
  insertMarkItem(transaction, parent, index + length, endSide, new ContentFormat(MARK_END + mark, [client, k, endSide]))
  dropMarkerFormats(parent)
}
// YP13 end

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

// YP20 begin (edytor fork: hold records — see UPSTREAM.md YP20)
/**
 * The first clock in `(clock, end)` where membership in `set` changes, else `end`.
 *
 * @param {import('./utils/ids.js').IdSet} set
 * @param {number} client
 * @param {number} clock
 * @param {number} end
 * @return {number}
 */
const runEnd = (set, client, clock, end) => {
  for (const r of set.clients.get(client)?.getIds() ?? []) {
    if (r.clock > clock) return math.min(r.clock, end)
    if (r.clock + r.len > clock) return math.min(r.clock + r.len, end)
  }
  return end
}

/**
 * Append a hold record of `ids` to `list` (the document's records list).
 *
 * @param {Transaction} transaction
 * @param {YNode} list
 * @param {Array<number>} ids
 */
const holdHelper = (transaction, list, ids) => {
  insertInGapHelper(transaction, list, list._length, new ContentHold(ids))
}
// YP20 end

/**
 * With `held`, the live units are not deleted: their ids go to `held`
 * (`client, clock, len`), except those `fresh` names (YP20).
 *
 * @param {Transaction} transaction
 * @param {ItemTextListPosition} currPos
 * @param {number} length
 * @param {Array<number>|null} [held]
 * @param {import('./utils/ids.js').IdSet|null} [fresh]
 * @return {ItemTextListPosition}
 *
 * @private
 * @function
 */
export const deleteText = (transaction, currPos, length, held = null, fresh = null) => {
  const startLength = length
  let kept = 0 // YP20
  while (length > 0 && currPos.right !== null) {
    const item = currPos.right
    if (!item.deleted && item.countable) {
      const { client, clock } = item.id
      // YP20: a held run ends where the open step's inserts start or end
      const n = fresh === null ? math.min(length, item.length) : runEnd(fresh, client, clock, clock + math.min(length, item.length)) - clock
      if (n < item.length) {
        getItemCleanStart(transaction, createID(client, clock + n))
      }
      length -= item.length
      if (held === null || (fresh !== null && fresh.has(client, clock))) {
        item.delete(transaction)
      } else {
        held.push(client, clock, item.length)
        kept += item.length
      }
    }
    currPos.forward()
  }
  // YP20: the held units hide when their record integrates
  currPos.index -= kept
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

// YP16 begin (edytor fork: writes without the delta layer — see UPSTREAM.md YP16)
/**
 * What a detached node was given, replayed when it integrates: its content
 * (adjacent strings, and adjacent arrays, merged) and its attrs in
 * first-write order (`null`: removed).
 *
 * @typedef {{ runs: Array<string|Array<any>>, attrs: Object<string,{ value: any }|null> }} Prelim
 */

/**
 * @param {YNode} node
 * @return {Prelim}
 */
const prelimOf = node => node._prelim ?? (node._prelim = { runs: [], attrs: Object.create(null) })

/**
 * Split `runs` so that a run starts at `index`; returns that run's position.
 *
 * @param {Array<string|Array<any>>} runs
 * @param {number} index
 * @return {number}
 */
const splitRuns = (runs, index) => {
  let i = 0
  for (; i < runs.length && index > 0; i++) {
    const run = runs[i]
    if (index < run.length) {
      runs.splice(i, 1, run.slice(0, index), run.slice(index))
      return i + 1
    }
    index -= run.length
  }
  if (index > 0) throw new Error('Exceeded content range')
  return i
}

/**
 * Drop empty runs and merge adjacent runs of one kind.
 *
 * @param {Array<string|Array<any>>} runs
 */
const mergeRuns = runs => {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].length === 0) runs.splice(i, 1)
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const a = runs[i - 1]
    const b = runs[i]
    if (typeof a === typeof b) {
      runs.splice(i - 1, 2, typeof a === 'string' ? a + b : a.concat(b))
    }
  }
}

/**
 * A cursor at live index `index` of `node` — the positioning step of a delete. A distant index
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
  currPos.advance(transaction, index - adjust)
  // quiescent point at a positioning boundary — a later write near it seeds from this marker
  plantMarker(node, currPos)
  return currPos
}

/**
 * Write the content and attrs a detached node was given: the content runs in order, then the
 * attrs.
 *
 * @param {Transaction} transaction
 * @param {YNode} node
 * @param {Prelim} prelim
 */
const writePrelim = (transaction, node, prelim) => {
  let index = 0
  for (const run of prelim.runs) {
    for (const part of contentsOf(run)) {
      insertInGapHelper(transaction, node, index, part)
      index += part.getLength()
    }
  }
  for (const key in prelim.attrs) {
    const attr = prelim.attrs[key]
    if (attr === null) {
      nodeMapDelete(transaction, node, key)
    } else {
      nodeMapSet(transaction, node, key, attr.value)
    }
  }
}
// YP16 end

/**
 * The engine's node: a sequence (text, elements, nested nodes) and a map of attributes. YP19: the
 * reads and writes edytor calls — no observers, no plain formats, no JSON or string renderings.
 */
export class YNode {
  /**
   * @param {string?} name
   */
  constructor (name = null) {
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
    this._legacyTypeRef = this.name == null ? YXmlFragmentRefID : YXmlElementRefID
    /**
     * @type {Array<ArraySearchMarker>|null}
     */
    this._searchMarker = []
    /**
     * The writes made while this node is detached, replayed when it integrates (YP16).
     * @type {Prelim|null}
     */
    this._prelim = null
  }

  /**
   * The live length of the sequence (`0` while detached).
   */
  get length () {
    return this._length
  }

  /**
   * Integrate this type into the Yjs instance.
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
      if ((prelim.runs.length > 0 || Object.keys(prelim.attrs).length > 0) && (item === null || !item.deleted)) {
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
   * Removes an attribute. A deleted node is left as it is.
   *
   * @param {string} attributeName The attribute name that is to be removed.
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
   */
  getAttr (attributeName) {
    const val = this._map.get(attributeName)
    return val !== undefined && !val.deleted ? val.content.getContent()[val.length - 1] : undefined
  }

  /**
   * Inserts new content at an index — a string, or an array of elements (JSON values, nodes) —
   * as `insertInGap` places it (YP19: one sequence write). A deleted node is left as it is.
   *
   * @param {number} index The index to insert content at.
   * @param {Array<any>|string} content
   */
  insert (index, content) {
    if ((typeof content !== 'string' && !Array.isArray(content)) || content.length === 0) return
    if (this.doc == null) {
      const runs = prelimOf(this).runs
      runs.splice(splitRuns(runs, index), 0, content.slice())
      mergeRuns(runs)
      return
    }
    if (this._item !== null && this._item.deleted) return
    this.insertInGap(index, content)
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
      let at = index
      for (const part of contentsOf(content)) {
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
   * Deletes elements starting from an index. A deleted node is left as it is.
   * YP20: with `into` (the document's records list), the live units are not
   * removed but held by one record appended to `into` (their writer's delete,
   * which an undo of the record takes back), except those `fresh` names (the
   * open undo step's inserts: removed, so that step's undo changes nothing).
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} length The number of elements to remove. Defaults to 1.
   * @param {YNode|null} [into]
   * @param {import('./utils/ids.js').IdSet|null} [fresh]
   */
  delete (index, length = 1, into = null, fresh = null) {
    if (!(length > 0)) return
    if (this.doc == null) {
      const runs = prelimOf(this).runs
      let n = length
      for (let i = splitRuns(runs, index); i < runs.length && n > 0; i++) {
        const cut = Math.min(n, runs[i].length)
        runs[i] = runs[i].slice(cut)
        n -= cut
      }
      mergeRuns(runs)
      return
    }
    if (this._item !== null && this._item.deleted) return
    transact(this.doc, transaction => {
      const currPos = cursorAt(transaction, this, index)
      const held = into === null ? null : [] // YP20
      deleteText(transaction, currPos, length, held, fresh)
      if (held !== null && held.length > 0) {
        // YP20: `deleteText` moved the markers as for a delete; the hold keeps them
        const ms = this._searchMarker === null ? null : this._searchMarker.slice()
        holdHelper(transaction, /** @type {YNode} */ (into), held)
        if (ms !== null && this._searchMarker !== null) this._searchMarker.splice(0, this._searchMarker.length, ...ms)
      }
      plantMarker(this, currPos)
    })
  }

  /**
   * YP20: append to this node (the document's records list) one hold record of
   * the items `ids` names (`client, clock, len` triples): they read as deleted
   * while the record is live.
   *
   * @param {Array<number>} ids
   */
  hold (ids) {
    if (this.doc == null) throw new Error('hold: node is not integrated')
    if (ids.length > 0) transact(this.doc, transaction => holdHelper(transaction, this, ids))
  }

  // YP22 begin (edytor fork: move records — see UPSTREAM.md YP22)
  /**
   * YP22: move the units `ids` (`client, clock, len` ranges, in the order
   * they will show) to live index `index` of this sequence: one move record
   * there (`ContentMove`); `side` is its class among the items of its origin
   * (`0` after, `1` before), `at` the chain it stands at for the sort of two
   * records at one origin — the units from the root sequence down to the
   * unit it stands at, outermost first (`null`: the first unit it names) —
   * and `part` the writer's order among the records standing at that unit.
   *
   * @param {number} index
   * @param {Array<number>} ids
   * @param {number} [side]
   * @param {number} [part]
   * @param {Array<ID>|null} [at]
   */
    move (index, ids, side = 0, part = 0, at = null) {
    if (this.doc == null) throw new Error('move: node is not integrated')
    if (ids.length === 0) return
    transact(this.doc, transaction => {
      // Above every record seen from a peer (`_clock`, raised by remote records
      // only): this writer's records keep one priority until it sees another's,
      // so its gestures win or lose together against a concurrent peer's.
      const priority = /** @type {any} */ (transaction.doc)._clock + 1
      insertInGapHelper(transaction, this, index, new ContentMove(priority, side, ids, part, at))
    })
  }
  // YP22 end

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
   * The keys of the live attributes.
   *
   * @return {IterableIterator<string>}
   */
  * attrKeys () {
    for (const [key, item] of this._map) {
      if (!item.deleted) yield key
    }
  }

  /**
   * Write this node's type reference (and name), sent with the item that holds it.
   *
   * @param {UpdateEncoder} encoder The encoder to write data to.
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
        if (value instanceof YNode) {
          content = new ContentType(/** @type {any} */ (value))
        } else {
          throw new Error('Unexpected content type')
        }
    }
  }
  new Item(createID(ownClientId, doc.store.getClock(ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0)
}

/**
 * @private
 *
 * @param {UpdateDecoder} decoder
 * @return {ContentType}
 */
export const readContentType = decoder => new ContentType(readYNode(decoder))

/**
 * @private
 *
 * @param {UpdateDecoder} decoder
 * @return {ContentString}
 */
export const readContentString = decoder => new ContentString(decoder.readString())

/**
 * @param {UpdateDecoder} decoder
 * @param {import('./utils/ID.js').ID} id YP25: the item's id (a paired mark's operation id is usually it)
 * @return {ContentFormat}
 */
export const readContentFormat = (decoder, id) => {
  const key = decoder.readKey()
  return new ContentFormat(key, readFormatValue(decoder, key, id)) // YP25
}

/**
 * @param {UpdateDecoder} decoder
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
 * @param {UpdateDecoder} decoder
 * @return {ContentBinary}
 */
export const readContentBinary = decoder => new ContentBinary(decoder.readBuf())

/**
 * @private
 *
 * @param {UpdateDecoder} decoder
 * @return {ContentDeleted}
 */
export const readContentDeleted = decoder => new ContentDeleted(decoder.readLen())

/**
 * YP20, YP22: a record's id ranges, a count then one `client, clock, len` each.
 *
 * @param {UpdateDecoder} decoder
 * @return {Array<number>}
 */
const readIds = decoder => {
  const ids = []
  for (let n = decoder.readLen(); n > 0; n--) {
    const id = decoder.readLeftID()
    ids.push(id.client, id.clock, decoder.readLen())
  }
  return ids
}

/**
 * YP20: a hold record, one `client, clock, len` per unit.
 *
 * @param {UpdateDecoder} decoder
 * @return {ContentHold}
 */
export const readContentHold = decoder => new ContentHold(readIds(decoder))

/**
 * YP22: a move record: its priority, side, part and whether an anchor chain
 * follows in one word, the chain (a count, then its units), then one
 * `client, clock, len` per range.
 *
 * @param {UpdateDecoder} decoder
 * @return {ContentMove}
 */
export const readContentMove = decoder => {
  const word = decoder.readLen()
  /** @type {Array<ID>|null} */
  let at = null
  if (word & 16) {
    at = []
    for (let n = decoder.readLen(); n > 0; n--) at.push(decoder.readLeftID())
  }
  return new ContentMove(word >> 5, word & 1, readIds(decoder), (word >> 1) & 7, at)
}

const refused = () => { error.unexpectedCase() }

/**
 * A lookup map for reading Item content. YP19: JSON (2), embed (5) and
 * subdocument (9) contents are refused like GC (0) and Skip (10): edytor
 * writes none, so an update holding one is malformed. YP20: 11 is a hold
 * record. YP22: 12 is a move record.
 *
 * @type {Array<function(UpdateDecoder, import('./utils/ID.js').ID):AbstractContent>}
 */
export const contentRefs = [
  refused, // 0 - GC is not ItemContent
  readContentDeleted, // 1
  refused, // 2 - JSON
  readContentBinary, // 3
  readContentString, // 4
  refused, // 5 - embed
  readContentFormat, // 6
  readContentType, // 7
  readContentAny, // 8
  refused, // 9 - subdocument
  refused, // 10 - Skip is not ItemContent
  readContentHold, // 11 - a hold record (YP20)
  readContentMove // 12 - a move record (YP22)
]

/**
 * @param {UpdateDecoder} decoder
 * @param {number} info
 * @param {import('./utils/ID.js').ID} id YP25: the item's id (a format item reads it)
 */
export const readItemContent = (decoder, info, id) => contentRefs[info & binary.BITS5](decoder, id)

/**
 * @param {UpdateDecoder} decoder
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
