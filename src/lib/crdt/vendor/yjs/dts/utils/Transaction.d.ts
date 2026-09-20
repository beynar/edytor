export const generateNewClientId: typeof random.uint53;
/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number on messages sent and the number of observer calls.
 * If possible the user of this library should bundle as many changes as
 * possible. Here is an example to illustrate the advantages of bundling:
 *
 * @example
 * const ydoc = new Y.Doc()
 * const map = ydoc.get('map')
 * // Log content when change is triggered
 * map.observe(() => {
 *   console.log('change triggered')
 * })
 * // Each change on the map type triggers a log message:
 * map.setAttr('a', 0) // => "change triggered"
 * map.setAttr('b', 0) // => "change triggered"
 * // When put in a transaction, it will trigger the log after the transaction:
 * ydoc.transact(() => {
 *   map.setAttr('a', 1)
 *   map.setAttr('b', 1)
 * }) // => "change triggered"
 *
 * @public
 */
export class Transaction {
    /**
     * @param {Doc} doc
     * @param {any} origin
     * @param {boolean} local
     */
    constructor(doc: Doc, origin: any, local: boolean);
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    doc: Doc;
    /**
     * Describes the set of deleted items by ids
     */
    deleteSet: import("./ids.js").IdSet;
    /**
     * Describes the set of items that are cleaned up / deleted by ids. It is a subset of
     * this.deleteSet
     */
    cleanUps: import("./ids.js").IdSet;
    /**
     * Describes the set of inserted items by ids
     */
    insertSet: import("./ids.js").IdSet;
    /**
     * Holds the state before the transaction started.
     * @type {Map<Number,Number>?}
     */
    _beforeState: Map<number, number> | null;
    /**
     * Holds the state after the transaction.
     * @type {Map<Number,Number>?}
     */
    _afterState: Map<number, number> | null;
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<YNode,Set<String|null>>}
     */
    changed: Map<YNode, Set<string | null>>;
    /**
     * Stores the events for the types that observe also child elements.
     * It is mainly used by `observeDeep`.
     * @type {Map<YNode,Array<YEvent<any>>>}
     */
    changedParentTypes: Map<YNode, Array<YEvent<any>>>;
    /**
     * @type {Array<AbstractStruct>}
     */
    _mergeStructs: Array<AbstractStruct>;
    /**
     * @type {any}
     */
    origin: any;
    /**
     * Stores meta information on the transaction
     * @type {Map<any,any>}
     */
    meta: Map<any, any>;
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    local: boolean;
    /**
     * @type {Set<Doc>}
     */
    subdocsAdded: Set<Doc>;
    /**
     * @type {Set<Doc>}
     */
    subdocsRemoved: Set<Doc>;
    /**
     * @type {Set<Doc>}
     */
    subdocsLoaded: Set<Doc>;
    /**
     * @type {boolean}
     */
    _needFormattingCleanup: boolean;
    _done: boolean;
    /**
     * Holds the state before the transaction started.
     *
     * @deprecated
     * @type {Map<Number,Number>}
     */
    get beforeState(): Map<number, number>;
    /**
     * Holds the state after the transaction.
     *
     * @deprecated
     * @type {Map<Number,Number>}
     */
    get afterState(): Map<number, number>;
}
export function cleanupYTextFormatting(type: YNode): number;
export function cleanupYTextAfterTransaction(transaction: Transaction): void;
export function transact<T>(doc: Doc, f: (arg0: Transaction) => T, origin?: any, local?: boolean): T;
import * as random from 'lib0-v14/random';
import { YEvent } from './YEvent.js';
