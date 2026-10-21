import * as math from 'lib0-v14/math'
import { callAll } from 'lib0-v14/function'

import { createIdSet } from './ids.js'
import { writeUpdateMessageFromTransaction } from './encoding-helpers.js'
import { UpdateEncoder } from './UpdateEncoder.js'
import { findIndexSS, tryGcDeleteSet, tryMerge, tryToMergeWithLefts } from './transaction-helpers.js'
import * as random from 'lib0-v14/random'

export const generateNewClientId = random.uint53

/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number of messages sent.
 *
 * YP19: a commit is told through the document's events (`commit`, then
 * `afterTransaction`); nodes have no observers. YP30: `beforeCommit` runs
 * before them, inside the transaction.
 *
 * @public
 */
export class Transaction {
  /**
   * @param {Doc} doc
   * @param {any} origin
   * @param {boolean} local
   */
  constructor (doc, origin, local) {
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    this.doc = doc
    /**
     * Describes the set of deleted items by ids
     */
    this.deleteSet = createIdSet()
    /**
     * Describes the set of inserted items by ids
     */
    this.insertSet = createIdSet()
    // YP33 begin (edytor fork: one log of what the transaction did to items — see UPSTREAM.md YP33)
    /**
     * What the transaction did to items, in order: per run of one writer's
     * items `kind, client, clock, len` (an item that continues the last entry
     * extends it). Kind 0, an edit: integrated (`len > 0`, before its content
     * integrates; an item integrated removed logs none) or removed (`len < 0`);
     * kind 1, a hold record's
     * (YP20): shown (`len > 0`) or hidden (`< 0`; an item removed while held
     * is logged shown, so an item's kinds 0 and 1 sum to its visibility
     * change); kind 2, its mover changed (YP22: a move record integrated or
     * deleted, a moved unit removed).
     * @type {Array<number>}
     */
    this.log = []
    // YP33 end
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<YNode,Set<String|null>>}
     */
    this.changed = new Map()
    /**
     * @type {Array<AbstractStruct>}
     */
    this._mergeStructs = []
    /**
     * @type {any}
     */
    this.origin = origin
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    this.local = local
  }
}

/**
 * @param {Array<Transaction>} transactionCleanups
 * @param {number} i
 */
const cleanupTransactions = (transactionCleanups, i) => {
  if (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i]
    const doc = transaction.doc
    const store = doc.store
    const ds = transaction.deleteSet
    const mergeStructs = transaction._mergeStructs
    // insertIntoIdSet(store.ds, ds)
    try {
      // A remote change may have moved what a search marker counted: drop them.
      if (!transaction.local) {
        transaction.changed.forEach((_subs, type) => {
          if (type._searchMarker) type._searchMarker.length = 0
        })
      }
      // Each listener runs even if another throws (the first error is rethrown).
      callAll([
        () => doc.emit('commit', [transaction, doc]),
        () => doc.emit('afterTransaction', [transaction, doc])
      ], [])
    } finally {
      // Replace deleted items with ItemDeleted / GC.
      // This is where content is actually remove from the Yjs Doc.
      if (doc.gc) {
        tryGcDeleteSet(transaction, ds, doc.gcFilter)
      }
      tryMerge(ds, store)

      // on all affected store.clients props, try to merge
      transaction.insertSet.clients.forEach((ids, client) => {
        const firstClock = ids.getIds()[0].clock
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
        // we iterate from right to left so we can safely remove entries
        const firstChangePos = math.max(findIndexSS(structs, firstClock), 1)
        for (let i = structs.length - 1; i >= firstChangePos;) {
          i -= 1 + tryToMergeWithLefts(structs, i)
        }
      })
      // try to merge mergeStructs
      // @todo: it makes more sense to transform mergeStructs to a DS, sort it, and merge from right to left
      //        but at the moment DS does not handle duplicates
      for (let i = mergeStructs.length - 1; i >= 0; i--) {
        const { client, clock } = mergeStructs[i].id
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
        const replacedStructPos = findIndexSS(structs, clock)
        if (replacedStructPos + 1 < structs.length) {
          if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
            continue // no need to perform next check, both are already merged
          }
        }
        if (replacedStructPos > 0) {
          tryToMergeWithLefts(structs, replacedStructPos)
        }
      }
      if (!transaction.local && transaction.insertSet.clients.has(doc.clientID)) {
        console.log('[yjs] Changed the client-id because another client seems to be using it.') // YP15
        doc.clientID = generateNewClientId()
      }
      if (doc._observers.has('update')) {
        const encoder = new UpdateEncoder()
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
        if (hasContent) {
          doc.emit('update', [encoder.toUint8Array(), transaction.origin, doc, transaction])
        }
      }

      if (transactionCleanups.length <= i + 1) {
        doc._transactionCleanups = []
        doc.emit('afterAllTransactions', [doc, transactionCleanups])
      } else {
        cleanupTransactions(transactionCleanups, i + 1)
      }
    }
  }
}

/**
 * Implements the functionality of `y.transact(()=>{..})`
 *
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} [origin=true]
 * @param {boolean} [local=true]
 * @return {T}
 *
 * @function
 */
export const transact = (doc, f, origin = null, local = true) => {
  const transactionCleanups = doc._transactionCleanups
  let initialCall = false
  /**
   * @type {any}
   */
  let result = null
  if (doc._transaction === null) {
    initialCall = true
    doc._transaction = new Transaction(doc, origin, local)
    transactionCleanups.push(doc._transaction)
    if (transactionCleanups.length === 1) {
      doc.emit('beforeAllTransactions', [doc])
    }
    doc.emit('beforeTransaction', [doc._transaction, doc])
  }
  try {
    result = f(doc._transaction)
  } finally {
    if (initialCall) {
      try {
        // YP30 begin: the outermost function returned (or threw), the
        // transaction still open: a `beforeCommit` listener's writes join it.
        if (doc._observers.has('beforeCommit')) {
          doc.emit('beforeCommit', [doc._transaction, doc])
        }
        // YP30 end
      } finally {
        const finishCleanup = doc._transaction === transactionCleanups[0]
        doc._transaction = null
        if (finishCleanup) {
          // The first transaction ended, now process observer calls.
          // Observer call may create new transactions for which we need to call the observers and do cleanup.
          // We don't want to nest these calls, so we execute these calls one after
          // another.
          // Also we need to ensure that all cleanups are called, even if the
          // observes throw errors.
          // This file is full of hacky try {} finally {} blocks to ensure that an
          // event can throw errors and also that the cleanup is called.
          cleanupTransactions(transactionCleanups, 0)
        }
      }
    }
  }
  return result
}
