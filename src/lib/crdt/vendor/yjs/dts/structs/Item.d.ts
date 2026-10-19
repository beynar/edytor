export function followRedone(store: StructStore, id: ID): {
    item: Item;
    diff: number;
};
/**
 * Abstract class that represents any content.
 */
export class Item extends AbstractStruct {
    /**
     * @param {ID} id
     * @param {Item | null} left
     * @param {ID | null} origin
     * @param {Item | null} right
     * @param {ID | null} rightOrigin
     * @param {YNode|ID|string|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it, is string if child of top-level-parent
     * @param {string | null} parentSub
     * @param {AbstractContent} content
     */
    constructor(id: ID, left: Item | null, origin: ID | null, right: Item | null, rightOrigin: ID | null, parent: YNode | ID | string | null, parentSub: string | null, content: AbstractContent);
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    origin: ID | null;
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    left: Item | null;
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    right: Item | null;
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    rightOrigin: ID | null;
    /**
     * @type {YNode|ID|string|null}
     */
    parent: YNode | ID | string | null;
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     */
    parentSub: string | null;
    /**
     * If this type's effect is redone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    redone: ID | null;
    /**
     * @type {AbstractContent}
     */
    content: AbstractContent;
    /**
     * bit1: keep
     * bit2: countable
     * bit3: deleted
     * bit4: mark - mark node as fast-search-marker
     * @type {number} byte
     */
    info: number;
    /**
     * YP20: how many live hold records (`ContentHold`) name this item. A
     * held item reads as deleted; the count is local, never encoded (each
     * replica counts the records it integrated).
     * @type {number}
     */
    holds: number;
    /**
     * YP22: the live move records (`ContentMove`) naming this item, the
     * strongest first — the greatest `(priority, client, clock)` — or `null`.
     * The first is its mover: the item shows there, hidden at home. Local,
     * never encoded.
     * @type {Array<Item>|null}
     */
    movers: Array<Item> | null;
    /**
     * This is used to mark the item as an indexed fast-search marker
     *
     * @type {boolean}
     */
    set marker(isMarked: boolean);
    get marker(): boolean;
    set keep(doKeep: boolean);
    /**
     * If true, do not garbage collect this Item.
     */
    get keep(): boolean;
    get countable(): boolean;
    /**
     * Whether this item shows nowhere: removed or held (YP22; a moved item
     * shows at its mover).
     * @type {Boolean}
     */
    get gone(): boolean;
    /**
     * YP22: the live move record this item shows at (the strongest of
     * `movers`), or `null` at home.
     * @type {Item|null}
     */
    get mover(): Item | null;
    markDeleted(): void;
    /**
     * Computes the last content address of this Item.
     */
    get lastId(): ID;
    /**
     * Try to merge two items
     *
     * @param {Item} right
     * @return {boolean}
     */
    mergeWith(right: Item): boolean;
    /**
     * Mark this Item as deleted.
     *
     * @param {Transaction} transaction
     */
    delete(transaction: Transaction): void;
    /**
     * @param {Transaction} tr
     * @param {boolean} parentGCd
     */
    gc(tr: Transaction, parentGCd: boolean): void;
    /**
     * Split this into two items
     * @param {Transaction?} transaction
     * @param {number} diff
     * @return {Item}
     */
    split(transaction: Transaction | null, diff: number): Item;
    get ref(): 2 | 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11 | 12 | 13;
    /**
     * @type {true}
     */
    isItem: true;
}
/**
 * Do not implement this class!
 */
export class AbstractContent {
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * Should return false if this Item is some kind of meta information
     * (e.g. format information).
     *
     * * Whether this Item should be addressable via `yarray.get(i)`
     * * Whether this Item should be counted when computing yarray.length
     *
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {AbstractContent}
     */
    copy(): AbstractContent;
    /**
     * @param {number} _offset
     * @return {AbstractContent}
     */
    splice(_offset: number): AbstractContent;
    /**
     * @param {AbstractContent} _right
     * @return {boolean}
     */
    mergeWith(_right: AbstractContent): boolean;
    /**
     * @param {Transaction} _transaction
     * @param {Item} _item
     */
    integrate(_transaction: Transaction, _item: Item): void;
    /**
     * @param {Transaction} _transaction
     * @param {Item} [_item] the item deleted (YP22: a move record reads it)
     */
    delete(_transaction: Transaction, _item?: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    gc(_transaction: Transaction): void;
    /**
     * @param {UpdateEncoder} _encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     * @param {Item} [_item] the item written (YP25: a format item reads its id)
     */
    write(_encoder: UpdateEncoder, _offset: number, _offsetEnd: number, _item?: Item): void;
    /**
     * @return {1|2|3|4|5|6|7|8|9|11|12|13}
     */
    getRef(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11 | 12 | 13;
}
export class ContentAny {
    /**
     * @param {Array<any>} arr
     */
    constructor(arr: Array<any>);
    /**
     * @type {Array<any>}
     */
    arr: Array<any>;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentAny}
     */
    copy(): ContentAny;
    /**
     * @param {number} offset
     * @return {ContentAny}
     */
    splice(offset: number): ContentAny;
    /**
     * @param {ContentAny} right
     * @return {boolean}
     */
    mergeWith(right: ContentAny): boolean;
    /**
     * @param {Transaction} _transaction
     * @param {Item} _item
     */
    integrate(_transaction: Transaction, _item: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoder, offset: number, offsetEnd: number): void;
    /**
     * @return {8}
     */
    getRef(): 8;
}
export class ContentBinary {
    /**
     * @param {Uint8Array} content
     */
    constructor(content: Uint8Array);
    content: Uint8Array<ArrayBufferLike>;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentBinary}
     */
    copy(): ContentBinary;
    /**
     * @param {number} _offset
     * @return {ContentBinary}
     */
    splice(_offset: number): ContentBinary;
    /**
     * @param {ContentBinary} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentBinary): boolean;
    /**
     * @param {Transaction} _transaction
     * @param {Item} _item
     */
    integrate(_transaction: Transaction, _item: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoder, _offset: number, _offsetEnd: number): void;
    /**
     * @return {3}
     */
    getRef(): 3;
}
export class ContentDeleted {
    /**
     * @param {number} len
     * @param {number} [cls] YP29: a collected mark's or claim's sort class
     */
    constructor(len: number, cls?: number);
    len: number;
    /**
     * YP29: what a collected paired mark item or claim item keeps, for each
     * of its units: its sort class (`markClass`: `0` a left-side mark, `2` a
     * right-side one, `3` a claim), which orders concurrent inserts at its
     * origin on every replica (`undefined`: none, any other deleted content).
     *
     * @type {number|undefined}
     */
    cls: number | undefined;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentDeleted}
     */
    copy(): ContentDeleted;
    /**
     * @param {number} offset
     * @return {ContentDeleted}
     */
    splice(offset: number): ContentDeleted;
    /**
     * @param {ContentDeleted} right
     * @return {boolean}
     */
    mergeWith(right: ContentDeleted): boolean;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    integrate(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoder, offset: number, offsetEnd: number): void;
    /**
     * @return {1|13}
     */
    getRef(): 1 | 13;
}
/**
 * A hold record: one unit per held id range (`client, clock, len`). While the
 * record is live, the items it names read as deleted; deleting the record
 * shows them again (an undo), unless another live record holds them. A record
 * integrates at once; what it names that has not arrived takes its hold when
 * it does (`applyPending`).
 */
export class ContentHold {
    /**
     * @param {Array<number>} ids
     */
    constructor(ids: Array<number>);
    ids: number[];
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentHold}
     */
    copy(): ContentHold;
    /**
     * @param {number} offset
     * @return {ContentHold}
     */
    splice(offset: number): ContentHold;
    /**
     * @param {ContentHold} right
     * @return {boolean}
     */
    mergeWith(right: ContentHold): boolean;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    integrate(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    delete(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoder, offset: number, offsetEnd: number): void;
    /**
     * @return {11}
     */
    getRef(): 11;
}
export function hideIds(tr: Transaction, ids: Array<number>): void;
export function unhide(tr: Transaction): void;
export function applyPending(tr: Transaction, clients: Array<number>): void;
/**
 * A move record: one countable unit at its destination, naming the units
 * it moves (`client, clock, len` ranges, in the order they show) with a
 * Lamport `priority`, a `side` (`0`: it stands after what precedes it,
 * `1`: before what follows it — its sort class among the items of one
 * origin, `markClass`), and for the sort of two records at one origin
 * (`utils/marks.js` `sourceOrder`) the chain of units it stands at (`at`:
 * the home slots from the root sequence down to that unit, else the first
 * unit it names) and its `part` there. While the record is live, each named unit shows at
 * the record that wins its movers and is hidden at home; deleting the
 * record (an undo) hands the unit to the next record, else home. A record
 * waits for the units it names as an item waits for its origin
 * (`getMissing`), so two records at one origin sort by their units' home
 * order on every replica (`sourceOrder`). Immutable once written, so
 * replicas converge in any order. The record's item is the one integrating
 * or deleting it (it is what the units' `movers` hold).
 */
export class ContentMove {
    /**
     * @param {number} priority
     * @param {number} side
     * @param {Array<number>} ids
     * @param {number} [part] the writer's order among the records standing at one unit (0–7)
     * @param {Array<ID>|null} [at] the chain the record stands at, outermost first (`null`: the first unit it names)
     */
    constructor(priority: number, side: number, ids: Array<number>, part?: number, at?: Array<ID> | null);
    priority: number;
    side: number;
    ids: number[];
    part: number;
    at: ID[] | null;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentMove}
     */
    copy(): ContentMove;
    /**
     * @param {number} _offset
     * @return {ContentMove}
     */
    splice(_offset: number): ContentMove;
    /**
     * @param {ContentMove} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentMove): boolean;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    integrate(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    delete(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoder, _offset: number, _offsetEnd: number): void;
    /**
     * @return {12}
     */
    getRef(): 12;
}
export function readFormatValue(decoder: UpdateDecoder, key: string, id: ID): any;
export class ContentFormat {
    /**
     * @param {string} key
     * @param {Object} value
     */
    constructor(key: string, value: Object);
    key: string;
    value: Object;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentFormat}
     */
    copy(): ContentFormat;
    /**
     * @param {number} _offset
     * @return {ContentFormat}
     */
    splice(_offset: number): ContentFormat;
    /**
     * @param {ContentFormat} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentFormat): boolean;
    /**
     * @param {Transaction} _transaction
     * @param {Item} item
     */
    integrate(_transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     * @param {Item} [item] YP25: the item, whose id a mark's operation id usually is
     */
    write(encoder: UpdateEncoder, _offset: number, _offsetEnd: number, item?: Item): void;
    /**
     * @return {6}
     */
    getRef(): 6;
}
/**
 * @private
 */
export class ContentString {
    /**
     * @param {string} str
     */
    constructor(str: string);
    /**
     * @type {string}
     */
    str: string;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentString}
     */
    copy(): ContentString;
    /**
     * @param {number} offset
     * @return {ContentString}
     */
    splice(offset: number): ContentString;
    /**
     * @param {ContentString} right
     * @return {boolean}
     */
    mergeWith(right: ContentString): boolean;
    /**
     * @param {Transaction} _transaction
     * @param {Item} _item
     */
    integrate(_transaction: Transaction, _item: Item): void;
    /**
     * @param {Transaction} _transaction
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoder, offset: number, offsetEnd: number): void;
    /**
     * @return {4}
     */
    getRef(): 4;
}
export const YArrayRefID: 0;
export const YMapRefID: 1;
export const YTextRefID: 2;
export const YXmlElementRefID: 3;
export const YXmlFragmentRefID: 4;
export const YXmlHookRefID: 5;
export const YXmlTextRefID: 6;
/**
 * @private
 */
export class ContentType {
    /**
     * @param {import('../ynode.js').YNode} type
     */
    constructor(type: import("../ynode.js").YNode);
    /**
     * @type {import('../ynode.js').YNode}
     */
    type: import("../ynode.js").YNode;
    /**
     * @return {number}
     */
    getLength(): number;
    /**
     * @return {Array<any>}
     */
    getContent(): Array<any>;
    /**
     * @return {boolean}
     */
    isCountable(): boolean;
    /**
     * @return {ContentType}
     */
    copy(): ContentType;
    /**
     * @param {number} _offset
     * @return {ContentType}
     */
    splice(_offset: number): ContentType;
    /**
     * @param {ContentType} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentType): boolean;
    /**
     * @param {Transaction} transaction
     * @param {Item} item
     */
    integrate(transaction: Transaction, item: Item): void;
    /**
     * @param {Transaction} transaction
     */
    delete(transaction: Transaction): void;
    /**
     * @param {Transaction} tr
     */
    gc(tr: Transaction): void;
    /**
     * @param {UpdateEncoder} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoder, _offset: number, _offsetEnd: number): void;
    /**
     * @return {7}
     */
    getRef(): 7;
}
import { ID } from '../utils/ID.js';
import { AbstractStruct } from '../structs/AbstractStruct.js';
