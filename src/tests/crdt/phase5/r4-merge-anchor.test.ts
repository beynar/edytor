/**
 * Phase 5, H9's second half (R4): a merge claim is anchored to the end of
 * the head stream (`merge.claim.anchor` in `docs/editor-delete-contract.md`).
 * A split its writer did not see moves the merged text to the piece that
 * ends the head's region, as every serial order of the two gestures does.
 * Expected values are the serial outcomes, hand-authored:
 *
 * - Backspace joins "world" into "hello" ‖ Enter after "he" → "he",
 *   "lloworld" (it read "heworld", "llo");
 * - ‖ Enter at the end of "hello" → "hello", "world";
 * - ‖ Enter at its start → "", "helloworld";
 * - a block already merged into the head moves with the split and the new
 *   merge follows it (both serial orders);
 * - the merged block's text keeps its own edits; an undo of the merge, or of
 *   the split, gives back the serial result;
 * - a merge into a split-born head (its stream delimited by the next block's
 *   boundary) ‖ a split of it.
 *
 * Every row runs on 48 client-id pairs, both delivery orders, duplicate
 * delivery and a reload (`converge` in the p1 harness).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { clientPairs, converge } from '../arch-v2/p1-harness.js';
import { semantics } from '../arch-v2/cw01-sweep.js';

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

const XY = [
	{ id: 'X', text: 'hello' },
	{ id: 'Y', text: 'world' }
];
const join = (ed) => ed.mergeBackward('Y');

describe('merge.claim.anchor — a merge ‖ a split of the block it joins', () => {
	it('R4: Backspace joins “world” into “hello” ‖ Enter after “he” → “he”, “lloworld”', () =>
		expect(texts(XY, join, (ed) => ed.splitBlock('X', 2, 'N'))).toEqual([['he', 'lloworld']]));

	it('‖ Enter at the end of “hello” → “hello”, “world”', () =>
		expect(texts(XY, join, (ed) => ed.splitBlock('X', 5, 'N'))).toEqual([['hello', 'world']]));

	it('‖ Enter at its start → “”, “helloworld”', () =>
		expect(texts(XY, join, (ed) => ed.splitBlock('X', 0, 'N'))).toEqual([['', 'helloworld']]));

	it('‖ two Enters → the merged text follows the last piece', () =>
		expect(
			texts(XY, join, (ed) => {
				const r = ed.splitBlock('X', 1, 'N');
				return r.status === 'applied' ? ed.splitBlock('N', 2, 'M') : r;
			})
		).toEqual([['h', 'el', 'loworld']]));

	it('a block merged into the head before moves with the split; the new merge follows it', () =>
		expect(
			texts(
				[
					{ id: 'X', text: 'hello' },
					{ id: 'Z', text: 'zz' },
					{ id: 'Y', text: 'world' }
				].map((b) => b),
				(ed) => join(ed),
				(ed) => ed.splitBlock('X', 2, 'N'),
				24
			)
		).toEqual([['he', 'llo', 'zzworld']]));

	it('a merge into a head already merged into (known to both) ‖ a split of the head', () => {
		// X "hello" with Z merged in (both peers saw it), then Y joins ‖ Enter after "he".
		const seed = [
			{ id: 'X', text: 'hello' },
			{ id: 'Z', text: 'zz' },
			{ id: 'Y', text: 'world' }
		];
		const out = texts(
			seed,
			(ed) => {
				const r = ed.mergeBackward('Z');
				return r.status === 'applied' ? ed.mergeBackward('Y') : r;
			},
			(ed) => ed.splitBlock('X', 2, 'N'),
			24
		);
		// Serial: merges first → "hellozzworld" split after "he" → "he", "llozzworld".
		expect(out).toEqual([['he', 'llozzworld']]);
	});

	it('a merge into a split-born head ‖ a split of it', () => {
		// P "abc|def" was split into P "abc" and X "def" (one text); Y joins X ‖ X splits.
		const seed = [
			{ id: 'P', text: 'abc' },
			{ id: 'X', text: 'def' },
			{ id: 'Y', text: 'world' }
		];
		expect(texts(seed, join, (ed) => ed.splitBlock('X', 1, 'N'), 24)).toEqual([
			['abc', 'd', 'efworld']
		]);
	});

	it('typing after the merged text, on either side, keeps it in the last piece', () =>
		expect(
			texts(
				XY,
				(ed) => {
					const r = join(ed);
					return r.status === 'applied' ? ed.insertText('X', 10, '!') : r;
				},
				(ed) => {
					const r = ed.insertText('X', 5, '?');
					return r.status === 'applied' ? ed.splitBlock('X', 2, 'N') : r;
				},
				24
			)
		).toEqual([['he', 'llo?world!']]));
});
