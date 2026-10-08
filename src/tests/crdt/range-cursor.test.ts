/**
 * U3 — the vendored bounded read-only `RangeCursor`
 * (`src/lib/crdt/vendor/yjs/src/utils/RangeCursor.js`, UPSTREAM.md YP5).
 *
 * Contract under test:
 *
 * - REFERENCE EQUIVALENCE: `cursor.read(i0, i1)` emits the same content +
 *   folded marks as clipping the whole-node `toDelta` render — marks
 *   inherited from format markers BEFORE the range, `{mark:null}` clears,
 *   boundary clips, surrogates, live inline atoms, tombstoned content and
 *   tombstoned format markers — because both sides consume the same
 *   `readItemPieces` physical-sequence interpretation.
 * - ATTRIBUTION: under an attribution renderer (the test port of the pruned
 *   `AttributionsRenderer`, `harness/content-map-renderer.js`) the pieces carry the same
 *   native attribution inputs (`attrs`/`deleted`) that the toDelta render
 *   turns into op-level `attribution`.
 * - READ PURITY: reads produce no updates, split no items, change no undo
 *   state, and install/mutate no renderer. The only writes are adaptive
 *   `_searchMarker` checkpoint maintenance — the same non-replicated cache
 *   writes upstream's own read-path lookups (`findMarker`) perform.
 * - BOUNDS: `stats.items` counts sequence items stepped — a seeded or
 *   previously-walked read stays range-sized, never whole-text.
 * - SEED KINDS: the read seed accepts markers the mutation seed must
 *   reject (`a[b]b[b=null]c` counterexample) — and that acceptance is
 *   invisible to `applyDelta` (byte-identical updates).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import * as delta from 'lib0-v14/delta';
import {
	ArraySearchMarker,
	createAttributionFromAttributionItems
} from '../../lib/crdt/vendor/yjs/src/ynode.js';
import { ContentMapRenderer, allIds, idMapOf, nodeItems } from './harness/content-map-renderer.js';

const newDoc = () => {
	const doc = new Y.Doc();
	doc.clientID = 1;
	return doc;
};

/** Apply a delta in one transaction. */
const apply = (doc, text, d) => doc.transact(() => text.applyDelta(d));

/** The whole-node reference: `toDelta` insert ops clipped to `[i0, i1)`. */
const oracleItemsOfRange = (text, i0, i1, renderer = null) => {
	const items = [];
	let pos = 0;
	const deltaJSON = text.toDelta(renderer === null ? {} : { renderer }).toJSON() ?? {
		children: []
	};
	for (const op of deltaJSON.children ?? []) {
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
				const last = items[items.length - 1];
				const marks = op.format;
				const slice = op.insert.slice(lo - start, hi - start);
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
		} else if (Array.isArray(op.insert)) {
			for (const entry of op.insert) {
				const idx = pos;
				pos += 1;
				if (idx < i0 || idx >= i1) continue;
				items.push({ kind: 'inline', entry });
			}
		}
	}
	return items;
};

/**
 * Project the native piece stream to the oracle's shape — the same
 * projection Edytor's `readRange` performs.
 */
const cursorItemsOfRange = (text, i0, i1, renderer = undefined) => {
	const cur = renderer === undefined ? new Y.RangeCursor(text) : new Y.RangeCursor(text, renderer);
	const items = [];
	for (const p of cur.read(i0, i1)) {
		if (p.deleted || p.len === 0) continue;
		const c = p.content;
		if (typeof c.str === 'string') {
			const marks = p.formats;
			const slice = c.str.slice(p.offset, p.offset + p.len);
			const last = items[items.length - 1];
			if (
				last &&
				last.kind === 'text' &&
				JSON.stringify(last.marks ?? null) === JSON.stringify(marks ?? null)
			) {
				last.text += slice;
			} else {
				items.push({ kind: 'text', text: slice, ...(marks === undefined ? {} : { marks }) });
			}
		} else if (typeof c.getContent === 'function') {
			const arr = c.getContent();
			for (let k = p.offset; k < p.offset + p.len; k++)
				items.push({ kind: 'inline', entry: arr[k] });
		}
	}
	return items;
};

const expectRangeParity = (text, ranges, renderer = null) => {
	for (const [i0, i1] of ranges) {
		expect(cursorItemsOfRange(text, i0, i1, renderer ?? undefined), `range ${i0}..${i1}`).toEqual(
			oracleItemsOfRange(text, i0, i1, renderer)
		);
	}
};

const allRanges = (len) => {
	const out = [];
	for (let i0 = 0; i0 <= len; i0++) {
		for (let i1 = i0; i1 <= len; i1++) out.push([i0, i1]);
	}
	out.push([5, 5], [0, 0], [len, len], [3, 2]);
	return out;
};

const RICH_FORMAT = (doc) => {
	const text = doc.get('t');
	apply(
		doc,
		text,
		delta
			.create()
			.insert('plain ')
			.insert('bold ', { bold: true })
			.insert('both ', { bold: true, italic: true })
			.insert('ital ', { italic: true })
			.insert(' end')
	);
	return text;
};

describe('RangeCursor — bounded output vs whole-node toDelta reference', () => {
	it('every range of a richly formatted text matches the reference', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		expectRangeParity(text, allRanges(text.length));
	});

	it('overlapping marks and null clears produce identical boundaries', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		apply(doc, text, delta.create().retain(8).retain(4, { underline: true }));
		apply(doc, text, delta.create().retain(12).retain(3, { italic: null }));
		expectRangeParity(text, allRanges(text.length));
		// 'both ' sits at 11–16 — [12,15) is 'oth' under bold only.
		expect(cursorItemsOfRange(text, 12, 15)).toEqual([
			{ kind: 'text', text: 'oth', marks: { bold: true } }
		]);
	});

	it('surrogate pairs slice identically at code-unit boundaries', () => {
		const doc = newDoc();
		const text = doc.get('t');
		apply(doc, text, delta.create().insert('ab 🚀 cd', { bold: true }).insert(' 𝌆x'));
		expectRangeParity(text, allRanges(text.length));
		// U+1D306 '𝌆' is a surrogate pair — a code-unit clip mid-pair must
		// match the reference's own `str.slice` behavior.
		// U+1D306 '𝌆' is a surrogate pair at units 9–10 — a code-unit clip
		// mid-pair must match the reference's own `str.slice` behavior.
		const pieceText = (i0, i1) =>
			new Y.RangeCursor(text)
				.read(i0, i1)
				.map((p) => p.content.str.slice(p.offset, p.offset + p.len))
				.join('');
		expect(pieceText(9, 10)).toBe('𝌆'[0]);
		expect(pieceText(10, 11)).toBe('𝌆'[1]);
	});

	it('live inline atoms emit one piece per element with node identity', () => {
		const doc = newDoc();
		const text = doc.get('t');
		const atom = doc.get('at');
		atom.setAttr('id', 'm1');
		atom.setAttr('type', 'mention');
		apply(doc, text, delta.create().insert('ab').insert([atom]).insert('cd'));
		expect(text.length).toBe(5);
		expectRangeParity(text, allRanges(text.length));
		const pieces = new Y.RangeCursor(text).read(2, 3);
		expect(pieces.length).toBe(1);
		expect(pieces[0].len).toBe(1);
		expect(pieces[0].content.getContent()[0]).toBe(atom);
	});

	it('tombstoned content and tombstoned format markers emit nothing', () => {
		const doc = newDoc();
		const text = doc.get('t');
		apply(doc, text, delta.create().insert('abcdef').insert('MID', { b: true }).insert('xyz'));
		// Delete the whole bold span (tombstones 'MID' between its markers)
		// and a plain content span — tombstones stay in the item list.
		apply(doc, text, delta.create().retain(6).delete(3));
		apply(doc, text, delta.create().retain(6).delete(2));
		expect(text.length).toBe(7); // 'abcdef' + 'z'
		expectRangeParity(text, allRanges(text.length));
		// The only live content in the gap reads cleanly — tombstoned items
		// emit nothing.
		const pieces = new Y.RangeCursor(text).read(6, 7);
		expect(pieces.filter((p) => !p.deleted && p.len > 0)).toEqual([
			expect.objectContaining({ len: 1 })
		]);
		expect(pieces.filter((p) => !p.deleted && p.len > 0).map((p) => p.content.str)).toEqual(['z']);
	});

	it('adjacent same-state pieces share the materialized formats object (the alias contract)', () => {
		const doc = newDoc();
		const text = doc.get('t');
		// Two live strings separated by a tombstone under ONE fold state —
		// adjacent pieces would merge, so the tombstone keeps them distinct.
		apply(
			doc,
			text,
			delta.create().insert('ab', { b: true }).insert('X', { b: true }).insert('cd', { b: true })
		);
		apply(doc, text, delta.create().retain(2).delete(1));
		const pieces = new Y.RangeCursor(text).read(0, 4).filter((p) => !p.deleted && p.len > 0);
		expect(pieces.length).toBe(2);
		expect(pieces[0].formats).toBe(pieces[1].formats); // SHARED — read-only for consumers
		expect(pieces[0].formats).toEqual({ b: true });
	});

	it('marks set through ops are inherited across the range boundary', () => {
		const doc = newDoc();
		const text = doc.get('t');
		apply(doc, text, delta.create().insert('aaaa').insert('bbbb', { b: true }));
		apply(doc, text, delta.create().retain(2).retain(4, { u: true }));
		// Underline spans 2–5: [3,5) crosses 'a'{u} → 'b'{b,u}.
		expectRangeParity(text, allRanges(text.length));
		expect(cursorItemsOfRange(text, 3, 5)).toEqual([
			{ kind: 'text', text: 'a', marks: { u: true } },
			{ kind: 'text', text: 'b', marks: { b: true, u: true } }
		]);
	});
});

describe('RangeCursor — renderer + native attribution', () => {
	const attributedDoc = () => {
		const doc = newDoc();
		const text = doc.get('t');
		apply(doc, text, delta.create().insert('abcdef', { b: true }).insert('ghi'));
		// Attribute every inserted id to 'alice'.
		const attributions = {
			inserts: idMapOf(allIds(doc), [Y.createContentAttribute('insert', 'alice')]),
			deletes: Y.createIdMap()
		};
		return { doc, text, renderer: new ContentMapRenderer(attributions) };
	};

	it('attributed pieces carry the same attribution inputs as the toDelta render', () => {
		const { text, renderer } = attributedDoc();
		const ops = text.toDelta({ renderer }).toJSON().children;
		const pieces = new Y.RangeCursor(text, renderer).read(0, text.length);
		const rendered = pieces.filter((p) => p.len > 0);
		expect(rendered.length).toBe(ops.filter((o) => o.type === 'insert').length);
		for (const p of rendered) {
			const expected = createAttributionFromAttributionItems(p.attrs, p.deleted);
			expect(expected).toEqual({ insert: ['alice'] });
		}
		expectRangeParity(text, allRanges(text.length), renderer);
	});

	it('reads under a renderer walk correctly without marker seeding (different index space)', () => {
		const { text, renderer } = attributedDoc();
		// The seek is renderer-gated (markers record raw countable space) —
		// reads stay correct through the plain forward walk.
		const stats = { items: 0, markers: 0 };
		const cur = new Y.RangeCursor(text, renderer);
		expect(cursorItemsOfRange(text, 2, 7, renderer)).toEqual(
			oracleItemsOfRange(text, 2, 7, renderer)
		);
		cur.read(2, 7, stats);
		expect(stats.items).toBeGreaterThan(0);
	});
});

describe('RangeCursor — integration scenarios', () => {
	it('remote integration: reads on a doc built from applyUpdate match the reference', () => {
		const src = newDoc();
		const text = RICH_FORMAT(src);
		const update = Y.encodeStateAsUpdate(src);
		const dst = newDoc();
		Y.applyUpdate(dst, update);
		const dtext = dst.get('t');
		// applyUpdate cleared the marker pool — reads re-seed it adaptively.
		expect(dtext._searchMarker.length).toBe(0);
		expectRangeParity(dtext, allRanges(dtext.length));
		// After the parity walk, the pool has populated — a targeted read is bounded.
		const stats = { items: 0, markers: 0 };
		new Y.RangeCursor(dtext).read(10, 14, stats);
		const wholeItems = nodeItems(dtext).length;
		expect(stats.items).toBeLessThan(wholeItems);
	});

	it('undo/redo-produced items read identically to the reference', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		const um = new Y.UndoManager(text);
		apply(doc, text, delta.create().retain(6).insert('NEW', { code: true }));
		um.undo();
		expectRangeParity(text, allRanges(text.length));
		um.redo();
		expectRangeParity(text, allRanges(text.length));
	});

	it('reads inside an open transaction see uncommitted items (read-your-writes)', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		doc.transact(() => {
			text.applyDelta(delta.create().retain(6).insert('NEW ', { bold: true }));
			expect(cursorItemsOfRange(text, 6, 10)).toEqual(oracleItemsOfRange(text, 6, 10));
			text.applyDelta(delta.create().retain(0).retain(6, { code: true }));
			expect(cursorItemsOfRange(text, 0, 12)).toEqual(oracleItemsOfRange(text, 0, 12));
			text.applyDelta(delta.create().retain(8).retain(4, { bold: null }));
			expect(cursorItemsOfRange(text, 6, 16)).toEqual(oracleItemsOfRange(text, 6, 16));
		});
		expectRangeParity(text, allRanges(text.length));
	});

	it('a cursor serves forward, backward and repeated reads correctly', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		const cur = new Y.RangeCursor(text);
		const read = (i0, i1) => {
			const items = [];
			for (const p of cur.read(i0, i1)) {
				if (p.deleted || p.len === 0 || typeof p.content.str !== 'string') continue;
				items.push({
					kind: 'text',
					text: p.content.str.slice(p.offset, p.offset + p.len),
					...(p.formats === undefined ? {} : { marks: p.formats })
				});
			}
			return items;
		};
		expect(read(6, 11)).toEqual(oracleItemsOfRange(text, 6, 11));
		expect(read(11, 18)).toEqual(oracleItemsOfRange(text, 11, 18));
		expect(read(18, 20)).toEqual(oracleItemsOfRange(text, 18, 20));
		// Backward read — rewind + re-seek.
		expect(read(0, 8)).toEqual(oracleItemsOfRange(text, 0, 8));
		// Random order on ONE cursor.
		let s = 0x5eed;
		const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (let k = 0; k < 60; k++) {
			const i0 = Math.floor(rand() * text.length);
			const i1 = i0 + Math.floor(rand() * (text.length - i0));
			expect(read(i0, i1), `read ${i0}..${i1}`).toEqual(oracleItemsOfRange(text, i0, i1));
		}
	});
});

describe('RangeCursor — read purity', () => {
	it('reads produce no updates, no splits, no undo-history change, no renderer change', () => {
		const doc = newDoc();
		const text = RICH_FORMAT(doc);
		const um = new Y.UndoManager(text);
		apply(doc, text, delta.create().retain(2).insert('X'));
		const updatesBefore = Y.encodeStateAsUpdate(doc);
		const itemsBefore = nodeItems(text).length;
		const stackBefore = um.undoStack.length + um.redoStack.length;
		const rendererBefore = text._renderer;
		// Reads across the whole text, seeded and cold.
		for (const [i0, i1] of allRanges(text.length)) {
			new Y.RangeCursor(text).read(i0, i1);
		}
		const cur = new Y.RangeCursor(text);
		cur.read(3, 9);
		cur.read(20, 26);
		cur.read(0, 5);
		expect(Y.encodeStateAsUpdate(doc)).toEqual(updatesBefore);
		expect(nodeItems(text).length).toBe(itemsBefore);
		expect(um.undoStack.length + um.redoStack.length).toBe(stackBefore);
		expect(text._renderer).toBe(rendererBefore);
	});

	it('marker perturbations from reads are behavior-invisible to mutations', () => {
		const ops = [
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(10).insert('y'))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(5).retain(8, { b: true }))),
			(t, doc) => doc.transact(() => t.applyDelta(delta.create().retain(3).delete(4)))
		];
		const mk = (seeded) => {
			const doc = newDoc();
			const t = doc.get('t');
			doc.transact(() => {
				const d = delta.create();
				for (let i = 0; i < 30; i++) d.insert('x', i % 2 ? { i: true } : { b: true });
				t.applyDelta(d);
			});
			if (seeded) {
				// Reads populate + perturb the checkpoint pool first.
				const cur = new Y.RangeCursor(t);
				for (let k = 0; k < 12; k++) cur.read((k * 7) % 25, ((k * 7) % 25) + 3);
			} else {
				t._searchMarker = null;
			}
			for (const op of ops) op(t, doc);
			return { doc, t };
		};
		const on = mk(true);
		const off = mk(false);
		expect(Y.encodeStateAsUpdate(on.doc)).toEqual(Y.encodeStateAsUpdate(off.doc));
		expect(on.t.toDelta().toJSON()).toEqual(off.t.toDelta().toJSON());
	});
});

describe('RangeCursor — traversal bounds', () => {
	it('repeated range reads stay range-sized after the checkpoint pool fills', () => {
		const doc = newDoc();
		const text = doc.get('t');
		doc.transact(() => {
			const d = delta.create();
			for (let i = 0; i < 500; i++) {
				d.insert('abcdefghij', i % 2 === 0 ? { bold: true } : {});
			}
			text.applyDelta(d);
		});
		const wholeItems = nodeItems(text).length;
		expect(wholeItems).toBeGreaterThanOrEqual(1000);
		// Cold sweep of 25 disjoint 200-char ranges — each plants sparse
		// checkpoints; later passes then stay range-sized.
		const cur = new Y.RangeCursor(text);
		const stats = { items: 0, markers: 0 };
		for (let k = 0; k < 25; k++) cur.read(k * 200, k * 200 + 200, stats);
		// Second pass: every read is seeded/bounded — far below whole-items.
		for (let k = 0; k < 25; k++) {
			const before = stats.items;
			cur.read(k * 200, k * 200 + 200, stats);
			expect(stats.items - before).toBeLessThan(wholeItems / 2);
		}
	});

	it('a seeded read steps only the gap between checkpoint and range', () => {
		const doc = newDoc();
		const text = doc.get('t');
		doc.transact(() => {
			const d = delta.create();
			for (let i = 0; i < 200; i++) d.insert('s' + i + 'xxxxx ', i % 3 ? { i: true } : { b: true });
			text.applyDelta(d);
		});
		// Plant checkpoints via one cold pass.
		const warm = new Y.RangeCursor(text);
		for (let k = 0; k < 10; k++) warm.read(k * 200, k * 200 + 100);
		// Targeted read near a planted checkpoint.
		const stats = { items: 0, markers: 0 };
		new Y.RangeCursor(text).read(1500, 1510, stats);
		expect(stats.items).toBeLessThan(200); // ≪ the ~1000-item list
	});
});

describe('RangeCursor — read seed vs mutation seed (counterexample)', () => {
	/**
	 * `a[b]b[b=null]c` — tail-anchored markers land on the last countable
	 * item `c` at index 2, whose left is the `b:null` marker — NOT the first
	 * item at index 2. The mutation seed must reject it; the read seed must
	 * accept it — the distinguishing property pinned here.
	 */
	const counterDoc = () => {
		const doc = newDoc();
		const text = doc.get('t');
		apply(doc, text, delta.create().insert('a').insert('b', { b: true }).insert('c'));
		return { doc, text };
	};
	const findItem = (text, str) => nodeItems(text).find((it) => it.content.str === str);

	it('a marker anchored after same-index non-countable items seeds reads but not mutations', () => {
		const { doc, text } = counterDoc();
		const cItem = findItem(text, 'c');
		expect(cItem).toBeTruthy();
		// The fabricated marker is exactly what `plantMarker`'s tail-anchor
		// writes when `c` is non-mergeable (e.g. remote or GC-gap
		// separated): index 2 = `c`'s left edge, `{}` = state there (the
		// `b:null` marker cleared `b`). Pushed directly — the read seed's
		// scan never runs `findMarker`'s merge-left re-anchor.
		const m = new ArraySearchMarker(cItem, 2);
		m.formats = new Map();
		text._searchMarker.push(m);

		// READ: seeded directly on `c` — one item stepped, correct output.
		const stats = { items: 0, markers: 0 };
		const pieces = new Y.RangeCursor(text).read(2, 3, stats);
		expect(stats.items).toBe(1);
		expect(
			pieces
				.filter((p) => !p.deleted && p.len > 0)
				.map((p) => p.content.str.slice(p.offset, p.offset + p.len))
		).toEqual(['c']);
		expect(pieces[0].formats).toBeUndefined();

		// MUTATION: the same marker must be rejected by applyDelta's seed —
		// `c`'s left is non-countable, so the op walks from _start. Compare
		// against a markers-disabled doc: byte-identical store + delta.
		const off = counterDoc();
		off.text._searchMarker = null;
		doc.transact(() => text.applyDelta(delta.create().retain(2).insert('X')));
		off.doc.transact(() => off.text.applyDelta(delta.create().retain(2).insert('X')));
		expect(Y.encodeStateAsUpdate(doc)).toEqual(Y.encodeStateAsUpdate(off.doc));
		expect(text.toDelta().toJSON()).toEqual(off.text.toDelta().toJSON());
	});

	it('the mutation seed still anchors on first-at-index markers the read seed also accepts', () => {
		// Sanity: an unformatted tail marker (first-at-index) seeds both.
		const { doc, text } = counterDoc();
		doc.transact(() => text.applyDelta(delta.create().retain(3))); // plants at tail
		const stats = { items: 0, markers: 0 };
		new Y.RangeCursor(text).read(2, 3, stats);
		expect(stats.items).toBeLessThan(4);
	});
});
