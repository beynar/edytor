import * as decoding from 'lib0-v14/decoding'
import * as error from 'lib0-v14/error' // YP24

import { ID } from './ID.js'
import { UPDATE_ENCODING } from './UpdateEncoder.js' // YP24

// YP24 begin (edytor fork: one string table per update — see UPSTREAM.md YP24)
/**
 * Read a content value written by `writeValue` (lib0's `readAny` layout, its
 * strings and object keys from the update's string table).
 *
 * @param {UpdateDecoder} decoder
 * @return {any}
 */
const readValue = decoder => {
  const rest = decoder.restDecoder
  switch (rest.arr[rest.pos]) {
    case 115: // YP28: a large integer
      rest.pos++
      return decoding.readVarUint(rest)
    case 114: // YP28: a large integer, through the client table, and a clock
      rest.pos++
      return [decoder.readClient(), decoding.readVarUint(rest)]
    case 119:
      rest.pos++
      return decoder.readKey()
    case 118: {
      rest.pos++
      /** @type {Object<string,any>} */
      const obj = {}
      for (let n = decoding.readVarUint(rest); n > 0; n--) {
        const key = decoder.readKey()
        obj[key] = readValue(decoder)
      }
      return obj
    }
    case 117: {
      rest.pos++
      const arr = []
      for (let n = decoding.readVarUint(rest); n > 0; n--) arr.push(readValue(decoder))
      return arr
    }
    default:
      return decoding.readAny(rest)
  }
}
// YP24 end

export class IdSetDecoder {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    /**
     * @private
     */
    this.dsCurrVal = 0
    this.restDecoder = decoder
  }

  resetDsCurVal () {
    this.dsCurrVal = 0
  }

  /**
   * YP26: the client of a delete set's ranges.
   *
   * @return {number}
   */
  readDsClient () {
    return decoding.readVarUint(this.restDecoder)
  }

  /**
   * @return {number}
   */
  readDsClock () {
    this.dsCurrVal += decoding.readVarUint(this.restDecoder)
    return this.dsCurrVal
  }

  /**
   * @return {number}
   */
  readDsLen () {
    const diff = decoding.readVarUint(this.restDecoder) + 1
    this.dsCurrVal += diff
    return diff
  }
}

export class UpdateDecoder extends IdSetDecoder {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    super(decoder)
    /**
     * List of cached keys. If the keys[id] does not exist, we read a new key
     * from stringEncoder and push it to keys.
     *
     * @type {Array<string>}
     */
    this.keys = []
    // YP24: the feature flag names the encoding; another one (upstream's `0`) is refused
    if (decoding.readVarUint(decoder) !== UPDATE_ENCODING) throw error.create('an update of another encoding')
    this.keyClockDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder)) // YP24
    this.clientDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.leftClockDecoder = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.rightClockDecoder = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.infoDecoder = new decoding.RleDecoder(decoding.readVarUint8Array(decoder), decoding.readUint8)
    this.stringDecoder = new decoding.StringDecoder(decoding.readVarUint8Array(decoder))
    this.typeRefDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.lenDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
    // YP26 begin: the update's client table, read as its indices are
    /**
     * @type {Array<number>}
     */
    this.clients = []
    // YP26 end
  }

  /**
   * @return {ID}
   */
  readLeftID () {
    return new ID(this.readClient(), this.leftClockDecoder.read())
  }

  /**
   * @return {ID}
   */
  readRightID () {
    return new ID(this.readClient(), this.rightClockDecoder.read())
  }

  /**
   * Read the next client id.
   * Use this in favor of readID whenever possible to reduce the number of objects created.
   * YP26: an index in the update's client table (a new one's id follows it).
   *
   * @return {number}
   */
  readClient () {
    const index = this.clientDecoder.read()
    const clients = this.clients
    if (index === clients.length) clients.push(this.clientDecoder.read())
    else if (index > clients.length) throw error.create('an unknown client')
    return clients[index]
  }

  /**
   * YP26: a delete set's client, from the client table.
   *
   * @return {number}
   */
  readDsClient () {
    return this.readClient()
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readInfo () {
    return /** @type {number} */ (this.infoDecoder.read())
  }

  /**
   * @return {string}
   */
  readString () {
    return this.stringDecoder.read()
  }

  /**
   * @return {number} An unsigned 8-bit integer
   */
  readTypeRef () {
    return this.typeRefDecoder.read()
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @return {number}
   */
  readLen () {
    return this.lenDecoder.read()
  }

  /**
   * @return {any}
   */
  readAny () {
    return readValue(this) // YP24
  }

  /**
   * @return {Uint8Array}
   */
  readBuf () {
    return decoding.readVarUint8Array(this.restDecoder)
  }

  /**
   * @return {any}
   */
  readJSON () {
    return readValue(this) // YP24
  }

  /**
   * @return {string}
   */
  readKey () {
    // YP24: `0` a new string, else the index of a known one plus one
    const keyClock = this.keyClockDecoder.read()
    if (keyClock === 0) {
      const key = this.stringDecoder.read()
      this.keys.push(key)
      return key
    }
    if (keyClock > this.keys.length) throw error.create('an unknown key')
    return this.keys[keyClock - 1]
  }

}
