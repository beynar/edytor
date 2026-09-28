/**
 * Meta API for describing Yjs documents
 */

import * as decoding from 'lib0-v14/decoding'
import * as s from 'lib0-v14/schema'

import { $idSet, $idMapAny, createIdMap, writeIdMap, readIdMap } from './ids.js'
import { IdSetEncoderV2 } from './UpdateEncoder.js'
import { IdSetDecoderV2 } from './UpdateDecoder.js'

/**
 * @param {IdMap<any>} [inserts]
 * @param {IdMap<any>} [deletes]
 * @return {ContentMap}
 */
export const createContentMap = (inserts = createIdMap(), deletes = createIdMap()) => ({ inserts, deletes })

/**
 * @todo this encoding needs to be heavily optimized for production
 *
 * @param {import('./UpdateEncoder.js').IdSetEncoder} encoder
 * @param {ContentMap} contentMap
 */
export const writeContentMap = (encoder, contentMap) => {
  writeIdMap(encoder, contentMap.inserts)
  writeIdMap(encoder, contentMap.deletes)
}

/**
 * @todo this encoding needs to be heavily optimized for production
 *
 * @param {import('./UpdateDecoder.js').IdSetDecoder} decoder
 * @return {ContentMap} contentMap
 */
export const readContentMap = (decoder) => createContentMap(
  readIdMap(decoder),
  readIdMap(decoder)
)

/**
 * @param {ContentMap} contentMap
 */
export const encodeContentMap = contentMap => {
  const encoder = new IdSetEncoderV2()
  writeContentMap(encoder, contentMap)
  return encoder.toUint8Array()
}

/**
 * @param {Uint8Array<any>} buf
 */
export const decodeContentMap = buf => readContentMap(new IdSetDecoderV2(decoding.createDecoder(buf)))

/**
 * Schema of {@link ContentIds} - the shape produced by {@link createContentIds}.
 *
 * Structural: a `ContentIds` is a plain object literal, so there is no prototype to tag. The
 * *nominal* {@link $idSet} checks on the two fields are what discriminate it from a
 * {@link ContentMap} in both directions.
 *
 * @type {s.Schema<ContentIds>}
 */
export const $contentIds = s.$object({ inserts: $idSet, deletes: $idSet })

/**
 * Schema of {@link ContentMap} - the shape produced by {@link createContentMap}.
 *
 * See {@link $contentIds}. Use {@link $idMap} on the individual fields to additionally constrain
 * the mapped-value type; `ContentMap` itself hardcodes `IdMap<any>`.
 *
 * @type {s.Schema<ContentMap>}
 */
export const $contentMap = s.$object({ inserts: $idMapAny, deletes: $idMapAny })
