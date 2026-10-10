/**
 * @typedef {{ inserts: IdSet, deletes: IdSet }} ContentIds
 */
export class IdRange {
    /**
     * @param {number} clock
     * @param {number} len
     */
    constructor(clock: number, len: number);
    /**
     * @type {number}
     */
    clock: number;
    /**
     * @type {number}
     */
    len: number;
    /**
     * @param {number} clock
     * @param {number} len
     */
    copyWith(clock: number, len: number): IdRange;
}
export class MaybeIdRange {
    /**
     * @param {number} clock
     * @param {number} len
     * @param {boolean} exists
     */
    constructor(clock: number, len: number, exists: boolean);
    /**
     * @type {number}
     */
    clock: number;
    /**
     * @type {number}
     */
    len: number;
    /**
     * @type {boolean}
     */
    exists: boolean;
}
export function createMaybeIdRange(clock: number, len: number, exists: boolean): MaybeIdRange;
export class IdRanges {
    /**
     * @param {Array<IdRange>} ids
     */
    constructor(ids: Array<IdRange>);
    sorted: boolean;
    /**
     * A typical use-case for IdSet is to append data. We heavily optimize this case by allowing the
     * last item to be mutated if it isn't used currently.
     * This flag is true if the last item was exposed to the outside.
     */
    _lastIsUsed: boolean;
    /**
     * @private
     */
    private _ids;
    copy(): IdRanges;
    /**
     * @param {number} clock
     * @param {number} length
     */
    add(clock: number, length: number): void;
    /**
     * Return the list of immutable id ranges, sorted and merged.
     */
    getIds(): IdRange[];
}
/**
 * @implements {traits.EqualityTrait}
 */
export class IdSet implements traits.EqualityTrait {
    /**
     * @type {Map<number,IdRanges>}
     */
    clients: Map<number, IdRanges>;
    isEmpty(): boolean;
    /**
     * @param {(idrange:IdRange, client:number) => void} f
     */
    forEach(f: (idrange: IdRange, client: number) => void): void;
    /**
     * @param {ID} id
     * @return {boolean}
     */
    hasId(id: ID): boolean;
    /**
     * @param {number} client
     * @param {number} clock
     */
    has(client: number, clock: number): boolean;
    /**
     * Whether any id in the range `[clock, clock+len)` of `client` is contained in this set.
     * Allocation-free (binary search).
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {boolean}
     */
    intersects(client: number, clock: number, len: number): boolean;
    /**
     * Whether the entire range `[clock, clock+len)` of `client` is contained in this set.
     * Allocation-free (binary search). Because `getIds()` returns maximal, merged ranges, full
     * coverage of a range implies it lies within a single range.
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {boolean}
     */
    covers(client: number, clock: number, len: number): boolean;
    /**
     * Total number of ids in `[clock, clock+len)` of `client` contained in this set.
     * Allocation-free (binary search + linear scan of the overlapping ranges). Equivalent to
     * `slice(client, clock, len).reduce((s, r) => r.exists ? s + r.len : s, 0)` without allocating.
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {number}
     */
    coveredLength(client: number, clock: number, len: number): number;
    /**
     * Return slices of ids that exist in this idset.
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {Array<MaybeIdRange>}
     */
    slice(client: number, clock: number, len: number): Array<MaybeIdRange>;
    /**
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     */
    add(client: number, clock: number, len: number): void;
    /**
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     */
    delete(client: number, clock: number, len: number): void;
    /**
     * @param {any} other
     */
    [traits.EqualityTraitSymbol](other: any): boolean;
}
export function equalIdSets(ds1: IdSet, ds2: IdSet): boolean;
export function _deleteRangeFromIdSet(set: IdSet, client: number, clock: number, len: number): void;
export function iterateStructsByIdSet(transaction: Transaction, ds: IdSet, f: (arg0: GC | Item) => void): void;
export function iterateStructsByIdSetWithoutSplits(store: StructStore, ds: IdSet, f: (struct: GC | Item | Skip, offset: number, len: number) => void): void;
export function findIndexInIdRanges(dis: Array<IdRange>, clock: number): number | null;
export function findRangeStartInIdRanges(dis: Array<IdRange>, clock: number): number | null;
export function mergeIdSets(idSets: Array<IdSet>): IdSet;
/**
 * @param {IdSet} dest
 * @param {IdSet} src
 */
export function insertIntoIdSet(dest: IdSet, src: IdSet): void;
export function _diffSet(set: IdSet, exclude: IdSet): IdSet;
/**
 * Remove all ranges from `exclude` from `idSet`. The result is a fresh IdSet containing all ranges from `idSet` that are not
 * in `exclude`.
 *
 * @type {(idSet: IdSet, exclude: IdSet) => IdSet}
 */
export const diffIdSet: (idSet: IdSet, exclude: IdSet) => IdSet;
export function _intersectSets(setA: IdSet, setB: IdSet): IdSet;
export function intersectSets(setA: IdSet, setB: IdSet): IdSet;
export function createIdSet(): IdSet;
export function createDeleteSetFromStructStore(ss: StructStore): IdSet;
export function writeIdSet(encoder: IdSetEncoderV1 | IdSetEncoderV2, idSet: IdSet): void;
export function readIdSet(decoder: IdSetDecoderV1 | IdSetDecoderV2): IdSet;
export function readAndApplyDeleteSet(decoder: IdSetDecoderV1 | IdSetDecoderV2, transaction: Transaction, store: StructStore): Uint8Array<ArrayBuffer> | null;
export type ContentIds = {
    inserts: IdSet;
    deletes: IdSet;
};
import * as traits from 'lib0-v14/traits';
