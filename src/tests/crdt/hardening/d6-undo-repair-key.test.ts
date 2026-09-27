/**
 * HARDENING D6 — `undoRepairClaims` pending-span coalescing must key on
 * the REAL `(holder, seqIndex)` pair (review
 * `docs/elegance-review-2026-09-23.md` §D6).
 *
 * The repair emits fresh slice records grouped by the winning record's
 * holder list and live seqIndex; adjacent elementary intervals won by the
 * same (holder, seqIndex) coalesce into one record. The old coalescing
 * map was keyed by the CONCATENATED string `` `${holder}${seqIndex}` `` —
 * non-injective: ('a', 12) and ('a1', 2) both encode 'a12'. When two
 * colliding claims won adjacent spans of a resurrected text, the second
 * holder's span silently EXTENDED the first's pending record — the merged
 * claim then landed on the wrong `slices` list, stealing atoms from the
 * holder that actually won them (and leaving the rightful holder with no
 * claim at all).
 *
 * The fix keeps the coalescing but keys it as nested maps —
 * `Map<holder, Map<seqIndex, span>>` — so ('a',12) and ('a1',2) can never
 * meet.
 *
 * Staging (verified against the vendored engine): text '0123456789' on
 * block 'b'; holder 'a' carries `{t:'b',[2,4)}` at slices seqIndex 12 and
 * holder 'a1' carries `{t:'b',[4,7)}` at seqIndex 2 — records whose `s`
 * anchors bind atoms that a delete then tombstones. Undo resurrects the
 * atoms as copies that integrate LEFT of the tombstone items, so the
 * tombstone-bound anchors resolve PAST the copies in normal space (the
 * records cover nothing — 'b' swallows the run) while the redone-space
 * resolution still lands them at [2,4)/[4,7). The repair must therefore
 * emit a claim for BOTH holders — under adjacent (holder, seqIndex) keys
 * that collide under the old string key.
 */
// @ts-nocheck -- reaches into engine internals to stage the colliding lists.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { bindText } from '../../../lib/crdt/text/model.js';

const M = bindModel(Y);
const T = bindText(Y);
const E = bindEdytorDoc(Y);
let cid = 400_000;

const PAD = { t: 'void', s: { i: null, a: -1 }, e: { i: null, a: 0 } };

/**
 * Insert the colliding claims. Index accounting: every slices list starts
 * with the block's own seed `{t:self,B,E}` record at index 0, so 'a' gets
 * 11 pads (recA at 12) and 'a1' one pad (recA1 at 2).
 */
const stage = (doc, bText, aSlices, a1Slices) => {
	doc.transact(() => {
		// 'a' — pads to seqIndex 12, record covering atoms [2,4).
		for (let i = 0; i < 11; i++) aSlices.insert(aSlices.length, [{ ...PAD }]);
		aSlices.insert(aSlices.length, [
			{ t: 'b', s: T.anchorAt(doc, bText, 2), e: T.anchorAt(doc, bText, 4), g: 9 }
		]);
		// 'a1' — record at seqIndex 2 covering atoms [4,7).
		// ('a',12) and ('a1',2) collide under `${holder}${seqIndex}` → 'a12'.
		a1Slices.insert(a1Slices.length, [{ ...PAD }]);
		a1Slices.insert(a1Slices.length, [
			{ t: 'b', s: T.anchorAt(doc, bText, 4), e: T.anchorAt(doc, bText, 7), g: 9 }
		]);
	});
};

describe('D6 — undoRepairClaims holder×seqIndex key is injective', () => {
	test('surgical: colliding (holder, seqIndex) pairs emit separate claim groups', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		M.insertBlock(
			doc,
			{ parent: null, index: 0 },
			{
				id: 'b',
				type: 'p',
				content: [{ kind: 'text', text: '0123456789' }]
			}
		);
		M.insertBlock(doc, { parent: null, index: 1 }, { id: 'a', type: 'p' });
		M.insertBlock(doc, { parent: null, index: 2 }, { id: 'a1', type: 'p' });
		const bText = M.blockNodeOf(doc, 'b').getAttr('content');
		stage(
			doc,
			bText,
			M.blockNodeOf(doc, 'a').getAttr('slices'),
			M.blockNodeOf(doc, 'a1').getAttr('slices')
		);

		// Precondition: the staged records own their spans pre-delete.
		expect(M.blockText(doc, 'a')).toBe('23');
		expect(M.blockText(doc, 'a1')).toBe('456');
		expect(M.blockText(doc, 'b')).toBe('01789');

		// Raw undo — no facade repair observer on this doc.
		const um = new Y.UndoManager(doc.get('blocks'), { captureTimeout: 0 });
		doc.transact(() => bText.delete(2, 5)); // tombstone atoms 2..6
		um.undo();
		// Unrepaired state: 'b' swallowed the whole run (the R3 shape).
		expect(M.blockText(doc, 'a')).toBe('');
		expect(M.blockText(doc, 'a1')).toBe('');
		expect(M.blockText(doc, 'b')).toBe('0123456789');

		const blocks = M.collectBlocks(doc);
		const own = T.computeOwnership(doc, blocks);
		const out = T.undoRepairClaims(doc, blocks, own, 'b', bText, [{ i0: 2, i1: 7 }]);

		// The fused-key bug emitted ONE group ('a'@12 covering [2,7)) and
		// nothing for 'a1'. Correct: two holders, one seqIndex bucket each.
		const groupA = out.get('a');
		const groupA1 = out.get('a1');
		expect(groupA).toBeDefined();
		expect(groupA1).toBeDefined();
		expect([...groupA!.keys()]).toEqual([12]);
		expect([...groupA1!.keys()]).toEqual([2]);
		const recA = groupA!.get(12)!;
		const recA1 = groupA1!.get(2)!;
		expect(recA).toHaveLength(1);
		expect(recA1).toHaveLength(1);
		// Each record claims exactly its holder's atoms — not the fused span.
		expect(T.resolveAnchor(doc, bText, recA[0].s)).toBe(2);
		expect(T.resolveAnchor(doc, bText, recA[0].e)).toBe(4);
		expect(T.resolveAnchor(doc, bText, recA1[0].s)).toBe(4);
		expect(T.resolveAnchor(doc, bText, recA1[0].e)).toBe(7);
	});

	test("end-to-end: a real undo repair restores each colliding holder's span", () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [
				{
					id: 'b',
					type: 'paragraph',
					content: [{ kind: 'text', text: '0123456789' }]
				},
				{ id: 'a', type: 'paragraph', content: [] },
				{ id: 'a1', type: 'paragraph', content: [] }
			]
		});
		const bText = M.blockNodeOf(doc, 'b').getAttr('content');
		stage(
			doc,
			bText,
			M.blockNodeOf(doc, 'a').getAttr('slices'),
			M.blockNodeOf(doc, 'a1').getAttr('slices')
		);
		expect(ed.blockText('a')).toBe('23');
		expect(ed.blockText('a1')).toBe('456');
		expect(ed.blockText('b')).toBe('01789');

		// Raw UndoManager + raw transact (origin null, tracked by default):
		// the doc-level repair observer still fires — it is attached once
		// per doc by the facade, for ANY undo-shaped transaction.
		const um = new Y.UndoManager(doc.get('blocks'), { captureTimeout: 0 });
		doc.transact(() => bText.delete(2, 5));
		um.undo();

		// Old key: 'a1'@2 collided with 'a'@12 → the fused claim landed on
		// 'a' — a displayed '23456', a1 displayed ''. Correct: each holder's
		// own span comes home.
		expect(ed.blockText('a')).toBe('23');
		expect(ed.blockText('a1')).toBe('456');
		expect(ed.blockText('b')).toBe('01789');

		// The repair is replicated state — a fresh replica derives the same
		// ownership (no redone knowledge needed).
		const remote = new Y.Doc();
		remote.clientID = cid++;
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
		const red = E.create(remote);
		expect(red.blockText('a')).toBe('23');
		expect(red.blockText('a1')).toBe('456');
		expect(red.blockText('b')).toBe('01789');
	});
});
