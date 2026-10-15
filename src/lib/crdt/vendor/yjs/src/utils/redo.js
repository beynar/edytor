/**
 * YP18: what remains of the engine's UndoManager — the struct primitives an
 * undo is made of. The history itself (stacks, capture, the undo and redo
 * transactions) is edytor's (`src/lib/crdt/doc/history.ts`).
 */
import { Item } from '../structs/Item.js'
import { createID } from './ID.js'
import { getItemCleanStart } from './transaction-helpers.js'

/**
 * Redoes the effect of this operation.
 *
 * @param {Transaction} transaction The Yjs instance.
 * @param {Item} item
 * @param {Set<Item>} redoitems
 * @param {IdSet} itemsToDelete
 * @param {function(ID):boolean} [deletedByHistory] Whether a step of the history deletes the item `id` names (YP18)
 *
 * @return {Item|null}
 *
 * @private
 */
export const redoItem = (transaction, item, redoitems, itemsToDelete, deletedByHistory = () => false) => {
  const doc = transaction.doc
  const store = doc.store
  const ownClientID = doc.clientID
  const redone = item.redone
  if (redone !== null) {
    return getItemCleanStart(transaction, redone)
  }
  let parentItem = /** @type {YNode} */ (item.parent)._item
  /**
   * @type {Item|null}
   */
  let left = null
  /**
   * @type {Item|null}
   */
  let right
  // make sure that parent is redone
  if (parentItem !== null && parentItem.removed) { // YP20: a held parent is alive
    // try to undo parent if it will be undone anyway
    if (parentItem.redone === null && (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems, itemsToDelete, deletedByHistory) === null)) {
      return null
    }
    while (parentItem.redone !== null) {
      parentItem = getItemCleanStart(transaction, parentItem.redone)
    }
  }
  /**
   * @type {YNode}
   */
  const parentType = /** @type {YNode} */ (parentItem === null ? item.parent : /** @type {ContentType} */ (parentItem.content).type)

  if (item.parentSub === null) {
    // Is an array item. Insert at the old position
    left = item.left
    right = item
    // find next cloned_redo items
    while (left !== null) {
      /**
       * @type {Item|null}
       */
      let leftTrace = left
      // trace redone until parent matches
      while (leftTrace !== null && /** @type {YNode} */ (leftTrace.parent)._item !== parentItem) {
        leftTrace = leftTrace.redone === null ? null : getItemCleanStart(transaction, leftTrace.redone)
      }
      if (leftTrace !== null && /** @type {YNode} */ (leftTrace.parent)._item === parentItem) {
        left = leftTrace
        break
      }
      left = left.left
    }
    while (right !== null) {
      /**
       * @type {Item|null}
       */
      let rightTrace = right
      // trace redone until parent matches
      while (rightTrace !== null && /** @type {YNode} */ (rightTrace.parent)._item !== parentItem) {
        rightTrace = rightTrace.redone === null ? null : getItemCleanStart(transaction, rightTrace.redone)
      }
      if (rightTrace !== null && /** @type {YNode} */ (rightTrace.parent)._item === parentItem) {
        right = rightTrace
        break
      }
      right = right.right
    }
  } else {
    right = null
    if (item.right) {
      left = item
      // Iterate right while right is in itemsToDelete
      // If it is intended to delete right while item is redone, we can expect that item should replace right.
      while (left !== null && left.right !== null && (left.right.redone || itemsToDelete.hasId(left.right.id) || deletedByHistory(left.right.id))) {
        left = left.right
        // follow redone
        while (left.redone) left = getItemCleanStart(transaction, left.redone)
      }
      if (left && left.right !== null) {
        // It is not possible to redo this item because it conflicts with a
        // change from another client
        return null
      }
    } else {
      left = parentType._map.get(item.parentSub) || null
    }
    if (left !== null && /** @type {YNode} */ (left.parent)._item !== parentItem) {
      left = parentType._map.get(item.parentSub) || null
    }
  }
  const nextClock = store.getClock(ownClientID)
  const nextId = createID(ownClientID, nextClock)
  const redoneItem = new Item(
    nextId,
    left, left && left.lastId,
    right, right && right.id,
    parentType,
    item.parentSub,
    item.content.copy()
  )
  item.redone = nextId
  keepItem(redoneItem, true)
  redoneItem.integrate(transaction, 0)
  return redoneItem
}

/**
 * Make sure that neither item nor any of its parents is ever deleted.
 *
 * This property does not persist when storing it into a database or when
 * sending it to other peers
 *
 * @param {Item|null} item
 * @param {boolean} keep
 */
export const keepItem = (item, keep) => {
  while (item !== null && item.keep !== keep) {
    item.keep = keep
    item = /** @type {YNode} */ (item.parent)._item
  }
}
