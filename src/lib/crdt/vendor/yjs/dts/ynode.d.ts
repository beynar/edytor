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
     * Move past `length` live units, splitting the item the last one ends in,
     * and past the deleted items around them (YP19: the positioning of every
     * write; mark items are folded, never rewritten).
     *
     * @param {Transaction} transaction
     * @param {number} length
     */
    advance(transaction: Transaction, length: number): void;
}
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
export function cursorAt(transaction: Transaction, node: YNode, index: number): ItemTextListPosition;
/**
 * The engine's node: a sequence (text, elements, nested nodes) and a map of attributes. YP19: the
 * reads and writes edytor calls — no observers, no plain formats, no JSON or string renderings.
 */
export class YNode {
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
    _legacyTypeRef: number;
    /**
     * @type {Array<ArraySearchMarker>|null}
     */
    _searchMarker: Array<ArraySearchMarker> | null;
    /**
     * The writes made while this node is detached, replayed when it integrates (YP16).
     * @type {Prelim|null}
     */
    _prelim: Prelim | null;
    /**
     * The live length of the sequence (`0` while detached).
     */
    get length(): number;
    /**
     * Integrate this type into the Yjs instance.
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
     * Removes an attribute. A deleted node is left as it is.
     *
     * @param {string} attributeName The attribute name that is to be removed.
     */
    deleteAttr(attributeName: string): void;
    /**
     * Sets or updates an attribute. A deleted node is left as it is.
     *
     * @template VAL
     * @param {string} attributeName The attribute name that is to be set.
     * @param {VAL} attributeValue The attribute value that is to be set.
     * @return {VAL}
     */
    setAttr<VAL>(attributeName: string, attributeValue: VAL): VAL;
    /**
     * Returns an attribute value that belongs to the attribute name.
     *
     * @param {string} attributeName The attribute name that identifies the queried value.
     * @return {any} The queried attribute value.
     */
    getAttr(attributeName: string): any;
    /**
     * Inserts new content at an index — a string, or an array of elements (JSON values, nodes) —
     * as `insertInGap` places it (YP19: one sequence write). A deleted node is left as it is.
     *
     * @param {number} index The index to insert content at.
     * @param {Array<any>|string} content
     */
    insert(index: number, content: Array<any> | string): void;
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
     * Deletes elements starting from an index. A deleted node is left as it is.
     *
     * @param {number} index Index at which to start deleting elements
     * @param {number} length The number of elements to remove. Defaults to 1.
     */
    delete(index: number, length?: number): void;
    /**
     * Executes a provided function on once on every key-value pair.
     *
     * @param {(val:any,key:string,ynode:this)=>any} f
     */
    forEachAttr(f: (val: any, key: string, ynode: this) => any): void;
    /**
     * The keys of the live attributes.
     *
     * @return {IterableIterator<string>}
     */
    attrKeys(): IterableIterator<string>;
    /**
     * Write this node's type reference (and name), sent with the item that holds it.
     *
     * @param {UpdateEncoder} encoder The encoder to write data to.
     */
    _write(encoder: UpdateEncoder): void;
}
export function nodeMapDelete(transaction: Transaction, parent: YNode, key: string): void;
export function nodeMapSet(transaction: Transaction, parent: YNode, key: string, value: YValue): void;
export function readContentType(decoder: UpdateDecoder): ContentType;
export function readContentString(decoder: UpdateDecoder): ContentString;
export function readContentFormat(decoder: UpdateDecoder): ContentFormat;
export function readContentAny(decoder: UpdateDecoder): ContentAny;
export function readContentBinary(decoder: UpdateDecoder): ContentBinary;
export function readContentDeleted(decoder: UpdateDecoder): ContentDeleted;
/**
 * A lookup map for reading Item content. YP19: JSON (2), embed (5) and
 * subdocument (9) contents are refused like GC (0) and Skip (10): edytor
 * writes none, so an update holding one is malformed.
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
 * What a detached node was given, replayed when it integrates: its content
 * (adjacent strings, and adjacent arrays, merged) and its attrs in
 * first-write order (`null`: removed).
 */
export type Prelim = {
    runs: Array<string | Array<any>>;
    attrs: {
        [x: string]: {
            value: any;
        } | null;
    };
};
import { Item } from './structs/Item.js';
import { ContentType } from './structs/Item.js';
import { ContentString } from './structs/Item.js';
import { ContentFormat } from './structs/Item.js';
import { ContentAny } from './structs/Item.js';
import { ContentBinary } from './structs/Item.js';
import { ContentDeleted } from './structs/Item.js';
