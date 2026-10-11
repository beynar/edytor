export class LazyStructReader {
    /**
     * @param {UpdateDecoder} decoder
     * @param {boolean} filterSkips
     */
    constructor(decoder: UpdateDecoder, filterSkips: boolean);
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
export function decodeUpdate(update: Uint8Array): {
    structs: (GC | Item | Skip)[];
    ds: import("./ids.js").IdSet;
};
export class LazyStructWriter {
    /**
     * @param {import('./UpdateEncoder.js').UpdateEncoder} encoder
     */
    constructor(encoder: import("./UpdateEncoder.js").UpdateEncoder);
    currClient: number;
    startClock: number;
    written: number;
    encoder: import("./UpdateEncoder.js").UpdateEncoder;
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
export function sliceStruct(left: Item | GC | Skip, diff: number): Item | GC | Skip;
export function writeStructToLazyStructWriter(lazyWriter: LazyStructWriter, struct: Item | GC | Skip, offset: number, offsetEnd: number): void;
export function finishLazyStructWriting(lazyWriter: LazyStructWriter): void;
import { GC } from '../structs/GC.js';
import { Item } from '../structs/Item.js';
import { Skip } from '../structs/Skip.js';
import { UpdateDecoder } from './UpdateDecoder.js';
