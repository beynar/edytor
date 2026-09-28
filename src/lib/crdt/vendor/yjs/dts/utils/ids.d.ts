/**
 * @typedef {{ inserts: IdSet, deletes: IdSet }} ContentIds
 */
/**
 * @typedef {{ inserts: IdMap<any>, deletes: IdMap<any> }} ContentMap
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
    /**
     * Helper method making this compatible with IdMap.
     *
     * @return {Array<ContentAttribute<any>>}
     */
    get attrs(): Array<ContentAttribute<any>>;
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
    /**
     * Test a predicate against every attribute held by these ranges. Does not mutate - see
     * {@link AttrRanges#everyAttr}.
     *
     * This exists because an `IdMap` may hold `IdRanges`: {@link insertIntoIdMap}'s `src` may be an
     * `IdSet`, and `_insertIntoIdSet` picks the container class from whichever `src` reaches a client
     * first. For a pure `IdRanges` the loop is vacuous ({@link IdRange#attrs} is always `[]`), but it
     * must *not* shortcut to `true`: the append branch of `_insertIntoIdSet` copies elements without
     * checking their class, so an `IdRanges` reached by an `IdSet` first and an `IdMap` second holds
     * real `AttrRange`s - which {@link $idMap} must still validate.
     *
     * @param {(attr:ContentAttribute<any>) => boolean} f
     * @return {boolean}
     */
    everyAttr(f: (attr: ContentAttribute<any>) => boolean): boolean;
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
    $type: s.Schema<IdSet>;
    /**
     * @param {any} other
     */
    [traits.EqualityTraitSymbol](other: any): boolean;
}
export function equalIdSets(ds1: IdSet, ds2: IdSet): boolean;
export function _deleteRangeFromIdSet(set: IdSet | IdMap<any>, client: number, clock: number, len: number): void;
export function iterateStructsByIdSet(transaction: Transaction, ds: IdSet, f: (arg0: GC | Item) => void): void;
export function iterateStructsByIdSetWithoutSplits(store: StructStore, ds: IdSet, f: (struct: GC | Item | Skip, offset: number, len: number) => void): void;
export function findIndexInIdRanges(dis: Array<IdRange>, clock: number): number | null;
export function findRangeStartInIdRanges(dis: Array<IdRange>, clock: number): number | null;
export function mergeIdSets(idSets: Array<IdSet>): IdSet;
/**
 * @template {IdSet | IdMap<any>} S
 * @param {S} dest
 * @param {S} src
 */
export function insertIntoIdSet<S extends IdSet | IdMap<any>>(dest: S, src: S): void;
/**
 * Note that `src` may be an `IdSet`, in which case `dest` ends up holding `IdRanges` - which carry
 * no attributes ({@link IdRange#attrs} is `[]`). This is by design; {@link $idMap} tolerates it.
 *
 * @type {(dest: IdMap<any>, src: IdMap<any>|IdSet) => void}
 */
export const insertIntoIdMap: (dest: IdMap<any>, src: IdMap<any> | IdSet) => void;
export function _diffSet<Set extends IdSet | IdMap<any>>(set: Set, exclude: IdSet | IdMap<any>): Set;
/**
 * Remove all ranges from `exclude` from `idSet`. The result is a fresh IdSet containing all ranges from `idSet` that are not
 * in `exclude`.
 *
 * @type {(idSet: IdSet, exclude: IdSet|IdMap<any>) => IdSet}
 */
export const diffIdSet: (idSet: IdSet, exclude: IdSet | IdMap<any>) => IdSet;
export function _intersectSets<SetA extends IdSet | IdMap<any>, SetB extends IdSet | IdMap<any>>(setA: SetA, setB: SetB): SetA extends IdMap<infer A> ? (SetB extends IdMap<infer B> ? IdMap<A | B> : IdMap<A>) : IdSet;
export function intersectSets<SetA extends IdSet | IdMap<any>, SetB extends IdSet | IdMap<any>>(setA: SetA, setB: SetB): SetA extends IdMap<infer A> ? (SetB extends IdMap<infer B> ? IdMap<A | B> : IdMap<A>) : IdSet;
export function createIdSet(): IdSet;
export function createDeleteSetFromStructStore(ss: StructStore): IdSet;
export function writeIdSet(encoder: IdSetEncoderV1 | IdSetEncoderV2, idSet: IdSet): void;
export function readIdSet(decoder: IdSetDecoderV1 | IdSetDecoderV2): IdSet;
export function readAndApplyDeleteSet(decoder: IdSetDecoderV1 | IdSetDecoderV2, transaction: Transaction, store: StructStore): Uint8Array<ArrayBuffer> | null;
/**
 * @template Attrs
 */
export class AttrRange<Attrs> {
    /**
     * @param {number} clock
     * @param {number} len
     * @param {Array<ContentAttribute<Attrs>>} attrs
     */
    constructor(clock: number, len: number, attrs: Array<ContentAttribute<Attrs>>);
    /**
     * @readonly
     */
    readonly clock: number;
    /**
     * @readonly
     */
    readonly len: number;
    /**
     * @readonly
     */
    readonly attrs: ContentAttribute<Attrs>[];
    /**
     * @param {number} clock
     * @param {number} len
     */
    copyWith(clock: number, len: number): AttrRange<Attrs>;
}
/**
 * @todo rename this to `Attribute`
 * @template V
 */
export class ContentAttribute<V> {
    /**
     * @param {string} name
     * @param {V} val
     */
    constructor(name: string, val: V);
    name: string;
    val: V;
    hash(): string;
}
export function createContentAttribute<V>(name: string, val: V): ContentAttribute<V>;
export function createMaybeAttrRange<Attrs>(clock: number, len: number, attrs: Array<ContentAttribute<Attrs>> | null): MaybeAttrRange<Attrs>;
/**
 * Whenever this is instantiated, it must receive a fresh array of ops, not something copied.
 *
 * @template Attrs
 */
export class AttrRanges<Attrs> {
    /**
     * @param {Array<AttrRange<Attrs>>} ids
     */
    constructor(ids: Array<AttrRange<Attrs>>);
    sorted: boolean;
    /**
     * @private
     */
    private _ids;
    copy(): AttrRanges<Attrs>;
    /**
     * @param {number} clock
     * @param {number} length
     * @param {Array<ContentAttribute<Attrs>>} attrs
     */
    add(clock: number, length: number, attrs: Array<ContentAttribute<Attrs>>): void;
    /**
     * Return the list of id ranges, sorted and merged.
     */
    getIds(): AttrRange<Attrs>[];
    /**
     * Test a predicate against every attribute held by these ranges.
     *
     * Unlike {@link AttrRanges#getIds} this does **not** sort/merge - i.e. it does not mutate its
     * receiver, which matters because it backs {@link $idMap}`.check`. The *set* of attributes is
     * invariant under sorting/merging (merging only ever concatenates existing attr arrays), so this
     * observes exactly the attributes that `getIds()` would expose.
     *
     * @param {(attr:ContentAttribute<Attrs>) => boolean} f
     * @return {boolean}
     */
    everyAttr(f: (attr: ContentAttribute<Attrs>) => boolean): boolean;
}
/**
 * @template Attrs
 */
export class IdMap<Attrs> {
    /**
     * @type {Map<number,AttrRanges<Attrs>>}
     */
    clients: Map<number, AttrRanges<Attrs>>;
    /**
     * @type {Map<string, ContentAttribute<Attrs>>}
     */
    attrsH: Map<string, ContentAttribute<Attrs>>;
    /**
     * @type {Set<ContentAttribute<Attrs>>}
     */
    attrs: Set<ContentAttribute<Attrs>>;
    /**
     * @param {(attrRange:AttrRange<Attrs>, client:number) => void} f
     */
    forEach(f: (attrRange: AttrRange<Attrs>, client: number) => void): void;
    isEmpty(): boolean;
    /**
     * @param {ID} id
     * @return {boolean}
     */
    hasId(id: ID): boolean;
    /**
     * @param {number} client
     * @param {number} clock
     * @return {boolean}
     */
    has(client: number, clock: number): boolean;
    /**
     * Total number of ids in `[clock, clock+len)` of `client` contained in this map (i.e. carrying
     * an attribution, incl. an empty `[]`). Allocation-free (binary search + linear scan).
     * Equivalent to `slice(client, clock, len).reduce((s, r) => r.attrs != null ? s + r.len : s, 0)`
     * without allocating.
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {number}
     */
    coveredLength(client: number, clock: number, len: number): number;
    /**
     * Return attributions for a slice of ids.
     *
     * @param {ID} id
     * @param {number} len
     * @return {Array<MaybeAttrRange<Attrs>>}
     */
    sliceId(id: ID, len: number): Array<MaybeAttrRange<Attrs>>;
    /**
     * Return attributions for a slice of ids.
     *
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @return {Array<MaybeAttrRange<Attrs>>}
     */
    slice(client: number, clock: number, len: number): Array<MaybeAttrRange<Attrs>>;
    /**
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     * @param {Array<ContentAttribute<Attrs>>} attrs
     */
    add(client: number, clock: number, len: number, attrs: Array<ContentAttribute<Attrs>>): void;
    /**
     * @param {number} client
     * @param {number} clock
     * @param {number} len
     */
    delete(client: number, clock: number, len: number): void;
    $type: s.Schema<IdMap<any>>;
}
export function idmapAttrsEqual<T>(a: Array<T>, b: Array<T>): boolean;
export function writeIdMap<Attr>(encoder: IdSetEncoderV1 | IdSetEncoderV2, idmap: IdMap<Attr>): void;
export function encodeIdMap(idmap: IdMap<any>): Uint8Array<ArrayBuffer>;
export function readIdMap(decoder: IdSetDecoderV1 | IdSetDecoderV2): IdMap<any>;
export function decodeIdMap(data: Uint8Array): IdMap<any>;
export function createIdMap(): IdMap<any>;
/**
 * Schema of an {@link IdSet}.
 *
 * Nominal: `check` is a single identity compare against the globally interned `y:idSet` tag, so it
 * stays sound across duplicate yjs installations (unlike `instanceof`) - the same reason
 * {@link $renderer} uses `$type`.
 */
export const $idSet: s.Schema<IdSet>;
/**
 * Schema of an {@link IdMap} with any mapped-value type. This is where the nominal `y:idMap` tag
 * lives - {@link $idMap} builds on it. Mirrors lib0's `$deltaAny` / `$delta` split.
 */
export const $idMapAny: s.Schema<IdMap<any>>;
export type ContentIds = {
    inserts: IdSet;
    deletes: IdSet;
};
export type ContentMap = {
    inserts: IdMap<any>;
    deletes: IdMap<any>;
};
export type MaybeAttrRange<Attrs> = {
    clock: number;
    len: number;
    attrs: Array<ContentAttribute<Attrs>> | null;
};
import * as traits from 'lib0-v14/traits';
import * as s from 'lib0-v14/schema';
import { IdSetEncoderV2 } from './UpdateEncoder.js';
import { IdSetDecoderV2 } from './UpdateDecoder.js';
