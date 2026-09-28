/**
 * @template {DeltaConf} DConf
 * YEvent describes the changes on a YNode.
 */
export class YEvent<DConf extends DeltaConf> {
    /**
     * @param {YNode<DConf>} target The changed type.
     * @param {import('./Transaction.js').Transaction} transaction
     * @param {Set<any>?} subs The keys that changed
     */
    constructor(target: YNode<DConf>, transaction: import("./Transaction.js").Transaction, subs: Set<any> | null);
    /**
     * The type on which this event was created on.
     * @type {import('../ynode.js').YNode<DConf>}
     */
    target: import("../ynode.js").YNode<DConf>;
    /**
     * The current target on which the observe callback is called.
     * @type {YNode<any>}
     */
    currentTarget: YNode<any>;
    /**
     * The transaction that triggered this event.
     * @type {import('./Transaction.js').Transaction}
     */
    transaction: import("./Transaction.js").Transaction;
    /**
     * @type {Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>|null}
     */
    _delta: Delta<import("../ynode.js").DeltaConfDeltaToYNode<DConf>> | null;
    /**
     * @type {Delta<DConf>|null}
     */
    _deltaDeep: Delta<DConf> | null;
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
    /**
     * @template {boolean} [Deep=false]
     * @param {object} [opts]
     * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to the target type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
     * @param {Deep} [opts.deep]
     * @return {Deep extends true ? Delta<DConf> : Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
     *
     * @public
     */
    public getDelta<Deep extends boolean = false>({ renderer, deep }?: {
        renderer?: import("./renderer-helpers.js").AbstractRenderer | null | undefined;
        deep?: Deep | undefined;
    }): Deep extends true ? Delta<DConf> : Delta<import("../ynode.js").DeltaConfDeltaToYNode<DConf>>;
    /**
     * Compute the changes in the delta format.
     * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
     *
     * @type {Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
     * @public
     */
    public get delta(): Delta<import("../ynode.js").DeltaConfDeltaToYNode<DConf>>;
    /**
     * Compute the changes in the delta format.
     * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
     *
     * @type {Delta<DConf>} The Delta representation of this type.
     * @public
     */
    public get deltaDeep(): Delta<DConf>;
}
