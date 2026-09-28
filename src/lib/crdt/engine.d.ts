import type * as V from './vendor/yjs/dts/index.js';

/** The engine symbols edytor calls — the keys of `Y` in `engine.js`. */
export type EngineSymbol =
	| 'Doc'
	| 'Node'
	| 'UndoManager'
	| 'Item'
	| 'RangeCursor'
	| 'transact'
	| 'applyUpdate'
	| 'encodeStateAsUpdate'
	| 'encodeStateVector'
	| 'decodeStateVector'
	| 'decodeUpdate'
	| 'mergeUpdates'
	| 'Skip'
	| 'findIndexSS'
	| 'createRelativePositionFromTypeIndex'
	| 'createRelativePositionFromJSON'
	| 'createAbsolutePositionFromRelativePosition'
	| 'relativePositionToJSON'
	| 'createIdSet'
	| 'diffIdSet'
	| 'insertIntoIdSet'
	| 'createIdMap'
	| 'insertIntoIdMap'
	| 'createContentMap'
	| 'decodeContentMap'
	| 'iterateStructsByIdSet'
	| 'getItemCleanStart'
	| 'redoItem';

export declare const Y: Pick<typeof V, EngineSymbol>;
