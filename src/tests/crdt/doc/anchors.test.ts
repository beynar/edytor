/**
 * U09 — selection anchors bound to backing-text atoms.
 *
 * `ed.anchorAt(blockId, displayOffset, affinity)` produces a JSON-safe
 * `DocAnchor` `{b, a}`; `ed.resolveAnchor` maps it back to a current
 * `{blockId, offset}` through ownership — moved/merged atoms carry the
 * anchor into whichever block displays them, deleted atoms resolve to
 * the gap where they lived, and a fully-unowned/deleted backing falls
 * back to the owner emission seam (or `null` when the owner is dead).
 *
 * Affinity contract:
 * - 'left'  (assoc < 0): bound to the atom BEFORE the position — an
 *   insert exactly at the position lands to the anchor's right. Carets
 *   and range ENDS.
 * - 'right' (assoc >= 0): bound to the atom AT the position — an insert
 *   lands to the anchor's left, outside a range starting here. Range
 *   STARTS.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

let clientSeq = 2000;
const seeded = () => {
	const doc = new Y.Doc();
	doc.clientID = clientSeq++;
	const ed = E.create(doc);
	ed.init();
	return { doc, ed };
};

const textOf = (ed: ReturnType<typeof E.create>, id: string) =>
	ed
		.runs(id)
		.map((r) => (r.kind === 'text' ? r.text : '​'))
		.join('');

describe('anchorAt/resolveAnchor — positions, affinity, boundaries', () => {
	it('an anchor tracks its position through an insert before the caret', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 2, 'left');
		ed.insertText(DEFAULT_SEED_ID, 0, 'XX');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 4 });
	});

	it('left affinity does not absorb an insert at the position; right affinity does', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
		const left = ed.anchorAt(DEFAULT_SEED_ID, 2, 'left');
		const right = ed.anchorAt(DEFAULT_SEED_ID, 2, 'right');
		ed.insertText(DEFAULT_SEED_ID, 2, 'Z'); // → 'heZllo'
		// caret semantics: stays before the inserted 'Z' (offset 2).
		expect(ed.resolveAnchor(left)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
		// range-start semantics: glued to 'l' — the insert lands outside.
		expect(ed.resolveAnchor(right)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 3 });
	});

	it('a caret at offset 0 stays at 0 across prepends (live-start sentinel)', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'ab');
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 0, 'left');
		expect(caret).toEqual({ b: DEFAULT_SEED_ID, a: { i: null, a: -1 } });
		ed.insertText(DEFAULT_SEED_ID, 0, 'Q');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 0 });
	});

	it('a caret at end bound left does not follow appends', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'ab');
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 2, 'left');
		ed.insertText(DEFAULT_SEED_ID, 2, 'Z');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
	});

	it('an empty display anchors to the block own backing text at index 0', () => {
		const { ed } = seeded();
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 0, 'left');
		expect(caret).toEqual({ b: DEFAULT_SEED_ID, a: { i: null, a: -1 } });
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 0 });
		// Typed content lands where the empty anchor pointed.
		ed.insertText(DEFAULT_SEED_ID, 0, 'x');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 0 });
	});

	it('anchors survive JSON round-trip — the awareness wire shape', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
		const anchor = ed.anchorAt(DEFAULT_SEED_ID, 3, 'left');
		const revived = JSON.parse(JSON.stringify(anchor));
		expect(ed.resolveAnchor(revived)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 3 });
	});

	it('a split-start anchor keeps its owner facet through JSON round-trip', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		ed.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		const anchor = ed.anchorAt('tail', 0, 'left');
		expect(anchor?.o).toBe('tail');
		const revived = JSON.parse(JSON.stringify(anchor));
		expect(revived?.o).toBe('tail');
		// The owner facet must survive serialization — an awareness
		// round-trip that dropped `o` would re-expose the adjacent-block
		// migration (the receiver re-resolves into BOOTSTRAP's stream).
		expect(ed.resolveAnchor(revived)).toEqual({ blockId: 'tail', offset: 0 });
		// Older anchors have no `o` — they must still resolve (compatible
		// fallback via generic atom-following).
		const { o: _dropped, ...legacy } = revived!;
		expect(ed.resolveAnchor(legacy)).toBeTruthy();
	});
});

describe('anchor resolution through structure', () => {
	it('split: an anchor follows its atoms into the new sibling', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'abcdef');
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 4, 'left'); // binds 'd'
		ed.splitBlock(DEFAULT_SEED_ID, 3, 'b2');
		expect(textOf(ed, DEFAULT_SEED_ID)).toBe('abc');
		expect(textOf(ed, 'b2')).toBe('def');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: 'b2', offset: 1 });
	});

	it('merge: an anchor follows its atoms into the claiming block', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'abc');
		ed.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		ed.insertText('b2', 0, 'def');
		const caret = ed.anchorAt('b2', 1, 'left'); // binds 'd' in b2's backing
		expect(caret?.b).toBe('b2');
		expect(ed.mergeBackward('b2').ids).toEqual([DEFAULT_SEED_ID]);
		expect(textOf(ed, DEFAULT_SEED_ID)).toBe('abcdef');
		// 'd' now displays at index 3 of the merged block — resolves after it.
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 4 });
	});

	it('move: an anchor on a moved block keeps resolving inside it', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'abc');
		ed.insertBlock({ parent: null, index: 1 }, { id: 'wrap', type: 'paragraph' });
		ed.insertBlock({ parent: null, index: 2 }, { id: 'b3', type: 'paragraph' });
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 1, 'left');
		ed.nestBlock(DEFAULT_SEED_ID, 'wrap');
		expect(ed.parentOf(DEFAULT_SEED_ID)).toBe('wrap');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 1 });
	});

	it('deleted backing block → resolveAnchor returns null (caller falls back)', () => {
		const { ed } = seeded();
		ed.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		ed.insertText('b2', 0, 'def');
		const caret = ed.anchorAt('b2', 1, 'left');
		ed.deleteBlock('b2');
		expect(ed.resolveAnchor(caret)).toBeNull();
	});

	it('deleted atoms resolve to the gap where they lived', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 3, 'left'); // binds second 'l'
		ed.deleteText(DEFAULT_SEED_ID, 1, 3); // → 'ho'
		// 'l' atoms are tombstones; the gap between 'h' and 'o' is index 1.
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 1 });
	});

	it('a deleted atom keeps its gap when a surviving neighbor moves', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
		ed.splitBlock(DEFAULT_SEED_ID, 2, 'b2'); // 'he' | 'llo'
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 1, 'left'); // binds 'e' in b1
		// Delete 'e' locally, then merge — gap resolves inside the claiming block.
		ed.deleteText(DEFAULT_SEED_ID, 1, 1); // 'h' | 'llo'
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 1 });
	});

	it('inline atom boundary: right-affinity anchors ride the atom through edits', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'ab');
		ed.insertInline(DEFAULT_SEED_ID, 2, { id: 'm1', type: 'mention' });
		expect(ed.displayLength(DEFAULT_SEED_ID)).toBe(3);
		const beforeAtom = ed.anchorAt(DEFAULT_SEED_ID, 2, 'right'); // binds the atom
		const afterB = ed.anchorAt(DEFAULT_SEED_ID, 2, 'left'); // binds 'b'
		ed.insertText(DEFAULT_SEED_ID, 2, 'X'); // 'abX[atom]'
		expect(ed.resolveAnchor(beforeAtom)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 3 });
		expect(ed.resolveAnchor(afterB)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
	});

	it('removed inline atom → its anchor resolves to the gap where it lived', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'ab');
		ed.insertInline(DEFAULT_SEED_ID, 2, { id: 'm1', type: 'mention' });
		const onAtom = ed.anchorAt(DEFAULT_SEED_ID, 2, 'right'); // binds the atom
		ed.removeInline(DEFAULT_SEED_ID, 'm1');
		expect(ed.resolveAnchor(onAtom)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
	});

	it('unicode: anchors bind across surrogate pairs in UTF-16 offsets', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'a\u{1F600}b'); // length 4
		const caret = ed.anchorAt(DEFAULT_SEED_ID, 4, 'left'); // binds 'b'
		ed.deleteText(DEFAULT_SEED_ID, 1, 2); // remove the emoji → 'ab'
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
	});

	it('anchorAt(null-backing targets) returns null', () => {
		const { ed } = seeded();
		expect(ed.anchorAt('missing-block', 0, 'left')).toBeNull();
	});
});

describe('anchors under concurrency (two replicas)', () => {
	const pair = () => {
		const d1 = new Y.Doc();
		d1.clientID = clientSeq++;
		const e1 = E.create(d1);
		e1.init();
		const d2 = new Y.Doc();
		d2.clientID = clientSeq++;
		Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
		const e2 = E.create(d2);
		const push = (from: Y.Doc, to: Y.Doc) =>
			Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'sync');
		return { d1, d2, e1, e2, push };
	};

	it('a remote insert before the caret shifts the local anchor', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'hello');
		push(d1, d2);
		const caret = e1.anchorAt(DEFAULT_SEED_ID, 2, 'left');
		e2.insertText(DEFAULT_SEED_ID, 0, 'XX');
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 4 });
	});

	it('a remote insert AT the caret respects affinity', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'hello');
		push(d1, d2);
		const left = e1.anchorAt(DEFAULT_SEED_ID, 2, 'left');
		const right = e1.anchorAt(DEFAULT_SEED_ID, 2, 'right');
		e2.insertText(DEFAULT_SEED_ID, 2, 'Z');
		push(d2, d1);
		expect(e1.resolveAnchor(left)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 2 });
		expect(e1.resolveAnchor(right)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 3 });
	});

	it('an anchor bound before a remote merge follows its atoms into the merge', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'abc');
		e1.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		e1.insertText('b2', 0, 'def');
		push(d1, d2);
		const caret = e1.anchorAt('b2', 1, 'left');
		e2.mergeBackward('b2');
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 4 });
	});

	it('a caret at a split-block start resolves to its own block, not the seam neighbour', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		ed.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		// tail's stream is a mid-backing slice of the shared text — the
		// left neighbour atom belongs to BOOTSTRAP. A plain left anchor
		// would encode the seam's left facet; the minted anchor must carry
		// tail's own facet (a === -2 marker on a left-sticky binding).
		const caret = ed.anchorAt('tail', 0, 'left');
		expect(caret?.a.a).toBe(-2);
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
	});

	it('a split-start caret keeps left insert-affinity — a remote insert stays to its right', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		e2.insertText('tail', 0, 'n'); // remote peer types at the same gap
		push(d2, d1);
		// The caret does NOT absorb the insert — stays before 'n' at 0.
		// (Right-binding here resolved to 1 — the composition corruption.)
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
	});

	it('a split-start caret stays in its block through an adjacent-block append', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		expect(caret?.a.a).toBe(-2);
		// The LEFT neighbour appends — the atom now occupying the seam gap
		// is owned by BOOTSTRAP, not tail. The caret must not migrate into
		// BOOTSTRAP's stream (would land alphaX@5 and type 'Z' there).
		e2.insertText(DEFAULT_SEED_ID, 5, 'X');
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
		// Typing at the resolved caret produces alphaX / ZHello — the
		// document split order, not alphaZX / Hello.
		const at = e1.resolveAnchor(caret);
		e1.insertText(at!.blockId, at!.offset, 'Z');
		expect(textOf(e1, DEFAULT_SEED_ID)).toBe('alphaX');
		expect(textOf(e1, 'tail')).toBe('ZHello');
	});

	it('a split-start caret follows its facet into a remote merge', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		e2.mergeBackward('tail');
		push(d2, d1);
		// 'Hello' now displays inside BOOTSTRAP — the caret's facet atoms
		// moved, so the position follows into the claiming block at the
		// same gap (between 'a' and 'H').
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 5 });
	});

	it('a split-start caret follows its facet through a remote mergeForward', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		// mergeForward(alpha) pulls tail INTO alpha — `o` dies, the caret
		// follows its atoms into the surviving block at the seam.
		e2.mergeForward(DEFAULT_SEED_ID);
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: DEFAULT_SEED_ID, offset: 5 });
	});

	it('a split-start caret survives deletion of the predecessor’s last atom', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		// The -2 anchor binds alpha's LAST atom — deleting it leaves the
		// bound atom dead; resolution must still land inside tail's
		// stream at its start (gap before 'H', now backing index 4).
		e2.deleteText(DEFAULT_SEED_ID, 4, 1);
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
		const at = e1.resolveAnchor(caret)!;
		e1.insertText(at.blockId, at.offset, 'Z');
		expect(textOf(e1, DEFAULT_SEED_ID)).toBe('alph');
		expect(textOf(e1, 'tail')).toBe('ZHello');
	});

	it('a split-start caret survives deletion of the whole predecessor block', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		// Every atom the anchor bound is dead; 'Hello' slides to backing
		// [0,5) and tail still owns it — the caret stays at tail@0.
		e2.deleteBlock(DEFAULT_SEED_ID);
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
		const at = e1.resolveAnchor(caret)!;
		e1.insertText(at.blockId, at.offset, 'Z');
		expect(textOf(e1, 'tail')).toBe('ZHello');
	});

	it('a split-start caret stays in its block when the block is moved', () => {
		const { ed } = seeded();
		ed.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		ed.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		const caret = ed.anchorAt('tail', 0, 'left');
		// Moving the OWNED block does not move its atoms' ownership —
		// display order decouples from backing order; the seam caret is
		// still the start of tail's stream.
		expect(ed.moveBlock('tail', { parent: null, index: 0 }).status).toBe('applied');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
	});

	it('a split-start caret lands in its own block when the destination empties in place', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		e1.splitBlock(DEFAULT_SEED_ID, 5, 'tail');
		push(d1, d2);
		const caret = e1.anchorAt('tail', 0, 'left');
		// tail's atoms all die but the BLOCK survives (empty paragraph) —
		// the caret must not migrate into alpha's surviving content
		// (alpha@5 would type into the previous block).
		e2.deleteText('tail', 0, 5);
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: 'tail', offset: 0 });
	});
});

describe('history independence — direct vs split construction', () => {
	// Equivalent VISIBLE structures reached through different histories
	// must behave equivalently under sequential edits: `alpha`/`Hello`
	// built as two direct siblings versus one paragraph split at the
	// seam. Identity is matched by an explicit mapping (bootstrap ↔
	// bootstrap, tail ↔ d2) — not by CRDT internals.
	it('a seam caret behaves identically whether its block was split or built directly', () => {
		const direct = seeded();
		direct.ed.insertBlock({ parent: null, index: 1 }, { id: 'd2', type: 'paragraph' });
		direct.ed.insertText(DEFAULT_SEED_ID, 0, 'alpha');
		direct.ed.insertText('d2', 0, 'Hello');

		const split = seeded();
		split.ed.insertText(DEFAULT_SEED_ID, 0, 'alphaHello');
		split.ed.splitBlock(DEFAULT_SEED_ID, 5, 'tail');

		const map: Record<string, string> = { tail: 'd2' };
		// Same intent, different encodings: the direct doc's block starts
		// its OWN backing (plain left anchor); the split doc's stream
		// starts mid-backing (-2 facet anchor carrying `o`).
		const directCaret = direct.ed.anchorAt('d2', 0, 'left');
		const splitCaret = split.ed.anchorAt('tail', 0, 'left');
		expect(directCaret?.a.a).toBe(-1);
		expect(splitCaret?.a.a).toBe(-2);

		// Sequential edit — append into the predecessor's end on both.
		direct.ed.insertText(DEFAULT_SEED_ID, 5, 'X');
		split.ed.insertText(DEFAULT_SEED_ID, 5, 'X');
		const dPos = direct.ed.resolveAnchor(directCaret)!;
		const sPos = split.ed.resolveAnchor(splitCaret)!;
		expect(map[sPos.blockId]).toBe(dPos.blockId);
		expect(sPos.offset).toBe(dPos.offset);

		// Follow-up input lands at the same semantic destination.
		direct.ed.insertText(dPos.blockId, dPos.offset, 'Z');
		split.ed.insertText(sPos.blockId, sPos.offset, 'Z');
		expect(textOf(direct.ed, 'd2')).toBe('ZHello');
		expect(textOf(split.ed, 'tail')).toBe(textOf(direct.ed, 'd2'));
		expect(textOf(split.ed, DEFAULT_SEED_ID)).toBe(textOf(direct.ed, DEFAULT_SEED_ID));
	});
});
