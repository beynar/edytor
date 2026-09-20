export function readBlockSet(decoder: UpdateDecoderV1 | UpdateDecoderV2): BlockSet;
export function writeBlockSet(encoder: UpdateEncoderV1 | UpdateEncoderV2, blocks: BlockSet): void;
export class BlockSet {
    /**
     * @type {Map<number, BlockRange>}
     */
    clients: Map<number, BlockRange>;
    toIdSet(): import("./ids.js").IdSet;
    /**
     * Remove id-ranges from update - convert them to skip if applicable.
     *
     * @param {IdSet} exclude
     */
    exclude(exclude: IdSet): void;
    /**
     * @param {BlockSet} inserts
     */
    insertInto(inserts: BlockSet): void;
}
declare class BlockRange {
    /**
     * @param {Array<Item|GC|Skip>} refs
     */
    constructor(refs: Array<Item | GC | Skip>);
    i: number;
    /**
     * @type {Array<Item | GC | Skip>}
     */
    refs: Array<Item | GC | Skip>;
}
import { Item } from '../structs/Item.js';
import { GC } from '../structs/GC.js';
import { Skip } from '../structs/Skip.js';
export {};
