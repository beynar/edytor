/**
 * YEvent describes the changes on a YNode.
 */
export class YEvent {
    /**
     * @param {YNode} target The changed type.
     * @param {import('./Transaction.js').Transaction} transaction
     * @param {Set<any>?} subs The keys that changed
     */
    constructor(target: YNode, transaction: import("./Transaction.js").Transaction, subs: Set<any> | null);
    /**
     * The type on which this event was created on.
     * @type {import('../ynode.js').YNode}
     */
    target: import("../ynode.js").YNode;
    /**
     * The current target on which the observe callback is called.
     * @type {YNode}
     */
    currentTarget: YNode;
    /**
     * The transaction that triggered this event.
     * @type {import('./Transaction.js').Transaction}
     */
    transaction: import("./Transaction.js").Transaction;
    /**
     * Whether the children changed.
     * @type {Boolean}
     * @private
     */
    private childListChanged;
    /**
     * Set of all changed attributes.
     * @type {Set<string>}
     */
    keysChanged: Set<string>;
    /**
     * Check if a struct is deleted by this event.
     *
     * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
     *
     * @param {AbstractStruct} struct
     * @return {boolean}
     */
    deletes(struct: AbstractStruct): boolean;
    /**
     * Check if a struct is added by this event.
     *
     * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
     *
     * @param {AbstractStruct} struct
     * @return {boolean}
     */
    adds(struct: AbstractStruct): boolean;
}
