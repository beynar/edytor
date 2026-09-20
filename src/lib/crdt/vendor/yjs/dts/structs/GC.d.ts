export const structGCRefNumber: 0;
/**
 * @private
 */
export class GC extends AbstractStruct {
    delete(): void;
    /**
     * gc structs can't be spliced.
     *
     * If this feature is required in the future, then need to try to merge this struct after
     * transaction.
     *
     * @param {number} diff
     */
    splice(diff: number): GC;
    /**
     * @type {0}
     */
    ref: 0;
    /**
     * @type {false}
     */
    isItem: false;
}
import { AbstractStruct } from './AbstractStruct.js';
