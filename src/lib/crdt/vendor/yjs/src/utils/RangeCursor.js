/**
 * Bounded read-only range cursor over a `YNode`'s item list — a local
 * (Edytor) addition, not upstream source. See UPSTREAM.md (P5).
 *
 * A `RangeCursor` reads the interval `[i0, i1)` of a list-type `YNode`
 * without materializing the whole node: it seeks via the engine's own
 * search-marker checkpoints (the `formats` snapshots P4 added for
 * `applyDelta`'s mutation-cursor seeding are exactly the checkpoints a
 * format-aware range read needs) and emits one {@link RangePiece} per
 * visible piece overlapping the range — the SAME physical-sequence
 * interpretation `YNode#toDelta` renders with (`readItemPieces`), folded
 * by `updateCurrentFormats`, measured by `rendererContentLength`.
 *
 * Cold reads leave sparse format-aware checkpoints behind their walk at
 * `READ_PLANT_GAP`-item cadence (`plantSearchMarker`) — `findMarker`'s
 * merge-left rule cannot anchor mid-run in same-client-contiguous lists,
 * so read-driven planting is what keeps repeated reads bounded — the
 * same adaptive role the Edytor-side read index played before U3.
 *
 * Reads are pure with respect to replicated state: they never open a
 * transaction — no updates are produced, no items are split, no undo
 * state changes, no renderer is installed or mutated. The only writes
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
import { rendererContentLength, readItemPieces } from './renderer-helpers.js'
import { updateCurrentFormats } from './transaction-helpers.js'

/**
 * Checkpoint cadence for cold walks: a read that steps this many items
 * past the last checkpoint records a marker at that boundary, so later
 * reads seed near their targets even where no mutation planted one —
 * the same sparse cadence the Edytor-side read index used (WU8).
 */
const READ_PLANT_GAP = 64

/**
 * One element of the bounded read stream produced by {@link RangeCursor#read}
 * — the read-side analogue of a delta op's content payload, carrying the same
 * attribution inputs `YNode#toDelta` consumes (mode `1` semantics).
 *
 * @typedef {Object} RangePiece
 * @property {AbstractContent} content - the piece's content object. BORROWED
 *   from the item (never mutated, never copied) or produced by the renderer.
 *   Emit `[offset, offset + len)` of it: slice `content.str` for
 *   `ContentString` (UTF-16 units — identical to clipping a `toDelta` insert
 *   op's string) and index `content.getContent()` for element content.
 * @property {ID} id - replicated id of the first emitted element.
 * @property {number} index - rendered position the emitted range starts at.
 * @property {number} offset - start of the emitted range inside `content`.
 * @property {number} len - rendered length of the emitted range. `0` for
 *   `ContentFormat` markers and for pieces occupying no rendered position
 *   (renderer-hidden or unattributed tombstones).
 * @property {boolean} deleted - effective tombstone flag (renderer-aware: a
 *   restored piece clears it, an attributed tombstone keeps it).
 * @property {Array<ContentAttribute<any>>?} attrs - native attribution
 *   inputs (`createAttributionFromAttributionItems` computes the delta-level
 *   `Attribution` from them); `null` when unattributed.
 * @property {Object<string,any>|undefined} formats - folded format state at
 *   the piece (the `toDelta` `format` object equivalent). SHARED between
 *   adjacent pieces of one fold state — treat as read-only.
 */

/**
 * A forward-only, read-only cursor over one `YNode` list. Fields mirror
 * `ItemTextListPosition` (`p`/`index`/`currentFormats`) — `index` is the
 * rendered position of `p`'s left edge, `currentFormats` the format state
 * folded to it.
 */
export class RangeCursor {
  /**
   * @param {YNode<any>} parent - the list node to read.
   * @param {AbstractRenderer?} [renderer] - defaults to the node's active
   *   renderer (`this._renderer`), the `toDelta`/`applyDelta` convention.
   *   Pass `null` to force the generic interpretation.
   */
  constructor (parent, renderer = parent._renderer) {
    /**
     * @type {YNode<any>}
     */
    this.parent = parent
    /**
     * @type {AbstractRenderer?}
     */
    this.renderer = renderer
    /**
     * The next unprocessed sequence item — a parked cursor keeps `index` at
     * its left edge.
     * @type {import('../structs/Item.js').Item?}
     */
    this.p = parent._start
    /**
     * Rendered units strictly before `p` — the
     * `ItemTextListPosition#index`/`ArraySearchMarker#index` space
     * (countable, non-deleted units while `renderer === null`).
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
   * Read-seed eligibility is deliberately WEAKER than `applyDelta`'s
   * mutation seed (UPSTREAM.md P5): a read may resume on ANY item at-or-left
   * of the target — the forward fold reproduces format state from the
   * snapshot — while the mutation cursor must anchor on the FIRST item at
   * the index (its `p.left` must be countable-or-null). Both consume the
   * same marker records and snapshots.
   *
   * Restricted to `renderer === null` for the same reason the mutation seed
   * is: `marker.index` records the raw countable space, which a renderer's
   * `contentLength` can reinterpret.
   *
   * @param {number} index
   */
  seek (index) {
    const parent = this.parent
    const ms = parent._searchMarker
    if (ms === null || this.renderer !== null) return
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
   * Fold one `ContentFormat` piece into the cursor's format state — the
   * `!deleted` gate mirrors `ItemTextListPosition#forward`/`toDelta`: a
   * tombstoned marker (or a piece the renderer renders as deleted) applies
   * nothing.
   *
   * @param {AttributedContent<any>} c
   * @param {{ markers: number }?} stats
   */
  _foldPiece (c, stats) {
    if (c.content.constructor !== ContentFormat) return
    if (!c.deleted) {
      updateCurrentFormats(this.currentFormats, /** @type {ContentFormat} */ (c.content))
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
        if (v != null) (f ??= {})[k] = v
      })
      this._formatsObj = f
    }
    return f
  }

  /**
   * Emit the {@link RangePiece}s of `[i0, i1)` — a bounded, read-only walk
   * of the item list producing the same pieces `toDelta`'s current-state
   * render consumes (`readItemPieces`), clipped to the range and carrying
   * folded format state + native attribution inputs.
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
    /**
     * Per-item attributed pieces buffer (reused across items), plus the
     * trivial-piece scratch `readItemPieces` reuses — `cs` is drained
     * before the next item, so one allocation serves the whole read.
     * @type {Array<AttributedContent<any>>}
     */
    const cs = []
    /**
     * @type {AttributedContent<any>?}
     */
    let csScratch = null
    // Items stepped since the cursor passed the last checkpoint — a sparse
    // marker is recorded at every `READ_PLANT_GAP` boundary during a cold
    // walk (the checkpoint pool only fills where work actually happens —
    // `findMarker`'s merge-left rule cannot anchor mid-run in
    // same-client-contiguous lists, so read-driven planting is what makes
    // read-only workloads bounded). Index space is the raw countable one,
    // hence the `renderer === null` gate — same space markers record.
    let stepsSincePlant = 0
    const planting = this.renderer === null && parent._searchMarker !== null
    while (this.p !== null) {
      const item = this.p
      const start = this.index
      const end = start + rendererContentLength(this.renderer, item)
      if (stats !== null) stats.items++
      if (end <= i0) {
        // Boundary checkpoint — BEFORE folding the item (the snapshot is
        // the format state at its left edge).
        if (planting && ++stepsSincePlant >= READ_PLANT_GAP) {
          plantSearchMarker(parent, item, start, this.currentFormats)
          stepsSincePlant = 0
        }
        // Prefix item — only format state can matter. `readItemPieces`
        // gives marker pieces their effective `deleted` flag (renderer-
        // aware), identical to `toDelta`'s fold.
        if (item.content.constructor === ContentFormat) {
          cs.length = 0
          readItemPieces(cs, this.renderer, item, csScratch)
          if (csScratch === null) csScratch = cs[0] ?? null
          for (let k = 0; k < cs.length; k++) {
            this._foldPiece(cs[k], stats)
          }
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
      // Overlapping item — produce its attributed pieces (the shared
      // physical-sequence interpretation).
      cs.length = 0
      readItemPieces(cs, this.renderer, item, csScratch)
      if (csScratch === null) csScratch = cs[0] ?? null
      /**
       * Rendered position of the piece currently being processed.
       * @type {number}
       */
      let pix = start
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k]
        const content = c.content
        if (content.constructor === ContentFormat) {
          this._foldPiece(c, stats)
          // Marker pieces reach the stream only when attributed — they
          // occupy no rendered position.
          if (c.attrs != null) {
            out.push({
              content,
              id: createID(item.id.client, c.clock),
              index: pix,
              offset: 0,
              len: 0,
              deleted: c.deleted,
              attrs: c.attrs,
              formats: this._emitFormats()
            })
          }
          continue
        }
        // Rendered length of this piece: `render` is the mode-1 flag
        // (`!deleted || attrs != null`) — deleted unattributed pieces
        // occupy no rendered position, attributed tombstones do (they
        // render as deletes).
        const plen = c.render && content.isCountable() ? content.getLength() : 0
        if (plen === 0) {
          if (pix >= i0 && pix < i1) {
            out.push({
              content,
              id: createID(item.id.client, c.clock),
              index: pix,
              offset: 0,
              len: 0,
              deleted: c.deleted,
              attrs: c.attrs,
              formats: this._emitFormats()
            })
          }
          continue
        }
        const lo = math.max(i0, pix)
        const hi = math.min(i1, pix + plen)
        if (lo < hi) {
          out.push({
            content,
            id: createID(item.id.client, c.clock + (lo - pix)),
            index: lo,
            offset: lo - pix,
            len: hi - lo,
            deleted: c.deleted,
            attrs: c.attrs,
            formats: this._emitFormats()
          })
        }
        pix += plen
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
