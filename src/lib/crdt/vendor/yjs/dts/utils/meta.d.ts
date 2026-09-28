export function createContentMap(inserts?: IdMap<any>, deletes?: IdMap<any>): ContentMap;
export function writeContentMap(encoder: import("./UpdateEncoder.js").IdSetEncoder, contentMap: ContentMap): void;
export function readContentMap(decoder: import("./UpdateDecoder.js").IdSetDecoder): ContentMap;
export function encodeContentMap(contentMap: ContentMap): Uint8Array<ArrayBuffer>;
export function decodeContentMap(buf: Uint8Array<any>): import("./ids.js").ContentMap;
/**
 * Schema of {@link ContentIds} - the shape produced by {@link createContentIds}.
 *
 * Structural: a `ContentIds` is a plain object literal, so there is no prototype to tag. The
 * *nominal* {@link $idSet} checks on the two fields are what discriminate it from a
 * {@link ContentMap} in both directions.
 *
 * @type {s.Schema<ContentIds>}
 */
export const $contentIds: s.Schema<ContentIds>;
/**
 * Schema of {@link ContentMap} - the shape produced by {@link createContentMap}.
 *
 * See {@link $contentIds}. Use {@link $idMap} on the individual fields to additionally constrain
 * the mapped-value type; `ContentMap` itself hardcodes `IdMap<any>`.
 *
 * @type {s.Schema<ContentMap>}
 */
export const $contentMap: s.Schema<ContentMap>;
import * as s from 'lib0-v14/schema';
