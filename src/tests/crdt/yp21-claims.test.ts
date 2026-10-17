/**
 * Vendored-engine patch YP21 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a claim
 * item — a sequence unit `{ m }` — sorts after everything else among the items
 * of one origin (left-side mark items, content, right-side mark items, claim
 * items), and its content is never collected. So a boundary or text a
 * concurrent writer puts at a claim's origin lands before the claim, on every
 * pair of client ids and in both delivery orders.
 *
 * Expected values come from that rule, never from running code. The edytor
 * rows (a merge ‖ a split of the block it joins) are
 * `text/merge-claim-anchor.test.ts`.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';

const mk = (client: number) => {
	const doc = new Y.Doc();
	doc.clientID = client;
	return doc;
};
const t = (doc) => doc.get('t');
const sync = (from, to) =>
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
/** Every live unit of `doc`'s text, in order: a character, `[m]` a claim, `|s|` a boundary. */
const units = (doc) => {
	const out = [];
	for (let it = t(doc)._start; it !== null; it = it.right) {
		if (it.deleted || !it.countable) continue;
		const c = it.content;
		if (typeof c.str === 'string') out.push(...c.str);
		else
			for (const v of c.arr)
				out.push(
					typeof v?.m === 'string' ? `[${v.m}]` : typeof v?.s === 'string' ? `|${v.s}|` : '?'
				);
	}
	return out.join('');
};
/** Two replicas of "hello" (written by client 1) under clients `a` and `b`. */
const pair = (a: number, b: number) => {
	const seed = mk(1);
	t(seed).insert(0, 'hello');
	const state = Y.encodeStateAsUpdate(seed);
	return [a, b].map((c) => {
		const doc = mk(c);
		Y.applyUpdate(doc, state);
		return doc;
	});
};
const PAIRS = [
	[2, 3],
	[3, 2],
	[7, 50],
	[50, 7]
];

/** `x` on replica A ‖ `y` on replica B, delivered both ways in both orders: the converged units. */
const race = (x, y) => {
	const out = new Set<string>();
	for (const [a, b] of PAIRS)
		for (const first of [0, 1]) {
			const [A, B] = pair(a, b);
			x(A);
			y(B);
			if (first === 0) {
				sync(A, B);
				sync(B, A);
			} else {
				sync(B, A);
				sync(A, B);
			}
			expect(units(A)).toBe(units(B));
			out.add(units(A));
		}
	return [...out];
};
const claim = (doc, at = 5, m = 'Y') => t(doc).insertAtGapEnd(at, [{ m }]);

describe('YP21 — a claim item sorts after what a concurrent writer puts at its origin', () => {
	it('a boundary at the claim’s gap goes before it', () =>
		expect(race(claim, (doc) => t(doc).insertAtGapEnd(5, [{ s: 'N', n: 1 }]))).toEqual([
			'hello|N|[Y]'
		]));

	it('text typed at the claim’s gap goes before it', () =>
		expect(race(claim, (doc) => t(doc).insertInGap(5, '!'))).toEqual(['hello![Y]']));

	it('text typed after the first typed character stays before it too', () =>
		expect(
			race(claim, (doc) => {
				t(doc).insertInGap(5, '!');
				t(doc).insertInGap(6, '?');
			})
		).toEqual(['hello!?[Y]']));

	it('a split before the claim’s gap leaves the claim in the last piece', () =>
		expect(race(claim, (doc) => t(doc).insertAtGapEnd(2, [{ s: 'N', n: 1 }]))).toEqual([
			'he|N|llo[Y]'
		]));

	it('a mark ending at the claim’s gap, on either side, ends before it', () => {
		for (const side of [0, 1])
			for (const doc of race(claim, (d) => t(d).mark(0, 5, 'b', true, 0, side))) {
				expect(doc).toBe('hello[Y]');
			}
		const [A, B] = pair(2, 3);
		claim(A);
		t(B).mark(0, 5, 'b', true, 0, 1);
		sync(A, B);
		const kinds = [];
		for (let it = t(B)._start; it !== null; it = it.right)
			kinds.push(it.content.constructor.name === 'ContentAny' ? 'claim' : it.countable ? 'c' : 'f');
		expect(kinds.lastIndexOf('f')).toBeLessThan(kinds.indexOf('claim'));
	});

	it('two claims at one gap order by client id, as two inserts do', () =>
		expect(race(claim, (doc) => claim(doc, 5, 'Z'))).toEqual(['hello[Y][Z]', 'hello[Z][Y]']));

	it('a writer who saw the claim types before it (its insert’s right origin is the claim)', () => {
		const [A, B] = pair(2, 3);
		claim(A);
		sync(A, B);
		t(B).insertInGap(5, '!');
		sync(B, A);
		expect(units(A)).toBe('hello![Y]');
		expect(units(B)).toBe('hello![Y]');
	});
});

describe('YP21 — collection and other items', () => {
	it('a deleted, collected claim item keeps its content; a deleted character does not', () => {
		const doc = mk(2);
		t(doc).insert(0, 'ab');
		claim(doc, 2);
		t(doc).delete(0, 3);
		const kinds = [];
		for (let it = t(doc)._start; it !== null; it = it.right)
			kinds.push(it.content.constructor.name);
		expect(kinds).toContain('ContentAny');
		expect(kinds).toContain('ContentDeleted');
		expect(kinds).not.toContain('ContentString');
	});

	it('a JSON unit without `m`, and a map value with one, keep upstream’s order (by client id)', () => {
		const plain = race(
			(doc) => t(doc).insertAtGapEnd(5, [{ x: 'Y' }]),
			(doc) => t(doc).insertAtGapEnd(5, [{ s: 'N', n: 1 }])
		);
		expect(plain.sort()).toEqual(['hello?|N|', 'hello|N|?']);
		const winners = new Set();
		for (const [a, b] of PAIRS) {
			const [A, B] = pair(a, b);
			A.get('m').setAttr('k', { m: 'A' });
			B.get('m').setAttr('k', 'B');
			sync(A, B);
			sync(B, A);
			expect(A.get('m').getAttr('k')).toEqual(B.get('m').getAttr('k'));
			// The larger client's value wins, as upstream's map: a value `{m}` has no class of its own.
			expect(A.get('m').getAttr('k')).toEqual(a > b ? { m: 'A' } : 'B');
			winners.add(JSON.stringify(A.get('m').getAttr('k')));
		}
		expect(winners.size).toBe(2);
	});
});
