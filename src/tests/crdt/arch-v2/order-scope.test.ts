/**
 * Re-score 11 (EW-05, EW-11, DW-05): what the text-order promise covers.
 * The client-id sweeps (`cw01-order-sweep`, `dr-crdt-order`, the rescore7
 * and wave10 rows on `clientPairs`) prove it for one structural gesture per
 * peer between syncs — a split, a paste of lines into a line, a lift, an
 * outdent, a Turn into, a merge that unnests children — with text typed
 * before the split point (typing or deleting after one's own split point
 * before it syncs is the split residual, pinned in `dr-crdt-order`). They do not cover a new line
 * inserted beside a block (Enter at a block's start or end, Duplicate, the +
 * button: `insertBlock` ranks it at random in the gap), a paste of whole
 * blocks or over selected blocks (`insertFlow`'s `whole` and `replace`:
 * `insertBlocks` too, DR-crdt-1), several structural gestures by one peer before it syncs
 * (Turn into over several blocks is one plan per block, FX-05), or
 * a move (a drag, the handle's Alt+↑/↓/→ (Alt+← is the outdent, ranked), Mod+Shift+↑/↓, the block menu's
 * Move up/down, Tab). The rows below pin one outcome set each, so the
 * docs that list these as not covered change with the code. Expected sets
 * are hand-authored: the serial order, and the one the ids can give.
 *
 * DW-05: one client never mints the same source rank twice in one gap;
 * FX-06: what one gesture minted there never interleaves a later one's.
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
			// The serial order reads he|llo| world|hello world. Since D-18 the
			// pieces of X's text keep its order (" world" came too early before);
			// the copy, a block of its own, still lands at random beside " world".
		).toEqual(['P|he|llo| world|hello world|Q', 'P|he|llo|hello world| world|Q']));

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
			// D-18: the pieces keep the text's order on every pair (two outcomes before).
		).toEqual(['he|llo| world|k']));

	/**
	 * DR-crdt-1: a paste of whole blocks (a block-selection copy) lands after
	 * the caret's block, and a paste or typing over selected blocks takes the
	 * first one's slot, both ranked at random there (`insertBlocks`): a
	 * peer's split of the block before them sorts before or after them by
	 * client id, never among them (their lines are one run, `order.insert.run`).
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
			// The serial order reads hello| world|W1|W2. W2 extends W1's run
			// (`order.insert.run`): " world" never reads between them.
		).toEqual(['P|hello| world|W1|W2|S|Q', 'P|hello|W1|W2| world|S|Q'].sort()));
	it('a paste over the selected block S ‖ Enter in X', () =>
		expect(
			outcomes(
				S,
				[(ed) => ed.insertFlow({ replace: ['S'] }, { lines: lines('W1', 'W2') })],
				[split('X', 5, 'N')]
			)
			// The serial order reads hello| world|W1|W2 (W1|W2 one run, `order.insert.run`).
		).toEqual(['P|hello| world|W1|W2|Q', 'P|hello|W1|W2| world|Q'].sort()));
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

	/**
	 * HX-05: a paste at the start of a line whose first line stands apart
	 * (a list, a code block, a divider, an image: `flow.apart`) places its
	 * blocks before the line at a plain rank, as Enter at a line's start
	 * adds one (`insertBlockBefore`): a peer's split of the line above, or
	 * its paste at that line's end, sorts beside them by client id.
	 */
	const bulleted = (id: string, ...items: string[]) => ({
		id,
		type: 'unordered-list',
		children: items.map((t) => ({ id: t, type: 'list-item', content: [{ kind: 'text', text: t }] }))
	});
	const H = [{ id: 'P', text: 'hello world' }, { id: 'B', text: 'body text' }, para('Q')];
	it('a paste of [list, "x"] at the start of B ‖ Enter in the line above', () =>
		expect(
			outcomes(
				H,
				[
					(ed) =>
						ed.insertFlow(
							{ block: 'B', offset: 0 },
							{
								lines: [
									bulleted('L', 'one'),
									{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
								]
							}
						)
				],
				[split('P', 5, 'N')]
			)
			// The serial order reads hello| world|one|xbody text.
		).toEqual(['hello| world|one|xbody text|Q', 'hello|one| world|xbody text|Q'].sort()));
	it('a list pasted at the start of B ‖ a list pasted at the end of the line above', () =>
		expect(
			outcomes(
				H,
				[(ed) => ed.insertFlow({ block: 'B', offset: 0 }, { lines: [bulleted('L1', 'one')] })],
				[(ed) => ed.insertFlow({ block: 'P', offset: 11 }, { lines: [bulleted('L2', 'two')] })]
			)
			// The serial order reads hello world|two|one|body text.
		).toEqual(['hello world|one|two|body text|Q', 'hello world|two|one|body text|Q'].sort()));

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

/**
 * FX-06: Ada pastes ['', 'one', 'two'] at the end of X; Bob deletes the two
 * lines; Ada presses Enter at the end of X and types; Bob undoes. The
 * restored paste stays contiguous: Ada's later line sorts after both
 * pasted lines (her clock grew), never between them.
 */
describe('FX-06: a later split never interleaves a restored multi-line paste', () => {
	const line = (id: string, text: string) => ({ id, content: [{ kind: 'text', text }] });
	it('paste, delete its lines, Enter at the end and type, undo', () => {
		const out = new Set<string>();
		for (const [ida, idb] of clientPairs(24)) {
			const seed = seedUpdate([para('P'), { id: 'X', text: 'hello' }, para('Q')]);
			const a = replica('ada', seed, ida);
			const b = replica('bob', seed, idb);
			ok(
				a.ed.insertFlow(
					{ block: 'X', offset: 5 },
					{ lines: [line('L0', ''), line('L1', 'one'), line('L2', 'two')] }
				)
			);
			quiesce([a, b]);
			const pasted = a.ed.order().filter((id) => ['one', 'two'].includes(a.ed.blockText(id)));
			expect(pasted.length).toBe(2);
			ok(b.ed.deleteBlocks(pasted));
			quiesce([a, b]);
			ok(a.ed.splitBlock('X', 5, 'N'));
			ok(a.ed.insertText('N', 0, 'new'));
			quiesce([a, b]);
			b.undo();
			quiesce([a, b]);
			const text = (r) =>
				r.ed
					.order()
					.map((id) => r.ed.blockText(id))
					.join('|');
			expect(text(a)).toBe(text(b));
			for (const r of [a, b]) expect(r.problems).toEqual([]);
			out.add(text(a));
			a.destroy();
			b.destroy();
		}
		expect([...out]).toEqual(['P|hello|one|two|new|Q']);
	});
});

/**
 * FX-05: Turn into over several list items is one plan per item (the
 * editor's `convertBlocks`), so it is several gestures before a sync: Ada
 * turns `a` and `b` into headings ‖ Bob outdents `c` → `b` can read after
 * `c`. Shift+Tab over items with an unselected one between them is one
 * plan per group of adjacent items too (`moveRoots`, SW15-crdt-1). The
 * same two adjacent items outdented together (`unNestBlocks`, one plan)
 * keep the order. One `unNestBlocks` call over NON-adjacent siblings (a
 * headless call, or `edytor.moveBlocks` with `direction: 'out'`) does not
 * (DR-rest-2): its serial result moves the unselected item between them
 * first (`p|b|a|c…`), and a race can keep the old order instead.
 */
describe('FX-05, SW15-crdt-1: a command over several groups is several gestures (pinned)', () => {
	const heading = (id: string) => (ed) =>
		ed.apply(ed.compose(ed.prepare.liftOut(id, 'heading'), ed.prepare.setBlockType(id, 'heading')));
	const seed = [para('p'), list('a', 'b', 'c', 'd', 'e'), para('q')];
	it('Turn a and b into headings ‖ Shift+Tab on c', () =>
		expect(outcomes(seed, [heading('a'), heading('b')], [(ed) => ed.unNestBlock('c')])).toEqual(
			['p|a|b|c|d|e|q', 'p|a|c|b|d|e|q'].sort()
		));
	it('Shift+Tab on a and c, b unselected (two groups, one plan each) ‖ Shift+Tab on d', () =>
		expect(
			outcomes(
				seed,
				[(ed) => ed.unNestBlocks(['a']), (ed) => ed.unNestBlocks(['c'])],
				[(ed) => ed.unNestBlock('d')]
			)
		).toEqual(['p|a|b|c|d|e|q', 'p|a|d|b|c|e|q'].sort()));
	it('Shift+Tab on a and b together ‖ Shift+Tab on c: the order holds', () =>
		expect(
			outcomes(seed, [(ed) => ed.unNestBlocks(['a', 'b'])], [(ed) => ed.unNestBlock('c')])
		).toEqual(['p|a|b|c|d|e|q']));
	it('unNestBlocks over non-adjacent a and c ‖ Shift+Tab on d: not a serial order (pinned)', () =>
		expect(
			outcomes(seed, [(ed) => ed.unNestBlocks(['a', 'c'])], [(ed) => ed.unNestBlock('d')])
		).toEqual(['p|a|b|c|d|e|q', 'p|b|a|c|d|e|q']));
	it('unNestBlocks over non-adjacent b and d ‖ Shift+Tab on c: not a serial order (pinned)', () =>
		expect(
			outcomes(seed, [(ed) => ed.unNestBlocks(['b', 'd'])], [(ed) => ed.unNestBlock('c')])
		).toEqual(['p|a|b|c|d|e|q', 'p|a|c|b|d|e|q']));
});
