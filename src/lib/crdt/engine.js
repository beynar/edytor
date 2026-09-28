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
	UndoManager: V.UndoManager,
	Item: V.Item,
	RangeCursor: V.RangeCursor,
	transact: V.transact,
	applyUpdate: V.applyUpdate,
	encodeStateAsUpdate: V.encodeStateAsUpdate,
	encodeStateVector: V.encodeStateVector,
	decodeStateVector: V.decodeStateVector,
	decodeUpdate: V.decodeUpdate,
	// the engine's pending store is V2-encoded (admission of pending structs)
	decodeUpdateV2: V.decodeUpdateV2,
	// the store-before-ack body carries the acknowledged deletes (`sync.writeSaved`)
	UpdateEncoderV1: V.UpdateEncoderV1,
	writeIdSet: V.writeIdSet,
	mergeUpdates: V.mergeUpdates,
	Skip: V.Skip,
	findIndexSS: V.findIndexSS,
	createRelativePositionFromTypeIndex: V.createRelativePositionFromTypeIndex,
	createRelativePositionFromJSON: V.createRelativePositionFromJSON,
	createAbsolutePositionFromRelativePosition: V.createAbsolutePositionFromRelativePosition,
	relativePositionToJSON: V.relativePositionToJSON,
	createIdSet: V.createIdSet,
	diffIdSet: V.diffIdSet,
	insertIntoIdSet: V.insertIntoIdSet,
	createIdMap: V.createIdMap,
	insertIntoIdMap: V.insertIntoIdMap,
	createContentMap: V.createContentMap,
	decodeContentMap: V.decodeContentMap,
	// text delete marks (`text/deletes.ts`, fork patch P11)
	iterateStructsByIdSet: V.iterateStructsByIdSet,
	getItemCleanStart: V.getItemCleanStart,
	redoItem: V.redoItem
};
