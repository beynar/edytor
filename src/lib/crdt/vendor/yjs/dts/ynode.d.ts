export function warnPrematureAccess(): void;
export class ItemTextListPosition {
    /**
     * @param {Item|null} left
     * @param {Item|null} right
     * @param {number} index
     * @param {Map<string,any>} currentFormats
     */
    constructor(left: Item | null, right: Item | null, index: number, currentFormats: Map<string, any>);
    left: Item | null;
    right: Item | null;
    index: number;
    currentFormats: Map<string, any>;
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
export function plantMarker(parent: YNode, currPos: ItemTextListPosition): void;
export function plantSearchMarker(parent: YNode, p: Item, index: number, formats: Map<string, any>): void;
export function findMarker(yarray: YNode, index: number): ArraySearchMarker | null;
export function updateMarkerChanges(searchMarker: Array<ArraySearchMarker>, index: number, len: number): void;
export function callTypeObservers(type: YNode, transaction: Transaction, event: YEvent): void;
export function cursorAt(transaction: Transaction, node: YNode, index: number): ItemTextListPosition;
/**
 * The engine's node: a sequence (text, elements, nested nodes) and a map of attributes.
 *
 * @extends {ObservableV2<{ destroy: (type: YNode) => void }>}
 */
export class YNode extends ObservableV2<{
    destroy: (type: YNode) => void;
}> {
    /**
     * @param {string?} name
     */
    constructor(name?: string | null);
    /**
     * @type {string|null}
     */
    name: string | null;
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
     * @type {EventHandler<YEvent,Transaction>}
     */
    _eH: EventHandler<YEvent, Transaction>;
    /**
     * Deep event handlers
     * @type {EventHandler<YEvent,Transaction>}
     */
    _dEH: EventHandler<YEvent, Transaction>;
    _legacyTypeRef: number;
    /**
     * @type {Array<ArraySearchMarker>|null}
     */
    _searchMarker: Array<ArraySearchMarker> | null;
    /**
     * Whether this YText contains formats.
     * This flag is updated when a formatting item is integrated (see ContentFormat.integrate)
     */
    _hasFormatting: boolean;
    /**
     * The writes made while this node is detached, replayed when it integrates (YP16).
     * @type {Prelim|null}
     */
    _prelim: Prelim | null;
    get length(): number;
    /**
     * @return {YNode?}
     */
    get parent(): YNode | null;
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
    /**
     * @return {YNode}
     */
    _copy(): YNode;
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
     * @template {(target: YEvent, tr: Transaction) => void} F
     * @param {F} f Observer function
     * @return {F}
     */
    observe<F extends (target: YEvent, tr: Transaction) => void>(f: F): F;
    /**
     * Observe all events that are created by this type and its children.
     *
     * @template {(target: YEvent, tr: Transaction) => void} F
     * @param {F} f Observer function
     * @return {F}
     */
    observeDeep<F extends (target: YEvent, tr: Transaction) => void>(f: F): F;
    /**
     * Unregister an observer function.
     *
     * @param {(type: YEvent, tr: Transaction) => void} f Observer function
     */
    unobserve(f: (type: YEvent, tr: Transaction) => void): void;
    /**
     * Unregister an observer function.
     *
     * @param {(type: YEvent, tr: Transaction) => void} f Observer function
     */
    unobserveDeep(f: (type: YEvent, tr: Transaction) => void): void;
    /**
     * Makes a copy of this data type that can be included somewhere else.
     *
     * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
     *
     * @return {YNode}
     */
    clone(): YNode;
    /**
     * Removes all attributes.
     */
    clearAttrs(): void;
    /**
     * Removes an attribute. A deleted node is left as it is.
     *
     * @param {string} attributeName The attribute name that is to be removed.
     *
     * @public
     */
    public deleteAttr(attributeName: string): void;
    /**
     * Sets or updates an attribute. A deleted node is left as it is.
     *
     * @template VAL
     * @param {string} attributeName The attribute name that is to be set.
     * @param {VAL} attributeValue The attribute value that is to be set.
     * @return {VAL}
     *
     * @public
     */
    public setAttr<VAL>(attributeName: string, attributeValue: VAL): VAL;
    /**
     * Returns an attribute value that belongs to the attribute name.
     *
     * @param {string} attributeName The attribute name that identifies the queried value.
     * @return {any} The queried attribute value.
     * @public
     */
    public getAttr(attributeName: string): any;
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
     * @return {Object<string,any>} A JSON Object that describes the attributes.
     *
     * @public
     */
    public getAttrs(): {
        [x: string]: any;
    };
    /**
     * Inserts new content at an index: a string, or an array of elements (JSON values, nodes,
     * documents). A deleted node is left as it is.
     *
     * @example
     *  // Insert character 'a' at position 0
     *  yarray.insert(0, ['a'])
     *  // Insert numbers 1, 2 at position 1
     *  yarray.insert(1, [1, 2])
     *
     * @param {number} index The index to insert content at.
     * @param {Array<any>|string} content Array of content to append.
     * @param {Object<string,any>} [format]
     */
    insert(index: number, content: Array<any> | string, format?: {
        [x: string]: any;
    }): void;
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
     * Formats `[index, index + length)`: each key of `formats` takes its value there (`null`
     * removes it). A deleted node is left as it is.
     *
     * @param {number} index
     * @param {number} length
     * @param {Object<string,any>} formats
     */
    format(index: number, length: number, formats: {
        [x: string]: any;
    }): void;
    /**
     * Appends content to this YArray.
     *
     * @param {Array<any>|string} content Array of content to append.
     */
    push(content: Array<any> | string): void;
    /**
     * Prepends content to this YArray.
     *
     * @param {Array<any>|string} content Array of content to prepend.
     */
    unshift(content: Array<any> | string): void;
    /**
     * Deletes elements starting from an index. A deleted node is left as it is.
     *
     * @param {number} index Index at which to start deleting elements
     * @param {number} length The number of elements to remove. Defaults to 1.
     */
    delete(index: number, length?: number): void;
    /**
     * Returns the i-th element from a YArray.
     *
     * @param {number} index The index of the element to return from the YArray
     * @return {any}
     */
    get(index: number): any;
    /**
     * Returns a portion of this YXmlFragment into a JavaScript Array selected
     * from start to end (end not included).
     *
     * @param {number} [start]
     * @param {number} [end]
     * @return {Array<any>}
     */
    slice(start?: number, end?: number): Array<any>;
    /**
     * Transforms this YArray to a JavaScript Array: each element, and each run of text under one set
     * of formats as one string.
     *
     * @return {Array<any>}
     */
    toArray(): Array<any>;
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
     * @return {string}
     */
    toString({ forceTag }?: {
        forceTag?: boolean | undefined;
    }): string;
    /**
     * Returns an Array with the result of calling a provided function on every
     * child-element.
     *
     * @template M
     * @param {(child:any,index:number)=>M} f Function that produces an element of the new Array
     * @return {Array<M>} A new array with each element being the result of the
     *                 callback function
     */
    map<M>(f: (child: any, index: number) => M): Array<M>;
    /**
     * Executes a provided function once on every element of this YArray.
     *
     * @param {(child:any,index:number)=>any} f Function that produces an element of the new Array
     */
    forEach(f: (child: any, index: number) => any): void;
    /**
     * Executes a provided function on once on every key-value pair.
     *
     * @param {(val:any,key:string,ynode:this)=>any} f
     */
    forEachAttr(f: (val: any, key: string, ynode: this) => any): void;
    /**
     * Returns the keys for each element in the YMap Type.
     *
     * @return {IterableIterator<string>}
     */
    attrKeys(): IterableIterator<string>;
    /**
     * Returns the values for each element in the YMap Type.
     *
     * @return {IterableIterator<any>}
     */
    attrValues(): IterableIterator<any>;
    /**
     * Returns an Iterator of [key, value] pairs
     *
     * @return {IterableIterator<[string, any]>}
     */
    attrEntries(): IterableIterator<[string, any]>;
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
     * @param {UpdateEncoder} encoder The encoder to write data to.
     */
    _write(encoder: UpdateEncoder): void;
    /**
     * Two nodes are equal when their names, attrs and content runs are.
     *
     * @param {this} other
     */
    [traits.EqualityTraitSymbol](other: this): boolean;
}
export function equalFormats(a: any, b: any): boolean;
export function typeListSlice(type: YNode, start: number, end: number): Array<any>;
export function typeListGet(type: YNode, index: number): any;
export function nodeMapDelete(transaction: Transaction, parent: YNode, key: string): void;
export function nodeMapSet(transaction: Transaction, parent: YNode, key: string, value: YValue): void;
export function nodeMapGet(parent: YNode, key: string): {
    [x: string]: any;
} | number | null | Array<any> | string | Uint8Array | YNode | undefined;
export function nodeMapGetAll(parent: YNode): {
    [x: string]: string | number | any[] | YNode | Uint8Array<ArrayBufferLike> | {
        [x: string]: any;
    } | null | undefined;
};
export function nodeMapHas(parent: YNode, key: string): boolean;
export function createMapIterator(type: YNode & {
    _map: Map<string, Item>;
}): IterableIterator<Array<any>>;
export function readContentType(decoder: UpdateDecoder): ContentType;
export function readContentString(decoder: UpdateDecoder): ContentString;
export function readContentJSON(decoder: UpdateDecoder): ContentJSON;
export function readContentFormat(decoder: UpdateDecoder): ContentFormat;
export function readContentEmbed(decoder: UpdateDecoder): ContentEmbed;
export function readContentDoc(decoder: UpdateDecoder): ContentDoc;
export function readContentAny(decoder: UpdateDecoder): ContentAny;
export function readContentBinary(decoder: UpdateDecoder): ContentBinary;
export function readContentDeleted(decoder: UpdateDecoder): ContentDeleted;
/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(UpdateDecoder):AbstractContent>}
 */
export const contentRefs: Array<(arg0: UpdateDecoder) => AbstractContent>;
export function readItemContent(decoder: UpdateDecoder, info: number): import("./structs/Item.js").AbstractContent;
export function readYNode(decoder: UpdateDecoder): YNode;
export type YValue = {
    [x: string]: any;
} | Array<any> | number | null | string | Uint8Array | bigint | YNode;
/**
 * One run of a node's current content: a string (text) or the elements of an array insert, under
 * the formats in effect there (`null`: none) — the shape a current-state `toDelta` op had.
 */
export type ContentRun = {
    insert: string | Array<any>;
    format: {
        [x: string]: any;
    } | null;
};
/**
 * What a detached node was given, replayed when it integrates: its content runs (adjacent runs of
 * one kind and equal formats merged — the normal form the pre-integration delta had) and its attrs
 * in first-write order (`null`: removed).
 */
export type Prelim = {
    runs: Array<ContentRun>;
    attrs: {
        [x: string]: {
            value: any;
        } | null;
    };
};
import { Item } from './structs/Item.js';
import { YEvent } from './utils/YEvent.js';
import { ObservableV2 } from 'lib0-v14/observable';
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
