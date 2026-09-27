/**
 * arch-v2 — checkpoint V1 rows: the selection value and its projection
 * (R4, R9, L4, §2.4 "Selection projection", §4.3 `session/selection`).
 *
 * - The value is none | text (anchor, focus: `DocAnchor`s, optional pending
 *   marks) | atom (block id, atom id) | blocks (ids); it is JSON (E6).
 * - `project(value, doc)` yields endpoints as (block, display offset) in
 *   document order, direction, collapsed, covered blocks and segments, edge
 *   flags, island/void root, and lazily the marks at the caret and the
 *   selected string; memoized per (value, index version).
 * - Anchors survive edits: a remote insert before the caret shifts it; an
 *   insert exactly at a caret lands after it; a range start (bound right)
 *   and end (bound left) keep boundary inserts outside (anchor contract
 *   rules 2 and 5). One dead endpoint collapses the range to the survivor.
 * - Every writer commits a value (`selection.value`, the V1 shadow until
 *   V2) and the state is its projection.
 *
 * Expected values come from the plan and the anchor contract, never from
 * running the code.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';

import * as selection from '$lib/session/selection.js';

const S = () => selection;

/** Red on the reference; green since V1. */
const row = test;

const E = bindEdytorDoc(Y);
const ROLES = { box: { island: true }, figure: { void: true } };
const REMOTE = { remote: true };

const t = (text: string, marks?: Record<string, unknown>) => ({
	kind: 'text',
	text,
	...(marks ? { marks } : {})
});
const at = (id: string) => ({ kind: 'inline', id, type: 'mention', data: {} });
const p = (id: string, ...content) => ({ id, type: 'paragraph', content });

const seedOf = (content) => {
	const doc = new Y.Doc();
	doc.clientID = 1;
	E.create(doc).init({ content });
	return Y.encodeStateAsUpdate(doc);
};
const replica = (seed: Uint8Array, clientID: number) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, seed, REMOTE);
	return { doc, ed: E.create(doc, { roleOf: (type: string) => ROLES[type] }) };
};
const one = (content) => replica(seedOf(content), 10).ed;
/** Run `fn` on `from` and deliver exactly its update to `to` (a remote apply). */
const remote = (from, to, fn: () => void) => {
	const before = Y.encodeStateVector(from.doc);
	fn();
	Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, before), REMOTE);
};

const DOC = () => [
	p('a', t('hello')),
	p('b', t('x'), t('bo', { bold: true }), t('ld'), at('m1'), t('tail')),
	{ id: 'box', type: 'box', content: [t('')], children: [p('in', t('inner'))] },
	{ id: 'fig', type: 'figure', content: [t('cap')] }
];

describe('V1 — SelectionValue', () => {
	row('the four kinds are values: frozen, JSON round-trip (E6)', () => {
		const { noSelection, textSelection, atomSelection, blockSelection } = S();
		const ed = one(DOC());
		const caret = ed.anchorAt('a', 2, 'left');
		const values = [
			noSelection,
			textSelection(caret),
			textSelection(ed.anchorAt('a', 1, 'right'), ed.anchorAt('b', 3, 'left'), { bold: true }),
			atomSelection('b', 'm1'),
			blockSelection(['a', 'b'])
		];
		expect(values.map((v) => v.kind)).toEqual(['none', 'text', 'text', 'atom', 'blocks']);
		expect(values[1]).toEqual({ kind: 'text', anchor: caret, focus: caret });
		expect(values[2].pending).toEqual({ bold: true });
		for (const v of values) {
			expect(Object.isFrozen(v)).toBe(true);
			expect(JSON.parse(JSON.stringify(v))).toEqual(v);
		}
	});
});

describe('V1 — project(value, version)', () => {
	row('a caret: (block, display offset), collapsed, edges, covered block and segment', () => {
		const { project, textSelection } = S();
		const ed = one(DOC());
		const v = project(textSelection(ed.anchorAt('b', 5, 'left')), ed);
		expect(v).toMatchObject({
			kind: 'text',
			start: { block: 'b', offset: 5 },
			end: { block: 'b', offset: 5 },
			isCollapsed: true,
			isReversed: false,
			blocks: ['b'],
			isAtStartOfText: false,
			// display offset 5 is the end of the first text segment `xbold` (the atom starts there)
			isAtEndOfText: true,
			isAtStartOfBlock: false,
			isAtEndOfBlock: false,
			isTextSpanning: false,
			isBlockSpanning: false,
			islandRoot: null,
			voidRoot: null
		});
		expect(v.segments.map((s) => [s.block, s.kind, s.segOrd ?? s.id])).toEqual([['b', 'text', 0]]);
		expect(v.content).toBe('');
		// the character before the caret is `d` (no marks)
		expect(v.marks).toEqual({});
	});

	row('marks at the caret: the character before it; offset 0 reads the first run', () => {
		const { project, textSelection } = S();
		const ed = one(DOC());
		expect(project(textSelection(ed.anchorAt('b', 3, 'left')), ed).marks).toEqual({ bold: true });
		expect(project(textSelection(ed.anchorAt('b', 1, 'left')), ed).marks).toEqual({});
		const bold = one([p('z', t('ab', { bold: true }), t('c'))]);
		expect(project(textSelection(bold.anchorAt('z', 0, 'left')), bold).marks).toEqual({
			bold: true
		});
	});

	row('a reversed cross-block range: document order, direction, segments, lazy content', () => {
		const { project, textSelection } = S();
		const ed = one(DOC());
		// anchor at b@8 (`xbold` 0-5, the atom 5-6, `tail` from 6: after `ta`), focus at a@1
		const v = project(textSelection(ed.anchorAt('b', 8, 'left'), ed.anchorAt('a', 1, 'right')), ed);
		expect(v).toMatchObject({
			start: { block: 'a', offset: 1 },
			end: { block: 'b', offset: 8 },
			isCollapsed: false,
			isReversed: true,
			blocks: ['a', 'b'],
			isTextSpanning: true,
			isBlockSpanning: true,
			isAtStartOfBlock: false,
			isAtEndOfBlock: false
		});
		expect(v.segments.map((s) => [s.block, s.kind, s.segOrd ?? s.id])).toEqual([
			['a', 'text', 0],
			['b', 'text', 0],
			['b', 'inline', 'm1'],
			['b', 'text', 1]
		]);
		// text only: the atom contributes nothing
		expect(v.content).toBe('ello' + 'xbold' + 'ta');
		// marks over the start edge: `ello` has none
		expect(v.marks).toEqual({});
		for (const lazy of ['marks', 'content']) {
			expect(typeof Object.getOwnPropertyDescriptor(v, lazy)?.get).toBe('function');
		}
	});

	row('island and void roots come from the start block ancestry', () => {
		const { project, textSelection } = S();
		const ed = one(DOC());
		expect(project(textSelection(ed.anchorAt('in', 2, 'left')), ed)).toMatchObject({
			islandRoot: 'box',
			voidRoot: null
		});
		expect(project(textSelection(ed.anchorAt('fig', 0, 'left')), ed)).toMatchObject({
			islandRoot: null,
			voidRoot: 'fig'
		});
	});

	row('a block set: document order, whole-block endpoints, never collapsed, no marks', () => {
		const { project, blockSelection } = S();
		const ed = one(DOC());
		const v = project(blockSelection(['b', 'a']), ed);
		expect(v).toMatchObject({
			kind: 'blocks',
			start: { block: 'a', offset: 0 },
			end: { block: 'b', offset: 10 },
			isCollapsed: false,
			isReversed: false,
			blocks: ['a', 'b'],
			isAtStartOfBlock: true,
			isAtEndOfBlock: true
		});
		expect(v.marks).toEqual({});
		expect(project(blockSelection(['a']), one([p('a', t(''))]))).toMatchObject({
			isCollapsed: false,
			start: { block: 'a', offset: 0 },
			end: { block: 'a', offset: 0 }
		});
	});

	row('an inline atom: its display cell', () => {
		const { project, atomSelection } = S();
		const ed = one(DOC());
		const v = project(atomSelection('b', 'm1'), ed);
		expect(v).toMatchObject({
			kind: 'atom',
			start: { block: 'b', offset: 5 },
			end: { block: 'b', offset: 6 },
			isCollapsed: false,
			blocks: ['b']
		});
		expect(v.segments.map((s) => s.id)).toEqual(['m1']);
	});

	row('memoized per (value, version): same object until the document changes', () => {
		const { project, textSelection } = S();
		const ed = one(DOC());
		const value = textSelection(ed.anchorAt('a', 2, 'left'));
		const first = project(value, ed);
		expect(project(value, ed)).toBe(first);
		ed.insertText('a', 0, 'Q');
		const second = project(value, ed);
		expect(second).not.toBe(first);
		expect(second.start).toEqual({ block: 'a', offset: 3 });
	});
});

describe('V1 — anchors survive remote edits (R4)', () => {
	const peers = () => {
		const seed = seedOf([p('a', t('hello world')), p('b', t('bb'))]);
		return [replica(seed, 20), replica(seed, 30)];
	};

	row('a remote insert before the caret shifts it', () => {
		const { project, textSelection } = S();
		const [A, B] = peers();
		const caret = textSelection(A.ed.anchorAt('a', 5, 'left'));
		remote(B, A, () => B.ed.insertText('a', 0, 'XX'));
		expect(project(caret, A.ed).start).toEqual({ block: 'a', offset: 7 });
	});

	row('a remote inline atom before the caret counts one', () => {
		const { project, textSelection } = S();
		const [A, B] = peers();
		const caret = textSelection(A.ed.anchorAt('a', 11, 'left'));
		remote(B, A, () => B.ed.insertInline('a', 3, { id: 'm9', type: 'mention', data: {} }));
		expect(project(caret, A.ed).start).toEqual({ block: 'a', offset: 12 });
	});

	row('a remote insert exactly at a caret lands after it', () => {
		const { project, textSelection } = S();
		const [A, B] = peers();
		const caret = textSelection(A.ed.anchorAt('a', 5, 'left'));
		remote(B, A, () => B.ed.insertText('a', 5, 'ZZ'));
		expect(project(caret, A.ed)).toMatchObject({
			start: { block: 'a', offset: 5 },
			isCollapsed: true
		});
	});

	row('range boundaries keep remote boundary inserts outside', () => {
		const { project, textSelection } = S();
		const [A, B] = peers();
		// `lo wo` = [3, 8): start bound right, end bound left
		const range = textSelection(A.ed.anchorAt('a', 3, 'right'), A.ed.anchorAt('a', 8, 'left'));
		remote(B, A, () => {
			B.ed.insertText('a', 8, '>');
			B.ed.insertText('a', 3, '<');
		});
		const v = project(range, A.ed);
		expect([v.start, v.end]).toEqual([
			{ block: 'a', offset: 4 },
			{ block: 'a', offset: 9 }
		]);
		expect(v.content).toBe('lo wo');
	});

	row('one dead endpoint collapses the range to the survivor (contract rule 5)', () => {
		const { project, textSelection } = S();
		const [A, B] = peers();
		const range = textSelection(A.ed.anchorAt('a', 2, 'right'), A.ed.anchorAt('b', 1, 'left'));
		remote(B, A, () => B.ed.deleteBlock('b'));
		expect(project(range, A.ed)).toMatchObject({
			start: { block: 'a', offset: 2 },
			end: { block: 'a', offset: 2 },
			isCollapsed: true
		});
	});
});

describe('V1/V2 — every writer commits a value; the state is its projection', () => {
	const view = () => {
		const document = createDocument({
			value: { children: [p('a', t('hello')), p('b', t('x'), at('m1'), t('yz'))] }
		});
		return new Edytor({ document, plugins: [richTextPlugin, mentionPlugin] });
	};
	const text = (edytor, id: string) => edytor.idToBlock.get(id).firstText;

	row('every writer leaves the value of what it wrote', () => {
		const { textSelection, blockSelection, atomSelection, noSelection } = S();
		const edytor = view();
		const sel = edytor.selection;
		expect(sel.value).toEqual(noSelection);

		sel.setCollapsedStateAtTextOffset(text(edytor, 'a'), 3);
		const caret = edytor.facade.anchorAt('a', 3, 'left');
		expect(sel.value).toEqual(textSelection(caret));

		sel.setRangeStateAtTextOffsets(text(edytor, 'a'), 1, edytor.idToBlock.get('b').lastText, 1, {
			isReversed: true
		});
		// reversed: the anchor is the end (bound left), the focus the start (bound right)
		expect(sel.value).toEqual(
			textSelection(edytor.facade.anchorAt('b', 3, 'left'), edytor.facade.anchorAt('a', 1, 'right'))
		);

		sel.selectBlocks(edytor.idToBlock.get('b'));
		expect(sel.value).toEqual(blockSelection(['b']));

		sel.selectInlineBlock(edytor.idToBlock.get('b').content[1]);
		expect(sel.value).toEqual(atomSelection('b', 'm1'));
	});

	row('the state is the projection of the value on the shared fields', () => {
		const { project } = S();
		const edytor = view();
		const sel = edytor.selection;
		sel.setRangeStateAtTextOffsets(text(edytor, 'a'), 1, edytor.idToBlock.get('b').lastText, 1);
		const v = project(sel.value, edytor.facade);
		const s = sel.state;
		expect(v.start).toEqual({ block: 'a', offset: s.startText.segStart + s.yStart });
		expect(v.end).toEqual({ block: 'b', offset: s.endText.segStart + s.yEnd });
		expect([v.isCollapsed, v.isReversed, v.blocks, v.content, v.marks]).toEqual([
			s.isCollapsed,
			s.isReversed,
			s.blocks.map((b) => b.id),
			s.content,
			s.currentMarks
		]);
	});
});
