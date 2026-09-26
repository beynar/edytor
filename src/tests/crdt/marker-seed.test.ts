/**
 * WU9/P4 differential tests — the format-aware search-marker seeding patch.
 *
 * The patch lets `YNode#applyDelta` seed its `ItemTextListPosition` cursor
 * from a search marker carrying a `currentFormats` snapshot, accelerates
 * `createRelativePositionFromTypeIndex` / `createAbsolutePositionFromRelativePosition`
 * with marker lookups, and keeps `marker.formats` valid through insert/delete/
 * re-anchor paths (`src/lib/crdt/vendor/yjs/UPSTREAM.md` P4).
 *
 * Setting `_searchMarker = null` on a type makes every added path inert —
 * the seed gate, the end-plant, the marker lookups and the format-fold hooks
 * all test `!== null` first — so "markers disabled" is exactly the upstream
 * behavior. These tests replay identical operation streams on marker-enabled
 * vs marker-disabled types and require byte-identical document state: item
 * production, format boundaries, positions and history semantics must be
 * indistinguishable.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, test } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import * as delta from 'lib0-v14/delta';

/** Build a fragmented formatted text: n single-char items separated by format markers. */
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

/**
 * Serialized delta JSON — YNode#toJSON normalizes embedded type references,
 * so two structurally-identical texts stringify identically.
 */
const deltaJSON = (text) => JSON.stringify(text.toDelta().toJSON());
const updateBytes = (doc) => Y.encodeStateAsUpdate(doc);

const newDoc = () => {
	const doc = new Y.Doc();
	doc.clientID = 1; // identical client ids ⇒ identical struct ids ⇒ byte-identical stores
	return doc;
};

/**
 * Replay one op stream on two docs — markers on vs markers off — and compare.
 * `ops` is a list of functions receiving (text, doc).
 */
const replayPair = (ops, { items = 200, disableOnSecond = true } = {}) => {
	const a = newDoc();
	const b = newDoc();
	const ta = buildFragmented(a, 't', items);
	const tb = buildFragmented(b, 't', items);
	if (disableOnSecond) tb._searchMarker = null;
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

describe('WU9/P4 marker seeding — differential vs disabled', () => {
	test('distant pure retains + inserts produce identical state', () => {
		const ops = [];
		for (let i = 0; i < 30; i++) {
			const pos = (i * 37) % 190;
			ops.push((t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(pos).insert(`y${i}`)))
			);
			ops.push((t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(pos).delete(2))));
		}
		expectIdentical(replayPair(ops));
	});

	test('retains carrying formats over seeded regions apply identically', () => {
		const ops = [
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(60).retain(20, { b: null }))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(30).retain(40, { u: true }))),
			(t, doc) =>
				doc.transact(() =>
					t.applyDelta(delta.create().retain(100).retain(10, { i: null, u: null }))
				),
			// same-position repeats exercise the seeded path for the second apply
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(60).retain(20, { b: true })))
		];
		expectIdentical(replayPair(ops));
	});

	test('insert-with-format inside formatted regions produces identical markers', () => {
		const ops = [
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(50).insert('AB', { b: true }))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(51).insert('C'))),
			(t, doc) =>
				doc.transact(() =>
					t.applyDelta(delta.create().retain(150).insert('D', { i: true, u: true }))
				)
		];
		expectIdentical(replayPair(ops));
	});

	test('delete sweeps + reinserts over seeded regions stay identical', () => {
		const ops = [
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(40).delete(60))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(40).insert('reinserted'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(0).delete(10))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(20).retain(30, { i: true })))
		];
		expectIdentical(replayPair(ops));
	});

	test('undo/redo produces identical state (markers cleared on undo)', () => {
		const mk = (withMarkers) => {
			const doc = newDoc();
			const t = buildFragmented(doc, 't', 120);
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t);
			doc.transact(() => t.applyDelta(delta.create().retain(50).insert('ZZ', { b: true })));
			doc.transact(() => t.applyDelta(delta.create().retain(30).delete(20)));
			um.undo();
			um.undo();
			um.redo();
			return { doc, t };
		};
		const on = mk(true);
		const off = mk(false);
		expect(deltaJSON(on.t)).toEqual(deltaJSON(off.t));
		expect(updateBytes(on.doc)).toEqual(updateBytes(off.doc));
	});

	test('relative positions resolve identically under marker acceleration', () => {
		const { a, b, ta, tb } = replayPair([
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(80).insert('mid'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(10).delete(5)))
		]);
		for (const pos of [0, 1, 40, 90, 150, ta.length - 1]) {
			const ra = Y.createRelativePositionFromTypeIndex(ta, pos, 0);
			const rb = Y.createRelativePositionFromTypeIndex(tb, pos, 0);
			expect(Y.relativePositionToJSON(ra)).toEqual(Y.relativePositionToJSON(rb));
			const aa = Y.createAbsolutePositionFromRelativePosition(ra, a, false);
			const ab = Y.createAbsolutePositionFromRelativePosition(rb, b, false);
			expect(aa === null ? null : { index: aa.index, assoc: aa.assoc }).toEqual(
				ab === null ? null : { index: ab.index, assoc: ab.assoc }
			);
		}
	});

	test('remote update application produces identical convergence (markers cleared)', () => {
		const src = newDoc();
		src.clientID = 99; // a distinct remote peer — no id collision on applyUpdate
		buildFragmented(src, 't', 120);
		src.transact(() => src.get('t').applyDelta(delta.create().retain(50).insert('S', { u: true })));
		const update = Y.encodeStateAsUpdate(src);
		const a = newDoc();
		const b = newDoc();
		const ta = a.get('t');
		const tb = b.get('t');
		tb._searchMarker = null;
		Y.applyUpdate(a, update);
		Y.applyUpdate(b, update);
		expect(deltaJSON(ta)).toEqual(deltaJSON(tb));
		expect(updateBytes(a)).toEqual(updateBytes(b));
	});

	test('same-key boundary: an intervening marker shadows later snapshots', () => {
		// R1 regression (docs/crdt-v14-follow-up-review-2026-09-21.md): a marker
		// inside the [100,200) bold span keeps {b:true} when a 'Z' insert+negation
		// pair lands at index 50 — the negation's fold must stop at the span's
		// live `b` opener. Pre-repair the blind fold overwrote the snapshot with
		// {} and the seeded 'Q' insert dropped bold from the span tail.
		const ops = [
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(150).insert('P', { b: true }))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(50).insert('Z', { b: true }))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(152).insert('Q', { b: true })))
		];
		const a = newDoc();
		const b = newDoc();
		const ta = a.get('t');
		const tb = b.get('t');
		a.transact(() => ta.applyDelta(delta.create().insert('x'.repeat(300))));
		b.transact(() => tb.applyDelta(delta.create().insert('x'.repeat(300))));
		a.transact(() => ta.applyDelta(delta.create().retain(100).retain(100, { b: true })));
		b.transact(() => tb.applyDelta(delta.create().retain(100).retain(100, { b: true })));
		tb._searchMarker = null;
		for (const op of ops) {
			op(ta, a);
			op(tb, b);
			// per-op assertion — the corruption surfaced at the 'Q' insert
			expect(deltaJSON(ta)).toEqual(deltaJSON(tb));
			expect(updateBytes(a)).toEqual(updateBytes(b));
		}
		// explicit expected coverage: the last 50 original bold chars stay bold
		const json = JSON.parse(deltaJSON(ta));
		let pos = 0;
		const bold = [];
		for (const op of json.children ?? []) {
			const len = typeof op.insert === 'string' ? op.insert.length : 1;
			if (op.format?.b === true) bold.push([pos, pos + len]);
			pos += len;
		}
		expect(bold).toEqual([
			[50, 51],
			[101, 203]
		]);
	});

	test('deletes tombstoning format items invalidate planted snapshots', () => {
		// Regression for the WU9 audit hole: op at P plants a marker with a
		// formats snapshot; a later delete sweeps format markers left of P;
		// without the updateMarkerChanges invalidation the next seeded walk
		// would resurrect the deleted formats.
		const ops = [
			// plant a marker at index 120 carrying the {b|i} format state
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(120).insert('P'))),
			// delete a range containing format markers left of the planted marker
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(20).delete(60))),
			// seeded op at the planted position — must not resurrect deleted formats
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(80).insert('Q', { u: true }))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(90).retain(10, { b: null })))
		];
		expectIdentical(replayPair(ops));
	});

	test('item merge after split keeps marker snapshots honest', () => {
		const ops = [
			// plant a marker, then same-position ops that split + merge items
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(100).insert('SPLIT'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(100).delete(2))),
			(t, doc) =>
				doc.transact(() => t.applyDelta(delta.create().retain(98).retain(20, { hl: true }))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(103).insert('X')))
		];
		expectIdentical(replayPair(ops));
	});

	test('GC after deletes leaves identical state (linkage-verified anchors)', () => {
		const ops = [
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(20).delete(100))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(10).insert('tail'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(15).retain(5, { b: null })))
		];
		const r = replayPair(ops);
		// force GC pass on both docs identically
		r.a.transact(() => {});
		r.b.transact(() => {});
		expectIdentical(r);
	});

	test('nested modify ops through ContentType children stay identical', () => {
		const ops = [
			(t, doc) =>
				doc.transact(() => {
					const sub = new Y.Node('inline');
					sub.applyDelta(delta.create().insert('deep'));
					t.applyDelta(delta.create().retain(60).insert([sub]));
				}),
			(t, doc) =>
				doc.transact(() => {
					// modify op into the embedded child
					const d = delta.create().retain(60).modify(delta.create().insert('!'));
					t.applyDelta(d);
				})
		];
		expectIdentical(replayPair(ops));
	});
});
