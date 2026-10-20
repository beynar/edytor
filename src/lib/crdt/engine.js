/**
 * The engine object every `bind*` receives — exactly the vendored v14
 * symbols edytor calls, read as static namespace members so a consumer
 * bundle keeps only what these reach (handing the namespace itself to the
 * binders keeps the whole engine). Adding an engine call in `src/lib` means
 * adding its symbol here and in `engine.d.ts`;
 * `src/tests/crdt/engine-surface.test.ts` pins the two.
 *
 * The full namespace (`import * as Y from 'edytor/crdt'`) is a superset and
 * still satisfies `EngineApi`, so `bindCrdt(Y)` keeps working.
 */
import * as V from './vendor/yjs/src/index.js';

// Static member reads of the namespace: bundlers keep only these.
export const Y = {
	Doc: V.Doc,
	Node: V.Node,
	Item: V.Item,
	RangeCursor: V.RangeCursor,
	transact: V.transact,
	applyUpdate: V.applyUpdate,
	encodeStateAsUpdate: V.encodeStateAsUpdate,
	encodeStateVector: V.encodeStateVector,
	decodeStateVector: V.decodeStateVector,
	decodeUpdate: V.decodeUpdate,
	// the store-before-ack body carries the acknowledged deletes (`sync.writeSaved`)
	UpdateEncoder: V.UpdateEncoder,
	writeIdSet: V.writeIdSet,
	mergeUpdates: V.mergeUpdates,
	Skip: V.Skip,
	findIndexSS: V.findIndexSS,
	// a concurrent creation of one block id keeps the losing node (fork patch YP14)
	isKeptReplaced: V.isKeptReplaced,
	// a position as an item id and back (fork patch YP19)
	idAtIndex: V.idAtIndex,
	indexOfId: V.indexOfId,
	createIdSet: V.createIdSet,
	diffIdSet: V.diffIdSet,
	insertIntoIdSet: V.insertIntoIdSet,
	// the document's undo manager (`doc/history.ts`, fork patch YP18)
	iterateStructsByIdSet: V.iterateStructsByIdSet,
	getItemCleanStart: V.getItemCleanStart,
	redoItem: V.redoItem,
	keepItem: V.keepItem,
	followRedone: V.followRedone,
	isParentOf: V.isParentOf,
	mergeIdSets: V.mergeIdSets,
	createID: V.createID,
	// a suggestion's proposed deletion reads gone until its plan ends (fork patch YP32)
	unhide: V.unhide
};
