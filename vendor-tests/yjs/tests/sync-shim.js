/**
 * Test-harness shim for `@y/protocols/sync` (from `@y/protocols@1.0.6-rc.1`,
 * upstream `src/sync.js`, MIT © Kevin Jahns — see src/lib/crdt/vendor/yjs/LICENSE
 * for the matching upstream license).
 *
 * This is a verbatim port of the upstream sync protocol with exactly one
 * change: the engine import `@y/y` is retargeted to the vendored source, and
 * `lib0/*` is retargeted to `lib0-v14/*`. The published `@y/protocols` package
 * would instantiate the *npm* `@y/y` engine — a second engine copy whose
 * `instanceof` checks are incompatible with docs created by the vendored
 * source. Only the message types the upstream test helper uses are exercised
 * (SyncStep1/SyncStep2/Update); the full set of helpers is kept for fidelity.
 */
import * as encoding from 'lib0-v14/encoding'
import * as decoding from 'lib0-v14/decoding'
import * as Y from '../../../src/lib/crdt/vendor/yjs/src/index.js'

/**
 * @typedef {Map<number, number>} StateMap
 */

export const messageYjsSyncStep1 = 0
export const messageYjsSyncStep2 = 1
export const messageYjsUpdate = 2

/**
 * @param {encoding.Encoder} encoder
 * @param {Y.Doc} doc
 */
export const writeSyncStep1 = (encoder, doc) => {
  encoding.writeVarUint(encoder, messageYjsSyncStep1)
  const sv = Y.encodeStateVector(doc)
  encoding.writeVarUint8Array(encoder, sv)
}

/**
 * @param {encoding.Encoder} encoder
 * @param {Y.Doc} doc
 * @param {Uint8Array} [encodedStateVector]
 */
export const writeSyncStep2 = (encoder, doc, encodedStateVector) => {
  encoding.writeVarUint(encoder, messageYjsSyncStep2)
  encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, encodedStateVector))
}

/**
 * Read SyncStep1 message and reply with SyncStep2.
 *
 * @param {decoding.Decoder} decoder The reply to the received message
 * @param {encoding.Encoder} encoder The received message
 * @param {Y.Doc} doc
 */
export const readSyncStep1 = (decoder, encoder, doc) =>
  writeSyncStep2(encoder, doc, decoding.readVarUint8Array(decoder))

/**
 * Read and apply Structs and then DeleteStore to a y instance.
 *
 * @param {decoding.Decoder} decoder
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 * @param {(error:Error)=>any} [errorHandler]
 */
export const readSyncStep2 = (decoder, doc, transactionOrigin, errorHandler) => {
  try {
    Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), transactionOrigin)
  } catch (error) {
    if (errorHandler != null) errorHandler(/** @type {Error} */ (error))
    // This catches errors that are thrown by event handlers
    console.error('Caught error while handling a Yjs update', error)
  }
}

/**
 * @param {encoding.Encoder} encoder
 * @param {Uint8Array} update
 */
export const writeUpdate = (encoder, update) => {
  encoding.writeVarUint(encoder, messageYjsUpdate)
  encoding.writeVarUint8Array(encoder, update)
}

/**
 * Read and apply Structs and then DeleteStore to a y instance.
 *
 * @param {decoding.Decoder} decoder
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 * @param {(error:Error)=>any} [errorHandler]
 */
export const readUpdate = readSyncStep2

/**
 * @param {decoding.Decoder} decoder A message received from another client
 * @param {encoding.Encoder} encoder The reply message. Does not need to be sent if empty.
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 * @param {(error:Error)=>any} [errorHandler] Optional error handler that catches errors when reading Yjs messages.
 */
export const readSyncMessage = (decoder, encoder, doc, transactionOrigin, errorHandler) => {
  const messageType = decoding.readVarUint(decoder)
  switch (messageType) {
    case messageYjsSyncStep1:
      readSyncStep1(decoder, encoder, doc)
      break
    case messageYjsSyncStep2:
      readSyncStep2(decoder, doc, transactionOrigin, errorHandler)
      break
    case messageYjsUpdate:
      readUpdate(decoder, doc, transactionOrigin, errorHandler)
      break
    default:
      throw new Error('Unknown message type')
  }
  return messageType
}
