/**
 * Vendored-engine patch YP20 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a text
 * delete is a hold record. A record (`ContentHold`, content ref 11) names id
 * ranges; while it is live the items it names read as deleted, and deleting
 * the record shows them again. An item is visible iff it is not removed and no
 * live record holds it — a function of the replicated state (the items, the
 * delete set, the records and the deleted records), so replicas converge in
 * any delivery order.
 *
 * Expected values come from that rule, never from running code. The edytor
 * rows (the double delete, undo order, another author's text) are
 * `arch-v2/text-delete-marks.test.ts` and the contract programs.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { mulberry32 } from './harness/rng.js';

const mk = (client: number) => {
	const doc = new Y.Doc();
	doc.clientID = client;
	return doc;
};
const t = (doc) => doc.get('t');
const records = (doc) => doc.get('textdel');
const text = (doc) => t(doc).toString();
/** Everything `from` holds that `to` lacks. */
const sync = (from, to) =>
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
/** The live records of `doc`: `[item, unit]` per record. */
const live = (doc) => {
	const out = [];
	for (let it = records(doc)._start; it !== null; it = it.right)
		if (!it.deleted) for (let j = 0; j < it.length; j++) out.push([it, j]);
	return out;
};
/**
 * Delete record `j` of struct `it` (an undo of that delete), by id: the
 * records list's markers go, as a history's replay drops them.
 */
const release = (doc, [it, j]) =>
	doc.transact((tr) => {
		const ids = Y.createIdSet();
		ids.add(it.id.client, it.id.clock + j, 1);
		Y.iterateStructsByIdSet(tr, ids, (s) => s.delete(tr));
		if (records(doc)._searchMarker) records(doc)._searchMarker.length = 0;
	});
const reload = (doc) => {
	const copy = new Y.Doc();
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return copy;
};
const seeded = (s: string, ...clients: number[]) => {
	const seed = mk(1);
	t(seed).insert(0, s);
	const state = Y.encodeStateAsUpdate(seed);
	return clients.map((c) => {
		const doc = mk(c);
		Y.applyUpdate(doc, state);
		return doc;
	});
};

describe('YP20 — a hold record hides, its delete shows the same items', () => {
	it('one record: hidden, length and log; deleting it shows the item in place', () => {
		const [a] = seeded('abc', 2);
		const logs = [];
		a.on('commit', (tr) => logs.push([...tr.holds]));
		t(a).delete(1, 1, records(a));
		expect(text(a)).toBe('ac');
		expect(t(a).length).toBe(2);
		expect(logs.at(-1)).toEqual([1, 1, -1]);
		const b = t(a)._start.right;
		expect([b.deleted, b.removed, b.holds]).toEqual([true, false, 1]);
		release(a, live(a)[0]);
		expect(text(a)).toBe('abc');
		expect(logs.at(-1)).toEqual([1, 1, 1]);
		// The same item: no copy.
		expect(t(a)._start.right).toBe(b);
		expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(reload(a)));
	});

	it('two writers hold one character: it shows only once both records are gone, in any order', () => {
		for (const first of ['a', 'b']) {
			const [a, b] = seeded('abc', 2, 3);
			t(a).delete(1, 1, records(a));
			t(b).delete(1, 1, records(b));
			if (first === 'a') sync(a, b);
			sync(b, a);
			sync(a, b);
			expect([text(a), text(b)]).toEqual(['ac', 'ac']);
			release(
				a,
				live(a).find(([it]) => it.id.client === 2)
			);
			sync(a, b);
			expect([text(a), text(b)]).toEqual(['ac', 'ac']);
			release(
				b,
				live(b).find(([it]) => it.id.client === 3)
			);
			sync(b, a);
			expect([text(a), text(b), text(reload(a))]).toEqual(['abc', 'abc', 'abc']);
			expect(Y.encodeStateAsUpdate(a)).toEqual(Y.encodeStateAsUpdate(b));
		}
	});

	it('overlapping records: each item counts the records that hold it', () => {
		const [a] = seeded('abcdef', 2);
		t(a).delete(1, 4, records(a)); // bcde
		records(a).hold([1, 2, 2]); // cd, again
		expect(text(a)).toBe('af');
		const [r1, r2] = live(a);
		release(a, r1);
		expect(text(a)).toBe('abef');
		release(a, r2);
		expect(text(a)).toBe('abcdef');
	});

	it('a peer’s insert inside a held run is its own text: a release shows both, in YATA order', () => {
		const [a, b] = seeded('abcd', 2, 3);
		t(a).delete(1, 2, records(a)); // bc
		sync(a, b);
		t(b).insert(1, 'X'); // b sees "ad": X right after a
		sync(b, a);
		expect([text(a), text(b)]).toEqual(['aXd', 'aXd']);
		release(a, live(a)[0]);
		sync(a, b);
		expect(text(a)).toBe(text(b));
		expect(text(a).replace('X', '')).toBe('abcd');
	});
});

describe('YP20 — causality, storage and collection', () => {
	it('a record integrates at once; what it names that has not arrived takes the hold when it does', () => {
		const [a, b, c] = seeded('ab', 2, 3, 4);
		t(c).insert(2, 'x');
		sync(c, b);
		t(b).delete(2, 1, records(b)); // b holds c's x
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(c)), 'remote');
		expect(a.store.pendingStructs).toBeNull();
		expect(a.store.pendingHolds.get(4)).toEqual([0, 1, 1]);
		expect(live(a)).toHaveLength(1);
		let log;
		a.on('commit', (tr) => (log = [...tr.holds]));
		sync(c, a);
		expect(a.store.pendingHolds).toBeNull();
		expect(log).toEqual([4, 0, -1]);
		expect(text(a)).toBe('ab');
		let x = t(a)._start;
		while (x.id.client !== 4) x = x.right;
		expect([x.holds, x.deleted, x.removed]).toEqual([1, true, false]);
		// Released before its items arrive: nothing is left to apply.
		const [d] = seeded('ab', 5);
		Y.applyUpdate(d, Y.encodeStateAsUpdate(b, Y.encodeStateVector(c)), 'remote');
		release(d, live(d)[0]);
		expect(d.store.pendingHolds.get(4)).toEqual([0, 1, 1, 0, 1, -1]);
		sync(c, d);
		expect([text(d), d.store.pendingHolds]).toEqual(['abx', null]);
	});

	it('updates holding records merge, diff and reload as the state does', () => {
		const [a] = seeded('hello world', 2);
		const updates = [];
		a.on('update', (u) => updates.push(u));
		for (let i = 0; i < 5; i++) t(a).delete(10 - i, 1, records(a));
		t(a).insert(0, '>');
		t(a).delete(2, 2, records(a));
		const fresh = mk(9);
		Y.applyUpdate(fresh, Y.encodeStateAsUpdate(seeded('hello world', 5)[0]));
		Y.applyUpdate(fresh, Y.mergeUpdates(updates));
		expect(text(fresh)).toBe(text(a));
		expect(text(a)).toBe('>hlo ');
		const half = mk(10);
		Y.applyUpdate(half, Y.encodeStateAsUpdate(seeded('hello world', 6)[0]));
		Y.applyUpdate(half, Y.mergeUpdates(updates.slice(0, 3)));
		Y.applyUpdate(half, Y.diffUpdate(Y.mergeUpdates(updates), Y.encodeStateVector(half)));
		expect(text(half)).toBe(text(a));
		// A backspace run is one struct of five records.
		expect(live(a)).toHaveLength(6);
		expect(new Set(live(a).map(([it]) => it)).size).toBe(2);
	});

	it('a held item keeps its content; a removed one is collected; a removed held item logs its own give-back', () => {
		const [a] = seeded('abc', 2);
		t(a).delete(1, 1, records(a));
		const b = t(a)._start.right;
		expect(b.content.constructor.name).toBe('ContentString');
		expect(text(reload(a))).toBe('ac');
		let log;
		a.on('commit', (tr) => (log = { holds: [...tr.holds], removed: tr.deleteSet.has(1, 1) }));
		a.transact((tr) => b.delete(tr)); // the purge's delete
		expect(log).toEqual({ holds: [1, 1, 1], removed: true });
		expect(b.content.constructor.name).toBe('ContentDeleted');
		expect(t(a).length).toBe(2);
		release(a, live(a)[0]);
		expect(text(a)).toBe('ac');
		expect(text(reload(a))).toBe('ac');
	});
});

describe('YP20 — the held delete', () => {
	it('`fresh` units are removed, the others held: a mixed item splits where freshness changes', () => {
		const [a] = seeded('abc', 2);
		t(a).insert(3, 'de'); // client 2, clocks 0..1
		const fresh = Y.createIdSet();
		fresh.add(2, 1, 1); // 'e'
		let deletes;
		a.on('commit', (tr) => (deletes = tr.deleteSet));
		t(a).delete(1, 4, records(a), fresh); // b c d e
		expect(text(a)).toBe('a');
		expect(deletes.has(2, 1)).toBe(true);
		expect(deletes.has(2, 0)).toBe(false);
		expect(live(a).map(([it, j]) => it.content.ids.slice(j * 3, j * 3 + 3))).toEqual([
			[1, 1, 2],
			[2, 0, 1]
		]);
		release(a, live(a)[1]);
		expect(text(a)).toBe('ad');
	});

	it.each([2020, 7, 99])(
		'search markers (seed %i): holds at random places read and write as with markers off (byte-identical)',
		(seed) => {
			const rand = mulberry32(seed);
			const [a, b] = seeded('the quick brown fox jumps over the lazy dog '.repeat(8), 2, 2);
			t(b)._searchMarker = null;
			for (let step = 0; step < 300; step++) {
				const len = t(a).length;
				const at = Math.floor(rand() * (len + 1));
				const r = rand();
				const n = 1 + Math.floor(rand() * 3);
				for (const doc of [a, b]) {
					if (r < 0.45 && len > 0) {
						const i = Math.min(at, len - 1);
						t(doc).delete(i, Math.min(n, len - i), records(doc));
					} else if (r < 0.6 && live(doc).length > 0)
						release(doc, live(doc)[Math.floor(step % live(doc).length)]);
					else t(doc).insert(at, String.fromCharCode(97 + (step % 26)));
				}
				expect(text(a), `step ${step}`).toBe(text(b));
				expect(Y.encodeStateAsUpdate(a)).toEqual(Y.encodeStateAsUpdate(b));
			}
		}
	);
});
