export class LazyStructReader {
    /**
     * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
     * @param {boolean} filterSkips
     */
    constructor(decoder: UpdateDecoderV1 | UpdateDecoderV2, filterSkips: boolean);
    gen: Generator<GC | Item | Skip, void, unknown>;
    /**
     * @type {null | Item | Skip | GC}
     */
    curr: null | Item | Skip | GC;
    done: boolean;
    filterSkips: boolean;
    /**
     * @return {Item | GC | Skip |null}
     */
    next(): Item | GC | Skip | null;
}
export function logUpdate(update: Uint8Array): void;
export function logUpdateV2(update: Uint8Array, YDecoder?: typeof UpdateDecoderV2 | typeof UpdateDecoderV1): void;
export function decodeUpdate(update: Uint8Array): {
    structs: (GC | Item | Skip)[];
    ds: import("./ids.js").IdSet;
};
export function decodeUpdateV2(update: Uint8Array, YDecoder?: typeof UpdateDecoderV2 | typeof UpdateDecoderV1): {
    structs: (GC | Item | Skip)[];
    ds: import("./ids.js").IdSet;
};
export class LazyStructWriter {
    /**
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     */
    constructor(encoder: UpdateEncoderV1 | UpdateEncoderV2);
    currClient: number;
    startClock: number;
    written: number;
    encoder: UpdateEncoderV1 | UpdateEncoderV2;
    /**
     * We want to write operations lazily, but also we need to know beforehand how many operations we want to write for each client.
     *
     * This kind of meta-information (#clients, #structs-per-client-written) is written to the restEncoder.
     *
     * We fragment the restEncoder and store a slice of it per-client until we know how many clients there are.
     * When we flush (toUint8Array) we write the restEncoder using the fragments and the meta-information.
     *
     * @type {Array<{ written: number, restEncoder: Uint8Array }>}
     */
    clientStructs: Array<{
        written: number;
        restEncoder: Uint8Array;
    }>;
}
export function encodeStateVectorFromUpdateV2(update: Uint8Array, YEncoder?: typeof IdSetEncoderV1 | typeof IdSetEncoderV2, YDecoder?: typeof UpdateDecoderV1 | typeof UpdateDecoderV2): Uint8Array<ArrayBuffer>;
export function encodeStateVectorFromUpdate(update: Uint8Array): Uint8Array<ArrayBuffer>;
export function createContentIdsFromUpdateV2(update: Uint8Array, YDecoder?: typeof UpdateDecoderV2 | typeof UpdateDecoderV1): ContentIds;
export function createContentIdsFromUpdate(update: Uint8Array): ContentIds;
export function sliceStruct(left: Item | GC | Skip, diff: number): Item | GC | Skip;
export function writeStructToLazyStructWriter(lazyWriter: LazyStructWriter, struct: Item | GC | Skip, offset: number, offsetEnd: number): void;
export function finishLazyStructWriting(lazyWriter: LazyStructWriter): void;
export function convertUpdateFormat(update: Uint8Array, blockTransformer: (arg0: Item | GC | Skip) => Item | GC | Skip, YDecoder: typeof UpdateDecoderV2 | typeof UpdateDecoderV1, YEncoder: typeof UpdateEncoderV2 | typeof UpdateEncoderV1): Uint8Array<ArrayBuffer>;
export function obfuscateUpdate(update: Uint8Array, opts?: ObfuscatorOptions): Uint8Array<ArrayBuffer>;
export function obfuscateUpdateV2(update: Uint8Array, opts?: ObfuscatorOptions): Uint8Array<ArrayBuffer>;
export function convertUpdateFormatV1ToV2(update: Uint8Array): Uint8Array<ArrayBuffer>;
export function convertUpdateFormatV2ToV1(update: Uint8Array): Uint8Array<ArrayBuffer>;
export function intersectUpdateWithContentIdsV2(update: Uint8Array, contentIds: ContentIds, YDecoder?: typeof UpdateDecoderV1 | typeof UpdateDecoderV2, YEncoder?: typeof UpdateEncoderV1 | typeof UpdateEncoderV2): Uint8Array<ArrayBuffer>;
export function intersectUpdateWithContentIds(update: Uint8Array, contentIds: ContentIds): Uint8Array<ArrayBuffer>;
export type ObfuscatorOptions = {
    formatting?: boolean | undefined;
    subdocs?: boolean | undefined;
    /**
     * Whether to obfuscate nodeName / hookName
     */
    name?: boolean | undefined;
};
import { GC } from '../structs/GC.js';
import { Item } from '../structs/Item.js';
import { Skip } from '../structs/Skip.js';
import { UpdateDecoderV1 } from './UpdateDecoder.js';
import { UpdateDecoderV2 } from './UpdateDecoder.js';
import { UpdateEncoderV1 } from './UpdateEncoder.js';
import { UpdateEncoderV2 } from './UpdateEncoder.js';
import { IdSetEncoderV1 } from './UpdateEncoder.js';
import { IdSetEncoderV2 } from './UpdateEncoder.js';
