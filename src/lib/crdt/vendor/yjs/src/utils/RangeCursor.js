/**
 * Bounded read-only range cursor over a `YNode`'s item list — a local
 * (Edytor) addition, not upstream source. See UPSTREAM.md (YP5).
 *
 * A `RangeCursor` reads the interval `[i0, i1)` of a list-type `YNode`
 * without materializing the whole node: it seeks via the engine's own
 * search-marker checkpoints (the `formats` snapshots YP4 added for
 * `applyDelta`'s mutation-cursor seeding are exactly the checkpoints a
 * format-aware range read needs) and emits one {@link RangePiece} per
 * visible piece overlapping the range — the live content, folded by
 * `updateCurrentFormats`, measured by `liveLength` (the same interpretation
 * the write cursor, `ItemTextListPosition`, walks with).
 *
 * Cold reads leave sparse format-aware checkpoints behind their walk at
 * `READ_PLANT_GAP`-item cadence (`plantSearchMarker`) — `findMarker`'s
 * merge-left rule cannot anchor mid-run in same-client-contiguous lists,
 * so read-driven planting is what keeps repeated reads bounded — the
 * same adaptive role the Edytor-side read index played before U3.
 *
 * Reads are pure with respect to replicated state: they never open a
 * transaction — no updates are produced, no items are split, no undo
 * state changes. The only writes
 * are to the node's local `_searchMarker` pool — the same adaptive
 * checkpoint maintenance upstream's own read-path lookups perform via
 * `findMarker` (`typeListGet`, position resolution) — non-replicated,
 * behavior-invisible cache state.
 */
import * as math from 'lib0-v14/math'
import * as map from 'lib0-v14/map'

import { ContentFormat } from '../structs/Item.js'
import { plantSearchMarker } from '../ynode.js'

import { createID } from './ID.js'
import { updateCurrentFormats, liveLength } from './transaction-helpers.js'
import { formatValue } from './marks.js' // YP13

/**
 * Checkpoint cadence for cold walks: a read that steps this many items
 * past the last checkpoint records a marker at that boundary, so later
 * reads seed near their targets even where no mutation planted one —
 * the same sparse cadence the Edytor-side read index used (WU8).
 */
const READ_PLANT_GAP = 64

/**
 * One element of the bounded read stream produced by {@link RangeCursor#read}
 * — one live piece of content overlapping the range, with the formats folded
 * at it.
 *
 * @typedef {Object} RangePiece
 * @property {AbstractContent} content - the piece's content object. BORROWED
 *   from the item (never mutated, never copied).
 *   Emit `[offset, offset + len)` of it: slice `content.str` for
 *   `ContentString` (UTF-16 units) and index `content.getContent()` for
 *   element content.
 * @property {ID} id - replicated id of the first emitted element.
 * @property {number} index - rendered position the emitted range starts at.
 * @property {number} offset - start of the emitted range inside `content`.
 * @property {number} len - rendered length of the emitted range (`0` for a
 *   live piece occupying no position).
 * @property {boolean} deleted - always `false`: a read emits live content only.
 * @property {null} attrs - always `null` (no attribution layer).
 * @property {Object<string,any>|undefined} formats - folded format state at
 *   the piece. SHARED between adjacent pieces of one fold state — treat as
 *   read-only.
 */

/**
 * A forward-only, read-only cursor over one `YNode` list. Fields mirror
 * `ItemTextListPosition` (`p`/`index`/`currentFormats`) — `index` is the
 * rendered position of `p`'s left edge, `currentFormats` the format state
 * folded to it.
 */
export class RangeCursor {
  /**
   * @param {YNode} parent - the list node to read.
   */
  constructor (parent) {
    /**
     * @type {YNode}
     */
    this.parent = parent
    /**
     * The next unprocessed sequence item — a parked cursor keeps `index` at
     * its left edge.
     * @type {import('../structs/Item.js').Item?}
     */
    this.p = parent._start
    /**
     * Rendered units strictly before `p` — the
     * `ItemTextListPosition#index`/`ArraySearchMarker#index` space
     * (countable, non-deleted units).
     * @type {number}
     */
    this.index = 0
    /**
     * Format state folded to `index` — a private copy of any adopted marker
     * snapshot (`value === null` clears; same `updateCurrentFormats` fold).
     * @type {Map<string,any>}
     */
    this.currentFormats = new Map()
    /**
     * The materialized `formats` object handed to emitted pieces — `null`
     * until the next emission under the current fold state.
     * @type {Object<string,any>|undefined|null}
     */
    this._formatsObj = null
  }

  /**
   * Rewind to `_start` — format state cannot un-apply, so backward reads
   * reset before re-seeding.
   */
  reset () {
    this.p = this.parent._start
    this.index = 0
    this.currentFormats.clear()
    this._formatsObj = null
  }

  /**
   * Reposition the cursor at-or-before rendered position `index`, seeding
   * from the best engine-owned checkpoint — an `ArraySearchMarker`
   * carrying a `formats` snapshot.
   *
   * Read-seed eligibility is deliberately WEAKER than the write cursor's
   * seed (UPSTREAM.md YP5): a read may resume on ANY item at-or-left
   * of the target — the forward fold reproduces format state from the
   * snapshot — while the mutation cursor must anchor on the FIRST item at
   * the index (its `p.left` must be countable-or-null). Both consume the
   * same marker records and snapshots.
   *
   * @param {number} index
   */
  seek (index) {
    const parent = this.parent
    const ms = parent._searchMarker
    if (ms === null) return
    /**
     * @type {import('../structs/Item.js').Item?}
     */
    let bestP = null
    let bestIndex = this.index
    /**
     * @type {Map<string,any>?}
     */
    let bestFormats = null
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      if (m.formats === null || m.index <= 0) continue
      /**
       * @type {import('../structs/Item.js').Item}
       */
      let p = m.p
      let idx = m.index
      let steps = 0
      // A marker anchored right of the target can still seed: step left
      // over pure content until at-or-below `index` — format state doesn't
      // change across countable/non-deleted items (a format marker or
      // tombstone in the gap stops the walk and rejects the candidate).
      while (idx > index && p.left !== null && !p.left.deleted && p.left.countable && steps < 64) {
        p = p.left
        idx -= p.length
        steps++
      }
      if (
        idx <= index && idx > bestIndex &&
        // Anchor linkage is verified — records can outlive their items.
        (p.left === null ? parent._start === p : p.left.right === p) &&
        (p.right === null || p.right.left === p)
      ) {
        bestP = p
        bestIndex = idx
        bestFormats = m.formats
      }
    }
    if (bestP !== null) {
      this.p = bestP
      this.index = bestIndex
      // Private copy — the cursor's own folds must never corrupt the
      // marker's snapshot for other consumers.
      this.currentFormats = map.copy(/** @type {Map<string,any>} */ (bestFormats))
      this._formatsObj = null
    }
  }

  /**
   * Fold one `ContentFormat` item into the cursor's format state — the
   * `!deleted` gate mirrors `ItemTextListPosition#forward`: a tombstoned
   * marker applies nothing.
   *
   * @param {import('../structs/Item.js').Item} item
   * @param {{ markers: number }?} stats
   */
  _foldItem (item, stats) {
    if (!item.deleted) {
      updateCurrentFormats(this.currentFormats, /** @type {ContentFormat} */ (item.content))
      this._formatsObj = null
    }
    if (stats !== null) stats.markers++
  }

  /**
   * The cursor's format state as an emittable object — materialized once
   * per fold state and SHARED between the pieces emitted under it
   * (aliasing contract: consumers treat it as read-only; interning/freeze
   * happens at the publication boundary).
   *
   * @return {Object<string,any>|undefined}
   */
  _emitFormats () {
    let f = this._formatsObj
    if (f === null) {
      f = undefined
      this.currentFormats.forEach((v, k) => {
        v = formatValue(v) // YP13: a paired mark renders its winning value
        if (v != null) (f ??= {})[k] = v
      })
      this._formatsObj = f
    }
    return f
  }

  /**
   * Emit the {@link RangePiece}s of `[i0, i1)` — a bounded, read-only walk
   * of the item list producing its live content, clipped to the range and
   * carrying the folded format state.
   *
   * The cursor is left positioned to serve the NEXT forward read cheaply:
   * items fully consumed advance `p`/`index`; a range ending inside an
   * item leaves the cursor parked at that item's left edge (re-walking it
   * is slice math, not a rescan). A backward read rewinds to `_start` and
   * re-seeks — format state cannot un-apply.
   *
   * @param {number} i0 - rendered start position (inclusive).
   * @param {number} i1 - rendered end position (exclusive).
   * @param {{ items: number, markers: number }?} [stats] - per-read
   *   instrumentation: `items` counts sequence items stepped over,
   *   `markers` counts `ContentFormat` pieces seen (folded or tombstoned).
   * @return {Array<RangePiece>}
   */
  read (i0, i1, stats = null) {
    /**
     * @type {Array<RangePiece>}
     */
    const out = []
    const parent = this.parent
    if (i1 <= i0 || parent.doc === null) return out
    if (i0 < this.index) {
      this.reset()
    }
    if (i0 > this.index) {
      this.seek(i0)
    }
    // Items stepped since the cursor passed the last checkpoint — a sparse
    // marker is recorded at every `READ_PLANT_GAP` boundary during a cold
    // walk (the checkpoint pool only fills where work actually happens —
    // `findMarker`'s merge-left rule cannot anchor mid-run in
    // same-client-contiguous lists, so read-driven planting is what makes
    // read-only workloads bounded). Index space is the raw countable one —
    // the same space markers record.
    let stepsSincePlant = 0
    const planting = parent._searchMarker !== null
    while (this.p !== null) {
      const item = this.p
      const start = this.index
      const end = start + liveLength(item)
      if (stats !== null) stats.items++
      if (end <= i0) {
        // Boundary checkpoint — BEFORE folding the item (the snapshot is
        // the format state at its left edge).
        if (planting && ++stepsSincePlant >= READ_PLANT_GAP) {
          plantSearchMarker(parent, item, start, this.currentFormats)
          stepsSincePlant = 0
        }
        // Prefix item — only format state can matter.
        if (item.content.constructor === ContentFormat) {
          this._foldItem(item, stats)
        }
        this.index = end
        this.p = item.right
        continue
      }
      if (start >= i1) return out // park BEFORE this item — untouched
      // Overlapping item — same boundary-checkpoint rule at its left edge.
      if (planting && ++stepsSincePlant >= READ_PLANT_GAP) {
        plantSearchMarker(parent, item, start, this.currentFormats)
        stepsSincePlant = 0
      }
      // Overlapping item: a format marker folds (it occupies no position),
      // a tombstone shows nothing, live content emits its part of the range.
      const content = item.content
      if (content.constructor === ContentFormat) {
        this._foldItem(item, stats)
      } else if (!item.deleted) {
        const plen = content.isCountable() ? content.getLength() : 0
        if (plen === 0) {
          if (start >= i0 && start < i1) {
            out.push({
              content,
              id: item.id,
              index: start,
              offset: 0,
              len: 0,
              deleted: false,
              attrs: null,
              formats: this._emitFormats()
            })
          }
        } else {
          const lo = math.max(i0, start)
          const hi = math.min(i1, start + plen)
          if (lo < hi) {
            out.push({
              content,
              id: createID(item.id.client, item.id.clock + (lo - start)),
              index: lo,
              offset: lo - start,
              len: hi - lo,
              deleted: false,
              attrs: null,
              formats: this._emitFormats()
            })
          }
        }
      }
      if (end > i1) return out // range ends inside this item — stay parked at its left edge
      // Item fully consumed — the boundary at `end` is the next item's left
      // edge (at the tail, the last item's own left edge — `plantMarker`'s
      // tail-anchor convention).
      if (planting && ++stepsSincePlant >= READ_PLANT_GAP) {
        const next = item.right
        plantSearchMarker(parent, next === null ? item : next, next === null ? start : end, this.currentFormats)
        stepsSincePlant = 0
      }
      this.index = end
      this.p = item.right
    }
    return out
  }
}
