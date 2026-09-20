import * as dpos from 'lib0-v14/delta/position'
import * as map from 'lib0-v14/map'

import { createRelativePosition, createAbsolutePositionFromRelativePosition } from './RelativePosition.js'
import { rendererContentLength } from './renderer-helpers.js'
import { getPathTo } from './YEvent.js'
import { isParentOf } from './isParentOf.js'
import { createID, findRootTypeKey } from './ID.js'
import { $doc } from './schemas.js'
import { Item, ContentType, followRedone } from '../structs/Item.js'

/**
 * Transform lib0 delta positions ({@link DeltaPosition} — path-based, ephemeral, relative to a
 * rendered delta tree) to {@link import('./RelativePosition.js').RelativePosition}s (item-ID-based,
 * converging) and back. Use this to persist or sync cursors/marks (e.g. the result of
 * `position.marksToPositions(node.delta)`) robustly through Yjs.
 *
 * Both directions operate on a set of positions and return results 1:1 with the input (`null` for
 * positions that can't be resolved). Extra fields of a `MarkPos` (`id`, `attrs`) are ignored — zip
 * them back yourself: `marksToPositions(d).map((m, i) => ({ id: m.id, rpos: rposs[i] }))`.
 *
 * A delta position is only meaningful against the delta produced by a specific renderer. Both
 * transforms default to the root node's renderer (`root.useRenderer(..)`) — the same default that
 * `node.toDelta()` / `node.delta` use — so positions taken from those deltas resolve correctly
 * without options. When the delta was rendered differently (e.g. a doc-rooted `diffDocsToDelta`),
 * pass that renderer explicitly.
 *
 * @module position-helpers
 */

/**
 * @typedef {import('lib0-v14/delta/position').Pos} DeltaPosition
 */

/**
 * @typedef {import('./Renderer.js').AbstractRenderer} AbstractRenderer
 */

/**
 * @param {YNode<any>|Doc} root
 * @param {{ renderer?: AbstractRenderer|null }} opts
 * @return {AbstractRenderer|null}
 */
const resolveRenderer = (root, opts) => opts.renderer !== undefined ? opts.renderer : ($doc.check(root) ? null : root._renderer)

/**
 * The child node at a rendered slot / map entry: node children are always ContentType items.
 * Scalars (and subdocs) yield `null` — a delta position cannot descend into them.
 *
 * @param {Item} item
 * @return {YNode<any>|null}
 */
const contentTypeChild = item => item.content.constructor === ContentType ? /** @type {ContentType} */ (item.content).type : null

/**
 * The current map entry for `key`, unless it is absent or deleted without being rendered
 * (mirrors the renderer-aware map lookup of `applyDelta`).
 *
 * @param {YNode<any>} node
 * @param {string} key
 * @param {AbstractRenderer|null} renderer
 * @return {Item|null}
 */
const mapItemGet = (node, key, renderer) => {
  const it = node._map.get(key)
  return it === undefined || (it.deleted && rendererContentLength(renderer, it) === 0) ? null : it
}

/**
 * Transform delta positions (paths relative to `root`) to relative positions.
 *
 * Positions are resolved as a batch: one linked-list walk per visited node serves all positions
 * inside it, so many cursors in the same text cost a single traversal.
 *
 * When `root` is a Doc, paths must start with a root-type name (matching the doc-rooted deltas of
 * `diffDocsToDelta`). A terminal string step (attribute leaf, e.g. `['key']`) anchors the map
 * entry's item — such a relative position round-trips through this module, but its index is
 * meaningless to `createAbsolutePositionFromRelativePosition`. Unresolvable positions map to
 * `null`: the empty path `[]` (a node reference doesn't round-trip), descent into scalars or
 * subdocs, missing attributes, and out-of-range non-terminal indexes.
 *
 * @param {YNode<any>|Doc} root
 * @param {Array<DeltaPosition>} positions
 * @param {{ renderer?: AbstractRenderer|null }} [opts]
 * @return {Array<import('./RelativePosition.js').RelativePosition|null>}
 */
export const createRelativePositionsFromDeltaPositions = (root, positions, opts = {}) => {
  const renderer = resolveRenderer(root, opts)
  /**
   * @type {Array<import('./RelativePosition.js').RelativePosition|null>}
   */
  const results = new Array(positions.length).fill(null)
  /**
   * @typedef {{ posIdx: number, pos: DeltaPosition, depth: number }} Task
   */
  /**
   * @type {Map<YNode<any>, Array<Task>>}
   */
  let layer = new Map()
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]
    if (pos == null || pos.path.length === 0) continue
    if ($doc.check(root)) {
      const step0 = pos.path[0]
      // doc-rooted paths start with a root-type name; root types are not items, so a terminal
      // string at doc level has nothing to anchor
      if (typeof step0 !== 'string' || pos.path.length === 1) continue
      map.setIfUndefined(layer, root.get(step0), () => /** @type {Array<Task>} */ ([])).push({ posIdx: i, pos, depth: 1 })
    } else {
      map.setIfUndefined(layer, root, () => /** @type {Array<Task>} */ ([])).push({ posIdx: i, pos, depth: 0 })
    }
  }
  while (layer.size > 0) {
    /**
     * @type {Map<YNode<any>, Array<Task>>}
     */
    const nextLayer = new Map()
    layer.forEach((tasks, node) => {
      /**
       * @type {Array<{ eff: number, isLast: boolean, task: Task }>}
       */
      const walkTargets = []
      for (const task of tasks) {
        const { posIdx, pos, depth } = task
        const step = pos.path[depth]
        const isLast = depth === pos.path.length - 1
        if (typeof step === 'string') {
          const it = mapItemGet(node, step, renderer)
          if (it === null) continue
          if (isLast) {
            // attribute leaf: anchor the item holding the attribute value
            results[posIdx] = createRelativePosition(node, it.lastId, pos.assoc === -1 ? -1 : 0)
          } else {
            const child = contentTypeChild(it)
            if (child !== null) {
              map.setIfUndefined(nextLayer, child, () => /** @type {Array<Task>} */ ([])).push({ posIdx, pos, depth: depth + 1 })
            }
          }
        } else if (Number.isInteger(step) && step >= 0) {
          if (isLast && pos.assoc === -1 && step === 0) {
            results[posIdx] = createRelativePosition(node, null, -1)
          } else {
            // a left-associated cursor gap binds to the preceding character (cf. createRelativePositionFromTypeIndex)
            walkTargets.push({ eff: isLast && pos.assoc === -1 ? step - 1 : step, isLast, task })
          }
        }
      }
      if (walkTargets.length > 0) {
        // one walk over the item list resolves all targets of this node
        walkTargets.sort((a, b) => a.eff - b.eff)
        let item = node._start
        let itemLen = item === null ? 0 : rendererContentLength(renderer, item)
        let cum = 0
        /**
         * @type {Item|null}
         */
        let last = null
        for (const { eff, isLast, task } of walkTargets) {
          while (item !== null && cum + itemLen <= eff) {
            cum += itemLen
            last = item
            item = item.right
            itemLen = item === null ? 0 : rendererContentLength(renderer, item)
          }
          if (item !== null) {
            const offset = eff - cum
            if (isLast) {
              results[task.posIdx] = createRelativePosition(node, createID(item.id.client, item.id.clock + offset), task.pos.assoc === -1 ? -1 : 0)
            } else {
              const child = contentTypeChild(item)
              if (child !== null) {
                map.setIfUndefined(nextLayer, child, () => /** @type {Array<Task>} */ ([])).push({ posIdx: task.posIdx, pos: task.pos, depth: task.depth + 1 })
              }
            }
          } else if (isLast) {
            // walked past the end — same semantics as createRelativePositionFromTypeIndex
            const yassoc = task.pos.assoc === -1 ? -1 : 0
            results[task.posIdx] = createRelativePosition(node, yassoc < 0 && last !== null ? last.lastId : null, yassoc)
          }
        }
      }
    })
    layer = nextLayer
  }
  return results
}

/**
 * @param {YNode<any>} node
 * @param {AbstractRenderer|null} renderer
 * @return {number}
 */
const renderedLength = (node, renderer) => {
  let len = 0
  for (let item = node._start; item !== null; item = item.right) {
    len += rendererContentLength(renderer, item)
  }
  return len
}

/**
 * Transform relative positions to delta positions (paths relative to `root`).
 *
 * Resolution is batched: the path from `root` to a node is computed once per distinct node, however
 * many positions live inside it. Positions outside of `root`'s subtree (or from another doc) map to
 * `null`, as do attribute-leaf anchors whose attribute no longer exists.
 *
 * `followUndoneDeletions` (default `true`) matches `createAbsolutePositionFromRelativePosition` —
 * set it to `false` for consistent results across clients (https://github.com/yjs/yjs/issues/638).
 * The path from `root` down to the position's node never follows undone deletions.
 *
 * @param {YNode<any>|Doc} root
 * @param {Array<import('./RelativePosition.js').RelativePosition|null>} rposs - `null` entries (e.g. from the forward transform) map to `null`
 * @param {{ renderer?: AbstractRenderer|null, followUndoneDeletions?: boolean }} [opts]
 * @return {Array<DeltaPosition|null>}
 */
export const createDeltaPositionsFromRelativePositions = (root, rposs, opts = {}) => {
  const renderer = resolveRenderer(root, opts)
  const followUndoneDeletions = opts.followUndoneDeletions ?? true
  const isDocRoot = $doc.check(root)
  const doc = isDocRoot ? /** @type {Doc} */ (root) : /** @type {YNode<any>} */ (root).doc
  /**
   * @type {Array<DeltaPosition|null>}
   */
  const results = new Array(rposs.length).fill(null)
  if (doc === null) return results
  const store = doc.store
  /**
   * @param {YNode<any>} node
   * @return {Array<string|number>|null}
   */
  const pathFromRoot = node => {
    if (isDocRoot) {
      if (node.doc !== doc) return null
      let top = node
      while (top._item !== null) {
        top = /** @type {YNode<any>} */ (top._item.parent)
      }
      return [findRootTypeKey(top), ...getPathTo(top, node, renderer)]
    }
    if (node !== root && (node._item === null || !isParentOf(/** @type {YNode<any>} */ (root), node._item))) return null
    return getPathTo(/** @type {YNode<any>} */ (root), node, renderer)
  }
  /**
   * @type {Map<YNode<any>, Array<string|number>|null>}
   */
  const pathCache = new Map()
  /**
   * @type {Map<YNode<any>, number>}
   */
  const renderedLenCache = new Map()
  for (let i = 0; i < rposs.length; i++) {
    const rpos = rposs[i]
    if (rpos == null) continue
    /**
     * @type {YNode<any>}
     */
    let node
    /**
     * @type {string|number}
     */
    let terminal
    if (rpos.item !== null) {
      const rightID = rpos.item
      if (store.getClock(rightID.client) <= rightID.clock) continue
      const { item } = followUndoneDeletions ? followRedone(store, rightID) : { item: store.getItem(rightID) }
      if (!(item instanceof Item)) continue
      if (item.parentSub !== null) {
        // attribute leaf (created by createRelativePositionsFromDeltaPositions)
        node = /** @type {YNode<any>} */ (item.parent)
        if (mapItemGet(node, item.parentSub, renderer) === null) continue
        terminal = item.parentSub
      } else {
        const apos = createAbsolutePositionFromRelativePosition(rpos, doc, followUndoneDeletions, renderer)
        if (apos === null) continue
        node = apos.type
        terminal = apos.index
      }
    } else {
      const apos = createAbsolutePositionFromRelativePosition(rpos, doc, followUndoneDeletions, renderer)
      if (apos === null) continue
      node = apos.type
      // the end-of-type index of createAbsolutePositionFromRelativePosition is the raw length —
      // a delta position must index the rendered tree
      terminal = renderer !== null && rpos.assoc >= 0
        ? map.setIfUndefined(renderedLenCache, node, () => renderedLength(apos.type, renderer))
        : apos.index
    }
    const prefix = map.setIfUndefined(pathCache, node, () => pathFromRoot(/** @type {YNode<any>} */ (node)))
    if (prefix === null) continue
    results[i] = dpos.create(prefix.concat([terminal]), rpos.assoc < 0 ? -1 : 1)
  }
  return results
}

/**
 * Transform a single delta position to a relative position - see {@link createRelativePositionsFromDeltaPositions}.
 *
 * @param {YNode<any>|Doc} root
 * @param {DeltaPosition} pos
 * @param {{ renderer?: AbstractRenderer|null }} [opts]
 * @return {import('./RelativePosition.js').RelativePosition|null}
 */
export const createRelativePositionFromDeltaPosition = (root, pos, opts) => createRelativePositionsFromDeltaPositions(root, [pos], opts)[0]

/**
 * Transform a single relative position to a delta position - see {@link createDeltaPositionsFromRelativePositions}.
 *
 * @param {YNode<any>|Doc} root
 * @param {import('./RelativePosition.js').RelativePosition|null} rpos
 * @param {{ renderer?: AbstractRenderer|null, followUndoneDeletions?: boolean }} [opts]
 * @return {DeltaPosition|null}
 */
export const createDeltaPositionFromRelativePosition = (root, rpos, opts) => createDeltaPositionsFromRelativePositions(root, [rpos], opts)[0]
