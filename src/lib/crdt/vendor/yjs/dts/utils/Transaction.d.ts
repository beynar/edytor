export const generateNewClientId: typeof random.uint53;
/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number of messages sent.
 *
 * YP19: a commit is told through the document's events (`commit`, then
 * `afterTransaction`); nodes have no observers.
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
     * Describes the set of inserted items by ids
     */
    insertSet: import("./ids.js").IdSet;
    /**
     * YP20: the visibility changes hold records made, in order: per item,
     * `client, clock, len` (`len > 0`: shown, `< 0`: hidden; an item removed
     * while held is logged shown, as the delete set counts it hidden).
     * @type {Array<number>}
     */
    holds: Array<number>;
    /**
     * YP22: the units whose mover changed (a move record integrated or
     * deleted, a moved unit removed), in order: per item `client, clock, len`.
     * @type {Array<number>}
     */
    moves: Array<number>;
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<YNode,Set<String|null>>}
     */
    changed: Map<YNode, Set<string | null>>;
    /**
     * @type {Array<AbstractStruct>}
     */
    _mergeStructs: Array<AbstractStruct>;
    /**
     * @type {any}
     */
    origin: any;
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    local: boolean;
}
export function transact<T>(doc: Doc, f: (arg0: Transaction) => T, origin?: any, local?: boolean): T;
import * as random from 'lib0-v14/random';
