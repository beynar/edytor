/**
 * HISTORICAL DIAGNOSTICS — dev-only evidence, never shipped (U02 §5).
 *
 * Engine under test: `yjs-14-move` = npm `yjs@14.0.0-1` (upstream commit
 * b56debef005caef8660c672e17cec3e869646422, the PR #357 native-move
 * implementation). This is a *different engine* from the vendored rc.26 —
 * imported here only to pin two documented defects as durable regression
 * evidence. Production code never touches it; the assertions below document
 * OBSERVED buggy behavior (they would fail on a correct engine).
 *
 * Cases (plan §3):
 *  (a) issue #694 — `[0,1,2]`, move last element into the middle → `toJSON()`
 *      sparse while `toArray()` = `[0,2,1]`. https://github.com/yjs/yjs/issues/694
 *  (b) cursor case — anchor a relative position to `c` in `[a,b,c]`, move `c`
 *      to the front → anchor resolves to index 2 instead of 0.
 */
// @ts-nocheck -- historical engine has no usable types here; diagnostic only.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs-14-move';

describe('historical diagnostics: yjs@14.0.0-1 (PR #357 head)', () => {
	it('(a) #694 — move last element to middle: toJSON sparse, toArray correct', () => {
		const doc = new Y.Doc();
		const arr = doc.getArray('a');
		arr.insert(0, [0, 1, 2]);
		arr.move(2, 1);
		// Bug: materialized JSON is sparse — index 2 is a genuine hole
		// (no own property; JSON.stringify renders null) while logical reads
		// see [0,2,1].
		const json = arr.toJSON();
		expect(json.length).toBe(3);
		expect(json[0]).toBe(0);
		expect(json[1]).toBe(2);
		expect(json[2]).toBeUndefined();
		expect(Object.hasOwn(json, 2)).toBe(false); // the sparse-slot signature
		expect(JSON.stringify(json)).toBe('[0,2,null]');
		expect(arr.toArray()).toEqual([0, 2, 1]);
		expect(arr.length).toBe(3);
		expect([arr.get(0), arr.get(1), arr.get(2)]).toEqual([0, 2, 1]);
	});

	it('(a2) #694 — sparse toJSON persists after sync to a fresh document', () => {
		const doc = new Y.Doc();
		const arr = doc.getArray('a');
		arr.insert(0, [0, 1, 2]);
		arr.move(2, 1);
		const replica = new Y.Doc();
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
		const rArr = replica.getArray('a');
		expect(rArr.toArray()).toEqual([0, 2, 1]);
		const rJson = rArr.toJSON();
		expect(rJson.length).toBe(3);
		expect(Object.hasOwn(rJson, 2)).toBe(false);
	});

	it('(b) cursor case — anchor to `c`, move `c` to front, anchor resolves to 2 not 0', () => {
		const doc = new Y.Doc();
		const arr = doc.getArray('a');
		arr.insert(0, ['a', 'b', 'c']);
		// Anchor a position to 'c' (index 2). assoc=-1 binds the position to
		// the item boundary — a correct move keeps it on 'c' → index 0.
		const rpos = Y.createRelativePositionFromTypeIndex(arr, 2, -1);
		arr.move(2, 0);
		expect(arr.toArray()).toEqual(['c', 'a', 'b']);
		const abs = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
		// Bug: the anchor stays at index 2 rather than following 'c' to 0.
		expect(abs.index).toBe(2);
	});

	it('(b2) cursor case — assoc=0 anchor likewise fails to follow the moved item', () => {
		const doc = new Y.Doc();
		const arr = doc.getArray('a');
		arr.insert(0, ['a', 'b', 'c']);
		const rpos = Y.createRelativePositionFromTypeIndex(arr, 2, 0);
		arr.move(2, 0);
		const abs = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
		expect(abs.index).toBe(2);
	});
});
