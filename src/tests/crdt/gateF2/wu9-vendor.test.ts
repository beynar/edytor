/**
 * Gate-F2 probes — WU9/P4 marker patch adversarial cases NOT covered by
 * `src/tests/crdt/marker-seed.test.ts`:
 *
 * 1. TAIL ANCHOR: `applyDelta(retain(len).insert(x))` plants a marker
 *    anchored on the LAST item (plantMarker's tail branch). Deleting that
 *    anchor item then seeding must not resurrect it — updateMarkerChanges
 *    re-bases the anchor left and clears the snapshot.
 * 2. SAME-INDEX FORMAT BOUNDARY: a format op whose boundary IS a marker's
 *    index inserts ContentFormat items at that index — the marker's
 *    snapshot must fold them (updateMarkerFormats' list-order check), not
 *    stay stale.
 * 3. UNDO RESURRECTION: marker planted, adjacent content deleted, undo
 *    restores it — marker pool is cleared wholesale on undo; a seeded op
 *    after must rebuild honestly.
 * 4. GC'D/DELETED ANCHOR: the marker's anchor item is deleted inside a
 *    range then GC'd — the linkage check must reject the stale record.
 * 5. SEED GATES: a FORMATTED op0 retain, and any applyDelta under an
 *    explicit renderer, must not seed — verified by differential.
 * 6. WIRE INTEROP: v14-encoded updates (with markers active) decode under
 *    real `yjs@13.6.30`; and v13-encoded updates decode under v14.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as Y13 from 'yjs';
import * as delta from 'lib0-v14/delta';

const buildFragmented = (doc, name, n) => {
	const text = doc.get(name);
	doc.transact(() => {
		const d = delta.create();
		for (let i = 0; i < n; i++) {
			d.insert('x', i % 2 === 0 ? { b: true } : { i: true });
		}
		text.applyDelta(d);
	});
	return text;
};

const deltaJSON = (text) => JSON.stringify(text.toDelta().toJSON());
const updateBytes = (doc) => Y.encodeStateAsUpdate(doc);

const newDoc = () => {
	const doc = new Y.Doc();
	doc.clientID = 1;
	return doc;
};

const replayPair = (ops, { items = 200 } = {}) => {
	const a = newDoc();
	const b = newDoc();
	const ta = buildFragmented(a, 't', items);
	const tb = buildFragmented(b, 't', items);
	tb._searchMarker = null;
	for (const op of ops) {
		op(ta, a);
		op(tb, b);
	}
	return { a, b, ta, tb };
};

const expectIdentical = ({ a, b, ta, tb }) => {
	expect(deltaJSON(ta)).toEqual(deltaJSON(tb));
	expect(updateBytes(a)).toEqual(updateBytes(b));
};

describe('gateF2/WU9 — tail anchor + deleted anchor', () => {
	test('tail-planted marker whose anchor is deleted then re-seeded', () => {
		const ops = [
			// Sequential-append: plants a tail-anchored marker (last item).
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(200).insert('TAIL'))),
			// Delete the anchor item region (last 4 visible chars incl. TAIL).
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(199).delete(5))),
			// Append again — seed scan sees the deleted-anchor record; must
			// re-base left (updateMarkerChanges) or reject via linkage.
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(199).insert('NEW'))),
			// A mid-text seeded op on top.
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(100).insert('mid')))
		];
		const r = replayPair(ops);
		// markers were actually exercised (non-empty pool on the enabled doc)
		expect(r.ta._searchMarker.length).toBeGreaterThan(0);
		expectIdentical(r);
	});

	test('marker anchored mid-list deleted inside a deleted range', () => {
		const ops = [
			// plant a marker mid-text
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(150).insert('M'))),
			// delete a range COVERING the anchor item (151 onward)
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(140).delete(30))),
			// seeded op near the old anchor position
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(120).insert('seed'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(60).insert('x')))
		];
		expectIdentical(replayPair(ops));
	});

	test('GC after anchor deletion — stale linkage rejected', () => {
		const ops = [
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(150).insert('M'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(140).delete(30)))
		];
		const r = replayPair(ops);
		// Force GC passes on both docs.
		r.a.transact(() => {});
		r.b.transact(() => {});
		r.a.transact(() => {});
		r.b.transact(() => {});
		r.a.transact(() => r.ta.applyDelta(delta.create().retain(120).insert('post-gc')));
		r.b.transact(() => r.tb.applyDelta(delta.create().retain(120).insert('post-gc')));
		expectIdentical(r);
	});
});

describe('gateF2/WU9 — same-index format boundaries', () => {
	test('format op whose boundary IS the marker index folds the snapshot', () => {
		const ops = [
			// plant a marker at index 120
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(120).insert('P'))),
			// format op ending exactly AT index 120 → format item lands at the
			// marker's index — same-index fold must apply, not skip
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(110).retain(10, { z: true }))),
			// seeded op at/after the marker — must see the folded format
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(120).insert('Q'))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(125).retain(5, { z: null })))
		];
		expectIdentical(replayPair(ops));
	});

	test('format op starting exactly AT the marker index', () => {
		const ops = [
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(120).insert('P'))),
			// format op STARTING at the marker's index — the opening marker of
			// the range sits at index 121 (after P) — same-index vs at-right
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(121).retain(15, { q: 1 }))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(121).insert('R'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(130).insert('S')))
		];
		expectIdentical(replayPair(ops));
	});
});

describe('gateF2/WU9 — undo resurrection around markers', () => {
	test('delete-adjacent + undo + seeded op stays identical', () => {
		const mk = (withMarkers) => {
			const doc = newDoc();
			const t = buildFragmented(doc, 't', 150);
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t);
			// plant marker at 120
			doc.transact(() => t.applyDelta(delta.create().retain(120).insert('P')));
			// delete a range ADJACENT to (not covering) the marker
			doc.transact(() => t.applyDelta(delta.create().retain(80).delete(20)));
			// undo — resurrects the deleted items; marker pool cleared
			um.undo();
			// seeded op right at the old marker index — index space shifted
			doc.transact(() => t.applyDelta(delta.create().retain(120).insert('after-undo')));
			doc.transact(() => t.applyDelta(delta.create().retain(60).insert('deep')));
			return { doc, t };
		};
		const on = mk(true);
		const off = mk(false);
		expect(deltaJSON(on.t)).toEqual(deltaJSON(off.t));
		expect(updateBytes(on.doc)).toEqual(updateBytes(off.doc));
	});

	test('undo of the marker-planting op itself, then re-seed', () => {
		const mk = (withMarkers) => {
			const doc = newDoc();
			const t = buildFragmented(doc, 't', 150);
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t);
			doc.transact(() => t.applyDelta(delta.create().retain(120).insert('P', { u: true })));
			um.undo(); // removes 'P' — marker anchor deleted by undo
			doc.transact(() => t.applyDelta(delta.create().retain(110).insert('zz')));
			return { doc, t };
		};
		const on = mk(true);
		const off = mk(false);
		expect(deltaJSON(on.t)).toEqual(deltaJSON(off.t));
		expect(updateBytes(on.doc)).toEqual(updateBytes(off.doc));
	});
});

describe('gateF2/WU9 — seed gates', () => {
	test('a FORMATTED leading retain never seeds (gate rejects) but stays correct', () => {
		const ops = [
			// plant a marker first
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(100).insert('P'))),
			// op0 retain carries a format → gate must reject seeding; the format
			// must still apply across the retained range
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(50, { hl: true }).insert('X'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(70).insert('Y')))
		];
		expectIdentical(replayPair(ops));
	});

	test('applyDelta under an explicit renderer never seeds nor plants', () => {
		const a = newDoc();
		const b = newDoc();
		const ta = buildFragmented(a, 't', 150);
		const tb = buildFragmented(b, 't', 150);
		tb._searchMarker = null;
		// A DiffRenderer over (empty → current) makes every item attributed —
		// the seed gate (renderer === null) must hold and plantMarker must
		// skip (its call is gated `renderer === null` in applyDelta).
		const prevA = new Y.Doc();
		prevA.clientID = 1;
		const prevB = new Y.Doc();
		prevB.clientID = 1;
		const ra = new Y.DiffRenderer(prevA, a);
		const rb = new Y.DiffRenderer(prevB, b);
		const ops = [
			delta.create().retain(100).insert('P'),
			delta.create().retain(80).delete(10),
			delta.create().retain(60).insert('Q', { z: 1 })
		];
		const markersBefore = ta._searchMarker.length;
		for (const d of ops) {
			a.transact(() => ta.applyDelta(d, null, { renderer: ra }));
			b.transact(() => tb.applyDelta(d, null, { renderer: rb }));
		}
		// No marker may be planted through renderer-scoped applyDelta calls.
		expect(ta._searchMarker.length).toBe(markersBefore);
		expect(deltaJSON(ta)).toEqual(deltaJSON(tb));
		expect(updateBytes(a)).toEqual(updateBytes(b));
	});
});

describe('gateF2/WU9 — wire interop', () => {
	test('v14 update from a marker-active doc decodes under real yjs@13', () => {
		const doc = newDoc();
		const t = buildFragmented(doc, 't', 80);
		// Exercise the marker paths so marker records exist in memory.
		doc.transact(() => t.applyDelta(delta.create().retain(40).insert('mid')));
		doc.transact(() => t.applyDelta(delta.create().retain(20).retain(10, { z: true })));
		expect(t._searchMarker.length).toBeGreaterThan(0);
		const update = Y.encodeStateAsUpdate(doc);
		// Decode with real yjs 13 — the wire format must carry no marker state.
		// v14 list content surfaces as a v13 YText (`doc.get` returns a bare
		// AbstractType; the typed getter binds the decoded ref correctly).
		const d13 = new Y13.Doc();
		Y13.applyUpdate(d13, update);
		const t13 = d13.getText('t');
		const s13 = t13.toString();
		expect(s13).toContain('mid');
		expect(s13.length).toBe(83); // 80 chars + 'mid'
	});

	test('v13-encoded update decodes under vendored v14', () => {
		const d13 = new Y13.Doc();
		const t13 = d13.getText('t');
		t13.insert(0, 'hello ');
		t13.insert(6, 'world', { bold: true });
		const update = Y13.encodeStateAsUpdate(d13);
		const doc = newDoc();
		Y.applyUpdate(doc, update);
		const t = doc.get('t');
		const json = JSON.stringify(t.toDelta().toJSON());
		expect(json).toContain('hello ');
		expect(json).toContain('world');
		// And marker paths still work on the decoded content: retain(5) sits
		// inside 'hello ' before the trailing space → 'hello! world'.
		doc.transact(() => t.applyDelta(delta.create().retain(5).insert('!')));
		expect(JSON.stringify(t.toDelta().toJSON())).toContain('hello! ');
	});

	test('marker-enabled and disabled stores produce identical update bytes', () => {
		const r = replayPair([
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(50).insert('x'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(30).delete(5))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(40).retain(10, { m: 1 })))
		]);
		// The marker pool is populated on `a` and absent on `b` — the encoded
		// updates must still be byte-identical (markers are ephemeral state).
		expect(r.ta._searchMarker.length).toBeGreaterThan(0);
		expect(updateBytes(r.a)).toEqual(updateBytes(r.b));
	});
});
