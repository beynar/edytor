export function createContentIds(inserts?: IdSet, deletes?: IdSet): ContentIds;
export function createContentIdsFromContentMap(contentMap: ContentMap): import("./ids.js").ContentIds;
export function createContentIdsFromDoc(ydoc: import("./Doc.js").Doc, insertsContainDeletes: boolean): import("./ids.js").ContentIds;
export function createContentIdsFromDocDiff(ydocPrev: import("./Doc.js").Doc, ydocNext: import("./Doc.js").Doc): import("./ids.js").ContentIds;
export function excludeContentIds(content: ContentIds, excludeContent: ContentIds): import("./ids.js").ContentIds;
export function excludeContentMap(content: ContentMap, excludeContent: ContentIds | ContentMap): import("./ids.js").ContentMap;
export function mergeContentMaps(contents: Array<ContentMap>): import("./ids.js").ContentMap;
export function mergeContentIds(contents: Array<ContentIds>): import("./ids.js").ContentIds;
export function createContentMap(inserts?: IdMap<any>, deletes?: IdMap<any>): ContentMap;
export function createContentMapFromContentIds(contentIds: ContentIds, insertAttrs: Array<ContentAttribute<any>>, deleteAttrs?: Array<ContentAttribute<any>>): import("./ids.js").ContentMap;
export function writeContentIds(encoder: import("./UpdateEncoder.js").IdSetEncoder, contentIds: ContentIds): void;
export function encodeContentIds(contentIds: ContentIds): Uint8Array<ArrayBuffer>;
export function readContentIds(decoder: import("./UpdateDecoder.js").IdSetDecoder): ContentIds;
export function decodeContentIds(buf: Uint8Array<any>): import("./ids.js").ContentIds;
export function writeContentMap(encoder: import("./UpdateEncoder.js").IdSetEncoder, contentMap: ContentMap): void;
export function readContentMap(decoder: import("./UpdateDecoder.js").IdSetDecoder): ContentMap;
export function encodeContentMap(contentMap: ContentMap): Uint8Array<ArrayBuffer>;
export function intersectContentMap(mapA: ContentMap, mapB: ContentMap | ContentIds): import("./ids.js").ContentMap;
export function intersectContentIds(setA: ContentIds, setB: ContentIds | ContentMap): import("./ids.js").ContentIds;
export function decodeContentMap(buf: Uint8Array<any>): import("./ids.js").ContentMap;
export function filterContentMap(contentMap: ContentMap, insertPredicate: (c: Array<ContentAttribute<any>>) => boolean, deletePredicate: (c: Array<ContentAttribute<any>>) => boolean): import("./ids.js").ContentMap;
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
