/**
 * @typedef {IdSetDecoderV1 | IdSetDecoderV2} IdSetDecoder
 */
export class IdSetDecoderV1 {
    /**
     * @param {decoding.Decoder} decoder
     */
    constructor(decoder: decoding.Decoder);
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
export class UpdateDecoderV1 extends IdSetDecoderV1 {
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
     * @return {boolean} isKey
     */
    readParentInfo(): boolean;
    /**
     * @return {number} info An unsigned 8-bit integer
     */
    readTypeRef(): number;
    /**
     * Write len of a struct - well suited for Opt RLE encoder.
     *
     * @return {number} len
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
     * Legacy implementation uses JSON parse. We use any-decoding in v2.
     *
     * @return {any}
     */
    readJSON(): any;
    /**
     * @return {string}
     */
    readKey(): string;
}
export class IdSetDecoderV2 {
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
export class UpdateDecoderV2 extends IdSetDecoderV2 {
    /**
     * List of cached keys. If the keys[id] does not exist, we read a new key
     * from stringEncoder and push it to keys.
     *
     * @type {Array<string>}
     */
    keys: Array<string>;
    keyClockDecoder: decoding.IntDiffOptRleDecoder;
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
     * This is mainly here for legacy purposes.
     *
     * Initial we incoded objects using JSON. Now we use the much faster lib0-v14/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
     *
     * @return {any}
     */
    readJSON(): any;
    /**
     * @return {string}
     */
    readKey(): string;
}
export type IdSetDecoder = IdSetDecoderV1 | IdSetDecoderV2;
import * as decoding from 'lib0-v14/decoding';
import { ID } from './ID.js';
