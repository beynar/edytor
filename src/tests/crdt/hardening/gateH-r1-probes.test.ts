/**
 * GATE H adversarial probes — R1/P4 format-aware search markers.
 *
 * The repair claims: "Remote applies and undo still clear the whole pool
 * (`_searchMarker.length = 0`)" (Item.js integrate comment) — but the clear
 * in `_callObserver` is gated on `!transaction.local`. A remote update
 * applied INSIDE an outer local transaction (`doc.transact(() =>
 * applyUpdate(doc, u))`) joins the outer transaction — `local` stays true —
 * so integrated remote format items never trigger the pool clear and never
 * passed through `updateMarkerFormats`. Any marker snapshot taken before the
 * apply is then stale and seeds the next applyDelta.
 *
 * Also probed: marker-seeded `createRelativePositionFromTypeIndex`
 * (anchorAt/atomAnchorAt serialization depends on marker.index), undo
 * restoring format items with live markers, and facade-level randomized
 * differential replay (markers on vs `_searchMarker = null`).
 */
// @ts-nocheck -- probes reach into vendored engine internals on purpose.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as delta from 'lib0-v14/delta';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
let cid = 900_000;

/** Plant a format-carrying marker by forcing findMarker to walk to `index`. */
const plantMarkerAt = (t: any, index: number) => {
	// typeListGet → findMarker(type, index): creates/repositions a marker and
	// folds ContentFormat items into marker.formats during the rightward walk.
	t.get(index);
};

const seededMarkerCount = (t: any) =>
	(t._searchMarker ?? []).filter((m: any) => m.formats !== null).length;

const deltaJson = (t: any) => JSON.stringify(t.toDelta().toJSON());

const boldRangesOfDelta = (djson: {
	children?: { insert?: unknown; format?: Record<string, unknown> }[];
}): [number, number][] => {
	const out: [number, number][] = [];
	let pos = 0;
	for (const op of djson.children ?? []) {
		const len = typeof op.insert === 'string' ? op.insert.length : 1;
		if (op.format?.b === true) {
			if (out.length > 0 && out[out.length - 1][1] === pos) out[out.length - 1][1] = pos + len;
			else out.push([pos, pos + len]);
		}
		pos += len;
	}
	return out;
};

describe('gateH-R1 — remote apply inside a LOCAL transaction bypasses the marker clear', () => {
	test('nested-local applyUpdate leaves stale marker snapshots; next applyDelta corrupts', () => {
		// docA: 100 x's, bold [40,60), a format-carrying marker planted at 50.
		const docA = new Y.Doc();
		docA.clientID = cid++;
		const tA = docA.get('t');
		docA.transact(() => {
			tA.applyDelta(delta.create().insert('x'.repeat(100)));
			tA.applyDelta(delta.create().retain(40).retain(20, { b: true }));
		});
		plantMarkerAt(tA, 50);
		expect(seededMarkerCount(tA)).toBeGreaterThan(0);

		// docB (remote): same base, adds an italic span — a format item that
		// must reach/invalidate marker snapshots on the receiver.
		const docB = new Y.Doc();
		docB.clientID = cid++;
		const tB = docB.get('t');
		docB.transact(() => {
			tB.applyDelta(delta.create().insert('x'.repeat(100)));
			tB.applyDelta(delta.create().retain(10).retain(80, { i: true }));
		});
		const remoteUpdate = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));

		// Control replica: markers force-disabled — the upstream-inert oracle.
		const docC = new Y.Doc();
		docC.clientID = docA.clientID;
		const tC = docC.get('t');
		docC.transact(() => {
			tC.applyDelta(delta.create().insert('x'.repeat(100)));
			tC.applyDelta(delta.create().retain(40).retain(20, { b: true }));
		});
		tC._searchMarker = null;

		// THE ATTACK: apply the remote update INSIDE an outer local
		// transaction. transact() joins the open transaction — the applies
		// land with local=true → `_callObserver` never clears the pool.
		docA.transact(() => {
			Y.applyUpdate(docA, remoteUpdate);
		});
		Y.applyUpdate(docC, remoteUpdate);

		const seededBefore = seededMarkerCount(tA);
		// A seeded write after the nested apply — the marker snapshot is stale
		// iff the clear was skipped. The plain insert at 50 must only negate
		// `b` (which the snapshot knows); a stale snapshot additionally misses
		// the remote `i` span [10,90) → the negated-format pass differs.
		docA.transact(() => tA.applyDelta(delta.create().retain(50).insert('Z')));
		docC.transact(() => tC.applyDelta(delta.create().retain(50).insert('Z')));

		expect(deltaJson(tA)).toBe(deltaJson(tC));
		// readUpdateV2 forces `transaction.local = false` even when joining an
		// outer local transaction — so the observer-time pool clear still runs.
		// Pin that invariant: if it regresses, the differential above is the
		// only thing standing between this and silent format corruption.
		expect(
			seededBefore,
			'nested applyUpdate must still clear seeded marker snapshots ' +
				'(readUpdateV2 sets transaction.local=false on the outer tr)'
		).toBe(0);
	});

	test('the same nested apply WITHOUT prior markers is clean (control)', () => {
		const docA = new Y.Doc();
		docA.clientID = cid++;
		const tA = docA.get('t');
		docA.transact(() => {
			tA.applyDelta(delta.create().insert('x'.repeat(100)));
			tA.applyDelta(delta.create().retain(40).retain(20, { b: true }));
		});
		// No marker planted → nothing to go stale.
		const docB = new Y.Doc();
		docB.clientID = cid++;
		const tB = docB.get('t');
		docB.transact(() => {
			tB.applyDelta(delta.create().insert('x'.repeat(100)));
			tB.applyDelta(delta.create().retain(10).retain(80, { i: true }));
		});
		const remoteUpdate = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
		docA.transact(() => Y.applyUpdate(docA, remoteUpdate));
		docA.transact(() => tA.applyDelta(delta.create().retain(50).insert('Z')));
		// sanity: bold span intact, 'Z' plain, italic span covers the range
		const d = tA.toDelta().toJSON();
		expect(boldRangesOfDelta(d)).toEqual([
			[40, 50],
			[51, 61]
		]);
	});
});

describe('gateH-R1 — undo restoring format items with live markers', () => {
	test('undo resurrects format items; markers cleared; differential vs disabled', () => {
		const mk = (withMarkers: boolean) => {
			const doc = new Y.Doc();
			doc.clientID = 4242;
			const t = doc.get('t');
			doc.transact(() => {
				t.applyDelta(delta.create().insert('x'.repeat(200)));
				t.applyDelta(delta.create().retain(60).retain(80, { b: true }));
			});
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t, { captureTimeout: 0 });
			return { doc, t, um };
		};
		const a = mk(true);
		const b = mk(false);
		const step = (s: typeof a, fn: () => void) => {
			fn();
			s.um.stopCapturing();
		};
		// Plant markers INSIDE the bold span, then delete across it.
		step(a, () => plantMarkerAt(a.t, 100));
		step(b, () => plantMarkerAt(b.t, 100));
		expect(deltaJson(a.t)).toBe(deltaJson(b.t));
		step(a, () => a.doc.transact(() => a.t.applyDelta(delta.create().retain(50).delete(100))));
		step(b, () => b.doc.transact(() => b.t.applyDelta(delta.create().retain(50).delete(100))));
		expect(deltaJson(a.t)).toBe(deltaJson(b.t));
		// Undo restores the deleted text AND the format markers (as new items).
		step(a, () => a.um.undo());
		step(b, () => b.um.undo());
		expect(deltaJson(a.t)).toBe(deltaJson(b.t));
		// Seeded write where a stale snapshot would mis-fold.
		step(a, () =>
			a.doc.transact(() => a.t.applyDelta(delta.create().retain(100).insert('Q', { b: true })))
		);
		step(b, () =>
			b.doc.transact(() => b.t.applyDelta(delta.create().retain(100).insert('Q', { b: true })))
		);
		expect(deltaJson(a.t)).toBe(deltaJson(b.t));
		expect(
			Buffer.from(Y.encodeStateAsUpdate(a.doc)).equals(Buffer.from(Y.encodeStateAsUpdate(b.doc)))
		).toBe(true);
	});

	test('redo of a delete that tombstoned format items — marker pool stays sound', () => {
		const mk = (withMarkers: boolean) => {
			const doc = new Y.Doc();
			doc.clientID = 4243;
			const t = doc.get('t');
			doc.transact(() => {
				t.applyDelta(delta.create().insert('x'.repeat(200)));
				t.applyDelta(delta.create().retain(60).retain(80, { b: true }));
			});
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t, { captureTimeout: 0 });
			return { doc, t, um };
		};
		const a = mk(true);
		const b = mk(false);
		plantMarkerAt(a.t, 100);
		plantMarkerAt(b.t, 100);
		a.doc.transact(() => a.t.applyDelta(delta.create().retain(50).delete(100)));
		b.doc.transact(() => b.t.applyDelta(delta.create().retain(50).delete(100)));
		a.um.undo();
		b.um.undo();
		a.um.redo();
		b.um.redo();
		// Post-redo seeded op
		a.doc.transact(() => a.t.applyDelta(delta.create().retain(60).insert('R')));
		b.doc.transact(() => b.t.applyDelta(delta.create().retain(60).insert('R')));
		expect(deltaJson(a.t)).toBe(deltaJson(b.t));
	});
});

describe('gateH-R1 — marker-seeded anchor serialization (facade writes)', () => {
	test('anchorAt/resolveAnchor round-trip after marker-generating reads', () => {
		// The facade's slice-record anchors and caret anchors serialize through
		// createRelativePositionFromTypeIndex — now marker-seeded. A stale
		// marker.index writes a wrong replicated anchor.
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [
				{
					id: 'b',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'x'.repeat(300) }]
				}
			]
		});
		ed.setMark('b', 100, 100, 'b', true);
		// Generate markers via reads at several positions.
		for (const i of [50, 150, 250]) {
			const a = ed.anchorAt('b', i);
			expect(ed.resolveAnchor(a)).toEqual({ blockId: 'b', offset: i });
		}
		// Interleave writes that shift indexes, then re-resolve old anchors.
		ed.insertText('b', 10, 'PRE');
		for (const i of [60, 160, 260]) {
			const a = ed.anchorAt('b', i);
			expect(ed.resolveAnchor(a)).toEqual({ blockId: 'b', offset: i });
		}
		ed.deleteText('b', 200, 60);
		for (const i of [40, 120, 240 - 60]) {
			const a = ed.anchorAt('b', i);
			expect(ed.resolveAnchor(a)).toEqual({ blockId: 'b', offset: i });
		}
	});
});

describe('gateH-R1 — facade-level randomized differential (markers on vs off)', () => {
	const rng32 = (seed: number) => {
		let s = seed | 0;
		return () => {
			s = (s + 0x6d2b79f5) | 0;
			let t = Math.imul(s ^ (s >>> 15), 1 | s);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};

	/** Content node accessor for delta-level comparison. */
	const contentOf = (ed: any, id: string) => ed.resolveBlock(id)!.getAttr('content') as any;

	const facadeDeltaJson = (ed: any, id: string) =>
		JSON.stringify(contentOf(ed, id).toDelta().toJSON());

	const MARKS = [undefined, { b: true }, { i: true }, { b: true, u: 1 }, { b: null }];

	const runFacadeSchedule = (seed: number, steps: number) => {
		const mk = (withMarkers: boolean) => {
			const doc = new Y.Doc();
			doc.clientID = 4242;
			const ed = E.create(doc);
			ed.init({
				content: [
					{
						id: 'b',
						type: 'paragraph',
						content: [{ kind: 'text', text: 'x'.repeat(160) }]
					},
					{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'y'.repeat(60) }] }
				]
			});
			ed.setMark('b', 40, 80, 'b', true);
			const um = ed.createUndoManager({ captureTimeout: 0 });
			if (!withMarkers) {
				for (const id of ['b', 'c']) contentOf(ed, id)._searchMarker = null;
			}
			return { doc, ed, um, withMarkers };
		};
		const a = mk(true);
		const b = mk(false);
		const rand = rng32(seed);
		const lenOf = (s: typeof a, id: string) => (s.ed.blockText(id) ?? '').length;
		const saved: number[] = [];
		const drawA = () => {
			const v = rand();
			saved.push(v);
			return v;
		};
		const step = (s: typeof a, draw: () => number) => {
			const roll = draw();
			const id = draw() < 0.8 ? 'b' : 'c';
			const len = lenOf(s, id);
			if (roll < 0.35) {
				const pos = Math.floor(draw() * (len + 1));
				const str = 'z'.repeat(1 + Math.floor(draw() * 5));
				const fmt = MARKS[Math.floor(draw() * MARKS.length)];
				s.ed.insertText(id, pos, str, fmt as Record<string, unknown> | undefined);
			} else if (roll < 0.6 && len > 0) {
				const pos = Math.floor(draw() * len);
				const n = 1 + Math.floor(draw() * Math.min(12, len - pos));
				s.ed.deleteText(id, pos, n);
			} else if (roll < 0.85 && len > 0) {
				const pos = Math.floor(draw() * len);
				const n = Math.floor(draw() * Math.min(20, len - pos));
				if (n > 0) {
					if (draw() < 0.5) s.ed.setMark(id, pos, n, 'b', true);
					else s.ed.unsetMark(id, pos, n, 'b');
				}
			} else if (roll < 0.92 && lenOf(s, 'b') > 4) {
				// split then occasionally merge back
				const at = 1 + Math.floor(draw() * (lenOf(s, 'b') - 1));
				const newId = `s${Math.floor(draw() * 1e6)}`;
				s.ed.block('b').split(at, newId);
			} else if (roll < 0.96) {
				if (s.um.undoStack.length > 0) s.um.undo();
			} else {
				if (s.um.redoStack.length > 0) s.um.redo();
			}
			s.um.stopCapturing();
			// Marker-generating reads (anchor serialization path) + a cached
			// runs read that seeds the marker pool through findMarker walks.
			if (draw() < 0.5) void s.ed.runs(id);
			const pos2 = Math.floor(draw() * (lenOf(s, 'b') + 1));
			const anch = s.ed.anchorAt('b', pos2);
			const res = s.ed.resolveAnchor(anch);
			// On a hidden/merged-away 'b' the anchor may resolve into the
			// owner's coordinates — only same-block resolutions must round-trip
			// the offset exactly.
			if (res !== null && res.blockId === 'b') {
				expect(res.offset, 'anchor round-trip').toBe(pos2);
			}
		};
		for (let i = 0; i < steps; i++) {
			saved.length = 0;
			step(a, drawA);
			let k = 0;
			step(b, () => saved[k++]);
			// Block ids may diverge after splits (distinct newIds drawn the same
			// though — same draws) — compare each block's text+delta per replica.
			for (const id of new Set([...a.ed.listBlockIds(), ...b.ed.listBlockIds()])) {
				expect(
					facadeDeltaJson(a.ed, id) ?? 'missing',
					`seed ${seed} op ${i} block ${id} delta`
				).toBe(facadeDeltaJson(b.ed, id) ?? 'missing');
			}
			expect(a.ed.listBlockIds(), `seed ${seed} op ${i} order`).toEqual(b.ed.listBlockIds());
		}
		return { a, b };
	};

	for (const seed of [11, 23, 97, 555, 1311]) {
		test(`facade schedule seed ${seed}`, () => {
			const { a, b } = runFacadeSchedule(seed, 60);
			// NOTE: byte-identical stores are NOT expected — placement ranks
			// mint random tie-breaks (placement/model.ts rankBetween uses
			// randOf(doc), Math.random when unseeded). Order + delta equivalence is the
			// semantic invariant, asserted per-op inside runFacadeSchedule.
			expect(a.ed.listBlockIds()).toEqual(b.ed.listBlockIds());
			for (const id of a.ed.listBlockIds()) {
				expect(facadeDeltaJson(a.ed, id)).toBe(facadeDeltaJson(b.ed, id));
			}
		});
	}
});
