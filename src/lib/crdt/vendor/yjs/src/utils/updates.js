import * as binary from 'lib0-v14/binary'
import * as decoding from 'lib0-v14/decoding'
import * as encoding from 'lib0-v14/encoding'
import * as f from 'lib0-v14/function'
import * as string from 'lib0-v14/string'

import { readIdSet, writeIdSet } from './ids.js'

import { createID } from './ID.js'
import { UpdateEncoderV1, UpdateEncoderV2 } from './UpdateEncoder.js'
import { UpdateDecoderV1, UpdateDecoderV2 } from './UpdateDecoder.js'
import { GC } from '../structs/GC.js'
import { Item } from '../structs/Item.js'
import {
  readItemContent
} from '../ynode.js'
import { Skip } from '../structs/Skip.js'

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 */
function * lazyStructReaderGenerator (decoder) {
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding.readVarUint(decoder.restDecoder)
    const client = decoder.readClient()
    let clock = decoding.readVarUint(decoder.restDecoder)
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo()
      // @todo use switch instead of ifs
      if (info === 10) {
        const len = decoding.readVarUint(decoder.restDecoder)
        yield new Skip(createID(client, clock), len)
        clock += len
      } else if ((binary.BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
        // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
        // and we read the next string as parentYKey.
        // It indicates how we store/retrieve parent from `y.share`
        // @type {string|null}
        const struct = new Item(
          createID(client, clock),
          null, // left
          (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null, // origin
          null, // right
          (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null, // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? (decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID()) : null, // parent
          cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
          readItemContent(decoder, info) // item content
        )
        yield struct
        clock += struct.length
      } else {
        const len = decoder.readLen()
        yield new GC(createID(client, clock), len)
        clock += len
      }
    }
  }
}

export class LazyStructReader {
  /**
   * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
   * @param {boolean} filterSkips
   */
  constructor (decoder, filterSkips) {
    this.gen = lazyStructReaderGenerator(decoder)
    /**
     * @type {null | Item | Skip | GC}
     */
    this.curr = null
    this.done = false
    this.filterSkips = filterSkips
    this.next()
  }

  /**
   * @return {Item | GC | Skip |null}
   */
  next () {
    // ignore "Skip" structs
    do {
      this.curr = this.gen.next().value || null
    } while (this.filterSkips && this.curr !== null && this.curr.constructor === Skip)
    return this.curr
  }
}

/**
 * @param {Uint8Array} update
 */
export const decodeUpdate = (update) => decodeUpdateV2(update, UpdateDecoderV1)

/**
 * @param {Uint8Array} update
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} [YDecoder]
 *
 */
export const decodeUpdateV2 = (update, YDecoder = UpdateDecoderV2) => {
  const structs = []
  const updateDecoder = new YDecoder(decoding.createDecoder(update))
  const lazyDecoder = new LazyStructReader(updateDecoder, false)
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    structs.push(curr)
  }
  return {
    structs,
    ds: readIdSet(updateDecoder)
  }
}

export class LazyStructWriter {
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  constructor (encoder) {
    this.currClient = 0
    this.startClock = 0
    this.written = 0
    this.encoder = encoder
    /**
     * We want to write operations lazily, but also we need to know beforehand how many operations we want to write for each client.
     *
     * This kind of meta-information (#clients, #structs-per-client-written) is written to the restEncoder.
     *
     * We fragment the restEncoder and store a slice of it per-client until we know how many clients there are.
     * When we flush (toUint8Array) we write the restEncoder using the fragments and the meta-information.
     *
     * @type {Array<{ written: number, restEncoder: Uint8Array }>}
     */
    this.clientStructs = []
  }
}

/**
 * This method is intended to slice any kind of struct and retrieve the right part.
 * It does not handle side-effects, so it should only be used by the lazy-encoder.
 *
 * @param {Item | GC | Skip} left
 * @param {number} diff
 * @return {Item | GC | Skip}
 */
export const sliceStruct = (left, diff) => {
  if (left.constructor === GC) {
    const { client, clock } = left.id
    return new GC(createID(client, clock + diff), left.length - diff)
  } else if (left.constructor === Skip) {
    const { client, clock } = left.id
    return new Skip(createID(client, clock + diff), left.length - diff)
  } else {
    const leftItem = /** @type {Item} */ (left)
    const { client, clock } = leftItem.id
    return new Item(
      createID(client, clock + diff),
      null,
      createID(client, clock + diff - 1),
      null,
      leftItem.rightOrigin,
      leftItem.parent,
      leftItem.parentSub,
      leftItem.content.splice(diff)
    )
  }
}

/**
 * @param {LazyStructWriter} lazyWriter
 */
const flushLazyStructWriter = lazyWriter => {
  if (lazyWriter.written > 0) {
    lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: encoding.toUint8Array(lazyWriter.encoder.restEncoder) })
    lazyWriter.encoder.restEncoder = encoding.createEncoder()
    lazyWriter.written = 0
  }
}

/**
 * @param {LazyStructWriter} lazyWriter
 * @param {Item | GC | Skip} struct
 * @param {number} offset
 * @param {number} offsetEnd
 */
export const writeStructToLazyStructWriter = (lazyWriter, struct, offset, offsetEnd) => {
  // flush curr if we start another client
  if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
    flushLazyStructWriter(lazyWriter)
  }
  if (lazyWriter.written === 0) {
    lazyWriter.currClient = struct.id.client
    // write next client
    lazyWriter.encoder.writeClient(struct.id.client)
    // write startClock
    encoding.writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock + offset)
  }
  struct.write(lazyWriter.encoder, offset, offsetEnd)
  lazyWriter.written++
}
/**
 * Call this function when we collected all parts and want to
 * put all the parts together. After calling this method,
 * you can continue using the UpdateEncoder.
 *
 * @param {LazyStructWriter} lazyWriter
 */
export const finishLazyStructWriting = (lazyWriter) => {
  flushLazyStructWriter(lazyWriter)

  // this is a fresh encoder because we called flushCurr
  const restEncoder = lazyWriter.encoder.restEncoder

  /**
   * Now we put all the fragments together.
   * This works similarly to `writeClientsStructs`
   */

  // write # states that were updated - i.e. the clients
  encoding.writeVarUint(restEncoder, lazyWriter.clientStructs.length)

  for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
    const partStructs = lazyWriter.clientStructs[i]
    /**
     * Works similarly to `writeStructs`
     */
    // write # encoded structs
    encoding.writeVarUint(restEncoder, partStructs.written)
    // write the rest of the fragment
    encoding.writeUint8Array(restEncoder, partStructs.restEncoder)
  }
}

/**
 * @param {Uint8Array} update
 * @param {function(Item|GC|Skip):Item|GC|Skip} blockTransformer
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} YDecoder
 * @param {typeof UpdateEncoderV2 | typeof UpdateEncoderV1 } YEncoder
 */
export const convertUpdateFormat = (update, blockTransformer, YDecoder, YEncoder) => {
  const updateDecoder = new YDecoder(decoding.createDecoder(update))
  const lazyDecoder = new LazyStructReader(updateDecoder, false)
  const updateEncoder = new YEncoder()
  const lazyWriter = new LazyStructWriter(updateEncoder)
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    writeStructToLazyStructWriter(lazyWriter, blockTransformer(curr), 0, 0)
  }
  finishLazyStructWriting(lazyWriter)
  const ds = readIdSet(updateDecoder)
  writeIdSet(updateEncoder, ds)
  return updateEncoder.toUint8Array()
}

/**
 * @typedef {Object} ObfuscatorOptions
 * @property {boolean} [ObfuscatorOptions.formatting=true]
 * @property {boolean} [ObfuscatorOptions.subdocs=true]
 * @property {boolean} [ObfuscatorOptions.name=true] Whether to obfuscate nodeName / hookName
 */

/**
 * @param {Uint8Array} update
 */
export const convertUpdateFormatV2ToV1 = update => convertUpdateFormat(update, f.id, UpdateDecoderV2, UpdateEncoderV1)

