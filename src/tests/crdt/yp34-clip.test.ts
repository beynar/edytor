/**
 * Fork patch YP34: `clipUpdate(update, sv, ds)`, an update as it read at an
 * earlier state (its structs under `sv`, its deletes `ds` also holds), the
 * counterpart of `diffUpdate`. A re-seed's rebase reads a client's base out
 * of its whole old document with it (`room.reseed.rebase`).
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../lib/crdt/engine.js';
import { clipUpdate, decodeUpdate } from '../../lib/crdt/vendor/yjs/src/index.js';

describe('the clip (fork patch YP34)', () => {
	it('reads an update as it was at a state vector, with only the deletes a set holds', () => {
		// Deleted text keeps its content (edytor's hold records do; a collecting doc would not).
		const a = new Y.Doc({ gc: false });
		a.clientID = 1;
		const t = a.get('t');
		t.insert(0, 'hello');
		const sv = Y.encodeStateVector(a);
		const ds = decodeUpdate(Y.encodeStateAsUpdate(a)).ds;
		t.insert(5, ' world');
		t.delete(0, 1);
		const clipped = new Y.Doc();
		Y.applyUpdate(clipped, clipUpdate(Y.encodeStateAsUpdate(a), sv, ds));
		expect(clipped.get('t').toString()).toBe('hello');
		expect(Y.encodeStateVector(clipped)).toEqual(sv);
	});

	it('cuts a run that crosses the state vector', () => {
		const a = new Y.Doc();
		a.clientID = 1;
		a.get('t').insert(0, 'ab');
		const sv = Y.encodeStateVector(a);
		a.get('t').insert(2, 'cd');
		// One run `abcd` once merged; the clip keeps `ab`.
		const clipped = new Y.Doc();
		Y.applyUpdate(clipped, clipUpdate(Y.encodeStateAsUpdate(a), sv, Y.createIdSet()));
		expect(clipped.get('t').toString()).toBe('ab');
	});
});
