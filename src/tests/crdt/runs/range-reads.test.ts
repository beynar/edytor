/**
 * U3 — direct formatted range reads (`src/lib/crdt/text/model.ts`
 * `openRangeCursor`/`readRange` over the vendored `Y.RangeCursor`, plus the
 * maintained view in `src/lib/crdt/text/runs.ts`) unit + differential tests.
 *
 * Contract under test:
 *
 * - PARITY: `T.itemsOfRange`/`readRange` produce byte-identical ContentItems
 *   to the delta-JSON oracle (the pre-WU8 reader, kept verbatim below) at
 *   every range — marks inherited from format markers BEFORE the range,
 *   `{mark:null}` clears, boundary clips, live inline atoms.
 * - READ-YOUR-WRITES: the stateless reader AND the maintained view both
 *   observe uncommitted writes mid-transaction (uncommitted items are
 *   already linked into `_start`, exactly like `toDelta`).
 * - WORK: maintained range reads scale with the range plus a bounded
 *   checkpoint gap (`debug.itemsWalked`), never with whole-text length.
 *   The checkpoints are the engine's own `_searchMarker` pool — planted
 *   adaptively by reads (every `READ_PLANT_GAP` items walked, vendored
 *   `RangeCursor.js`) and by mutations at quiescent points, self-maintained
 *   through `updateMarkerChanges` — there is no Edytor-side index left.
 * - ISOLATION: public snapshots stay frozen/interned; the cursor's
 *   materialized `formats` object is shared between same-state pieces of
 *   ONE cursor (copy-on-adopt keeps marker snapshots private).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindModel, bindRuns } from '../../../lib/crdt/index.js';
import { bindText, readRange } from '../../../lib/crdt/text/model.js';
import { decorateRuns } from '../../../lib/crdt/text/runs.js';
import { createPeerPair } from '../harness/peer-set.js';
import { mulberry32, int, pick } from '../harness/rng.js';
import { modelSpecSeed, MODEL_BASE_SEED } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const O = bindRunsOracle(Y);
const T = bindText(Y);

/**
 * The pre-WU8 reader — full `toDelta().toJSON()` materialization + clip,
 * verbatim from the old `itemsOfRange`. Kept as the differential oracle:
 * it renders the ENTIRE sequence every call, so equivalence proves the
 * direct walk never loses format state or content.
 */
const oracleItemsOfRange = (text, i0, i1) => {
	if (text.doc == null) return [];
	const items = [];
	let pos = 0;
	const deltaJSON = text.toDelta().toJSON() ?? { children: [] };
	for (const op of deltaJSON.children ?? []) {
		const o = op;
		if (o.type === 'retain') {
			pos += typeof o.retain === 'number' ? o.retain : 0;
			continue;
		}
		if (o.type !== 'insert') continue;
		if (typeof o.insert === 'string') {
			const start = pos;
			pos += o.insert.length;
			const lo = Math.max(i0, start);
			const hi = Math.min(i1, pos);
			if (lo < hi) {
				const last = items[items.length - 1];
				const marks = o.format;
				const slice = o.insert.slice(lo - start, hi - start);
				if (
					last &&
					last.kind === 'text' &&
					JSON.stringify(last.marks ?? null) === JSON.stringify(marks ?? null)
				) {
					last.text += slice;
				} else {
					items.push({ kind: 'text', text: slice, ...(marks === undefined ? {} : { marks }) });
				}
			}
		} else if (Array.isArray(o.insert)) {
			for (const entry of o.insert) {
				const idx = pos;
				pos += 1;
				if (idx < i0 || idx >= i1) continue;
				let id, type, data;
				if (entry != null && typeof entry.getAttr === 'function') {
					id = entry.getAttr('id');
					type = entry.getAttr('type');
					data = entry.getAttr('data');
				} else {
					const attrs = entry?.attrs ?? {};
					const attrVal = (a) =>
						a !== null && typeof a === 'object' && 'value' in a ? a.value : a;
					id = attrVal(attrs.id);
					type = attrVal(attrs.type);
					data = attrVal(attrs.data);
				}
				items.push({
					kind: 'inline',
					id,
					type,
					...(data === undefined ? {} : { data })
				});
			}
		}
	}
	return items;
};

const contentOf = (doc, id) => M.collectBlocks(doc).get(id)?.content;

/** Assert the direct reader equals the oracle on every given range. */
const expectRangeParity = (text, ranges) => {
	for (const [i0, i1] of ranges) {
		expect(T.itemsOfRange(text, i0, i1), `itemsOfRange(${i0},${i1})`).toEqual(
			oracleItemsOfRange(text, i0, i1)
		);
	}
};

/** Every range `i0 < i1` plus the degenerate/edge ranges. */
const allRanges = (len) => {
	const out = [];
	for (let i0 = 0; i0 <= len; i0++) {
		for (let i1 = i0; i1 <= len; i1++) out.push([i0, i1]);
	}
	out.push([5, 5], [0, 0], [len, len], [3, 2]);
	return out;
};

const FORMAT_SEED = modelSpecSeed([
	{
		id: 'a',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'plain ' },
			{ kind: 'text', text: 'bold ', marks: { bold: true } },
			{ kind: 'text', text: 'both ', marks: { bold: true, italic: true } },
			{ kind: 'text', text: 'ital ', marks: { italic: true } },
			{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } },
			{ kind: 'text', text: ' end' }
		]
	}
]);

describe('range reads — parity vs the delta-JSON oracle', () => {
	it('every range of a richly formatted text matches the oracle', () => {
		const set = createPeerPair(FORMAT_SEED);
		const text = contentOf(set.A.doc, 'a');
		expectRangeParity(text, allRanges(text.length));
	});

	it('marks set/cleared through ops produce the same boundaries (incl. null clears)', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const text = contentOf(doc, 'a');
		// Overlapping marks: underline mid-'bold ', clear italic mid-'both '.
		set.A.transact(() => M.setMark(doc, 'a', 8, 4, 'underline', true));
		set.A.transact(() => M.unsetMark(doc, 'a', 12, 3, 'italic'));
		expectRangeParity(text, allRanges(text.length));
		// Spot-check semantics: the cleared span loses ONLY italic.
		// 'both ' sits at positions 11–16, so [12,15) is 'oth'.
		const mid = T.itemsOfRange(text, 12, 15);
		expect(mid).toEqual([{ kind: 'text', text: 'oth', marks: { bold: true } }]);
	});

	it('unicode (surrogate pairs) slices identically at code-unit boundaries', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: [
						{ kind: 'text', text: 'ab 🚀 cd', marks: { bold: true } },
						{ kind: 'text', text: ' 𝌆x' }
					]
				}
			])
		);
		const text = contentOf(set.A.doc, 'a');
		expectRangeParity(text, allRanges(text.length));
	});

	it('inline atoms keep live data and occupy exactly one position', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		set.A.transact(() => M.setInlineData(doc, 'a', 'm1', { user: 'edited' }));
		const text = contentOf(doc, 'a');
		const atom = T.itemsOfRange(text, 21, 22); // the mention's position (6+5+5+5)
		expect(atom).toEqual([{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'edited' } }]);
		expectRangeParity(text, allRanges(text.length));
	});

	it('detached backing text reads as empty (pre-integration guard)', () => {
		const node = T.newNode('content');
		expect(T.itemsOfRange(node, 0, 10)).toEqual([]);
		expect(node._searchMarker).toEqual([]);
	});
});

describe('range reads — cursor + native checkpoints', () => {
	it('a shared cursor serves forward, backward and repeated reads correctly', () => {
		const set = createPeerPair(FORMAT_SEED);
		const text = contentOf(set.A.doc, 'a');
		const cur = T.openRangeCursor(text);
		// Forward reads advance the cursor.
		expect(readRange(cur, 6, 11)).toEqual(oracleItemsOfRange(text, 6, 11));
		expect(readRange(cur, 11, 18)).toEqual(oracleItemsOfRange(text, 11, 18));
		// A read that continues inside the same item re-walks it correctly.
		expect(readRange(cur, 18, 20)).toEqual(oracleItemsOfRange(text, 18, 20));
		// Backward read rewinds (format state cannot un-apply).
		expect(readRange(cur, 0, 8)).toEqual(oracleItemsOfRange(text, 0, 8));
		// Random order reads on one cursor all match.
		const rng = mulberry32(0x5eed8);
		for (let k = 0; k < 50; k++) {
			const i0 = int(rng, 0, text.length);
			const i1 = int(rng, i0, text.length);
			expect(readRange(cur, i0, i1), `read ${i0}..${i1}`).toEqual(oracleItemsOfRange(text, i0, i1));
		}
	});

	it('native marker seeds produce identical reads and bounded intra-gap walks', () => {
		// A long formatted text: 200 items × 10 chars, alternating marks.
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: Array.from({ length: 200 }, (_, i) => ({
						kind: 'text',
						text: `s${String(i).padStart(3, '0')}xxxxx `,
						marks: i % 3 === 0 ? { bold: true } : i % 3 === 1 ? { italic: true } : undefined
					}))
				}
			])
		);
		const text = contentOf(set.A.doc, 'a');
		// Prime the engine's marker pool: one cold full-range read plants
		// sparse format-aware checkpoints behind its walk (every 64 items —
		// the vendored READ_PLANT_GAP cadence). Reads self-seed from the
		// pool; there is no caller-visible seed object anymore.
		readRange(T.openRangeCursor(text), 0, text.length);
		const markers = text._searchMarker.filter((m) => m.formats !== null);
		expect(markers.length).toBeGreaterThan(0);
		// Markers are sorted by index and start inside the text.
		let prev = 0;
		for (const m of markers) {
			expect(m.index).toBeGreaterThanOrEqual(prev);
			prev = m.index;
		}
		const rng = mulberry32(0x8cad);
		for (let k = 0; k < 100; k++) {
			const i0 = int(rng, 0, text.length);
			const i1 = int(rng, i0, text.length);
			const stats = { items: 0, markers: 0 };
			const cur = T.openRangeCursor(text);
			expect(readRange(cur, i0, i1, stats)).toEqual(oracleItemsOfRange(text, i0, i1));
			// The walk stays within the checkpoint gap + the read's own span:
			// never the whole prefix (each item here covers ≤10 chars; +8
			// covers format markers inside the span and the boundary item).
			const spanItems = Math.ceil(i1 - i0) + 8;
			expect(stats.items).toBeLessThanOrEqual(64 + spanItems);
		}
	});
});

describe('range reads — read-your-writes inside transactions', () => {
	it('the stateless reader sees uncommitted inserts and formats mid-transaction', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const text = contentOf(doc, 'a');
		doc.transact(() => {
			M.insertText(doc, 'a', 6, 'NEW ', { bold: true });
			expect(T.itemsOfRange(text, 6, 10)).toEqual(oracleItemsOfRange(text, 6, 10));
			M.setMark(doc, 'a', 0, 6, 'code', true);
			expect(T.itemsOfRange(text, 0, 12)).toEqual(oracleItemsOfRange(text, 0, 12));
			M.unsetMark(doc, 'a', 8, 4, 'bold');
			expect(T.itemsOfRange(text, 6, 16)).toEqual(oracleItemsOfRange(text, 6, 16));
		});
		// Post-commit the oracle and reader still agree everywhere.
		expectRangeParity(text, allRanges(text.length));
	});

	it('the maintained view reflects every step of one transaction', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		view.runs('a'); // prime the cursor/markers + cache
		doc.transact(() => {
			// After every op of a multi-operation transaction the maintained
			// view must equal a fresh projection (read-your-writes) — the
			// cursor walks the live item list; the engine keeps its markers'
			// positions valid through `updateMarkerChanges`.
			M.insertText(doc, 'a', 0, '>>', { bold: true });
			expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
			M.setMark(doc, 'a', 10, 8, 'strike', true);
			expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
			M.insertInline(doc, 'a', 5, { id: 'mx', type: 'mention', data: { live: 1 } });
			expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
			M.deleteText(doc, 'a', 0, 2);
			expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		});
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
	});

	it('an insert before a checkpoint shifts reads correctly (markers maintained, not stale)', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const before = view.runs('a');
		set.A.transact(() => M.insertText(doc, 'a', 0, 'PRE'));
		const after = view.runs('a');
		// The read used the marker-maintained positions — content shifted by 3.
		expect(after.map((r) => (r.kind === 'text' ? r.text : '�')).join('')).toBe(
			'PRE' + before.map((r) => (r.kind === 'text' ? r.text : '�')).join('')
		);
		expect(after).toEqual([...O.computeAllRuns(doc).get('a')]);
	});
});

describe('range reads — maintained work bounds', () => {
	it('repeated small slices of one long formatted text stay range-sized', () => {
		// 5,000 chars in 500 items; split into 25 blocks of 200 so each
		// maintained read is one small range of the shared backing text.
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'b0',
					type: 'paragraph',
					content: Array.from({ length: 500 }, (_, i) => ({
						kind: 'text',
						text: 'abcdefghij',
						marks: i % 2 === 0 ? { bold: true } : undefined
					}))
				}
			])
		);
		const doc = set.A.doc;
		let head = 'b0';
		for (let s = 1; s < 25; s++) {
			set.A.transact(() => M.splitBlock(doc, head, 200, `sp${s}`));
			head = `sp${s}`;
		}
		const view = R.attach(doc);
		view.debug.reset();
		const perRead = [];
		for (const id of M.listBlockIds(doc)) {
			const before = view.debug.itemsWalked;
			view.runs(id);
			perRead.push(view.debug.itemsWalked - before);
		}
		// Every read stayed within gap + its own span — a fresh render of the
		// 5k text would step all ~1500 items (500 strings + ~1000 format
		// markers for the alternating marks) every single time.
		for (const walked of perRead) {
			expect(walked).toBeLessThanOrEqual(64 + 128);
		}
		// The engine's marker pool filled adaptively — later reads seeded
		// from it instead of re-walking the prefix (a cold walk over ~1500
		// items would dwarf the bounded readings above).
		const text = contentOf(doc, 'b0');
		expect(text._searchMarker.length).toBeGreaterThan(0);
		// Correctness: every block equals the fresh oracle.
		const fresh = O.computeAllRuns(doc);
		for (const id of M.listBlockIds(doc)) {
			expect(view.runs(id)).toEqual([...fresh.get(id)]);
		}
	});

	it('one block owning disjoint segments of one text shares one cursor', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: Array.from({ length: 100 }, (_, i) => ({
						kind: 'text',
						text: 'abcdefghij',
						marks: { bold: i % 2 === 0 }
					}))
				}
			])
		);
		const doc = set.A.doc;
		// Split → merge back: 'a' ends up claiming its own list plus 'b''s —
		// several disjoint segs of one backing text in one block's display.
		set.A.transact(() => M.splitBlock(doc, 'a', 500, 'b'));
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		const view = R.attach(doc);
		view.debug.reset();
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		// Two segs, one text — total walk stays bounded well under 2× items.
		expect(view.debug.itemsWalked).toBeLessThan(1200);
	});
});

describe('range reads — remote, undo, marks identity, decorations', () => {
	it('a remote format update lands in range reads identically to fresh', () => {
		const set = createPeerPair(FORMAT_SEED);
		const viewB = R.attach(set.B.doc);
		viewB.runs('a');
		set.A.transact(() => M.setMark(set.A.doc, 'a', 6, 10, 'code', true));
		set.deliver('A', 'B');
		expect(viewB.runs('a')).toEqual([...O.computeAllRuns(set.B.doc).get('a')]);
		expect(viewB.runs('a')[1].marks).toEqual({ bold: true, code: true });
	});

	it('undo restores the pre-edit range reads (markers re-anchor)', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const um = set.A.enableUndo({ scope: doc });
		const before = view.runs('a');
		set.A.transact(() => M.setMark(doc, 'a', 0, 10, 'code', true));
		expect(view.runs('a')).not.toEqual(before);
		um.undo();
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		expect(view.runs('a')).toEqual(before);
	});

	it('equal mark sets intern to one object across blocks AND within a block', () => {
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: [
						{ kind: 'text', text: 'x', marks: { bold: true } },
						{ kind: 'text', text: 'y' },
						{ kind: 'text', text: 'z', marks: { bold: true } }
					]
				},
				{
					id: 'b',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'w', marks: { bold: true } }]
				}
			])
		);
		const view = R.attach(set.A.doc);
		expect(view.runs('a')[0].marks).toBe(view.runs('a')[2].marks);
		expect(view.runs('a')[0].marks).toBe(view.runs('b')[0].marks);
	});

	it('snapshots taken before later mutations stay frozen and unchanged', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const snap = view.runs('a');
		const flatBefore = snap.map((r) => (r.kind === 'text' ? r.text : '�')).join('');
		set.A.transact(() => M.insertText(doc, 'a', 0, 'NEW'));
		set.A.transact(() => M.unsetMark(doc, 'a', 8, 4, 'bold'));
		expect(Object.isFrozen(snap)).toBe(true);
		expect(snap.map((r) => (r.kind === 'text' ? r.text : '�')).join('')).toBe(flatBefore);
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
	});

	it('local decorations overlay correctly on top of the new read path', () => {
		const set = createPeerPair(FORMAT_SEED);
		const view = R.attach(set.A.doc);
		const snap = view.snapshot('a');
		const decorated = decorateRuns(snap, [
			{ from: 0, to: 12, key: 'spell', value: 'error' },
			{ from: 6, to: 11, key: 'syntax', value: 'kw' }
		]);
		expect(decorated[0]).toEqual({
			kind: 'text',
			text: 'plain ',
			decorations: { spell: 'error' }
		});
		expect(decorated[1].decorations).toEqual({ spell: 'error', syntax: 'kw' });
		// Persistent marks carry over with equal content — but a snapshot's
		// marks are caller-owned JSON clones, so decorateRuns clones them
		// before freezing (R4): the emitted run is frozen while the caller's
		// snapshot stays mutable.
		expect(decorated[1].marks).toEqual(snap[1].marks);
		expect(Object.isFrozen(decorated[1].marks)).toBe(true);
		expect(Object.isFrozen(snap[1].marks)).toBe(false);
	});

	it('multi-backing block: merged content reads each text independently', () => {
		const set = createPeerPair(FORMAT_SEED);
		const doc = set.A.doc;
		set.A.transact(() =>
			M.insertBlock(
				doc,
				{ parent: null, index: 1 },
				{
					id: 'd',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'delta', marks: { italic: true } }]
				}
			)
		);
		set.A.transact(() => M.mergeBlocks(doc, 'd', 'a'));
		const view = R.attach(doc);
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		const flat = view
			.runs('a')
			.map((r) => (r.kind === 'text' ? r.text : '�'))
			.join('');
		expect(flat).toContain('delta');
	});
});
