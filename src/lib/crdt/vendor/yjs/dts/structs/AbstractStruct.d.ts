export class AbstractStruct {
    /**
     * @param {ID} id
     * @param {number} length
     */
    constructor(id: ID, length: number);
    id: import("../index.js").ID;
    length: number;
    /**
     * @type {boolean}
     */
    get deleted(): boolean;
    /**
     * Merge this struct with the item to the right.
     * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
     * Also this method does *not* remove right from StructStore!
     * @param {GC|Item|Skip} _right
     * @return {boolean} whether this merged with right
     */
    mergeWith(_right: GC | Item | Skip): boolean;
    /**
     * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder The encoder to write data to.
     * @param {number} _offset
     * @param {number} _encodingRef
     */
    write(_encoder: UpdateEncoderV1 | UpdateEncoderV2, _offset: number, _encodingRef: number): void;
    /**
     * @param {Transaction} _transaction
     * @param {number} _offset
     */
    integrate(_transaction: Transaction, _offset: number): void;
    /**
     * @param {number} _diff
     * @return {GC|Item|Skip}
     */
    splice(_diff: number): GC | Item | Skip;
}
export function addStructToIdSet(idSet: IdSet, struct: AbstractStruct): void;
