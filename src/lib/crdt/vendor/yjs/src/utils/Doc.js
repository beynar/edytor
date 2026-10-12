/**
 * @module Y
 */

import { ObservableV2 } from 'lib0-v14/observable'
import * as map from 'lib0-v14/map'

import { StructStore } from './StructStore.js'
import { transact, generateNewClientId } from './Transaction.js'
import { YNode } from '../ynode.js'

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 */

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.commit
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 */

/**
 * A Yjs instance handles the state of shared data. YP19: no subdocuments,
 * no load/sync state, no guid — a document is its store, its root nodes and
 * its transaction events.
 * @extends ObservableV2<DocEvents>
 */
export class Doc extends ObservableV2 {
  /**
   * YP14: the default of every document's `keepReplaced` (`null`: no node is
   * kept, upstream's semantics). A binder sets it once for its documents.
   * @type {((item: import('../structs/Item.js').Item) => boolean) | null}
   */
  static keepReplaced = null

  /**
   * @param {DocOpts} opts configuration
   */
  constructor ({ gc = true, gcFilter = () => true } = {}) {
    super()
    this.gc = gc
    this.gcFilter = gcFilter
    /**
     * YP14: which node values a concurrent write of the same key replaced keep
     * their subtree (`isKeptReplaced` in `utils/transaction-helpers.js`);
     * `null`: the class's {@link Doc.keepReplaced}.
     * @type {((item: import('../structs/Item.js').Item) => boolean) | null}
     */
    this.keepReplaced = null
    this.clientID = generateNewClientId()
    /**
     * YP13: the greatest Lamport timestamp of a paired mark this document
     * integrated (see `utils/marks.js`).
     * @type {number}
     */
    this._markClock = 0
    /**
     * @type {Map<string, YNode>}
     */
    this.share = new Map()
    this.store = new StructStore()
    /**
     * @type {Transaction | null}
     */
    this._transaction = null
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = []
    this.isDestroyed = false
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @return T
   *
   * @public
   */
  transact (f, origin = null) {
    return transact(this, f, origin)
  }

  /**
   * The root node named `key`, created on first access.
   *
   * @param {string} [key]
   * @return {YNode}
   */
  get (key = '') {
    return map.setIfUndefined(this.share, key, () => {
      const t = new YNode(null)
      t._integrate(this, null)
      return t
    })
  }

  /**
   * Emit `destroy` to the document's listeners and drop them.
   */
  destroy () {
    this.isDestroyed = true
    this.emit('destroy', [this])
    super.destroy()
  }
}
