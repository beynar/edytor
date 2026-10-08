/**
 * R8 (WU-17): a whole-array data assignment scales linearly. `arrange`
 * keeps the items a longest common subsequence of the old and new values
 * keeps equal (`data.ts` `common`); it used a full LCS table, O(n·m) time
 * and memory (6,000 items: 2.1 s and 163 MB). The rows here bound the work
 * by counting the element reads `common` makes (a counting proxy over its
 * inputs, which throws past the budget so an old quadratic run fails fast),
 * and check what it answers against the contract: a common subsequence
 * (increasing pairs of equal elements), the longest one whenever the
 * candidate pairs stay under the bound (always when the old values are
 * distinct, `order`'s ids included), and positional pairing past it.
 * Expected lengths come from a reference LCS table in this file.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import { common } from '../../../lib/crdt/data.js';
import { mulberry32 } from '../harness/rng.js';

/** `xs` behind a proxy counting index reads into `count`, throwing past `budget`. */
const counted = (xs: string[], count: { reads: number }, budget: number) =>
	new Proxy(xs, {
		get(target, key, receiver) {
			if (typeof key === 'string' && /^\d+$/.test(key) && ++count.reads > budget)
				throw new Error(`over budget: ${count.reads} reads`);
			return Reflect.get(target, key, receiver);
		}
	});

/** The reference: a longest common subsequence's length, by the full table. */
const lcsLength = (a: string[], b: string[]) => {
	let row = new Array(b.length + 1).fill(0);
	for (let i = a.length - 1; i >= 0; i--) {
		const next = new Array(b.length + 1).fill(0);
		for (let j = b.length - 1; j >= 0; j--)
			next[j] = a[i] === b[j] ? row[j + 1] + 1 : Math.max(row[j], next[j + 1]);
		row = next;
	}
	return row[0];
};

/** `pairs` is a common subsequence of `a` and `b`: increasing on both sides, equal elements. */
const isCommon = (a: string[], b: string[], pairs: [number, number][]) =>
	pairs.every(
		([i, j], k) => a[i] === b[j] && (k === 0 || (i > pairs[k - 1]![0] && j > pairs[k - 1]![1]))
	);

const N = 6000;
const items = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);

describe('R8: common() reads each element a bounded number of times', () => {
	const cases: [string, string[], string[]][] = (() => {
		const a = items(N);
		const shuffled = [...a];
		const rand = mulberry32(17);
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}
		const edited = [...a];
		edited.splice(4000, 1);
		edited[3000] = 'changed';
		edited.splice(10, 0, 'inserted');
		const dupes = Array.from({ length: N }, (_, i) => String(i % 3));
		const dupesEdited = [
			...dupes.slice(0, 100),
			'x',
			...dupes.slice(100, 5000).reverse(),
			...dupes.slice(5000)
		];
		return [
			['equal arrays', a, [...a]],
			['an insert, an edit and a remove far apart', a, edited],
			['a shuffle (distinct values)', a, shuffled],
			['a reversal', a, [...a].reverse()],
			['nothing in common', a, a.map((s) => `${s}!`)],
			['three values repeated (past the bound)', dupes, dupesEdited]
		];
	})();
	for (const [name, a, b] of cases)
		it(`${name}: at most 4 reads per element of the 6,000 + 6,000`, () => {
			const count = { reads: 0 };
			const budget = 4 * (a.length + b.length);
			const pairs = common(counted(a, count, budget), counted(b, count, budget));
			expect(count.reads).toBeLessThanOrEqual(budget);
			expect(isCommon(a, b, pairs)).toBe(true);
		});

	it('distinct values: the pairs are a longest common subsequence (insert, edit, remove)', () => {
		const a = items(N);
		const b = [...a];
		b.splice(4000, 1);
		b[3000] = 'changed';
		b.splice(10, 0, 'inserted');
		expect(common(a, b)).toHaveLength(N - 2);
	});

	it('a permutation keeps its longest increasing run (what `order` re-ranks the rest around)', () => {
		const a = items(N);
		// Move one item from the start to the end, and swap two in the middle.
		const b = [...a.slice(1, 2000), a[2001]!, a[2000]!, ...a.slice(2002), a[0]!];
		expect(common(a, b)).toHaveLength(N - 2);
	});
});

describe('R8: common() is a longest common subsequence under the bound', () => {
	it('random short arrays with repeated values: the reference length, a valid subsequence', () => {
		const rand = mulberry32(5);
		for (let run = 0; run < 400; run++) {
			const alphabet = 1 + Math.floor(rand() * 6);
			const draw = () =>
				Array.from({ length: Math.floor(rand() * 14) }, () =>
					String.fromCharCode(97 + Math.floor(rand() * alphabet))
				);
			const [a, b] = [draw(), draw()];
			const pairs = common(a, b);
			expect(isCommon(a, b, pairs), `${a} / ${b}`).toBe(true);
			expect(pairs.length, `${a} / ${b}`).toBe(lcsLength(a, b));
		}
	});
});

describe('R8: arrange at 6,000 items writes only what differs', () => {
	const leavesOf = (node) =>
		new Map(
			[...node.attrKeys()].filter((k) => k.startsWith('d/')).map((k) => [k, node.getAttr(k)])
		);

	it('reassigning a 6,000-item array with one insert, one edit and one remove', () => {
		const rows = Array.from({ length: N }, (_, i) => ({ title: `task ${i}`, done: i % 2 === 0 }));
		const document = createDocument({
			value: { children: [{ id: 'A', type: 'paragraph', data: { rows } }] }
		});
		const node = document.facade.resolveBlock('A');
		const before = leavesOf(node);
		const next = rows.map((r) => ({ ...r }));
		next.splice(4000, 1);
		next[3000] = { title: 'changed', done: true };
		next.splice(10, 0, { title: 'new', done: false });
		expect(document.facade.patchData('A', [{ path: ['rows'], value: next }]).status).toBe(
			'applied'
		);
		expect(document.facade.blockDataOf('A').rows).toEqual(next);
		const after = leavesOf(node);
		const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
			(k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k))
		);
		// The new item (rank + two leaves), the edited item's two leaves, the
		// removed item's rank and two leaves: nothing else moves.
		expect(changed.length).toBeLessThanOrEqual(9);
		document.destroy();
	});
});

/**
 * The bench row (`BENCH_R8=1`, never in the lanes): a whole assignment of
 * an N-item array of objects with one insert, one edit and one remove, and
 * a reversal (`order`), median of five, with the most heap one grew.
 */
describe.runIf(process.env.BENCH_R8 === '1')('R8 bench', () => {
	it('whole assignment and order at 1,000 / 6,000 / 20,000 items', () => {
		const rows: string[] = [];
		for (const n of [1000, 6000, 20000]) {
			const data = Array.from({ length: n }, (_, i) => ({ title: `task ${i}`, done: false }));
			const next = data.map((r) => ({ ...r }));
			next.splice(Math.floor(n * 0.66), 1);
			next[Math.floor(n / 2)] = { title: 'changed', done: true };
			next.splice(10, 0, { title: 'new', done: false });
			const time = (patch) => {
				const samples: number[] = [];
				let heap = 0;
				for (let k = 0; k < 5; k++) {
					const document = createDocument({
						value: { children: [{ id: 'A', type: 'paragraph', data: { rows: data } }] }
					});
					const h0 = process.memoryUsage().heapUsed;
					const t0 = performance.now();
					expect(document.facade.patchData('A', [patch]).status).toBe('applied');
					samples.push(performance.now() - t0);
					heap = Math.max(heap, process.memoryUsage().heapUsed - h0);
					document.destroy();
				}
				samples.sort((x, y) => x - y);
				return `${samples[2]!.toFixed(1)} ms, +${(heap / 2 ** 20).toFixed(0)} MB`;
			};
			const reverse = Array.from({ length: n }, (_, i) => n - 1 - i);
			const assign = time({ path: ['rows'], value: next });
			rows.push(`${n}: assign ${assign}; reverse ${time({ path: ['rows'], order: reverse })}`);
		}
		process.stderr.write(`${rows.join('\n')}\n`);
	});
});
