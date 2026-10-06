export function warnPrematureAccess(): void;
export function createAttributionFromAttributionItems(attrs: Array<ContentAttribute<any>> | null, deleted: boolean): Attribution | undefined;
export class ItemTextListPosition {
    /**
     * @param {Item|null} left
     * @param {Item|null} right
     * @param {number} index
     * @param {Map<string,any>} currentFormats
     * @param {AbstractRenderer?} renderer
     */
    constructor(left: Item | null, right: Item | null, index: number, currentFormats: Map<string, any>, renderer: AbstractRenderer | null);
    left: Item | null;
    right: Item | null;
    index: number;
    currentFormats: Map<string, any>;
    renderer: import("./utils/renderer-helpers.js").AbstractRenderer | null;
    /**
     * Only call this if you know that this.right is defined
     */
    forward(): void;
    /**
     * @param {Transaction} transaction
     * @param {YNode} parent
     * @param {number} length
     * @param {Object<string,any>} formats
     *
     * @function
     */
    formatText(transaction: Transaction, parent: YNode, length: number, formats: {
        [x: string]: any;
    }): void;
}
export function insertContent(transaction: Transaction, parent: YNode, currPos: ItemTextListPosition, content: import("./structs/Item.js").AbstractContent, formats: {
    [x: string]: any;
}): void;
export function insertContentHelper(transaction: Transaction, parent: YNode, currPos: ItemTextListPosition, insert: Array<any> | string, formats: {
    [x: string]: any;
}): void;
export function insertAtGapEndHelper(transaction: Transaction, parent: YNode, index: number, content: import("./structs/Item.js").AbstractContent): void;
export function deleteText(transaction: Transaction, currPos: ItemTextListPosition, length: number): ItemTextListPosition;
export class ArraySearchMarker {
    /**
     * @param {Item} p
     * @param {number} index
     */
    constructor(p: Item, index: number);
    p: Item;
    index: number;
    /**
     * Snapshot of an `ItemTextListPosition` cursor's `currentFormats` map at
     * this marker's position (the left edge of `p`), or `null` when unknown.
     * Written only at *quiescent* points — the end of `YNode#applyDelta`
     * (post-op cursor state) and `findMarker`'s read walks — never mid-
     * mutation: `formatText`'s in-flight `currentFormats` is transient and
     * proved able to capture state invalidated later in the same operation.
     * Consumed by `YNode#applyDelta` to seed a formatting-aware cursor
     * without re-walking the list from `_start`.
     *
     * Validity: the snapshot is the format state at a fixed list position, so
     * it stays correct across content inserts/deletes anywhere (they never
     * change format state; `updateMarkerChanges` keeps `index` aligned).
     * Every mutation that could change it is covered: format-item inserts
     * fold into it via `updateMarkerFormats` (list-order aware AND bounded by
     * the next live same-key format item — a marker beyond that boundary still
     * draws the key from the intervening item, so folding would corrupt it;
     * unreachable anchors get `formats = null` instead), format-item
     * tombstones clear all snapshots in `Item#delete`, and re-anchored or
     * overwritten markers clear it in `overwriteMarker`/`updateMarkerChanges`/
     * `Item#mergeWith`. Wholesale clears (`_searchMarker.length = 0`) cover
     * remote integration and undo.
     *
     * @type {Map<string,any>?}
     */
    formats: Map<string, any> | null;
    timestamp: number;
}
export function plantSearchMarker(parent: YNode<any>, p: Item, index: number, formats: Map<string, any>): void;
export function findMarker(yarray: YNode, index: number): ArraySearchMarker | null;
export function updateMarkerChanges(searchMarker: Array<ArraySearchMarker>, index: number, len: number): void;
export function callTypeObservers(type: YNode, transaction: Transaction, event: YEvent<any>): void;
/**
 * Abstract Yjs Type class.
 *
 * A `YNode` is a {@link https://github.com/dmonad/lib0 lib0} `RDT` ("replicated data type", see
 * `lib0-v14/delta/rdt.js`): it emits a `'delta'` event whenever its state changes (carrying the change
 * and the origin of the transaction that caused it), accepts foreign
 * changes via {@link YNode#applyDelta}, exposes its delta {@link YNode#$delta schema}, and can be
 * torn down via {@link YNode#destroy}. This lets a `YNode` be `bind()`-ed to any other RDT (another
 * `YNode`, an in-memory delta, a DOM subtree, …). The legacy {@link YNode#observe `observe`} /
 * {@link YNode#observeDeep `observeDeep`} `YEvent` API continues to work alongside the `'delta'`
 * channel.
 *
 * @template {delta.DeltaConf} [DConf=any]
 * @extends {ObservableV2<{ delta: (delta: delta.Delta<DConf>, origin: any) => void, destroy: (type: YNode<DConf>) => void }>}
 */
export class YNode<DConf extends delta.DeltaConf = any> extends ObservableV2<{
    delta: (delta: delta.Delta<DConf>, origin: any) => void;
    destroy: (type: YNode<DConf>) => void;
}> {
    /**
     * @template {delta.DeltaConf} DC
     * @param {delta.Delta<DC>} d
     * @return {YNode<DC>}
     */
    static from<DC extends delta.DeltaConf>(d: delta.Delta<DC>): YNode<DC>;
    /**
     * @param {delta.DeltaConfGetName<DConf>?} name
     */
    constructor(name?: delta.DeltaConfGetName<DConf> | null);
    /**
     * @type {delta.DeltaConfGetName<DConf>}
     */
    name: delta.DeltaConfGetName<DConf>;
    /**
     * @type {Item|null}
     */
    _item: Item | null;
    /**
     * @type {Map<string,Item>}
     */
    _map: Map<string, Item>;
    /**
     * @type {Item|null}
     */
    _start: Item | null;
    /**
     * @type {Doc|null}
     */
    doc: Doc | null;
    _length: number;
    /**
     * Event handlers
     * @type {EventHandler<YEvent<DeltaToYNode<DConf>>,Transaction>}
     */
    _eH: EventHandler<YEvent<DeltaToYNode<DConf>>, Transaction>;
    /**
     * Deep event handlers
     * @type {EventHandler<YEvent<DConf>,Transaction>}
     */
    _dEH: EventHandler<YEvent<DConf>, Transaction>;
    /**
     * @type {null | Array<ArraySearchMarker>}
     */
    _searchMarker: null | Array<ArraySearchMarker>;
    /**
     * Maintained deep-delta cache backing {@link YNode#delta}. `null` until `delta` is first
     * accessed; thereafter kept current on every event of this type (incrementally, by applying the
     * deep change) and re-diffed by {@link YNode#useRenderer}. Cleared by {@link YNode#clearCache}.
     *
     * INVARIANT (fingerprint-memo safety): consumers (e.g. y-sync) diff against this LIVE object
     * via {@link YNode#delta}, which memoizes `_fingerprint` on its delta/op nodes at every depth.
     * Every in-place patch — the per-transaction `apply` in `cleanupTransactions` and the
     * renderer-overlay `apply` in {@link typeApplyRendererChange} — MUST route through the lib0
     * delta builder API (`apply`), which invalidates those memos. NEVER write delta/op fields
     * directly: a direct write leaves stale memos, corrupting every subsequent fingerprint read
     * and diff. Pinned by the `testRdtFingerprintMemo*CacheDrift` tests.
     * @type {delta.DeltaBuilderAny | null}
     */
    _delta: delta.DeltaBuilderAny | null;
    _legacyTypeRef: number;
    /**
     * Whether this YText contains formats.
     * This flag is updated when a formatting item is integrated (see ContentFormat.integrate)
     */
    _hasFormatting: boolean;
    /**
     * The active default renderer. Used by `toDelta`, `applyDelta`, and the events whenever no
     * explicit renderer is passed. `null` = no renderer: content renders as-is via the generic
     * fast path. Change it via {@link YNode#useRenderer}.
     * @type {AbstractRenderer?}
     */
    _renderer: AbstractRenderer | null;
    /**
     * Bound listener on the active renderer's `'change'` event — attribution corrections that
     * happen without a Y transaction on this doc (e.g. a suggestion is accepted and the
     * renderer's attribution overlay updates). `null` while no renderer is active.
     * Managed by {@link YNode#useRenderer}; see {@link typeApplyRendererChange}.
     * @type {((changes: IdSet, origin: any, local: boolean) => void) | null}
     */
    _rendererChangeHandler: ((changes: IdSet, origin: any, local: boolean) => void) | null;
    /**
     * Schema of the deltas this type produces — part of the lib0 `RDT` interface.
     *
     * @type {s.Schema<delta.Delta<DConf>>}
     */
    get $delta(): s.Schema<delta.Delta<DConf>>;
    /**
     * The deep delta of this type (the full nested content tree, children rendered as their own
     * deltas).
     *
     * The returned value is the type's **live** maintained cache: it is materialized on first access
     * and then kept current on every event fired on this type (and re-diffed by
     * {@link YNode#useRenderer}), so a reference held across edits keeps updating in place. Clone it
     * (e.g. `type.delta.clone()`) if you need a stable snapshot, and call {@link YNode#clearCache} to
     * drop the cache.
     *
     * Consider the returned delta **done** — it must not be edited from the outside. It is
     * deliberately typed as a `Delta` (not a `DeltaBuilder`) so the mutating builder API is not
     * reachable; editing it anyway would corrupt the cache without changing the CRDT. The proper way
     * to change this type is {@link YNode#applyDelta}.
     *
     * @type {delta.Delta<DConf>}
     */
    get delta(): delta.Delta<DConf>;
    /**
     * Render the full deep current state into a fresh `isFinal` builder (so subsequent `.apply`s of
     * deep changes update content in place). Uses this type's active renderer.
     *
     * @return {delta.DeltaBuilderAny}
     */
    _renderDelta(): delta.DeltaBuilderAny;
    /**
     * Discard the cached deep delta backing {@link YNode#delta}.
     *
     * After `delta` is first accessed, the cache is updated on every event fired on this type (and
     * re-diffed by {@link YNode#useRenderer}). Call this to drop it — e.g. to reclaim memory, or to
     * force an exact recomputation after editing while a non-base renderer is active (the incremental
     * updates can drift from a fresh deep render in that case).
     */
    clearCache(): void;
    /**
     * Change the default renderer used by this type. After calling `useRenderer(renderer)`, the
     * `toDelta`, `applyDelta`, and event methods all use `renderer` whenever no explicit renderer is
     * passed (an explicit `{ renderer }` argument still overrides it per call).
     *
     * If the deep-delta cache ({@link YNode#delta}) is being maintained, or a `'delta'` listener is
     * attached, the content is re-rendered with the new renderer and the difference is emitted on the
     * `'delta'` channel only (a renderer switch is not a CRDT change, so no `YEvent` is produced, and
     * the emitted origin is `null` as no transaction is involved).
     *
     * @param {AbstractRenderer?} renderer - `null` detaches: content renders as-is again
     * @return {this}
     */
    useRenderer(renderer: AbstractRenderer | null): this;
    get length(): number;
    /**
     * Returns a fresh delta that can be used to change this YNode.
     * @type {delta.DeltaBuilder<DeltaToYNode<DConf>>}
     */
    get change(): delta.DeltaBuilder<DeltaToYNode<DConf>>;
    /**
     * @return {YNode<any>?}
     */
    get parent(): YNode<any> | null;
    /**
     * Integrate this type into the Yjs instance.
     *
     * * Save this struct in the os
     * * This type is sent to other client
     * * Observer functions are fired
     *
     * @param {Doc} y The Yjs instance
     * @param {Item|null} item
     */
    _integrate(y: Doc, item: Item | null): void;
    _prelim: any;
    /**
     * @return {YNode<DConf>}
     */
    _copy(): YNode<DConf>;
    /**
     * Creates YEvent and calls all type observers.
     * Must be implemented by each type.
     *
     * @param {Transaction} transaction
     * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
     */
    _callObserver(transaction: Transaction, parentSubs: Set<null | string>): void;
    /**
     * Observe all events that are created on this type.
     *
     * @template {(target: YEvent<DeltaToYNode<DConf>>, tr: Transaction) => void} F
     * @param {F} f Observer function
     * @return {F}
     */
    observe<F extends (target: YEvent<DeltaToYNode<DConf>>, tr: Transaction) => void>(f: F): F;
    /**
     * Observe all events that are created by this type and its children.
     *
     * @template {function(YEvent<DConf>,Transaction):void} F
     * @param {F} f Observer function
     * @return {F}
     */
    observeDeep<F extends (arg0: YEvent<DConf>, arg1: Transaction) => void>(f: F): F;
    /**
     * Unregister an observer function.
     *
     * @param {(type:YEvent<DeltaToYNode<DConf>>,tr:Transaction)=>void} f Observer function
     */
    unobserve(f: (type: YEvent<DeltaToYNode<DConf>>, tr: Transaction) => void): void;
    /**
     * Unregister an observer function.
     *
     * @param {function(YEvent<DConf>,Transaction):void} f Observer function
     */
    unobserveDeep(f: (arg0: YEvent<DConf>, arg1: Transaction) => void): void;
    /**
     * Render the difference to another ydoc (which can be empty) and highlight the differences with
     * attributions.
     *
     * Note that deleted content that was not deleted in prevYdoc is rendered as an insertion with the
     * attribution `{ isDeleted: true, .. }`.
     *
     * @template {boolean} [Deep=false]
     *
     * @param {Object} [opts]
     * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
     * @param {IdSet?} [opts.itemsToRender]
     * @param {boolean} [opts.retainInserts] - if true, retain rendered inserts with attributions
     * @param {boolean} [opts.retainDeletes] - if true, retain rendered+attributed deletes only
     * @param {IdSet?} [opts.insertedItems] - ids inserted by the change being rendered; content that is both in `insertedItems` and deleted renders as a *fresh* insert even under `retainDeletes` (it was never part of the consuming state)
     * @param {Map<YNode,Set<string|null>>|null} [opts.modified] - set of types that should be rendered as modified children
     * @param {Deep} [opts.deep] - render child types as delta
     * @return {Deep extends true ? delta.Delta<DConf> : delta.Delta<DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
     *
     * @public
     */
    public toDelta<Deep extends boolean = false>(opts?: {
        renderer?: import("./utils/renderer-helpers.js").AbstractRenderer | null | undefined;
        itemsToRender?: import("./utils/ids.js").IdSet | null | undefined;
        retainInserts?: boolean | undefined;
        retainDeletes?: boolean | undefined;
        insertedItems?: import("./utils/ids.js").IdSet | null | undefined;
        modified?: Map<YNode<any>, Set<string | null>> | null | undefined;
        deep?: Deep | undefined;
    }): Deep extends true ? delta.Delta<DConf> : delta.Delta<DeltaConfDeltaToYNode<DConf>>;
    /**
     * Render the difference to another ydoc (which can be empty) and highlight the differences with
     * attributions.
     *
     * @param {Object} [opts]
     * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
     * @return {delta.Delta<DConf>}
     */
    toDeltaDeep(opts?: {
        renderer?: import("./utils/renderer-helpers.js").AbstractRenderer | null | undefined;
    }): delta.Delta<DConf>;
    /**
     * Apply a {@link Delta} on this shared type.
     *
     * @param {delta.DeltaAny} d The changes to apply on this element.
     * @param {any} [origin] Origin of the transaction that applies this delta (stored on
     * `transaction.origin` and forwarded verbatim on the emitted `'delta'` event, so listeners can
     * recognize — and skip — changes they produced themselves; see the lib0 `RDT` spec). Defaults to `null`.
     * @param {Object} [opts]
     * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to this type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
     * @return {delta.DeltaBuilder<any>?} The lib0 `RDT` "fix" of this apply — a change measured against the
     * caller's expected state (`old.apply(d)`) that transforms it into the actual state, or `null`
     * when `d` applied cleanly. A fix is produced when `d` (or a nested `modify`/`modifyAttr`)
     * addresses a *deleted but rendered* node (e.g. a suggestion-deleted paragraph under a
     * DiffRenderer): that part of the change is not applied to the document, and its inverse
     * (`lib0-v14/delta` `inverse` against the node's rendered state) is returned — the change is
     * immediately reverted.
     *
     * @public
     */
    public applyDelta(d: delta.DeltaAny, origin?: any, { renderer }?: {
        renderer?: import("./utils/renderer-helpers.js").AbstractRenderer | null | undefined;
    }): delta.DeltaBuilder<any> | null;
    /**
     * Makes a copy of this data type that can be included somewhere else.
     *
     * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
     *
     * @return {YNode<DConf>}
     */
    clone(): YNode<DConf>;
    /**
     * Removes all elements from this YMap.
     */
    clearAttrs(): void;
    /**
     * Removes an attribute from this YXmlElement.
     *
     * @param {string} attributeName The attribute name that is to be removed.
     *
     * @public
     */
    public deleteAttr(attributeName: string): void;
    /**
     * Sets or updates an attribute.
     *
     * @template {Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol>} KEY
     * @template {delta.DeltaConfGetAttrs<DConf>[KEY]} VAL
     *
     * @param {KEY} attributeName The attribute name that is to be set.
     * @param {VAL} attributeValue The attribute value that is to be set.
     * @return {VAL}
     *
     * @public
     */
    public setAttr<KEY extends Exclude<keyof delta.DeltaConfGetAttrs<DConf>, symbol>, VAL extends delta.DeltaConfGetAttrs<DConf>[KEY]>(attributeName: KEY, attributeValue: VAL): VAL;
    /**
     * Returns an attribute value that belongs to the attribute name.
     *
     * @template {Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol|number>} KEY
     * @param {KEY} attributeName The attribute name that identifies the queried value.
     * @return {delta.DeltaConfGetAttrs<DConf>[KEY]|undefined} The queried attribute value.
     * @public
     */
    public getAttr<KEY extends Exclude<keyof delta.DeltaConfGetAttrs<DConf>, symbol | number>>(attributeName: KEY): delta.DeltaConfGetAttrs<DConf>[KEY] | undefined;
    /**
     * Returns whether an attribute exists
     *
     * @param {string} attributeName The attribute name to check for existence.
     * @return {boolean} whether the attribute exists.
     *
     * @public
     */
    public hasAttr(attributeName: string): boolean;
    /**
     * Returns all attribute name/value pairs in a JSON Object.
     *
     * @return {{ [Key in Extract<keyof delta.DeltaConfGetAttrs<DConf>,string>]?: delta.DeltaConfGetAttrs<DConf>[Key]}} A JSON Object that describes the attributes.
     *
     * @public
     */
    public getAttrs(): { [Key in Extract<keyof delta.DeltaConfGetAttrs<DConf>, string>]?: delta.DeltaConfGetAttrs<DConf>[Key]; };
    /**
     * Inserts new content at an index.
     *
     * Important: This function expects an array of content. Not just a content
     * object. The reason for this "weirdness" is that inserting several elements
     * is very efficient when it is done as a single operation.
     *
     * @example
     *  // Insert character 'a' at position 0
     *  yarray.insert(0, ['a'])
     *  // Insert numbers 1, 2 at position 1
     *  yarray.insert(1, [1, 2])
     *
     * @param {number} index The index to insert content at.
     * @param {Array<delta.DeltaConfGetChildren<DConf>>|delta.DeltaConfGetText<DConf>} content Array of content to append.
     * @param {delta.Formats} [format]
     */
    insert(index: number, content: Array<delta.DeltaConfGetChildren<DConf>> | delta.DeltaConfGetText<DConf>, format?: delta.Formats): void;
    /**
     * Insert `content` (an array of JSON values, one countable unit each) at the end of the gap at
     * live index `index`: after every deleted item and every format item that precedes the next live
     * content item, with the formats in effect there and no format item added.
     *
     * @param {number} index
     * @param {Array<any>} content
     */
    insertAtGapEnd(index: number, content: Array<any>): void;
    /**
     * Insert `content` (a string, or an array of JSON values and nodes) at
     * live index `index` with no format item: its origin is the gap's last
     * content item, its right origin the gap's next live content item, and
     * the integration places it after the gap's left-side mark items and
     * before its right-side ones.
     *
     * @param {number} index
     * @param {string|Array<any>} content
     */
    insertInGap(index: number, content: string | Array<any>): void;
    /**
     * Write one paired mark operation over live `[index, index + length)`:
     * `mark` takes `value` there (`null`: removed) with a Lamport timestamp
     * above every mark this document saw. `startSide`/`endSide` (`0` left,
     * `1` right) decide whether a concurrent insert at each edge lands inside.
     *
     * @param {number} index
     * @param {number} length
     * @param {string} mark
     * @param {any} value
     * @param {number} startSide
     * @param {number} endSide
     */
    mark(index: number, length: number, mark: string, value: any, startSide: number, endSide: number): void;
    /**
     * Inserts new content at an index.
     *
     * Important: This function expects an array of content. Not just a content
     * object. The reason for this "weirdness" is that inserting several elements
     * is very efficient when it is done as a single operation.
     *
     * @example
     *  // Insert character 'a' at position 0
     *  yarray.insert(0, ['a'])
     *  // Insert numbers 1, 2 at position 1
     *  yarray.insert(1, [1, 2])
     *
     * @param {number} index The index to insert content at.
     * @param {number} length The index to insert content at.
     * @param {delta.Formats} formats
     *
     */
    format(index: number, length: number, formats: delta.Formats): void;
    /**
     * Appends content to this YArray.
     *
     * @param {Array<delta.DeltaConfGetChildren<DConf>>|delta.DeltaConfGetText<DConf>} content Array of content to append.
     *
     * @todo Use the following implementation in all types.
     */
    push(content: Array<delta.DeltaConfGetChildren<DConf>> | delta.DeltaConfGetText<DConf>): void;
    /**
     * Prepends content to this YArray.
     *
     * @param {delta.DeltaConfGetText<DConf>} content Array of content to prepend.
     */
    unshift(content: delta.DeltaConfGetText<DConf>): void;
    /**
     * Deletes elements starting from an index.
     *
     * @param {number} index Index at which to start deleting elements
     * @param {number} length The number of elements to remove. Defaults to 1.
     */
    delete(index: number, length?: number): void;
    /**
     * Returns the i-th element from a YArray.
     *
     * @param {number} index The index of the element to return from the YArray
     * @return {delta.DeltaConfGetChildren<DConf>}
     */
    get(index: number): delta.DeltaConfGetChildren<DConf>;
    /**
     * Returns a portion of this YXmlFragment into a JavaScript Array selected
     * from start to end (end not included).
     *
     * @param {number} [start]
     * @param {number} [end]
     * @return {Array<delta.DeltaConfGetChildren<DConf>>}
     */
    slice(start?: number, end?: number): Array<delta.DeltaConfGetChildren<DConf>>;
    /**
     * @todo refactor this, this should use getContent only!
     *
     * Transforms this YArray to a JavaScript Array.
     *
     * @return {Array<delta.DeltaConfGetChildren<DConf> | delta.DeltaConfGetText<DConf>>}
     */
    toArray(): Array<delta.DeltaConfGetChildren<DConf> | delta.DeltaConfGetText<DConf>>;
    /**
     * Transforms this Shared Type to a JSON object.
     * @return {{ name?: string, attrs?: { [K:string|number]: any }, children?: Array<any>  }}
     */
    toJSON(): {
        name?: string;
        attrs?: {
            [K: string | number]: any;
        };
        children?: Array<any>;
    };
    /**
     * @param {object} opts
     * @param {boolean} [opts.forceTag] enforce creating a surrouning <name /> tag, even if it is null.
     */
    toString({ forceTag }?: {
        forceTag?: boolean | undefined;
    }): string;
    /**
     * Returns an Array with the result of calling a provided function on every
     * child-element.
     *
     * @template M
     * @param {(child:delta.DeltaConfGetChildren<DConf>|delta.DeltaConfGetText<DConf>,index:number)=>M} f Function that produces an element of the new Array
     * @return {Array<M>} A new array with each element being the result of the
     *                 callback function
     */
    map<M>(f: (child: delta.DeltaConfGetChildren<DConf> | delta.DeltaConfGetText<DConf>, index: number) => M): Array<M>;
    /**
     * Executes a provided function once on every element of this YArray.
     *
     * @param {(child:delta.DeltaConfGetChildren<DConf>|delta.DeltaConfGetText<DConf>,index:number)=>any} f Function that produces an element of the new Array
     */
    forEach(f: (child: delta.DeltaConfGetChildren<DConf> | delta.DeltaConfGetText<DConf>, index: number) => any): void;
    /**
     * Executes a provided function on once on every key-value pair.
     *
     * @param {(val:delta.DeltaConfGetAttrs<DConf>[any],key:Exclude<keyof delta.DeltaConfGetAttrs<DConf>,symbol>,ynode:this)=>any} f
     */
    forEachAttr(f: (val: delta.DeltaConfGetAttrs<DConf>[any], key: Exclude<keyof delta.DeltaConfGetAttrs<DConf>, symbol>, ynode: this) => any): void;
    /**
     * Returns the keys for each element in the YMap Type.
     *
     * @return {IterableIterator<import('lib0-v14/ts').KeyOf<delta.DeltaConfGetAttrs<DConf>>>}
     */
    attrKeys(): IterableIterator<import("lib0-v14/ts").KeyOf<delta.DeltaConfGetAttrs<DConf>>>;
    /**
     * Returns the values for each element in the YMap Type.
     *
     * @return {IterableIterator<delta.DeltaConfGetAttrs<DConf>[any]>}
     */
    attrValues(): IterableIterator<delta.DeltaConfGetAttrs<DConf>[any]>;
    /**
     * Returns an Iterator of [key, value] pairs
     *
     * @return {IterableIterator<{ [K in keyof delta.DeltaConfGetAttrs<DConf>]: [K,delta.DeltaConfGetAttrs<DConf>[K]] }[any]>}
     */
    attrEntries(): IterableIterator<{ [K in keyof delta.DeltaConfGetAttrs<DConf>]: [K, delta.DeltaConfGetAttrs<DConf>[K]]; }[any]>;
    /**
     * Returns the number of stored attributes (count of key/value pairs)
     *
     * @return {number}
     */
    get attrSize(): number;
    /**
     * @todo this doesn't need to live in a method.
     *
     * Transform the properties of this type to binary and write it to an
     * BinaryEncoder.
     *
     * This is called when this Item is sent to a remote peer.
     *
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
     */
    _write(encoder: UpdateEncoderV1 | UpdateEncoderV2): void;
    $type: s.Schema<YNode<any>>;
    /**
     * @param {this} other
     */
    [traits.EqualityTraitSymbol](other: this): boolean;
}
/**
 * Schema of a {@link YNode} with any delta configuration. This is where the nominal `y:node` tag
 * lives - {@link $node} builds on it. Mirrors lib0's `$deltaAny` / `$delta` split.
 */
export const $nodeAny: s.Schema<YNode<any>>;
export function computeModifiedFromItems(store: StructStore, items: IdSet): Map<YNode<any>, Set<string | null>>;
export function typeApplyRendererChange(type: YNode<any>, changes: IdSet, origin: any): void;
export function equalFormats(a: any, b: any): boolean;
export function typeListSlice(type: YNode<any>, start: number, end: number): Array<any>;
export function typeListGet(type: YNode, index: number): any;
export function nodeMapDelete(transaction: Transaction, parent: YNode, key: string): void;
export function nodeMapSet(transaction: Transaction, parent: YNode, key: string, value: YValue): void;
export function nodeMapGet(parent: YNode<any>, key: string): {
    [x: string]: any;
} | number | null | Array<any> | string | Uint8Array | YNode<any> | undefined;
export function nodeMapGetAll(parent: YNode<any>): {
    [x: string]: string | number | any[] | YNode<any> | Uint8Array<ArrayBufferLike> | {
        [x: string]: any;
    } | null | undefined;
};
export function nodeMapGetDelta<TypeDelta extends delta.DeltaBuilderAny>(d: TypeDelta, parent: YNode, attrsToRender: Set<string | null> | null, renderer: AbstractRenderer | null, deep: boolean, modified?: Set<YNode> | Map<YNode, any> | null, itemsToRender?: IdSet | null, opts?: any, optsAll?: any): void;
export function nodeMapHas(parent: YNode<any>, key: string): boolean;
export function createMapIterator(type: YNode<any> & {
    _map: Map<string, Item>;
}): IterableIterator<Array<any>>;
export function readContentType(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentType;
export function readContentString(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentString;
export function readContentJSON(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentJSON;
export function readContentFormat(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentFormat;
export function readContentEmbed(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentEmbed;
export function readContentDoc(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentDoc;
export function readContentAny(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentAny;
export function readContentBinary(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentBinary;
export function readContentDeleted(decoder: UpdateDecoderV1 | UpdateDecoderV2): ContentDeleted;
/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractContent>}
 */
export const contentRefs: Array<(arg0: UpdateDecoderV1 | UpdateDecoderV2) => AbstractContent>;
export function readItemContent(decoder: UpdateDecoderV1 | UpdateDecoderV2, info: number): import("./structs/Item.js").AbstractContent;
export function readYNode(decoder: UpdateDecoderV1 | UpdateDecoderV2): YNode;
export type YValue = {
    [x: string]: any;
} | Array<any> | number | null | string | Uint8Array | bigint | YNode<any>;
export type DeltaConfDeltaToYNode<DConf extends delta.DeltaConf> = delta.DeltaConfOverwrite<DConf, {
    attrs: { [K in keyof delta.DeltaConfGetAttrs<DConf>]: DeltaToYNode<delta.DeltaConfGetAttrs<DConf>[K]>; };
    children: DeltaToYNode<delta.DeltaConfGetChildren<DConf>>;
}>;
export type DeltaToYNode<Data extends unknown> = Exclude<Data, delta.DeltaAny> | (Extract<Data, delta.DeltaAny> extends delta.Delta<infer DConf> ? (unknown extends DConf ? YNode<DConf> : never) : never);
import { Item } from './structs/Item.js';
import { YEvent } from './utils/YEvent.js';
import * as delta from 'lib0-v14/delta';
import { ObservableV2 } from 'lib0-v14/observable';
import * as s from 'lib0-v14/schema';
import * as traits from 'lib0-v14/traits';
import { ContentType } from './structs/Item.js';
import { ContentString } from './structs/Item.js';
import { ContentJSON } from './structs/Item.js';
import { ContentFormat } from './structs/Item.js';
import { ContentEmbed } from './structs/Item.js';
import { ContentDoc } from './structs/Item.js';
import { ContentAny } from './structs/Item.js';
import { ContentBinary } from './structs/Item.js';
import { ContentDeleted } from './structs/Item.js';
