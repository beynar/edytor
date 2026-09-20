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
import { bindEdytorDoc, BOOTSTRAP_BLOCK_ID } from '../../../lib/crdt/index.js';

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
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left');
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'XX');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 4 });
	});

	it('left affinity does not absorb an insert at the position; right affinity does', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		const left = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left');
		const right = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'right');
		ed.insertText(BOOTSTRAP_BLOCK_ID, 2, 'Z'); // → 'heZllo'
		// caret semantics: stays before the inserted 'Z' (offset 2).
		expect(ed.resolveAnchor(left)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
		// range-start semantics: glued to 'l' — the insert lands outside.
		expect(ed.resolveAnchor(right)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 3 });
	});

	it('a caret at offset 0 stays at 0 across prepends (live-start sentinel)', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'ab');
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 0, 'left');
		expect(caret).toEqual({ b: BOOTSTRAP_BLOCK_ID, a: { i: null, a: -1 } });
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'Q');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 0 });
	});

	it('a caret at end bound left does not follow appends', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'ab');
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left');
		ed.insertText(BOOTSTRAP_BLOCK_ID, 2, 'Z');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
	});

	it('an empty display anchors to the block own backing text at index 0', () => {
		const { ed } = seeded();
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 0, 'left');
		expect(caret).toEqual({ b: BOOTSTRAP_BLOCK_ID, a: { i: null, a: -1 } });
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 0 });
		// Typed content lands where the empty anchor pointed.
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'x');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 0 });
	});

	it('anchors survive JSON round-trip — the awareness wire shape', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		const anchor = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 3, 'left');
		const revived = JSON.parse(JSON.stringify(anchor));
		expect(ed.resolveAnchor(revived)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 3 });
	});
});

describe('anchor resolution through structure', () => {
	it('split: an anchor follows its atoms into the new sibling', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'abcdef');
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 4, 'left'); // binds 'd'
		ed.splitBlock(BOOTSTRAP_BLOCK_ID, 3, 'b2');
		expect(textOf(ed, BOOTSTRAP_BLOCK_ID)).toBe('abc');
		expect(textOf(ed, 'b2')).toBe('def');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: 'b2', offset: 1 });
	});

	it('merge: an anchor follows its atoms into the claiming block', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'abc');
		ed.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		ed.insertText('b2', 0, 'def');
		const caret = ed.anchorAt('b2', 1, 'left'); // binds 'd' in b2's backing
		expect(caret?.b).toBe('b2');
		expect(ed.mergeBackward('b2')).toBe(BOOTSTRAP_BLOCK_ID);
		expect(textOf(ed, BOOTSTRAP_BLOCK_ID)).toBe('abcdef');
		// 'd' now displays at index 3 of the merged block — resolves after it.
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 4 });
	});

	it('move: an anchor on a moved block keeps resolving inside it', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'abc');
		ed.insertBlock({ parent: null, index: 1 }, { id: 'wrap', type: 'paragraph' });
		ed.insertBlock({ parent: null, index: 2 }, { id: 'b3', type: 'paragraph' });
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 1, 'left');
		ed.nestBlock(BOOTSTRAP_BLOCK_ID, 'wrap');
		expect(ed.parentOf(BOOTSTRAP_BLOCK_ID)).toBe('wrap');
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 1 });
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
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 3, 'left'); // binds second 'l'
		ed.deleteText(BOOTSTRAP_BLOCK_ID, 1, 3); // → 'ho'
		// 'l' atoms are tombstones; the gap between 'h' and 'o' is index 1.
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 1 });
	});

	it('a deleted atom keeps its gap when a surviving neighbor moves', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		ed.splitBlock(BOOTSTRAP_BLOCK_ID, 2, 'b2'); // 'he' | 'llo'
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 1, 'left'); // binds 'e' in b1
		// Delete 'e' locally, then merge — gap resolves inside the claiming block.
		ed.deleteText(BOOTSTRAP_BLOCK_ID, 1, 1); // 'h' | 'llo'
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 1 });
	});

	it('inline atom boundary: right-affinity anchors ride the atom through edits', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'ab');
		ed.insertInline(BOOTSTRAP_BLOCK_ID, 2, { id: 'm1', type: 'mention' });
		expect(ed.displayLength(BOOTSTRAP_BLOCK_ID)).toBe(3);
		const beforeAtom = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'right'); // binds the atom
		const afterB = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left'); // binds 'b'
		ed.insertText(BOOTSTRAP_BLOCK_ID, 2, 'X'); // 'abX[atom]'
		expect(ed.resolveAnchor(beforeAtom)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 3 });
		expect(ed.resolveAnchor(afterB)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
	});

	it('removed inline atom → its anchor resolves to the gap where it lived', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'ab');
		ed.insertInline(BOOTSTRAP_BLOCK_ID, 2, { id: 'm1', type: 'mention' });
		const onAtom = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'right'); // binds the atom
		ed.removeInline(BOOTSTRAP_BLOCK_ID, 'm1');
		expect(ed.resolveAnchor(onAtom)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
	});

	it('unicode: anchors bind across surrogate pairs in UTF-16 offsets', () => {
		const { ed } = seeded();
		ed.insertText(BOOTSTRAP_BLOCK_ID, 0, 'a\u{1F600}b'); // length 4
		const caret = ed.anchorAt(BOOTSTRAP_BLOCK_ID, 4, 'left'); // binds 'b'
		ed.deleteText(BOOTSTRAP_BLOCK_ID, 1, 2); // remove the emoji → 'ab'
		expect(ed.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
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
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		push(d1, d2);
		const caret = e1.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'XX');
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 4 });
	});

	it('a remote insert AT the caret respects affinity', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		push(d1, d2);
		const left = e1.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'left');
		const right = e1.anchorAt(BOOTSTRAP_BLOCK_ID, 2, 'right');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 2, 'Z');
		push(d2, d1);
		expect(e1.resolveAnchor(left)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 2 });
		expect(e1.resolveAnchor(right)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 3 });
	});

	it('an anchor bound before a remote merge follows its atoms into the merge', () => {
		const { d1, d2, e1, e2, push } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'abc');
		e1.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		e1.insertText('b2', 0, 'def');
		push(d1, d2);
		const caret = e1.anchorAt('b2', 1, 'left');
		e2.mergeBackward('b2');
		push(d2, d1);
		expect(e1.resolveAnchor(caret)).toEqual({ blockId: BOOTSTRAP_BLOCK_ID, offset: 4 });
	});
});
