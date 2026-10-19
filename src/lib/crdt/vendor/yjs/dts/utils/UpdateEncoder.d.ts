/**
 * The update encoding this fork writes and reads, in upstream's reserved
 * feature-flag varuint (upstream writes `0`): `1`, a string table per update.
 */
export const UPDATE_ENCODING: 1;
export class IdSetEncoder {
    restEncoder: encoding.Encoder;
    dsCurrVal: number;
    toUint8Array(): Uint8Array<ArrayBuffer>;
    resetIdSetCurVal(): void;
    /**
     * YP26: the client of a delete set's ranges.
     *
     * @param {number} client
     */
    writeDsClient(client: number): void;
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
    keyClockEncoder: encoding.UintOptRleEncoder;
    clientEncoder: encoding.UintOptRleEncoder;
    leftClockEncoder: encoding.IntDiffOptRleEncoder;
    rightClockEncoder: encoding.IntDiffOptRleEncoder;
    infoEncoder: encoding.RleEncoder<number>;
    stringEncoder: encoding.StringEncoder;
    typeRefEncoder: encoding.UintOptRleEncoder;
    lenEncoder: encoding.UintOptRleEncoder;
    /**
     * Each client's index, in first-use order.
     *
     * @type {Map<number,number>}
     */
    clientTable: Map<number, number>;
    /**
     * YP26: write `client` to the client column as its index in the update's
     * client table, in first-use order: a new client's index (the table's
     * size) is followed by its id, once.
     *
     * @param {number} client
     */
    clientIndex(client: number): void;
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
     * YP24: the cache is on (upstream left it off for decoders older than its
     * own), and every map key, root name and string of a content value goes
     * through it: an update writes each distinct string once. The key column
     * says `0` for a new string (the next in the string column) and the index
     * of a known one plus one, so a key repeated block after block is the same
     * small number every time.
     *
     * @param {string} key
     */
    writeKey(key: string): void;
}
import * as encoding from 'lib0-v14/encoding';
