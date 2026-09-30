/**
 * Re-score 9, CW-01: concurrent structural gestures on neighbouring blocks
 * keep the text in source order on EVERY client-id assignment — not only
 * the three fixed `CLIENT_IDS` pairs the pinned rows use. Blocks two peers
 * move into the same gap used to sort by the ranks each drew at random
 * there (and by client id), so the text order followed the peers' ids on
 * about one pair in eight. Each row sweeps many client-id pairs and holds
 * every outcome to the §8 multi-replica rule: converged, well-formed, no
 * paragraph showing directly in a list, the text in document order
 * (`allText`), and a block inserted after an item (a divider, a code
 * block) right after that item's text. Expected values are hand-authored:
 * the seed's text in order, as any serial order of the gestures gives it.
 * The residuals are pinned exactly: each matrix names the wrong outcomes
 * it allows (`Residual`), and the last describe shows each one reached.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, clientPairs, clientTriples, converge, LIVE } from './p1-harness.js';
import {
	ALL,
	applies,
	gestures,
	insertedAbove,
	item,
	LIFTS,
	list,
	matrix,
	para,
	semantics,
	sweep,
	typed,
	type Gesture,
	type Move,
	type Residual
} from './cw01-sweep.js';

describe('CW-01: the review’s gesture pairs keep the text order on 240 client-id pairs', () => {
	const three = [para('p'), list('U', item('a'), item('b'), item('c'))];
	const rows: [Gesture, Gesture][] = [
		['outdent', 'outdent'],
		['heading', 'heading'],
		['outdent', 'heading'],
		['outdent', 'backspace']
	];
	for (const [ga, gb] of rows)
		it(`Ada: ${ga} b ‖ Bob: ${gb} a → pabc`, () =>
			expect(
				sweep(
					three,
					'pabc',
					[
						[ga, 'b'],
						[gb, 'a']
					],
					clientPairs(240)
				).join('\n')
			).toBe(''));

	it('a list nested right in a list: b → heading ‖ c → heading → abcxd', () => {
		const nested = [list('U', item('a'), list('U2', item('b'), item('c'), item('x')), item('d'))];
		expect(
			sweep(
				nested,
				'abcxd',
				[
					['heading', 'b'],
					['heading', 'c']
				],
				clientPairs(240)
			).join('\n')
		).toBe('');
	});
});

const flat = [
	para('P'),
	list('U', item('a'), item('b'), item('c'), item('d'), item('e')),
	para('Q')
];

describe('CW-01: every gesture pair on items at most two apart in one list, 12 client-id pairs each', () => {
	for (const ga of ALL)
		for (const gb of ALL)
			it(`${ga} ‖ ${gb}`, () =>
				expect(
					matrix(flat, ['a', 'b', 'c', 'd', 'e'], 'PabcdeQ', [ga, gb], {
						n: 12,
						reach: 2,
						residual: insertedAbove
					})
				).toBe(''));
});

describe('CW-01: three peers on three neighbouring items, every client-id order', () => {
	for (const ga of ALL)
		for (const gb of ALL)
			it(`${ga} ‖ ${gb} ‖ each gesture: the text keeps its order`, () => {
				const bad: string[] = [];
				for (const gc of ALL)
					for (const [x, y, z] of [
						['a', 'b', 'c'],
						['b', 'c', 'd'],
						['d', 'c', 'b']
					]) {
						const moves: Move[] = [
							[ga, x],
							[gb, y],
							[gc, z]
						];
						if (!moves.every(([g, id]) => applies(flat, g, id))) continue;
						// Three splits: where an inserted block lands is R2 and its three-peer mixes.
						const text: Residual = (wrong) => wrong === 'inserted';
						for (const line of sweep(flat, 'PabcdeQ', moves, clientTriples(12), text))
							bad.push(`${ga} ${x} ‖ ${gb} ${y} ‖ ${gc} ${z}: ${line}`);
					}
				expect(bad.slice(0, 6).join('\n')).toBe('');
			});
});

/**
 * R1 (pinned): in a list nested right in a list, `U[a, U2[b, c, x], d]`,
 * the two peers can move blocks at different levels — one moves an item of
 * `U2` into `U` (Shift+Tab, Backspace at the start of `b`) or lifts it out
 * of both lists, while the other lifts a LATER item of `U2` out of both
 * lists, taking `a` and `U2` whole into its new head list. Neither move
 * contests the other's block, so the item the first peer moved stays where
 * that peer put it — in `U`, now after the lifted item (whatever the ids),
 * or out of the lists before the head that won `a` (when the later
 * lifter's id wins). A split moves blocks to new parents; a block a peer
 * places meanwhile relative to the old parent does not follow it — the
 * same residual as an item a peer adds among the items before an outdented
 * one (`docs/editor-delete-contract.md`). Every replica converges.
 */
const U2 = ['b', 'c', 'x'];
const crossLevel: Residual = (wrong, moves, winner) => {
	if (wrong === 'inserted') return true; // R2, and its cross-level variants: not held here
	const [[, x], [, y]] = moves;
	if (!U2.includes(x) || !U2.includes(y) || x === y) return false;
	const [early, late] = U2.indexOf(x) < U2.indexOf(y) ? [0, 1] : [1, 0];
	const [ge, ie] = moves[early];
	if (!LIFTS.includes(moves[late][0])) return false;
	if (ge === 'outdent' || (ge === 'backspace' && ie === 'b')) return true;
	return LIFTS.includes(ge) && winner === late;
};

describe('CW-01: in a list nested right in a list, 12 client-id pairs each', () => {
	const nested = [
		para('P'),
		list('U', item('a'), list('U2', item('b'), item('c'), item('x')), item('d')),
		para('Q')
	];
	for (const ga of ALL)
		for (const gb of ALL)
			it(`${ga} ‖ ${gb}`, () =>
				expect(
					matrix(nested, ['a', 'b', 'c', 'x', 'd'], 'PabcxdQ', [ga, gb], {
						n: 12,
						reach: 2,
						residual: crossLevel
					})
				).toBe(''));
});

/**
 * The same rule off the list path: Shift+Tab on a block's children
 * (`unNestBlocks` out of a paragraph, which adopts the siblings after
 * them) and Backspace merging a block that has children (`mergeUnnesting`:
 * they unnest right after it) both move blocks into the gap after their
 * parent; they keep their order there whatever the ids (SW12-crdt-3).
 */
describe('SW12-crdt-3: outdents and merges of a block’s children keep the text order', () => {
	const kids = [
		para('P'),
		para('A', [para('x'), para('y'), para('z')]),
		para('B', [para('u'), para('v')]),
		para('Q')
	];
	const blocks = ['x', 'y', 'z', 'A', 'B', 'u', 'v'];
	for (const ga of ['outdent', 'backspace'] as Gesture[])
		for (const gb of ['outdent', 'backspace'] as Gesture[])
			it(`${ga} ‖ ${gb}`, () => {
				const bad: string[] = [];
				for (const x of blocks)
					for (const y of blocks) {
						if (!applies(kids, ga, x) || !applies(kids, gb, y)) continue;
						const moves: Move[] = [
							[ga, x],
							[gb, y]
						];
						for (const line of sweep(kids, 'PAxyzBuvQ', moves, clientPairs(24)))
							bad.push(`${ga} ${x} ‖ ${gb} ${y}: ${line}`);
					}
				expect(bad.slice(0, 6).join('\n')).toBe('');
			});
});

/**
 * SW12-crdt-1: two peers pressing Enter in one paragraph at once. The two
 * new blocks sort in the gap after it — by the ranks they drew there, so
 * "hello world" split at 2 and at 5 read "he", " world", "llo" on half the
 * assignments. A split now ranks its new block by the offset it splits at.
 */
describe('SW12-crdt-1: concurrent splits of one block keep its pieces in text order', () => {
	const seed = [para('P'), { id: 'X', text: 'hello world' }, para('Q')];
	const rows: [string, number, number, string[]][] = [
		['at 5 ‖ at 2', 5, 2, ['P', 'he', 'llo', ' world', 'Q']],
		['at 2 ‖ at 9', 2, 9, ['P', 'he', 'llo wor', 'ld', 'Q']],
		// A split at the end is headless only: the editor's Enter there inserts
		// a new block, not claimed (order-scope.test.ts).
		['at 11 ‖ at 5 (a split at the end ‖ in the middle)', 11, 5, ['P', 'hello', ' world', '', 'Q']]
	];
	for (const [name, at, bt, want] of rows)
		it(name, () => {
			for (const o of converge(
				seed,
				2,
				([a, b]) => {
					expect(a.ed.splitBlock('X', at, 'N1').status).toBe('applied');
					expect(b.ed.splitBlock('X', bt, 'N2').status).toBe('applied');
				},
				{ assignments: clientPairs(240) }
			)) {
				expect(o.problems).toEqual([]);
				expect(o.results.size).toBe(1);
				expect(o.ed.order().map((id) => o.ed.blockText(id))).toEqual(want);
				for (const r of o.reps) r.destroy();
			}
		});
});

/**
 * Two peers' blocks at one place never share a rank: the next block
 * inserted right after one of them lands right after it, not after the
 * other peer's (equal ranks sort by id, and nothing sorts between them).
 */
describe('CW-01: peers’ blocks placed at one place keep distinct ranks', () => {
	it('both press Enter at the end of X, then Ada presses Enter in her new line → right after it', () => {
		const seed = [para('P'), { id: 'X', text: 'hello' }, para('Q')];
		for (const o of converge(
			seed,
			2,
			([a, b]) => {
				expect(a.ed.splitBlock('X', 5, 'N1').status).toBe('applied');
				expect(b.ed.splitBlock('X', 5, 'N2').status).toBe('applied');
				a.receiveAll(b.log);
				b.receiveAll(a.log);
				expect(a.ed.insertText('N1', 0, 'one').status).toBe('applied');
				expect(a.ed.splitBlock('N1', 3, 'N3').status).toBe('applied');
				const order = a.ed.order();
				expect(order.indexOf('N3')).toBe(order.indexOf('N1') + 1);
			},
			{ assignments: clientPairs(24) }
		)) {
			expect(o.problems).toEqual([]);
			expect(o.results.size).toBe(1);
			const order = o.ed.order();
			expect(order.indexOf('N3')).toBe(order.indexOf('N1') + 1);
			for (const r of o.reps) r.destroy();
		}
	});

	it('both insert a divider after b: each one’s divider and line stay together', () => {
		for (const o of converge(
			flat,
			2,
			([a, b]) => {
				expect(gestures.divider(a.ed, 'b', '0').status).toBe('applied');
				expect(gestures.divider(b.ed, 'b', '1').status).toBe('applied');
			},
			{ semantics, assignments: clientPairs(24) }
		)) {
			expect(o.problems).toEqual([]);
			const order = o.ed.order().filter((id) => /^[DN]\d$/.test(id));
			expect([
				['D0', 'N0', 'D1', 'N1'],
				['D1', 'N1', 'D0', 'N0']
			]).toContainEqual(order);
			for (const r of o.reps) r.destroy();
		}
	});
});

/**
 * SW12-crdt-4: a paste of several lines splits the block it lands in, as
 * Enter does (`insertFlow`): its lines sort in the same gap as a peer's
 * split or paste in that block, and must keep the text order the same way.
 */
describe('SW12-crdt-4: a multi-line paste ‖ a split or paste in the same block keeps the text order', () => {
	const seed = [para('P'), { id: 'X', text: 'hello world' }, para('Q')];
	const line = (id: string, text: string) => ({ id, content: [{ kind: 'text', text }] });
	const paste = (ed, at: number, tag: string) =>
		ed.insertFlow(
			{ block: 'X', offset: at },
			{ lines: [line(`${tag}1`, '<'), line(`${tag}2`, '='), line(`${tag}3`, '>')] }
		);
	const rows: [string, (ed) => { status: string }, (ed) => { status: string }, string][] = [
		[
			'paste at 2 ‖ split at 8',
			(ed) => paste(ed, 2, 'A'),
			(ed) => ed.splitBlock('X', 8, 'N'),
			'Phe<=>llo worldQ'
		],
		[
			'paste at 8 ‖ split at 2',
			(ed) => paste(ed, 8, 'A'),
			(ed) => ed.splitBlock('X', 2, 'N'),
			'Phello wo<=>rldQ'
		],
		[
			'paste at 2 ‖ paste at 8',
			(ed) => paste(ed, 2, 'A'),
			(ed) => paste(ed, 8, 'B'),
			'Phe<=>llo wo<=>rldQ'
		]
	];
	for (const [name, fa, fb, want] of rows)
		it(name, () => {
			for (const o of converge(
				seed,
				2,
				([a, b]) => {
					expect(fa(a.ed).status).toBe('applied');
					expect(fb(b.ed).status).toBe('applied');
				},
				{ assignments: clientPairs(120) }
			)) {
				expect(o.problems).toEqual([]);
				expect(o.results.size).toBe(1);
				expect(allText(o.ed)).toBe(want);
				for (const r of o.reps) r.destroy();
			}
		});
});

/** The residuals above, each shown reached with the exact outcome it names. */
describe('CW-01 residuals, pinned', () => {
	const one = (seed, moves: Move[], ids: number[]) => {
		const [o] = converge(
			seed,
			moves.length,
			(reps) => moves.forEach(([g, id], k) => gestures[g](reps[k].ed, id, String(k))),
			{ semantics, assignments: [ids.map((i) => LIVE + i)] }
		);
		expect(o.problems).toEqual([]);
		expect(o.results.size).toBe(1);
		return o.ed;
	};
	const nested = [
		para('P'),
		list('U', item('a'), list('U2', item('b'), item('c'), item('x')), item('d')),
		para('Q')
	];

	it('R2: Ada inserts a divider after a ‖ Bob outdents c, Bob’s id wins → the divider above a', () => {
		const ed = one(
			flat,
			[
				['divider', 'a'],
				['outdent', 'c']
			],
			[1, 2]
		);
		expect(allText(ed)).toBe('PabcdeQ');
		expect(typed(ed)).toBe(
			'P:paragraph NEW:unordered-list D0:divider N0:paragraph NEW:unordered-list[a:list-item,b:list-item] c:paragraph U:unordered-list[d:list-item,e:list-item] Q:paragraph'
		);
		// Ada's id wins: her new list keeps a, the divider follows it.
		expect(
			typed(
				one(
					flat,
					[
						['divider', 'a'],
						['outdent', 'c']
					],
					[2, 1]
				)
			)
		).toBe(
			'P:paragraph NEW:unordered-list[a:list-item] D0:divider N0:paragraph NEW:unordered-list[b:list-item] c:paragraph U:unordered-list[d:list-item,e:list-item] Q:paragraph'
		);
	});

	it('R1: Ada outdents b into U ‖ Bob turns x into a heading → b stays in U, after x (any ids)', () => {
		for (const ids of [
			[1, 2],
			[2, 1]
		]) {
			const ed = one(
				nested,
				[
					['outdent', 'b'],
					['heading', 'x']
				],
				ids
			);
			expect(allText(ed)).toBe('PacxbdQ');
			expect(typed(ed)).toBe(
				'P:paragraph NEW:unordered-list[a:list-item,U2:unordered-list[c:list-item]] x:heading U:unordered-list[b:list-item,d:list-item] Q:paragraph'
			);
		}
	});

	it('R1: Ada turns b into a heading ‖ Bob turns x into one, Bob’s id wins a → b before a', () => {
		const moves: Move[] = [
			['heading', 'b'],
			['heading', 'x']
		];
		expect(allText(one(nested, moves, [1, 2]))).toBe('PbacxdQ');
		expect(allText(one(nested, moves, [2, 1]))).toBe('PabcxdQ');
	});
});
