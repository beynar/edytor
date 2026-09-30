/**
 * Re-score 11 (EW-05, EW-11, DW-05): what the text-order promise covers.
 * The client-id sweeps (`cw01-order-sweep`, `dr-crdt-order`, the rescore7
 * and wave10 rows on `clientPairs`) prove it for one structural gesture per
 * peer between syncs — a split, a paste of lines into a line, a lift, an
 * outdent, a Turn into, a merge that unnests children — with text typed
 * before the split point (typing after one's own split point before it
 * syncs is the split residual, pinned last). They do not cover a new line
 * inserted beside a block (Enter at a block's start or end, Duplicate, the +
 * button: `insertBlock` ranks it at random in the gap), a paste of whole
 * blocks or over selected blocks (`insertFlow`'s `whole` and `replace`:
 * `insertBlocks` too, DR-crdt-1), several structural gestures by one peer before it syncs, or
 * a move (a drag, the handle's Alt+arrows, Mod+Shift+↑/↓, the block menu's
 * Move up/down, Tab). The rows below pin one outcome set each, so the
 * docs that list these as not covered change with the code. Expected sets
 * are hand-authored: the serial order, and the one the ids can give.
 *
 * DW-05: one client never mints the same source rank twice in one gap.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { clientPairs, converge, quiesce, replica, seedUpdate } from './p1-harness.js';
import { para, semantics } from './cw01-sweep.js';

type Step = (ed) => { status: string } | undefined;
const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** Each converged outcome of Ada's `ada` steps ‖ Bob's `bob` steps: the blocks' texts, `|`-joined. */
const outcomes = (seed, ada: Step[], bob: Step[], n = 48): string[] => {
	const out = new Set<string>();
	for (const o of converge(
		seed,
		2,
		([a, b]) => {
			for (const s of ada) ok(s(a.ed));
			for (const s of bob) ok(s(b.ed));
		},
		{ semantics, assignments: clientPairs(n) }
	)) {
		expect(o.problems).toEqual([]);
		expect(o.results.size).toBe(1);
		out.add(
			o.ed
				.order()
				.filter((id) => o.ed.blockTypeOf(id) !== 'unordered-list')
				.map((id) => o.ed.blockText(id))
				.join('|')
		);
		for (const r of o.reps) r.destroy();
	}
	return [...out].sort();
};

/** The editor's Enter at the end of `id` (a new line after it), then typing `text` there. */
const enterEnd = (id: string, nid: string, text: string): Step[] => [
	(ed) => {
		const { parent, index } = ed.positionOf(id);
		return ed.insertBlock({ parent, index: index + 1 }, { id: nid, type: 'paragraph' });
	},
	(ed) => ed.insertText(nid, 0, text)
];
const split =
	(id: string, at: number, nid: string): Step =>
	(ed) =>
		ed.splitBlock(id, at, nid);
const item = (id: string) => ({ id, type: 'list-item', text: id });
const list = (...ids: string[]) => ({
	id: 'U',
	type: 'unordered-list',
	text: '',
	children: ids.map(item)
});
const X = [para('P'), { id: 'X', text: 'hello world' }, para('Q')];

describe('not covered: the text order can follow the client ids (pinned)', () => {
	it('Enter at the end of X and typing ‖ Enter in the middle of X', () =>
		expect(outcomes(X, enterEnd('X', 'N', 'foo'), [split('X', 5, 'M')])).toEqual(
			['P|hello| world|foo|Q', 'P|hello|foo| world|Q'].sort()
		));

	it('Enter at the end of a paragraph ‖ Backspace at the start of the first item below it', () =>
		expect(
			outcomes([para('p'), list('a', 'b')], enterEnd('p', 'N', 'n'), [
				(ed) => ed.mergeBackward('a')
			])
		).toEqual(['p|n|a|b', 'p|a|n|b'].sort()));

	it('two Enters by one peer before it syncs ‖ Backspace at the start of the first item below', () =>
		expect(
			outcomes(
				[{ id: 'X', text: 'hello world' }, list('a', 'b')],
				[split('X', 5, 'N1'), split('N1', 3, 'N2')],
				[(ed) => ed.mergeBackward('a')]
			)
			// The serial order reads hello| wo|rld|a|b.
		).toEqual(['hello| wo|a|rld|b']));

	it('Duplicate X, then Enter in X ‖ Enter earlier in X', () =>
		expect(
			outcomes(
				X,
				[(ed) => ed.duplicateBlock('X', (id) => `${id}2`), split('X', 5, 'N1')],
				[split('X', 2, 'N2')]
			)
			// The serial order reads he|llo| world|hello world: " world" always
			// comes too early, and the copy lands at random beside "llo".
		).toEqual(['P|he| world|hello world|llo|Q', 'P|he| world|llo|hello world|Q']));

	/**
	 * Enter inside the header of a container that shows nested lines (an open
	 * toggle, a callout or quote with children): the text after the caret
	 * becomes the first nested line (`prepareSplitKeepingChildren`), ranked
	 * as a plain first child, not by where it splits.
	 */
	const headerEnter =
		(at: number, nid: string): Step =>
		(ed) => {
			const split = ed.prepare.splitBlock('C', at, nid);
			const slot = ed.prepare.insertBlocks({ parent: 'C', index: 0 }, [
				{ id: nid, type: 'paragraph' }
			]);
			const step = { ...split.writes[0], parent: 'C', rank: slot.writes[0].ranks[0] };
			return ed.apply(ed.compose({ ...split, writes: [step] }));
		};
	it('two Enters inside a container header that shows nested lines', () =>
		expect(
			outcomes(
				[{ id: 'C', type: 'callout', text: 'hello world', children: [para('k')] }],
				[headerEnter(5, 'N1')],
				[headerEnter(2, 'N2')]
			)
		).toEqual(['he|llo| world|k', 'he| world|llo|k'].sort()));

	/**
	 * DR-crdt-1: a paste of whole blocks (a block-selection copy) lands after
	 * the caret's block, and a paste or typing over selected blocks takes the
	 * first one's slot, both ranked at random there (`insertBlocks`): a
	 * peer's split of the block before them sorts among them by client id.
	 * Ranking them by source kept the order but grew ranks 5 to 7 times as
	 * fast as plain ones under repeated pastes in one place (the EW-02
	 * guard's concern), so they stay not covered.
	 */
	const lines = (...ids: string[]) =>
		ids.map((id) => ({ id, type: 'paragraph', content: [{ kind: 'text', text: id }] }));
	const S = [para('P'), { id: 'X', text: 'hello world' }, para('S'), para('Q')];
	it('a paste of whole blocks with the caret in X ‖ Enter earlier in X', () =>
		expect(
			outcomes(
				S,
				[
					(ed) =>
						ed.insertFlow({ block: 'X', offset: 8 }, { lines: lines('W1', 'W2'), whole: true })
				],
				[split('X', 5, 'N')]
			)
			// The serial order reads hello| world|W1|W2.
		).toEqual(
			['P|hello| world|W1|W2|S|Q', 'P|hello|W1| world|W2|S|Q', 'P|hello|W1|W2| world|S|Q'].sort()
		));
	it('a paste over the selected block S ‖ Enter in X', () =>
		expect(
			outcomes(
				S,
				[(ed) => ed.insertFlow({ replace: ['S'] }, { lines: lines('W1', 'W2') })],
				[split('X', 5, 'N')]
			)
			// The serial order reads hello| world|W1|W2.
		).toEqual(
			['P|hello| world|W1|W2|Q', 'P|hello|W1| world|W2|Q', 'P|hello|W1|W2| world|Q'].sort()
		));
	it('typing over the selected block S ‖ Enter in X', () =>
		expect(
			outcomes(
				S,
				[
					(ed) => ed.insertFlow({ replace: ['S'] }, { lines: [{ id: 'T', type: 'paragraph' }] }),
					(ed) => ed.insertText('T', 0, 'typed')
				],
				[split('X', 5, 'N')]
			)
			// The serial order reads hello| world|typed.
		).toEqual(['P|hello| world|typed|Q', 'P|hello|typed| world|Q'].sort()));

	it('Tab on y ‖ Enter at the end of the last child of the block above', () =>
		expect(
			outcomes(
				[para('x', [para('k')]), para('y')],
				[(ed) => ed.nestBlock('y', 'x')],
				enterEnd('k', 'N', 'n')
			)
		).toEqual(['x|k|n|y', 'x|k|y|n'].sort()));
});

/**
 * DW-05: Ada splits X at its end and types; Bob deletes that line; Ada
 * splits X again at the same distance from the end and types; Bob undoes.
 * Both lines are back and never share a rank (tied by Ada's clock), and
 * Ada's next Enter in the first lands right after it, on every assignment.
 */
describe('DW-05: one client never mints one source rank twice in a gap', () => {
	const ids = [
		['b_m1', 'b_z2', 'b_a3'],
		['b_z1', 'b_a2', 'b_m3'],
		['b_a1', 'b_m2', 'b_z3']
	];
	for (const [one, two, three] of ids)
		it(`split, delete, re-split, undo, Enter (${one}, ${two}, ${three})`, () => {
			for (const [ida, idb] of clientPairs(24)) {
				const seed = seedUpdate([para('P'), { id: 'X', text: 'hello' }, para('Q')]);
				const a = replica('ada', seed, ida);
				const b = replica('bob', seed, idb);
				ok(a.ed.splitBlock('X', 5, one));
				ok(a.ed.insertText(one, 0, 'one'));
				quiesce([a, b]);
				ok(b.ed.deleteBlocks([one]));
				quiesce([a, b]);
				ok(a.ed.splitBlock('X', 5, two));
				ok(a.ed.insertText(two, 0, 'two'));
				quiesce([a, b]);
				b.undo();
				quiesce([a, b]);
				expect(a.ed.slotOf(one).rank).not.toBe(a.ed.slotOf(two).rank);
				ok(a.ed.splitBlock(one, 3, three));
				ok(a.ed.insertText(three, 0, 'three'));
				quiesce([a, b]);
				for (const r of [a, b]) {
					const order = r.ed.order();
					expect(order.indexOf(three)).toBe(order.indexOf(one) + 1);
					expect(r.problems).toEqual([]);
				}
				expect(a.texts()).toEqual(b.texts());
				a.destroy();
				b.destroy();
			}
		});
});
