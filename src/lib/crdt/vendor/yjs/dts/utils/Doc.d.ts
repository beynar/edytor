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
export class Doc extends ObservableV2<DocEvents> {
    /**
     * YP14: the default of every document's `keepReplaced` (`null`: no node is
     * kept, upstream's semantics). A binder sets it once for its documents.
     * @type {((item: import('../structs/Item.js').Item) => boolean) | null}
     */
    static keepReplaced: ((item: import("../structs/Item.js").Item) => boolean) | null;
    /**
     * @param {DocOpts} opts configuration
     */
    constructor({ gc, gcFilter }?: DocOpts);
    gc: boolean;
    gcFilter: (arg0: Item) => boolean;
    /**
     * YP14: which node values a concurrent write of the same key replaced keep
     * their subtree (`isKeptReplaced` in `utils/transaction-helpers.js`);
     * `null`: the class's {@link Doc.keepReplaced}.
     * @type {((item: import('../structs/Item.js').Item) => boolean) | null}
     */
    keepReplaced: ((item: import("../structs/Item.js").Item) => boolean) | null;
    clientID: number;
    /**
     * YP13, YP22: the greatest Lamport timestamp of a paired mark or a move
     * record this document integrated (see `utils/marks.js`,
     * `structs/Item.js` `ContentMove`); the next one it writes takes `_clock + 1`.
     * @type {number}
     */
    _clock: number;
    /**
     * @type {Map<string, YNode>}
     */
    share: Map<string, YNode>;
    store: StructStore;
    /**
     * @type {Transaction | null}
     */
    _transaction: Transaction | null;
    /**
     * @type {Array<Transaction>}
     */
    _transactionCleanups: Array<Transaction>;
    isDestroyed: boolean;
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
    public transact<T>(f: (arg0: Transaction) => T, origin?: any): T;
    /**
     * The root node named `key`, created on first access.
     *
     * @param {string} [key]
     * @return {YNode}
     */
    get(key?: string): YNode;
}
export type DocOpts = {
    /**
     * Disable garbage collection (default: gc=true)
     */
    gc?: boolean | undefined;
    /**
     * Will be called before an Item is garbage collected. Return false to keep the Item.
     */
    gcFilter?: ((arg0: Item) => boolean) | undefined;
};
export type DocEvents = {
    destroy: (arg0: Doc) => void;
    update: (arg0: Uint8Array<ArrayBuffer>, arg1: any, arg2: Doc, arg3: Transaction) => void;
    beforeAllTransactions: (arg0: Doc) => void;
    beforeTransaction: (arg0: Transaction, arg1: Doc) => void;
    commit: (arg0: Transaction, arg1: Doc) => void;
    afterTransaction: (arg0: Transaction, arg1: Doc) => void;
    afterAllTransactions: (arg0: Doc, arg1: Array<Transaction>) => void;
};
import { ObservableV2 } from 'lib0-v14/observable';
import { YNode } from '../ynode.js';
import { StructStore } from './StructStore.js';
