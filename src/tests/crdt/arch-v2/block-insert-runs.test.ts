/**
 * H1 (CRDT study 2026-10, `research-loro/exp1`; contract row
 * `order.insert.run`): a block inserted right after a block this client
 * ranked extends the client's run there, as an array item does
 * (`crdt/data.ts`, YATA's origin rule) — so two peers that each press Enter
 * at the end of the same block and type several paragraphs keep each one's
 * paragraphs together, whatever their client ids. Before, each new line took
 * a random rank in the gap and 34 of 40 client-id pairs interleaved
 * (`x a1 b1 a2 a3 b2 b3 q`).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import {
	decodeRank,
	encodeRank,
	rankAfter,
	RANK_RUN,
	rankBetween
} from '$lib/crdt/placement/rank.js';
import { clientPairs, converge } from './replica-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** The blocks' texts in document order, `|`-joined. */
const texts = (o) =>
	o.ed
		.order()
		.map((id) => o.ed.blockText(id))
		.join('|');

/** `count` lines typed after `after`, each Enter at the end of the previous one. */
const lines = (rep, tag: string, after: string, count: number): void => {
	let prev = after;
	for (let i = 1; i <= count; i++) {
		const id = `${tag}${i}`;
		const { parent, index } = rep.ed.positionOf(prev);
		ok(rep.ed.insertBlock({ parent, index: index + 1 }, { id, type: 'paragraph' }));
		ok(rep.ed.insertText(id, 0, id));
		prev = id;
	}
};

describe('H1: concurrent Enters at the end of one block never interleave', () => {
	it('two peers, three lines each, 40 client-id pairs', () => {
		const seen = new Set<string>();
		for (const o of converge(
			[
				{ id: 'X', text: 'x' },
				{ id: 'Q', text: 'q' }
			],
			2,
			([a, b]) => {
				lines(a, 'a', 'X', 3);
				lines(b, 'b', 'X', 3);
			},
			{ assignments: clientPairs(40) }
		)) {
			expect(o.problems).toEqual([]);
			seen.add(texts(o));
			for (const r of o.reps) r.destroy();
		}
		expect([...seen].sort()).toEqual(['x|a1|a2|a3|b1|b2|b3|q', 'x|b1|b2|b3|a1|a2|a3|q']);
	});

	it('three peers, two lines each after the same block', () => {
		const seen = new Set<string>();
		for (const o of converge(
			[
				{ id: 'X', text: 'x' },
				{ id: 'Q', text: 'q' }
			],
			3,
			(reps) => reps.forEach((rep, i) => lines(rep, 'abc'[i], 'X', 2))
		)) {
			expect(o.problems).toEqual([]);
			const t = texts(o);
			for (const tag of ['a', 'b', 'c']) expect(t).toContain(`${tag}1|${tag}2`);
			seen.add(t);
			for (const r of o.reps) r.destroy();
		}
		expect(seen.size).toBeGreaterThan(0);
	});

	it('a peer typing lines after its own line keeps them together around a peer’s line', () => {
		// Ada's a1 is already synced; Bob inserts after it while Ada adds a2, a3 after a1.
		for (const o of converge(
			[
				{ id: 'X', text: 'x' },
				{ id: 'Q', text: 'q' }
			],
			2,
			([a, b]) => {
				lines(a, 'a', 'X', 1);
				for (const u of a.log) b.receive(u);
				const { parent, index } = b.ed.positionOf('a1');
				ok(b.ed.insertBlock({ parent, index: index + 1 }, { id: 'b1', type: 'paragraph' }));
				ok(b.ed.insertText('b1', 0, 'b1'));
				let prev = 'a1';
				for (const id of ['a2', 'a3']) {
					const at = a.ed.positionOf(prev);
					ok(
						a.ed.insertBlock({ parent: at.parent, index: at.index + 1 }, { id, type: 'paragraph' })
					);
					ok(a.ed.insertText(id, 0, id));
					prev = id;
				}
			},
			{ assignments: clientPairs(16) }
		)) {
			expect(o.problems).toEqual([]);
			expect(texts(o)).toMatch(/a1\|a2\|a3/);
			for (const r of o.reps) r.destroy();
		}
	});
});

describe('H1: the run rule (`rankAfter`)', () => {
	it('after a rank another client made: a plain rank', () => {
		const left = rankBetween(undefined, undefined, 5, () => 0.5);
		const right = rankBetween(left, undefined, 5, () => 0.5);
		const r = rankAfter(left, right, 9, () => 0.5);
		expect(decodeRank(r)).toHaveLength(1);
		expect(left < r && r < right).toBe(true);
	});
	/** A run member's digit lies in the band right above the run marker's (`rankAfter`). */
	const inBand = (v: number) => v > RANK_RUN && v < RANK_RUN + 2 ** 29;
	it('after its own rank: the rank, then one segment of its run', () => {
		const left = rankBetween(undefined, undefined, 9, () => 0.5);
		const right = rankBetween(left, undefined, 5, () => 0.5);
		const r = rankAfter(left, right, 9, () => 0.5);
		expect(r.startsWith(left)).toBe(true);
		const segs = decodeRank(r);
		expect(segs).toHaveLength(2);
		expect(inBand(segs[1].v) && segs[1].t === 9).toBe(true);
		expect(left < r && r < right).toBe(true);
		// The next one after it stays in that run, at the same depth.
		const next = rankAfter(r, right, 9, () => 0.5);
		expect(decodeRank(next)).toHaveLength(2);
		expect(r < next && next < right).toBe(true);
		// So does one inserted right after `left` again, before the run's first member.
		const before = rankAfter(left, r, 9, () => 0.5);
		expect(decodeRank(before)).toHaveLength(2);
		expect(left < before && before < r).toBe(true);
	});
	it('a run of the earlier two-segment form (data arrays) is still extended in place', () => {
		const left = rankBetween(undefined, undefined, 9, () => 0.5);
		const old =
			left +
			encodeRank([
				{ v: RANK_RUN, t: 9 },
				{ v: 0, t: 9 }
			]);
		const r = rankAfter(old, undefined, 9, () => 0.5);
		expect(decodeRank(r)).toHaveLength(3);
		expect(r.startsWith(left + encodeRank([{ v: RANK_RUN, t: 9 }]))).toBe(true);
		expect(r > old).toBe(true);
	});
	it('nothing a peer inserts after the same left lands inside the run', () => {
		const left = rankBetween(undefined, undefined, 9, () => 0.5);
		const right = rankBetween(left, undefined, 5, () => 0.9);
		const mine = rankAfter(left, right, 9, () => 0.5);
		for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
			const theirs = rankAfter(left, right, 7, () => rand);
			expect(theirs < left || theirs > mine).toBe(true);
		}
	});
});
