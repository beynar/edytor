export class IdSetEncoder {
    restEncoder: encoding.Encoder;
    dsCurrVal: number;
    toUint8Array(): Uint8Array<ArrayBuffer>;
    resetIdSetCurVal(): void;
    /**
     * @param {number} clock
     */
    writeIdSetClock(clock: number): void;
    /**
     * @param {number} len
     */
    writeIdSetLen(len: number): void;
}
export class UpdateEncoder extends IdSetEncoder {
    /**
     * @type {Map<string,number>}
     */
    keyMap: Map<string, number>;
    /**
     * Refers to the next unique key-identifier to me used.
     * See writeKey method for more information.
     *
     * @type {number}
     */
    keyClock: number;
    keyClockEncoder: encoding.IntDiffOptRleEncoder;
    clientEncoder: encoding.UintOptRleEncoder;
    leftClockEncoder: encoding.IntDiffOptRleEncoder;
    rightClockEncoder: encoding.IntDiffOptRleEncoder;
    infoEncoder: encoding.RleEncoder<number>;
    stringEncoder: encoding.StringEncoder;
    parentInfoEncoder: encoding.RleEncoder<number>;
    typeRefEncoder: encoding.UintOptRleEncoder;
    lenEncoder: encoding.UintOptRleEncoder;
    /**
     * @param {ID} id
     */
    writeLeftID(id: ID): void;
    /**
     * @param {ID} id
     */
    writeRightID(id: ID): void;
    /**
     * @param {number} client
     */
    writeClient(client: number): void;
    /**
     * @param {number} info An unsigned 8-bit integer
     */
    writeInfo(info: number): void;
    /**
     * @param {string} s
     */
    writeString(s: string): void;
    /**
     * @param {boolean} isYKey
     */
    writeParentInfo(isYKey: boolean): void;
    /**
     * @param {number} info An unsigned 8-bit integer
     */
    writeTypeRef(info: number): void;
    /**
     * Write len of a struct - well suited for Opt RLE encoder.
     *
     * @param {number} len
     */
    writeLen(len: number): void;
    /**
     * @param {any} any
     */
    writeAny(any: any): void;
    /**
     * @param {Uint8Array} buf
     */
    writeBuf(buf: Uint8Array): void;
    /**
     * @param {any} embed
     */
    writeJSON(embed: any): void;
    /**
     * Property keys are often reused. For example, in y-prosemirror the key `bold` might
     * occur very often. For a 3d application, the key `position` might occur very often.
     *
     * We cache these keys in a Map and refer to them via a unique number.
     *
     * @param {string} key
     */
    writeKey(key: string): void;
}
import * as encoding from 'lib0-v14/encoding';
