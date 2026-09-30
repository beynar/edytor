/**
 * Follow-up review of CW-01 (DR-crdt-6, DR-crdt-7). Blocks ranked by where
 * they came from share one gap between two blocks `X` and `Y` with blocks
 * from other sources: the pieces a split of `X` creates, the blocks
 * leaving `X` for the gap right after it (its children, a list's last
 * items), and the blocks leaving `Y` for the gap right before it (a list's
 * first items). Every serial order puts them in that order; ranks built
 * from the same base and compared across sources (a split's offset against
 * an item's rank) put a lifted item between a paragraph's pieces on EVERY
 * client-id pair. And a split's pieces are ranked by where it splits,
 * counted so that a peer's own edit before its split point (typing, then
 * Enter) does not move it. Expected values are hand-authored: the text as
 * any serial order of the gestures gives it.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { clientPairs, converge } from './p1-harness.js';
import {
	ALL,
	insertedAbove,
	LIFTS,
	matrix,
	semantics,
	type Gesture,
	type Residual
} from './cw01-sweep.js';

/** Each converged outcome of `a ‖ b` on `seed`: the blocks' texts in document order. */
const texts = (seed, a: (ed) => { status: string }, b: (ed) => { status: string }, n = 48) => {
	const out = new Set<string>();
	for (const o of converge(
		seed,
		2,
		([x, y]) => {
			expect(a(x.ed).status).toBe('applied');
			expect(b(y.ed).status).toBe('applied');
		},
		{ semantics, assignments: clientPairs(n) }
	)) {
		expect(o.problems).toEqual([]);
		expect(o.results.size).toBe(1);
		out.add(JSON.stringify(o.ed.order().map((id) => o.ed.blockText(id))));
		for (const r of o.reps) r.destroy();
	}
	return [...out].map((t) => JSON.parse(t));
};

const heading = (id: string) => (ed) =>
	ed.apply(ed.compose(ed.prepare.liftOut(id, 'heading'), ed.prepare.setBlockType(id, 'heading')));

describe('DR-crdt-6: a split, an outdent and a lift into one gap keep the text order', () => {
	const above = [
		{ id: 'P', text: 'hello world' },
		{
			id: 'U',
			type: 'unordered-list',
			text: '',
			children: [
				{ id: 'a', type: 'list-item', text: 'A' },
				{ id: 'b', type: 'list-item', text: 'B' }
			]
		}
	];
	it('Enter mid-paragraph ‖ Backspace at the start of the first item below it', () =>
		expect(
			texts(
				above,
				(ed) => ed.splitBlock('P', 5, 'N'),
				(ed) => ed.mergeBackward('a')
			)
		).toEqual([['hello', ' world', 'A', '', 'B']]));

	it('Enter mid-paragraph ‖ Turn the first item below it into a heading', () =>
		expect(texts(above, (ed) => ed.splitBlock('P', 5, 'N'), heading('a'))).toEqual([
			['hello', ' world', 'A', '', 'B']
		]));

	it('a paste of lines mid-paragraph ‖ Backspace at the start of the first item below it', () =>
		expect(
			texts(
				above,
				(ed) =>
					ed.insertFlow(
						{ block: 'P', offset: 5 },
						{
							lines: [
								{ id: 'L1', content: [{ kind: 'text', text: '<' }] },
								{ id: 'L2', content: [{ kind: 'text', text: '>' }] }
							]
						}
					),
				(ed) => ed.mergeBackward('a')
			)
		).toEqual([['hello<', '> world', 'A', '', 'B']]));

	for (const parent of ['paragraph', 'list-item'])
		it(`Enter mid-${parent} ‖ Shift+Tab on its child`, () => {
			const seed = [
				{
					id: 'X',
					type: parent,
					text: 'hello world',
					children: [{ id: 'c', type: parent, text: 'C' }]
				},
				{ id: 'Q', text: 'Q' }
			];
			const doc =
				parent === 'paragraph'
					? seed
					: [{ id: 'U', type: 'unordered-list', text: '', children: [seed[0]] }, seed[1]];
			expect(
				texts(
					doc,
					(ed) => ed.splitBlock('X', 5, 'N'),
					(ed) => ed.unNestBlock('c')
				)
			).toEqual([[...(parent === 'paragraph' ? [] : ['']), 'hello', ' world', 'C', 'Q']]);
		});

	it('Shift+Tab on a paragraph’s child ‖ Backspace at the start of the first item after it', () =>
		expect(
			texts(
				[
					{ id: 'P', text: 'P', children: [{ id: 'c', text: 'C' }] },
					{
						id: 'U',
						type: 'unordered-list',
						text: '',
						children: [
							{ id: 'a', type: 'list-item', text: 'A' },
							{ id: 'b', type: 'list-item', text: 'B' }
						]
					}
				],
				(ed) => ed.unNestBlock('c'),
				(ed) => ed.mergeBackward('a')
			)
		).toEqual([['P', 'C', 'A', '', 'B']]));
});

const ORDER = ['P', 'c', 'a', 'b', 'd', 'Q'];
const splits = (g: Gesture) => g === 'enter' || g === 'paste';

/**
 * The two residuals splits add, pinned below (`docs/editor-delete-contract.md`):
 * - R3, a new block stays behind: the block a split creates right after
 *   `s` (Enter, a paste) stays where it was made — beside `s` in `s`'s
 *   parent — while the other peer moves `s` out of that parent (an outdent
 *   or a lift of `s`, a split of its list at a later item that takes `s`
 *   into a new head list, or a split of `s`'s parent that takes `s` into
 *   its new piece). It then reads before or after `s`'s text, not right
 *   after it.
 * - R4, a merge into a split block: Backspace joining `t` into the block
 *   `s` above it ‖ a split of `s` → `t`'s text follows `s`'s head, before
 *   the pieces the split made.
 * Plus R2 (`insertedAbove`), as in the CW-01 matrices.
 */
const splitResidual: Residual = (wrong, moves, winner) =>
	insertedAbove(wrong, moves, winner) ||
	moves.some(([gs, s], k) => {
		if (!splits(gs)) return false;
		const [gt, t] = moves[1 - k];
		if (gt === 'backspace') return t !== 'a' && ORDER[ORDER.indexOf(t) - 1] === s; // R4
		if (splits(gt)) return t === 'P' && s === 'c'; // R3: P's split takes c
		return t === s || ('abd'.includes(s) && 'abd'.includes(t) && s < t); // R3
	});

/**
 * Every gesture pair — the CW-01 five plus Enter and a multi-line paste —
 * on blocks at most two apart around a list: a paragraph with a child
 * above it (its pieces, its child's exits and the list's first-item lifts
 * share one gap), the list, and a paragraph after it. Turn into is made on
 * the items (off a list it retypes in place, or inserts after the block
 * as any insert does).
 */
describe('DR-crdt-6: every gesture pair with splits around a list, 8 client-id pairs each', () => {
	const t = (id: string) => `${id}.`;
	const seed = [
		{ id: 'P', text: t('P'), children: [{ id: 'c', text: t('c') }] },
		{
			id: 'U',
			type: 'unordered-list',
			text: '',
			children: ['a', 'b', 'd'].map((id) => ({ id, type: 'list-item', text: t(id) }))
		},
		{ id: 'Q', text: t('Q') }
	];
	const gs: Gesture[] = [...ALL, 'enter', 'paste'];
	for (const ga of gs)
		for (const gb of gs)
			it(`${ga} ‖ ${gb}`, () =>
				expect(
					matrix(seed, ORDER, 'P.c.a.b.d.Q.', [ga, gb], {
						n: 8,
						reach: 2,
						residual: splitResidual,
						on: (g, id) => !LIFTS.includes(g) || 'abd'.includes(id)
					})
				).toBe(''));
});

/** R3 and R4, each shown reached with the exact outcome it names, on any ids. */
describe('DR-crdt-6 residuals, pinned', () => {
	const list = (...items: string[]) => ({
		id: 'U',
		type: 'unordered-list',
		text: '',
		children: items.map((id) => ({ id, type: 'list-item', text: id.toUpperCase() }))
	});
	it('R3: Enter at the end of the last item ‖ Shift+Tab on it → the new item stays above it', () =>
		expect(
			texts(
				[list('a', 'b')],
				(ed) => ed.splitBlock('b', 1, 'N'),
				(ed) => ed.unNestBlock('b')
			)
		).toEqual([['', 'A', '', 'B']]));

	it('R3: Enter at the end of an item ‖ Shift+Tab on the next one → the new item stays after it', () =>
		expect(
			texts(
				[list('a', 'b', 'c')],
				(ed) => ed.splitBlock('a', 1, 'N'),
				(ed) => ed.unNestBlock('b')
			)
		).toEqual([['', 'A', 'B', '', '', 'C']]));

	it('R3: Enter in an earlier nested line’s sibling ‖ Shift+Tab on that earlier line, which adopts it (FX-09)', () =>
		expect(
			texts(
				[
					{
						id: 'x',
						text: 'x',
						children: [
							{ id: 'k1', text: 'k1' },
							{ id: 'k2', text: 'kk2' },
							{ id: 'k3', text: 'k3' }
						]
					},
					{ id: 'y', text: 'y' }
				],
				(ed) => ed.splitBlock('k2', 1, 'N'),
				(ed) => ed.unNestBlock('k1'),
				96
			)
		).toEqual([['x', 'k2', 'k1', 'k', 'k3', 'y']]));

	it('R4: Backspace joins “world” into “hello” ‖ Enter after “he” → “heworld”, “llo”', () =>
		expect(
			texts(
				[
					{ id: 'X', text: 'hello' },
					{ id: 'Y', text: 'world' }
				],
				(ed) => ed.mergeBackward('Y'),
				(ed) => ed.splitBlock('X', 2, 'N')
			)
		).toEqual([['heworld', 'llo']]));
});

/**
 * DR-crdt-7: a peer's own edit BEFORE its split point (typing an opening
 * sentence, then Enter after it; deleting the start, then Enter) shifts
 * the offset it splits at but not what follows it: pieces are ranked by
 * the text after the split point, so they keep the text order.
 */
describe('DR-crdt-7: an edit before one’s own split point keeps the pieces in order', () => {
	const seed = (text: string) => [
		{ id: 'P', text: 'P' },
		{ id: 'X', text },
		{ id: 'Q', text: 'Q' }
	];
	it('Ada types at the start, then Enter after it ‖ Bob presses Enter after “hello”', () =>
		expect(
			texts(
				seed('hello world'),
				(ed) => {
					ed.insertText('X', 0, 'Intro. ');
					return ed.splitBlock('X', 7, 'N1');
				},
				(ed) => ed.splitBlock('X', 5, 'N2')
			)
		).toEqual([['P', 'Intro. ', 'hello', ' world', 'Q']]));

	it('Ada deletes the start, then Enter ‖ Bob presses Enter earlier', () =>
		expect(
			texts(
				seed('abcdefghij'),
				(ed) => {
					ed.deleteText('X', 0, 5);
					return ed.splitBlock('X', 2, 'N1');
				},
				(ed) => ed.splitBlock('X', 4, 'N2')
			)
		).toEqual([['P', '', 'fg', 'hij', 'Q']]));

	it('Ada replaces the start with a paste of lines ‖ Bob presses Enter later', () =>
		expect(
			texts(
				seed('hello world'),
				(ed) => {
					ed.deleteText('X', 0, 5);
					return ed.insertFlow(
						{ block: 'X', offset: 0 },
						{
							lines: [
								{ id: 'L1', content: [{ kind: 'text', text: '<' }] },
								{ id: 'L2', content: [{ kind: 'text', text: '>' }] }
							]
						}
					);
				},
				(ed) => ed.splitBlock('X', 8, 'N2')
			).map((t) => t.join('|'))
		).toEqual(['P|<|> wo|rld|Q']));

	/**
	 * Residual (pinned, documented in the delete contract): a peer's edit
	 * AFTER its own split point that the other peer has not seen (typing at
	 * the end, then Enter further up) counts as text after that point, so
	 * its piece sorts before a piece the other peer split off above it.
	 */
	it('residual: Ada types at the end, then Enter after “hello wo” ‖ Bob presses Enter after “hello”', () =>
		expect(
			texts(
				seed('hello world'),
				(ed) => {
					ed.insertText('X', 11, ' again');
					return ed.splitBlock('X', 8, 'N1');
				},
				(ed) => ed.splitBlock('X', 5, 'N2')
			)
		).toEqual([['P', 'hello', 'rld again', ' wo', 'Q']]));

	/** The same residual when the unseen edit after the split point is a deletion (FX-10). */
	it('residual: Ada deletes “rld”, then Enter after “hello” ‖ Bob presses Enter after “hello w”', () =>
		expect(
			texts(
				seed('hello world'),
				(ed) => {
					ed.deleteText('X', 8, 3);
					return ed.splitBlock('X', 5, 'N1');
				},
				(ed) => ed.splitBlock('X', 7, 'N2')
			)
		).toEqual([['P', 'hello', 'o', ' w', 'Q']]));
});
