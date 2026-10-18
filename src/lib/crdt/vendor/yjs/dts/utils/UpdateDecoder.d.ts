export class IdSetDecoder {
    /**
     * @param {decoding.Decoder} decoder
     */
    constructor(decoder: decoding.Decoder);
    /**
     * @private
     */
    private dsCurrVal;
    restDecoder: decoding.Decoder<ArrayBufferLike>;
    resetDsCurVal(): void;
    /**
     * @return {number}
     */
    readDsClock(): number;
    /**
     * @return {number}
     */
    readDsLen(): number;
}
export class UpdateDecoder extends IdSetDecoder {
    /**
     * List of cached keys. If the keys[id] does not exist, we read a new key
     * from stringEncoder and push it to keys.
     *
     * @type {Array<string>}
     */
    keys: Array<string>;
    keyClockDecoder: decoding.UintOptRleDecoder;
    clientDecoder: decoding.UintOptRleDecoder;
    leftClockDecoder: decoding.IntDiffOptRleDecoder;
    rightClockDecoder: decoding.IntDiffOptRleDecoder;
    infoDecoder: decoding.RleDecoder<number>;
    stringDecoder: decoding.StringDecoder;
    parentInfoDecoder: decoding.RleDecoder<number>;
    typeRefDecoder: decoding.UintOptRleDecoder;
    lenDecoder: decoding.UintOptRleDecoder;
    /**
     * @return {ID}
     */
    readLeftID(): ID;
    /**
     * @return {ID}
     */
    readRightID(): ID;
    /**
     * Read the next client id.
     * Use this in favor of readID whenever possible to reduce the number of objects created.
     */
    readClient(): number;
    /**
     * @return {number} info An unsigned 8-bit integer
     */
    readInfo(): number;
    /**
     * @return {string}
     */
    readString(): string;
    /**
     * @return {boolean}
     */
    readParentInfo(): boolean;
    /**
     * @return {number} An unsigned 8-bit integer
     */
    readTypeRef(): number;
    /**
     * Write len of a struct - well suited for Opt RLE encoder.
     *
     * @return {number}
     */
    readLen(): number;
    /**
     * @return {any}
     */
    readAny(): any;
    /**
     * @return {Uint8Array}
     */
    readBuf(): Uint8Array;
    /**
     * @return {any}
     */
    readJSON(): any;
    /**
     * @return {string}
     */
    readKey(): string;
}
import * as decoding from 'lib0-v14/decoding';
import { ID } from './ID.js';
