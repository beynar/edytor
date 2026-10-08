/**
 * H9 / D-18 (`order.split.text`): blocks split from one text that stand
 * where they were made show in the text's order — the order of the
 * boundaries that delimit them — whatever each peer saw when it split.
 * One client's pieces keep the order it ranked them in; a moved piece
 * stands where it was moved. Expected values are the serial orders,
 * written by hand.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { clientPairs, clientTriples, converge } from './replica-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};
const texts = (o) =>
	o.ed
		.order()
		.map((id) => o.ed.blockText(id))
		.join('|');
const outcomes = (seed, program, assignments) => {
	const out = new Set<string>();
	for (const o of converge(seed, assignments[0].length, program, { assignments })) {
		expect(o.problems).toEqual([]);
		expect(o.results.size).toBe(1);
		out.add(texts(o));
		for (const r of o.reps) r.destroy();
	}
	return [...out];
};

describe('D-18: concurrent splits keep the text order', () => {
	it('three peers press Enter in one paragraph at once; one typed at its end first (the former residual)', () =>
		expect(
			outcomes(
				[{ id: 'X', text: 'hello world' }],
				([a, b, c]) => {
					// Text after A's split point that B and C never saw (DR-crdt-7's residual).
					ok(a.ed.insertText('X', 11, ' again'));
					ok(a.ed.splitBlock('X', 8, 'A'));
					ok(b.ed.splitBlock('X', 5, 'B'));
					ok(c.ed.splitBlock('X', 2, 'C'));
				},
				clientTriples(24)
			)
		).toEqual(['he|llo| wo|rld again']));

	it('two peers split, one of them twice, across every client-id pair', () =>
		expect(
			outcomes(
				[{ id: 'X', text: 'abcdefgh' }],
				([a, b]) => {
					ok(a.ed.splitBlock('X', 6, 'A1'));
					ok(a.ed.splitBlock('X', 2, 'A2'));
					ok(b.ed.deleteText('X', 7, 1));
					ok(b.ed.splitBlock('X', 4, 'B'));
				},
				clientPairs(48)
			)
		).toEqual(['ab|cd|ef|g']));
});

describe('D-18 leaves a moved block where it was moved', () => {
	it('a piece moved to the top stays on top while a peer splits the text', () =>
		expect(
			outcomes(
				[
					{ id: 'P', text: 'p' },
					{ id: 'X', text: 'hello world' }
				],
				([a, b]) => {
					ok(a.ed.splitBlock('X', 5, 'N'));
					ok(a.ed.moveBlock('N', { parent: null, index: 0 }));
					ok(b.ed.splitBlock('X', 2, 'M'));
				},
				clientPairs(24)
			)
		).toEqual([' world|p|he|llo']));
});
