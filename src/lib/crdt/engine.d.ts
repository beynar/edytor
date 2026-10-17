import type * as V from './vendor/yjs/dts/index.js';

/** The engine symbols edytor calls — the keys of `Y` in `engine.js`. */
export type EngineSymbol =
	| 'Doc'
	| 'Node'
	| 'Item'
	| 'RangeCursor'
	| 'transact'
	| 'applyUpdate'
	| 'encodeStateAsUpdate'
	| 'encodeStateVector'
	| 'decodeStateVector'
	| 'decodeUpdate'
	| 'UpdateEncoder'
	| 'writeIdSet'
	| 'mergeUpdates'
	| 'Skip'
	| 'findIndexSS'
	| 'isKeptReplaced'
	| 'sequenceOrder'
	| 'idAtIndex'
	| 'indexOfId'
	| 'createIdSet'
	| 'diffIdSet'
	| 'insertIntoIdSet'
	| 'iterateStructsByIdSet'
	| 'getItemCleanStart'
	| 'redoItem'
	| 'keepItem'
	| 'followRedone'
	| 'isParentOf'
	| 'mergeIdSets'
	| 'createID';

export declare const Y: Pick<typeof V, EngineSymbol>;
