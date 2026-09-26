/**
 * Gate-F2 probes — U3 native bounded range reads, hazards NOT covered by
 * `src/tests/crdt/runs/range-reads.test.ts`:
 *
 * 1. MARKS ALIASING (documented contract, probed at the boundary):
 *    emitted `marks` ALIAS the vendored cursor's materialized fold state —
 *    one object shared by every same-state piece of that cursor. A
 *    consumer mutating emitted marks corrupts the SAME cursor's later
 *    emissions — but can never reach the engine's `_searchMarker`
 *    snapshots (a cursor adopts them by private copy) or a fresh cursor.
 *    That is the U3 boundary — strictly stronger than WU8's shared-index
 *    corruption — and runs.ts still interns before publishing.
 *
 * 2. POST-COMMIT-TOMBSTONE PARITY: format markers and content deleted in
 *    COMMITTED transactions (not just mid-transaction) leave tombstoned
 *    items the reader must skip — full-range parity vs the oracle.
 *
 * 3. CHECKPOINT PINNING: every seed-usable search marker (`formats !==
 *    null`) pins `p` at exactly `index` — `p`'s visible left edge — and
 *    `formats` is the folded state at that edge. An off-by-one here
 *    mis-seeks every seeded read. Verified by re-walking.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel, bindRuns } from '../../../lib/crdt/index.js';
import { bindText, readRange } from '../../../lib/crdt/text/model.js';
import { createPeerPair } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const T = bindText(Y);

const contentOf = (doc, id) => M.collectBlocks(doc).get(id)?.content;

const FORMAT_SEED = modelSpecSeed([
	{
		id: 'a',
		type: 'paragraph',
		content: Array.from({ length: 140 }, (_, i) => ({
			kind: 'text',
			text: `t${String(i).padStart(3, '0')} `,
			marks: i % 4 === 0 ? { bold: true } : i % 4 === 2 ? { italic: true } : undefined
		}))
	}
]);

const oracle = (text, i0, i1) => {
	const items = [];
	let pos = 0;
	for (const op of text.toDelta().toJSON()?.children ?? []) {
		if (op.type === 'retain') {
			pos += typeof op.retain === 'number' ? op.retain : 0;
			continue;
		}
		if (op.type !== 'insert') continue;
		if (typeof op.insert === 'string') {
			const start = pos;
			pos += op.insert.length;
			const lo = Math.max(i0, start);
			const hi = Math.min(i1, pos);
			if (lo < hi) {
				const marks = op.format;
				items.push({
					kind: 'text',
					text: op.insert.slice(lo - start, hi - start),
					...(marks === undefined ? {} : { marks })
				});
			}
		} else if (Array.isArray(op.insert)) {
			for (const e of op.insert) {
				const idx = pos++;
				if (idx >= i0 && idx < i1) items.push({ kind: 'inline' });
			}
		}
	}
	return items;
};

describe('gateF2/U3 — marks aliasing contract boundary', () => {
	it('a consumer mutating emitted marks corrupts the SAME cursor — never the marker pool or a fresh cursor', () => {
		const set = createPeerPair(FORMAT_SEED);
		const text = contentOf(set.A.doc, 'a');
		// Prime the pool so seed-usable markers exist, then read through a
		// cursor whose emitted marks we corrupt.
		readRange(T.openRangeCursor(text), 0, text.length);
		const markerCount = text._searchMarker.filter((m) => m.formats !== null).length;
		expect(markerCount).toBeGreaterThan(0);
		const cur = T.openRangeCursor(text);
		const emitted = readRange(cur, 0, 2).find((it) => it.kind === 'text' && it.marks);
		expect(emitted).toBeDefined();
		// Consumer violates the read-only contract:
		emitted.marks.bold = 'MUTATED';
		emitted.marks.evil = true;
		// THE ALIAS: a continuing read inside the SAME fold span on the SAME
		// cursor reuses the materialized fold object — the corruption shows
		// through. (A fold boundary re-materializes it, so the blast radius
		// is one mark span of one cursor.)
		const poisoned = readRange(cur, 2, 4);
		expect(poisoned.find((it) => it.kind === 'text' && it.marks)?.marks).toEqual(
			expect.objectContaining({ bold: 'MUTATED', evil: true })
		);
		// But the mutation never reached the marker pool: every snapshot is
		// still clean, and a fresh cursor (which adopts them by private
		// copy) reads uncorrupted.
		for (const m of text._searchMarker) {
			if (m.formats === null) continue;
			expect([...m.formats.values()]).not.toContain('MUTATED');
			expect(m.formats.has('evil')).toBe(false);
		}
		const clean = readRange(T.openRangeCursor(text), 0, 4);
		expect(clean.find((it) => it.kind === 'text' && it.marks)?.marks).toEqual(
			expect.objectContaining({ bold: true })
		);
		expect(clean.find((it) => it.kind === 'text' && it.marks)?.marks.evil).toBeUndefined();
		// Documented boundary: this is WHY runs.ts interns before publishing.
	});

	it('the maintained view interns marks — its snapshots are immune and frozen', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const snap = view.runs('a');
		const marked = snap.find((r) => r.kind === 'text' && r.marks);
		expect(marked).toBeDefined();
		// Interned objects are frozen — a consumer literally cannot mutate.
		expect(Object.isFrozen(marked.marks)).toBe(true);
		expect(() => {
			marked.marks.bold = 'MUTATED';
		}).toThrow();
		// And subsequent reads are unaffected (the index never saw a write).
		expect(view.runs('a')).toEqual([...R.computeAllRuns(doc).get('a')]);
		view.dispose();
	});
});

describe('gateF2/U3 — tombstone + checkpoint pinning', () => {
	it('parity holds after committed deletions leave tombstoned content+markers', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const text = contentOf(doc, 'a');
		// Committed mutations → tombstoned format items AND content items.
		set.A.transact(() => M.setMark(doc, 'a', 10, 40, 'code', true));
		set.A.transact(() => M.unsetMark(doc, 'a', 20, 10, 'bold'));
		set.A.transact(() => M.deleteText(doc, 'a', 5, 30));
		set.A.transact(() => M.deleteText(doc, 'a', 100, 25));
		// Every range parity vs the oracle (the oracle skips tombstones too).
		for (let i0 = 0; i0 <= text.length; i0 += 7) {
			for (const i1 of [i0 + 1, i0 + 13, Math.min(text.length, i0 + 60)]) {
				if (i1 <= i0 || i1 > text.length) continue;
				const cur = T.openRangeCursor(text);
				expect(readRange(cur, i0, i1), `range ${i0}..${i1}`).toEqual(oracle(text, i0, i1));
			}
		}
		// And with a filled marker pool: seeded reads stay just as exact.
		readRange(T.openRangeCursor(text), 0, text.length);
		expect(text._searchMarker.filter((m) => m.formats !== null).length).toBeGreaterThan(0);
		for (let i0 = 0; i0 < text.length; i0 += 19) {
			const i1 = Math.min(text.length, i0 + 23);
			const cur = T.openRangeCursor(text);
			expect(readRange(cur, i0, i1), `seeded ${i0}..${i1}`).toEqual(oracle(text, i0, i1));
		}
	});

	it('every seed-usable marker pins its item at the exact visible offset', () => {
		const set = createPeerPair(FORMAT_SEED);
		const text = contentOf(set.A.doc, 'a');
		// The pool fills lazily — reads plant sparse checkpoints behind
		// their walks (mutations do the same at retain boundaries).
		readRange(T.openRangeCursor(text), 0, text.length);
		const markers = text._searchMarker.filter((m) => m.formats !== null);
		expect(markers.length).toBeGreaterThan(0);
		// Re-walk the item list computing each LIVE item's left edge
		// (format markers share the position of the content they precede);
		// every seed-usable marker anchored on a live item must pin `p` at
		// `index` exactly. Tombstoned anchors keep a valid seed position —
		// `updateMarkerChanges` clamps their index to the deleted run's
		// left edge — but no longer pin `p` itself, so they are skipped.
		const posOf = new Map(); // live item -> left edge
		let pos = 0;
		for (let it = text._start; it !== null; it = it.right) {
			if (it.deleted) continue;
			posOf.set(it, pos);
			const c = it.content;
			if (c.isCountable ? c.isCountable() : true) pos += it.length;
		}
		let pinned = 0;
		for (const m of markers) {
			if (m.p.deleted) continue;
			expect(posOf.get(m.p), 'live marker anchor must be in the item list').toBeDefined();
			expect(m.index).toBe(posOf.get(m.p));
			pinned++;
		}
		expect(pinned).toBeGreaterThan(0);
		// Indices strictly increase — deduped, sorted checkpoint records.
		for (let k = 1; k < markers.length; k++) {
			expect(markers[k].index).toBeGreaterThan(markers[k - 1].index);
		}
	});

	it('marker format snapshots are the state AT the anchor item (before it)', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: Array.from({ length: 140 }, (_, i) => ({
						kind: 'text',
						text: `x${i} `,
						marks: i % 2 === 0 ? { bold: true } : undefined
					}))
				}
			])
		);
		const text = contentOf(set.A.doc, 'a');
		readRange(T.openRangeCursor(text), 0, text.length);
		const markers = text._searchMarker.filter((m) => m.formats !== null);
		expect(markers.length).toBeGreaterThan(0);
		// For each live-anchored marker: independently compute mark state by
		// scanning the items before `m.p` — must equal the marker's
		// `formats` Map. (Tombstoned anchors keep a clamped position whose
		// snapshot no longer describes that exact edge — skipped.)
		for (const m of markers) {
			if (m.p.deleted) continue;
			const expectFormats = {};
			for (let it = text._start; it !== null && it !== m.p; it = it.right) {
				if (it.deleted) continue;
				const c = it.content;
				const countable = c.isCountable ? c.isCountable() : true;
				if (!countable && typeof c.key === 'string') {
					if (c.value == null) delete expectFormats[c.key];
					else expectFormats[c.key] = c.value;
				}
			}
			expect(Object.fromEntries(m.formats)).toEqual(expectFormats);
		}
	});
});
