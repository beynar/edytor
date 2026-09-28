/**
 * P3.1 — the engine object (`crdt/engine.js`) is a named-import subset of
 * the vendored namespace. Pins its keys to `EngineSymbol` (engine.d.ts) and
 * each value to the namespace export, so the object and its declaration
 * cannot drift, and the full namespace stays assignable to `EngineApi`.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../lib/crdt/engine.js';
import type { EngineSymbol } from '../../lib/crdt/engine.js';
import type { EngineApi } from '../../lib/crdt/engine-api.js';
import * as V from '../../lib/crdt/vendor/yjs/src/index.js';

const SYMBOLS = {
	Doc: 1,
	Node: 1,
	UndoManager: 1,
	Item: 1,
	RangeCursor: 1,
	transact: 1,
	applyUpdate: 1,
	encodeStateAsUpdate: 1,
	encodeStateVector: 1,
	decodeStateVector: 1,
	decodeUpdate: 1,
	findIndexSS: 1,
	createRelativePositionFromTypeIndex: 1,
	createRelativePositionFromJSON: 1,
	createAbsolutePositionFromRelativePosition: 1,
	relativePositionToJSON: 1,
	createIdSet: 1,
	diffIdSet: 1,
	insertIntoIdSet: 1,
	createIdMap: 1,
	insertIntoIdMap: 1,
	createContentMap: 1,
	decodeContentMap: 1,
	// used by the Durable Object room (P5): compaction and struct checks
	mergeUpdates: 1,
	Skip: 1,
	// text delete marks (P11)
	iterateStructsByIdSet: 1,
	getItemCleanStart: 1,
	redoItem: 1
} satisfies Record<EngineSymbol, 1>;

describe('engine object (named imports)', () => {
	it('holds exactly the EngineSymbol keys', () => {
		expect(Object.keys(Y).sort()).toEqual(Object.keys(SYMBOLS).sort());
	});

	it('every value is the vendored namespace export (one engine instance)', () => {
		for (const key of Object.keys(Y) as EngineSymbol[]) {
			expect(Y[key], key).toBe((V as Record<string, unknown>)[key]);
			expect(Y[key], key).toBeTypeOf('function');
		}
	});

	it('the full namespace satisfies EngineApi (bindCrdt(Y) with import * as Y)', () => {
		const api: EngineApi = V;
		expect(api.Doc).toBe(Y.Doc);
	});
});
