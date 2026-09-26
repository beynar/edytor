/**
 * HARDENING U0 / R1 — P4 format-aware search-marker corruption (review
 * `docs/crdt-v14-follow-up-review-2026-09-21.md` §R1, P1).
 *
 * `updateMarkerFormats` (src/lib/crdt/vendor/yjs/src/ynode.js:522) folds an
 * inserted format marker into EVERY later cached `marker.formats` snapshot —
 * ignoring intervening markers that set the same key again. A stale snapshot
 * is then consumed by `applyDelta`'s seeded cursor and the mark change
 * silently drops off existing text.
 *
 * Minimal reproduction (paragraph `p` = 300 'x'):
 *
 *   setMark(p,100,100,'b',true)      → bold [100,200)
 *   insertText(p,150,'P',{b:true})   → bold [100,201)
 *   insertText(p,50,'Z',{b:true})    → bold [50,51) ∪ [101,202)
 *   insertText(p,152,'Q',{b:true})   → corrupts a later snapshot; the seeded
 *                                      insert REMOVES bold from the last 50
 *                                      original bold chars (x150..x199).
 *
 * EXPECTED bold coverage (final text = 50x + 'Z' + 100x + 'PQ' + 150x, len 303):
 *   [50,51) ('Z') ∪ [101,203) (x100..x149 + 'P' + 'Q' + x150..x199).
 *
 * OBSERVED pre-repair (U0 pin run, vitest):
 *   facade runs bold ranges  [[50,51],[101,153]]   — [153,203) lost `b`
 *   raw-engine delta identical
 *   differential vs `_searchMarker = null`: identical delta + identical
 *   encoded state for steps 0–2, DIVERGED at step 3 (the 'Q' insert):
 *   patched emitted the bold tail unmarked, disabled kept it bold.
 *
 * U1 repair (landed): the fold in `updateMarkerFormats` now walks the item
 * list right from the insertion and stops at the first LIVE format item
 * setting the same key — a marker anchored beyond that boundary still draws
 * the key from the intervening marker, so the new format must not reach its
 * snapshot. Candidates the walk never reaches (stale anchor records) get
 * `formats = null` — invalidate, never corrupt.
 *
 * These tests now pin the repaired semantics GREEN: the minimal repro, its
 * facade/raw variants, boundary/clear/delete/undo/remote/split cases,
 * structured fixtures, and per-op differential oracles vs both
 * `_searchMarker = null` (upstream-inert) and the materialized pre-P4
 * baseline.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as delta from 'lib0-v14/delta';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
let cid = 100_000;

/** Bold coverage [start,end) pairs of a block's committed runs. */
const boldRanges = (runs: readonly unknown[]): [number, number][] => {
	const out: [number, number][] = [];
	let pos = 0;
	for (const r of runs) {
		const item = r as { kind: string; text?: string; marks?: Record<string, unknown> };
		const len = item.kind === 'text' ? (item.text ?? '').length : 1;
		if (item.kind === 'text' && item.marks?.b === true) {
			if (out.length > 0 && out[out.length - 1][1] === pos) out[out.length - 1][1] = pos + len;
			else out.push([pos, pos + len]);
		}
		pos += len;
	}
	return out;
};

/** Same coverage computed off a raw `YNode.toDelta().toJSON()` children list. */
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

/** The exact op sequence from the review, expressed as deltas (raw engine). */
const RAW_OPS = [
	(d: ReturnType<typeof delta.create>) => d.retain(100).retain(100, { b: true }),
	(d: ReturnType<typeof delta.create>) => d.retain(150).insert('P', { b: true }),
	(d: ReturnType<typeof delta.create>) => d.retain(50).insert('Z', { b: true }),
	(d: ReturnType<typeof delta.create>) => d.retain(152).insert('Q', { b: true })
];

const EXPECTED_TEXT = 'x'.repeat(50) + 'Z' + 'x'.repeat(100) + 'PQ' + 'x'.repeat(150);
const EXPECTED_BOLD: [number, number][] = [
	[50, 51],
	[101, 203]
];

describe('R1 — P4 marker corruption (facade)', () => {
	test('the 300-char reproduction keeps bold on the last 50 chars of the bold span', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'p', type: 'paragraph', content: [{ kind: 'text', text: 'x'.repeat(300) }] }]
		});
		ed.setMark('p', 100, 100, 'b', true);
		ed.insertText('p', 150, 'P', { b: true });
		ed.insertText('p', 50, 'Z', { b: true });
		ed.insertText('p', 152, 'Q', { b: true });

		expect(ed.blockText('p')).toBe(EXPECTED_TEXT);
		// The defect: `ed.runs('p')` bold coverage is [[50,51],[101,153]] —
		// positions [153,203) (x150..x199, the tail of the [100,200) bold span)
		// come back UNMARKED.
		expect(boldRanges(ed.runs('p'))).toEqual(EXPECTED_BOLD);
		// Same assertion through the transaction-aware surface + JSON export.
		expect(boldRanges(ed.contentItems('p'))).toEqual(EXPECTED_BOLD);
		const json = ed.contentJSON('p') as { text?: string; marks?: Record<string, unknown> }[];
		let pos = 0;
		const jsonBold: [number, number][] = [];
		for (const item of json) {
			const len = item.text?.length ?? 1;
			if (item.marks?.b === true) jsonBold.push([pos, pos + len]);
			pos += len;
		}
		expect(jsonBold).toEqual(EXPECTED_BOLD);
	});
});

describe('R1 — P4 marker corruption (raw engine applyDelta)', () => {
	test('the same op sequence on a bare YNode text keeps the bold tail', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const t = doc.get('t');
		doc.transact(() => t.applyDelta(delta.create().insert('x'.repeat(300))));
		for (const op of RAW_OPS) {
			doc.transact(() => t.applyDelta(op(delta.create())));
		}
		const djson = t.toDelta().toJSON();
		const text = (djson.children ?? [])
			.map((o: { insert?: unknown }) => (typeof o.insert === 'string' ? o.insert : ''))
			.join('');
		expect(text).toBe(EXPECTED_TEXT);
		expect(boldRangesOfDelta(djson)).toEqual(EXPECTED_BOLD);
	});
});

/* ── U1 differential-replay harness ─────────────────────────────────
 * The oracle: `_searchMarker = null` makes every P4 path inert (upstream
 * behavior). Identical clientID + identical op stream ⇒ byte-identical
 * stores — so any divergence is a P4 defect. Every comparison runs after
 * EVERY operation, not just at the end of the schedule.
 */

/** Deterministic PRNG (mulberry32). */
const rng32 = (seed: number) => {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const MARK_KEYS = ['b', 'i', 'u', 'hl', 'q'];
const MARK_VALS = [true, true, null, 1, 2, 'v'];
const randFormats = (r: () => number): Record<string, unknown> | undefined => {
	if (r() < 0.35) return undefined;
	const fmt: Record<string, unknown> = {};
	const n = 1 + Math.floor(r() * 2.2);
	for (let i = 0; i < n; i++) {
		fmt[MARK_KEYS[Math.floor(r() * MARK_KEYS.length)]] =
			MARK_VALS[Math.floor(r() * MARK_VALS.length)];
	}
	return fmt;
};

type Side = { doc: InstanceType<typeof Y.Doc>; t: any; um: InstanceType<typeof Y.UndoManager> };

/** Fixture: one long run — sparse formatting (markers must travel far). */
const buildSparse = (t: any, doc: any) => {
	t.applyDelta(delta.create().insert('x'.repeat(400)));
	t.applyDelta(delta.create().retain(120).retain(160, { b: true }));
};

/** Fixture: dense alternating single-char formats — format markers every 2 items. */
const buildDense = (t: any, doc: any) => {
	const d = delta.create();
	for (let i = 0; i < 140; i++) d.insert('x', i % 2 === 0 ? { b: true } : { i: true });
	t.applyDelta(d);
};

/** Fixture: disjoint spans + a cleared hole — intervening same-key boundaries. */
const buildHoled = (t: any, doc: any) => {
	t.applyDelta(delta.create().insert('x'.repeat(300)));
	t.applyDelta(delta.create().retain(60).retain(60, { i: true }));
	t.applyDelta(delta.create().retain(100).retain(100, { b: true }));
	t.applyDelta(delta.create().retain(130).retain(40, { b: null })); // hole [130,170)
	t.applyDelta(delta.create().retain(240).retain(40, { u: 2 }));
};

const markerCount = (t: any) => t._searchMarker?.length ?? 0;
const seededMarkerCount = (t: any) =>
	(t._searchMarker ?? []).filter((m: any) => m.formats !== null).length;
const formatItemCount = (t: any) => {
	let n = 0;
	for (let p = t._start; p !== null; p = p.right) {
		if (p.content.getRef() === 6) n++;
	}
	return n;
};

const assertSameState = (x: Side, y: Side, label: string) => {
	expect(JSON.stringify(x.t.toDelta().toJSON()), `delta diverged ${label}`).toBe(
		JSON.stringify(y.t.toDelta().toJSON())
	);
	expect(x.t.length, `length diverged ${label}`).toBe(y.t.length);
	expect(
		Buffer.from(Y.encodeStateAsUpdate(x.doc)).equals(Buffer.from(Y.encodeStateAsUpdate(y.doc))),
		`encoded state diverged ${label}`
	).toBe(true);
};

/**
 * Replay `ops` on a marker-enabled type (a) and a marker-disabled type (b),
 * asserting identical projection (delta JSON = text+marks), length and
 * encoded state after EVERY op.
 */
const replayChecked = (
	build: (t: any, doc: any) => void,
	ops: ((side: Side) => void)[],
	{ remote = false }: { remote?: boolean } = {}
) => {
	const mk = (withMarkers: boolean, clientID = 4242): Side => {
		const doc = new Y.Doc();
		doc.clientID = clientID;
		const t = doc.get('t');
		doc.transact(() => build(t, doc));
		if (!withMarkers) t._searchMarker = null;
		const um = new Y.UndoManager(t, { captureTimeout: 0 });
		return { doc, t, um };
	};
	const a = mk(true);
	const b = mk(false);
	// optional remote writer — independent clientID, one-directional sync into both
	const r = remote ? mk(true, 777) : null;
	assertSameState(a, b, 'after fixture');
	for (let i = 0; i < ops.length; i++) {
		ops[i](a);
		ops[i](b);
		if (r !== null) {
			ops[i](r);
			// deterministic undo grouping so both sides split stack items identically
			r.um.stopCapturing();
			const ua = Y.encodeStateAsUpdate(r.doc, Y.encodeStateVector(a.doc));
			const ub = Y.encodeStateAsUpdate(r.doc, Y.encodeStateVector(b.doc));
			Y.applyUpdate(a.doc, ua);
			Y.applyUpdate(b.doc, ub);
		}
		a.um.stopCapturing();
		b.um.stopCapturing();
		assertSameState(a, b, `at op ${i}`);
	}
	return { a, b };
};

/* ── U1 deterministic scenarios ──────────────────────────────────── */

describe('R1 — same-key boundary scenarios (differential, per-op)', () => {
	test('distant format insert before an existing span keeps span markers intact', () => {
		// Variant of the pinned repro on different coordinates/keys: the marker
		// inside [160,300) must keep {b:true} through the 'Z' insert+negation.
		const ops = [
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(80).retain(140, { b: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(200).insert('P'))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(30).insert('Z', { b: true }))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(202).insert('Q', { b: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(250).insert('R')))
		];
		const { a } = replayChecked(buildSparse, ops);
		// plain inserts inside the bold span become unbolded islands (the facade
		// inserts an explicit b:null pair) — [81,201) ∪ [202,250) ∪ [251,284)
		expect(boldRangesOfDelta(a.t.toDelta().toJSON())).toEqual([
			[30, 31],
			[81, 201],
			[202, 250],
			[251, 284]
		]);
	});

	test('mark clears: a {key:null} hole shadows later same-key folds', () => {
		// Bold [100,200) with a b:null hole [130,170); a marker planted inside the
		// hole carries no `b`. A distant same-key insert before the hole must not
		// resurrect `b` inside it, and a seeded op at the hole must stay unbold.
		const ops = [
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(150).insert('P'))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(50).insert('Z', { b: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(152).insert('Q'))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(175).insert('W', { b: true })))
		];
		const { a } = replayChecked(buildHoled, ops);
		// bold = Z@50 ∪ span minus the [131,173) hole; W@175 lands in the bold tail
		expect(boldRangesOfDelta(a.t.toDelta().toJSON())).toEqual([
			[50, 51],
			[101, 131],
			[173, 204]
		]);
	});

	test('alternating keys: a different-key insert reaches across same-position spans', () => {
		// 'i' fold must cross the b-span boundary (different key — not a
		// boundary) and stop only at the next 'i' item (the i-span opener).
		const ops = [
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(70).insert('M'))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(260).insert('N'))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(30).insert('Z', { i: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(31).insert('Q'))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(262).insert('S')))
		];
		replayChecked(buildHoled, ops);
	});

	test('zero-width boundaries: format ops at/around a marker index', () => {
		const ops = [
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(120).insert('P'))),
			// zero-length format retain at the marker's own index
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(121).retain(0, { q: true }))),
			// format range STARTING exactly at the marker index
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(121).retain(10, { q: 3 }))),
			// format range ENDING exactly at a later marker index
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(200).insert('K'))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(190).retain(11, { b: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(201).insert('T')))
		];
		replayChecked(buildHoled, ops);
	});

	test('deletion through formatted spans (incl. format tombstones + cleanup)', () => {
		const ops = [
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(150).insert('P'))),
			// delete across the b-span's opening marker AND the hole
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(90).delete(70))),
			// seeded op right where the span used to be
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(95).insert('Q', { u: true }))),
			// delete covering the rest of the b-span tail
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(60).delete(60))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(40).insert('Z')))
		];
		replayChecked(buildHoled, ops);
	});

	test('item split + merge cycles through seeded positions', () => {
		const ops = [
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(140).insert('SPLIT'))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(140).delete(3))),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(138).retain(20, { hl: 1 }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(143).insert('X'))),
			// delete the inserted region again → items may coalesce on cleanup
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(138).delete(10))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(200).insert('end')))
		];
		const r = replayChecked(buildHoled, ops);
		// extra GC pass merges tombstones identically on both sides
		r.a.doc.transact(() => {});
		r.b.doc.transact(() => {});
		assertSameState(r.a, r.b, 'post-GC');
	});

	test('remote integration of the same op clears and rebuilds markers identically', () => {
		replayChecked(
			buildHoled,
			[
				(s: Side) =>
					s.doc.transact(() => s.t.applyDelta(delta.create().retain(110).retain(30, { hl: true }))),
				(s: Side) =>
					s.doc.transact(() => s.t.applyDelta(delta.create().retain(50).insert('R', { b: true }))),
				(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(160).insert('T')))
			],
			{ remote: true }
		);
	});

	test('undo/redo through UndoManager across format + marker ops', () => {
		const ops = [
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(120).insert('P', { u: true }))),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(60).delete(25))),
			(s: Side) => s.um.undo(),
			(s: Side) => s.um.undo(),
			(s: Side) => s.um.redo(),
			(s: Side) =>
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(110).insert('after-undo'))),
			(s: Side) => s.um.undo(),
			(s: Side) => s.doc.transact(() => s.t.applyDelta(delta.create().retain(70).insert('tail')))
		];
		replayChecked(buildHoled, ops);
	});
});

/* ── U1 bounded randomized differential replay ───────────────────── */

describe('R1 — bounded randomized replay: patched vs disabled after EVERY op', () => {
	const runSchedule = (seed: number, build: (t: any, doc: any) => void, steps: number) => {
		const mk = (withMarkers: boolean, clientID = 4242): Side => {
			const doc = new Y.Doc();
			doc.clientID = clientID;
			const t = doc.get('t');
			doc.transact(() => build(t, doc));
			if (!withMarkers) t._searchMarker = null;
			const um = new Y.UndoManager(t, { captureTimeout: 0 });
			return { doc, t, um };
		};
		const a = mk(true);
		const b = mk(false);
		const r = mk(true, 977); // remote writer feeding both via updates
		const rand = rng32(seed);
		const randR = rng32(seed * 7919 + 1); // independent stream for the remote side
		let remoteLag = 0;
		/** Apply one randomly drawn op to `s`. Draws come from `rand` for a/b
		 * (identical op on both — they share length, asserted each step) and
		 * from `randR` for the remote writer (its own content/size). */
		const step = (s: Side, draw: () => number) => {
			const len = s.t.length;
			const roll = draw();
			if (roll < 0.4) {
				// insert (formatted or plain)
				const pos = Math.floor(draw() * (len + 1));
				const str = 'y'.repeat(1 + Math.floor(draw() * 6));
				const fmt = randFormats(draw);
				s.doc.transact(() =>
					s.t.applyDelta(
						fmt === undefined
							? delta.create().retain(pos).insert(str)
							: delta.create().retain(pos).insert(str, fmt)
					)
				);
			} else if (roll < 0.62 && len > 0) {
				// delete
				const pos = Math.floor(draw() * len);
				const n = 1 + Math.floor(draw() * Math.min(14, len - pos));
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(pos).delete(n)));
			} else if (roll < 0.9 && len > 0) {
				// format range (incl. clears via null and occasional zero-width)
				const pos = Math.floor(draw() * (len + 1));
				const n = draw() < 0.12 ? 0 : Math.floor(draw() * Math.min(20, len - pos + 1));
				const fmt = randFormats(draw) ?? { b: true };
				s.doc.transact(() => s.t.applyDelta(delta.create().retain(pos).retain(n, fmt)));
			} else if (roll < 0.95) {
				if (s.um.undoStack.length > 0) s.um.undo();
			} else {
				if (s.um.redoStack.length > 0) s.um.redo();
			}
			s.um.stopCapturing();
		};
		let maxMarkers = 0; // peak pool size — proof the marker paths ran
		let maxSeeded = 0; // peak snapshot-carrying markers — proof seeding could fire
		assertSameState(a, b, `seed ${seed} fixture`);
		for (let i = 0; i < steps; i++) {
			// one op drawn once, applied identically to both sides
			const saved: number[] = [];
			const drawA = () => {
				const v = rand();
				saved.push(v);
				return v;
			};
			step(a, drawA);
			let k = 0;
			step(b, () => saved[k++]); // identical draws ⇒ identical op
			step(r, randR);
			remoteLag++;
			// flush remote ops into a and b every few steps
			if (remoteLag >= 3) {
				remoteLag = 0;
				Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(r.doc, Y.encodeStateVector(a.doc)));
				Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(r.doc, Y.encodeStateVector(b.doc)));
			}
			if (markerCount(a.t) > maxMarkers) maxMarkers = markerCount(a.t);
			if (seededMarkerCount(a.t) > maxSeeded) maxSeeded = seededMarkerCount(a.t);
			assertSameState(a, b, `seed ${seed} op ${i}`);
		}
		return { side: a, maxMarkers, maxSeeded };
	};

	for (const seed of [1, 7, 42, 1999]) {
		test(`sparse long span — seed ${seed}`, () => {
			const { side, maxMarkers, maxSeeded } = runSchedule(seed, buildSparse, 70);
			expect(formatItemCount(side.t)).toBeGreaterThan(0);
			expect(maxMarkers).toBeGreaterThan(0);
			expect(maxSeeded).toBeGreaterThan(0);
		});
	}
	for (const seed of [2, 13, 777]) {
		test(`dense alternating single-char formats — seed ${seed}`, () => {
			const { side, maxMarkers, maxSeeded } = runSchedule(seed, buildDense, 70);
			expect(formatItemCount(side.t)).toBeGreaterThan(0);
			expect(maxMarkers).toBeGreaterThan(0);
			expect(maxSeeded).toBeGreaterThan(0);
		});
	}
	for (const seed of [3, 21, 555]) {
		test(`holed disjoint spans — seed ${seed}`, () => {
			const { side, maxMarkers, maxSeeded } = runSchedule(seed, buildHoled, 70);
			expect(formatItemCount(side.t)).toBeGreaterThan(0);
			expect(maxMarkers).toBeGreaterThan(0);
			expect(maxSeeded).toBeGreaterThan(0);
		});
	}
});

describe('R1 — differential oracle: patched engine vs markers disabled', () => {
	test('identical delta + identical encoded state after EVERY operation', () => {
		const mk = (withMarkers: boolean) => {
			const doc = new Y.Doc();
			doc.clientID = 4242; // same clientID → identical item ids → byte-comparable stores
			const t = doc.get('t');
			if (!withMarkers) t._searchMarker = null;
			doc.transact(() => t.applyDelta(delta.create().insert('x'.repeat(300))));
			return { doc, t };
		};
		const a = mk(true); // patched: P4 format-aware markers active
		const b = mk(false); // disabled = upstream semantics
		const dj = (t: { toDelta: () => { toJSON: () => unknown } }) =>
			JSON.stringify(t.toDelta().toJSON());
		expect(dj(a.t)).toBe(dj(b.t)); // seed state identical
		for (let i = 0; i < RAW_OPS.length; i++) {
			a.doc.transact(() => a.t.applyDelta(RAW_OPS[i](delta.create())));
			b.doc.transact(() => b.t.applyDelta(RAW_OPS[i](delta.create())));
			// OBSERVED: steps 0–2 identical; step 3 (insert 'Q' at 152) diverges —
			// the seeded cursor used a stale snapshot and dropped `b` from the
			// last 50 bold chars.
			expect(dj(a.t), `delta diverged at op ${i}`).toBe(dj(b.t));
			expect(
				Buffer.from(Y.encodeStateAsUpdate(a.doc)).equals(Buffer.from(Y.encodeStateAsUpdate(b.doc))),
				`encoded state diverged at op ${i}`
			).toBe(true);
		}
	});

	// The pre-WU9 baseline vendored tree is a local gitignored artifact
	// (bench/lib/mk-baseline.sh) — compare against it when materialized.
	const baselineIndex = fileURLToPath(
		new URL('../../../../bench/vendor-baseline/yjs/index.js', import.meta.url)
	);
	test.runIf(existsSync(baselineIndex))(
		'patched engine vs pre-P4 vendored baseline — identical after EVERY operation',
		async () => {
			const YB = await import(/* @vite-ignore */ baselineIndex);
			const mk = (Y_: typeof Y) => {
				const doc = new Y_.Doc();
				doc.clientID = 4242;
				const t = doc.get('t');
				doc.transact(() => t.applyDelta(delta.create().insert('x'.repeat(300))));
				return { doc, t };
			};
			const patched = mk(Y);
			const base = mk(YB as unknown as typeof Y);
			const dj = (t: { toDelta: () => { toJSON: () => unknown } }) =>
				JSON.stringify(t.toDelta().toJSON());
			expect(dj(patched.t)).toBe(dj(base.t));
			for (let i = 0; i < RAW_OPS.length; i++) {
				patched.doc.transact(() => patched.t.applyDelta(RAW_OPS[i](delta.create())));
				base.doc.transact(() => base.t.applyDelta(RAW_OPS[i](delta.create())));
				expect(dj(patched.t), `delta diverged from baseline at op ${i}`).toBe(dj(base.t));
				expect(
					Buffer.from(Y.encodeStateAsUpdate(patched.doc)).equals(
						Buffer.from((YB as unknown as typeof Y).encodeStateAsUpdate(base.doc))
					),
					`encoded state diverged from baseline at op ${i}`
				).toBe(true);
			}
		}
	);
});
