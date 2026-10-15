export class StructStore {
    /**
     * @type {Map<number,Array<GC|Item|Skip>>}
     */
    clients: Map<number, Array<GC | Item | Skip>>;
    /**
     * @type {null | { missing: Map<number, number>, update: Uint8Array<ArrayBuffer> }}
     */
    pendingStructs: null | {
        missing: Map<number, number>;
        update: Uint8Array<ArrayBuffer>;
    };
    /**
     * @type {null | Uint8Array<ArrayBuffer>}
     */
    pendingDs: null | Uint8Array<ArrayBuffer>;
    /**
     * YP20: holds whose items have not arrived, `client → [clock, len, delta, …]`.
     * @type {Map<number, Array<number>>|null}
     */
    pendingHolds: Map<number, Array<number>> | null;
    skips: import("./ids.js").IdSet;
    get ds(): import("./ids.js").IdSet;
    /**
     * @param {GC|Item|Skip} struct
     * @function
     */
    add(struct: GC | Item | Skip): void;
    /**
     * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
     *
     * @param {ID} id
     * @return {Item}
     */
    getItem(id: ID): Item;
    /**
     * Get the next expected clock for a specific client.
     *
     * @param {number} client
     * @return {number}
     *
     * @public
     * @function
     */
    public getClock(client: number): number;
}
export function getStateVector(store: StructStore): Map<number, number>;
import { Skip } from '../structs/Skip.js';
