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
    set deleted(doDelete: boolean);
    /**
     * Whether this item was deleted or not.
     * @type {Boolean}
     */
    get deleted(): boolean;
    markDeleted(): void;
    /**
     * Returns the next non-deleted item
     */
    get next(): Item | null;
    /**
     * Returns the previous non-deleted item
     */
    get prev(): Item | null;
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
    get ref(): 2 | 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
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
     */
    delete(_transaction: Transaction): void;
    /**
     * @param {Transaction} _transaction
     */
    gc(_transaction: Transaction): void;
    /**
     * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(_encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {1|2|3|4|5|6|7|8|9}
     */
    getRef(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, offset: number, offsetEnd: number): void;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {3}
     */
    getRef(): 3;
}
export class ContentDeleted {
    /**
     * @param {number} len
     */
    constructor(len: number);
    len: number;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, offset: number, offsetEnd: number): void;
    /**
     * @return {1}
     */
    getRef(): 1;
}
/**
 * @private
 */
export class ContentDoc {
    /**
     * @param {string} guid
     * @param {Object<string,any>} opts
     */
    constructor(guid: string, opts: {
        [x: string]: any;
    });
    /**
     * @type {Doc?}
     */
    doc: Doc | null;
    guid: string;
    opts: {
        [x: string]: any;
    };
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
     * @return {ContentDoc}
     */
    copy(): ContentDoc;
    /**
     * @param {number} _offset
     * @return {ContentDoc}
     */
    splice(_offset: number): ContentDoc;
    /**
     * @param {ContentDoc} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentDoc): boolean;
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
     * @param {Transaction} _tr
     */
    gc(_tr: Transaction): void;
    /**
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {9}
     */
    getRef(): 9;
}
export function createContentDocFromDoc(ydoc: Doc): ContentDoc;
/**
 * @private
 */
export class ContentEmbed {
    /**
     * @param {Object} embed
     */
    constructor(embed: Object);
    embed: Object;
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
     * @return {ContentEmbed}
     */
    copy(): ContentEmbed;
    /**
     * @param {number} _offset
     * @return {ContentEmbed}
     */
    splice(_offset: number): ContentEmbed;
    /**
     * @param {ContentEmbed} _right
     * @return {boolean}
     */
    mergeWith(_right: ContentEmbed): boolean;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {5}
     */
    getRef(): 5;
}
/**
 * @private
 */
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {6}
     */
    getRef(): 6;
}
/**
 * @private
 */
export class ContentJSON {
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
     * @return {ContentJSON}
     */
    copy(): ContentJSON;
    /**
     * @param {number} offset
     * @return {ContentJSON}
     */
    splice(offset: number): ContentJSON;
    /**
     * @param {ContentJSON} right
     * @return {boolean}
     */
    mergeWith(right: ContentJSON): boolean;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, offset: number, offsetEnd: number): void;
    /**
     * @return {2}
     */
    getRef(): 2;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} offset
     * @param {number} offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, offset: number, offsetEnd: number): void;
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
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} _offset
     * @param {number} _offsetEnd
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _offsetEnd: number): void;
    /**
     * @return {7}
     */
    getRef(): 7;
}
import { ID } from '../utils/ID.js';
import { AbstractStruct } from '../structs/AbstractStruct.js';
