export const structSkipRefNumber: 10;
/**
 * @private
 */
export class Skip extends AbstractStruct {
    delete(): void;
    /**
     * @param {Skip} right
     * @return {boolean}
     */
    mergeWith(right: Skip): boolean;
    /**
     * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
     * @param {number} offset
     */
    write(encoder: UpdateEncoderV1 | UpdateEncoderV2, offset: number): void;
    /**
     * @param {number} diff
     */
    splice(diff: number): Skip;
    /**
     * @type {10}
     */
    ref: 10;
    /**
     * @type {false}
     */
    isItem: false;
}
import { AbstractStruct } from './AbstractStruct.js';
