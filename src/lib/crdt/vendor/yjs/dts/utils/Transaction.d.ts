export const generateNewClientId: typeof random.uint53;
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
    log: Array<number>;
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
