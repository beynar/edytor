import * as error from 'lib0-v14/error'
import * as encoding from 'lib0-v14/encoding'

// YP24 begin (edytor fork: one string table per update — see UPSTREAM.md YP24)
/**
 * The update encoding this fork writes and reads, in upstream's reserved
 * feature-flag varuint (upstream writes `0`): `1`, a string table per update.
 */
export const UPDATE_ENCODING = 1

/**
 * YP28: whether `x` is an integer past 31 bits a varint holds exactly.
 *
 * @param {any} x
 * @return {boolean}
 */
const large = x => Number.isInteger(x) && x > 0x7fffffff && x <= Number.MAX_SAFE_INTEGER

/**
 * Write a content value in lib0's `writeAny` layout, its strings and object
 * keys through the update's string table (`writeKey`).
 *
 * @param {UpdateEncoder} encoder
 * @param {any} data
 */
const writeValue = (encoder, data) => {
  const rest = encoder.restEncoder
  if (typeof data === 'string') {
    encoding.write(rest, 119)
    encoder.writeKey(data)
  } else if (large(data)) {
    // YP28: an integer past lib0's 31 bits (a float64 there) as a varint
    encoding.write(rest, 115)
    encoding.writeVarUint(rest, data)
  } else if (data !== null && typeof data === 'object' && !(data instanceof Uint8Array)) {
    if (Array.isArray(data) && data.length === 2 && large(data[0]) && Number.isInteger(data[1]) && data[1] >= 0) {
      // YP28: a pair of a large integer and a clock (an item id, a block
      // slot's split key) names its first through the client table
      encoding.write(rest, 114)
      encoder.clientIndex(data[0])
      encoding.writeVarUint(rest, data[1])
    } else if (Array.isArray(data)) {
      encoding.write(rest, 117)
      encoding.writeVarUint(rest, data.length)
      for (let i = 0; i < data.length; i++) writeValue(encoder, data[i])
    } else {
      const keys = Object.keys(data)
      encoding.write(rest, 118)
      encoding.writeVarUint(rest, keys.length)
      for (let i = 0; i < keys.length; i++) {
        encoder.writeKey(keys[i])
        writeValue(encoder, data[keys[i]])
      }
    }
  } else {
    encoding.writeAny(rest, data)
  }
}
// YP24 end

export class IdSetEncoder {
  constructor () {
    this.restEncoder = encoding.createEncoder() // encodes all the rest / non-optimized
    this.dsCurrVal = 0
  }

  toUint8Array () {
    return encoding.toUint8Array(this.restEncoder)
  }

  resetIdSetCurVal () {
    this.dsCurrVal = 0
  }

  /**
   * YP26: the client of a delete set's ranges.
   *
   * @param {number} client
   */
  writeDsClient (client) {
    encoding.writeVarUint(this.restEncoder, client)
  }

  /**
   * @param {number} clock
   */
  writeIdSetClock (clock) {
    const diff = clock - this.dsCurrVal
    this.dsCurrVal = clock
    encoding.writeVarUint(this.restEncoder, diff)
  }

  /**
   * @param {number} len
   */
  writeIdSetLen (len) {
    if (len === 0) {
      error.unexpectedCase()
    }
    encoding.writeVarUint(this.restEncoder, len - 1)
    this.dsCurrVal += len
  }
}

export class UpdateEncoder extends IdSetEncoder {
  constructor () {
    super()
    /**
     * @type {Map<string,number>}
     */
    this.keyMap = new Map()
    /**
     * Refers to the next unique key-identifier to me used.
     * See writeKey method for more information.
     *
     * @type {number}
     */
    this.keyClock = 0
    this.keyClockEncoder = new encoding.UintOptRleEncoder() // YP24: 0 a new string, else its index + 1
    this.clientEncoder = new encoding.UintOptRleEncoder()
    this.leftClockEncoder = new encoding.IntDiffOptRleEncoder()
    this.rightClockEncoder = new encoding.IntDiffOptRleEncoder()
    this.infoEncoder = new encoding.RleEncoder(encoding.writeUint8)
    this.stringEncoder = new encoding.StringEncoder()
    this.typeRefEncoder = new encoding.UintOptRleEncoder()
    this.lenEncoder = new encoding.UintOptRleEncoder()
    // YP26 begin: one client table per update
    /**
     * Each client's index, in first-use order.
     *
     * @type {Map<number,number>}
     */
    this.clientTable = new Map()
    // YP26 end
  }

  /**
   * YP26: write `client` to the client column as its index in the update's
   * client table, in first-use order: a new client's index (the table's
   * size) is followed by its id, once.
   *
   * @param {number} client
   */
  clientIndex (client) {
    const index = this.clientTable.get(client)
    if (index === undefined) {
      const next = this.clientTable.size
      this.clientTable.set(client, next)
      this.clientEncoder.write(next)
      this.clientEncoder.write(client)
    } else {
      this.clientEncoder.write(index)
    }
  }

  toUint8Array () {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, UPDATE_ENCODING) // YP24: the feature flag names the encoding
    encoding.writeVarUint8Array(encoder, this.keyClockEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, this.clientEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, this.leftClockEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, this.rightClockEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(this.infoEncoder))
    encoding.writeVarUint8Array(encoder, this.stringEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, this.typeRefEncoder.toUint8Array())
    encoding.writeVarUint8Array(encoder, this.lenEncoder.toUint8Array())
    // @note The rest encoder is appended! (note the missing var)
    encoding.writeUint8Array(encoder, encoding.toUint8Array(this.restEncoder))
    return encoding.toUint8Array(encoder)
  }

  /**
   * @param {ID} id
   */
  writeLeftID (id) {
    this.clientIndex(id.client) // YP26
    this.leftClockEncoder.write(id.clock)
  }

  /**
   * @param {ID} id
   */
  writeRightID (id) {
    this.clientIndex(id.client) // YP26
    this.rightClockEncoder.write(id.clock)
  }

  /**
   * @param {number} client
   */
  writeClient (client) {
    this.clientIndex(client) // YP26
  }

  /**
   * YP26: a delete set's client goes through the client table too.
   *
   * @param {number} client
   */
  writeDsClient (client) {
    this.writeClient(client)
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeInfo (info) {
    this.infoEncoder.write(info)
  }

  /**
   * @param {string} s
   */
  writeString (s) {
    this.stringEncoder.write(s)
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeTypeRef (info) {
    this.typeRefEncoder.write(info)
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @param {number} len
   */
  writeLen (len) {
    this.lenEncoder.write(len)
  }

  /**
   * @param {any} any
   */
  writeAny (any) {
    writeValue(this, any) // YP24
  }

  /**
   * @param {Uint8Array} buf
   */
  writeBuf (buf) {
    encoding.writeVarUint8Array(this.restEncoder, buf)
  }

  /**
   * @param {any} embed
   */
  writeJSON (embed) {
    writeValue(this, embed) // YP24
  }

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
  writeKey (key) {
    const clock = this.keyMap.get(key)
    if (clock === undefined) {
      this.keyMap.set(key, this.keyClock++)
      this.keyClockEncoder.write(0)
      this.stringEncoder.write(key)
    } else {
      this.keyClockEncoder.write(clock + 1)
    }
  }
}
