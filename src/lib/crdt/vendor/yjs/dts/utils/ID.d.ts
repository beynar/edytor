export class ID {
    /**
     * @param {number} client client id
     * @param {number} clock unique per client id, continuous number
     */
    constructor(client: number, clock: number);
    /**
     * Client id
     * @type {number}
     */
    client: number;
    /**
     * unique per client id, continuous number
     * @type {number}
     */
    clock: number;
}
export function compareIDs(a: ID | null, b: ID | null): boolean;
export function createID(client: number, clock: number): ID;
export function findRootTypeKey(type: YNode<any>): string;
