/**
 * Vendored-engine patch YP22 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a move
 * is a record. A record (`ContentMove`, content ref 12) is one countable unit
 * at its destination naming the units it moves; while it is live each named
 * unit shows at the record that wins its movers — the greatest `(priority,
 * client, clock)` — and is hidden at home (`deleted`), and deleting the record
 * hands the unit to the next record, else home. The state that decides a
 * unit's place is the items, the records and the deleted records, so replicas
 * converge in any delivery order.
 *
 * Expected values come from that rule, never from running code. The edytor
 * rows (blocks, arrays, cycles) are the placement and data tests.
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
/** Everything `from` holds that `to` lacks. */
const sync = (from, to) =>
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
const reload = (doc) => {
	const copy = new Y.Doc();
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return copy;
};
/** The items of `node`'s sequence, in order, with what they are. */
const items = (node) => {
	const out = [];
	for (let it = node._start; it !== null; it = it.right) out.push(it);
	return out;
};
/**
 * The sequence as it displays (the reader edytor's index is): each live
 * unit at home in order, a live record expanded to the units it wins.
 */
const shown = (doc, node = t(doc)) => {
	const out = [];
	for (const it of items(node)) {
		if (it.deleted) continue;
		if (it.content instanceof Y.ContentMove) {
			const ids = it.content.ids;
			for (let i = 0; i < ids.length; i += 3)
				for (let k = 0; k < ids[i + 2]; k++) {
					const unit = unitAt(doc, ids[i], ids[i + 1] + k);
					if (unit !== null && unit.item.mover === it && !unit.item.gone) out.push(unit.value);
				}
		} else if (it.content.arr !== undefined) out.push(...it.content.arr);
		else if (it.content.str !== undefined) out.push(...it.content.str);
	}
	return out;
};
/** The item holding unit `client:clock` and the value at it. */
const unitAt = (doc, client, clock) => {
	const structs = doc.store.clients.get(client);
	if (structs === undefined || clock >= doc.store.getClock(client)) return null;
	const item = structs[Y.findIndexSS(structs, clock)];
	if (!(item instanceof Y.Item)) return null;
	const at = clock - item.id.clock;
	const value = item.content.arr !== undefined ? item.content.arr[at] : item.content.str?.[at];
	return { item, value };
};
/** The id of the unit holding `value` in `node` (a slot written once). */
const idOf = (doc, value, node = t(doc)) => {
	for (const it of items(node)) {
		const arr = it.content.arr;
		if (arr === undefined) continue;
		const k = arr.indexOf(value);
		if (k >= 0) return [it.id.client, it.id.clock + k, 1];
	}
	throw new Error(`no unit ${value}`);
};
const ids = (doc, ...values) => {
	const node = typeof values.at(-1) === 'object' ? values.pop() : t(doc);
	return values.flatMap((v) => idOf(doc, v, node));
};
/** The live records of `doc`'s sequence. */
const records = (doc, node = t(doc)) =>
	items(node).filter((it) => !it.deleted && it.content instanceof Y.ContentMove);
/**
 * Delete record item `it` (an undo of that move), by id: its sequence's
 * markers go, as a history's replay drops them (`dropSearchMarkers`).
 */
const release = (doc, it) =>
	doc.transact((tr) => {
		const set = Y.createIdSet();
		set.add(it.id.client, it.id.clock, 1);
		Y.iterateStructsByIdSet(tr, set, (s) => s.delete(tr));
		if (it.parent._searchMarker) it.parent._searchMarker.length = 0;
	});
const seeded = (values: string[], ...clients: number[]) => {
	const seed = mk(1);
	t(seed).insert(0, values);
	const state = Y.encodeStateAsUpdate(seed);
	return clients.map((c) => {
		const doc = mk(c);
		Y.applyUpdate(doc, state);
		return doc;
	});
};
const state = (doc) => Y.encodeStateAsUpdate(doc);

describe('YP22 — a move record shows its units at the record, hidden at home', () => {
	it('one record: the unit shows at the destination, the home is shorter, the log names it', () => {
		const [a] = seeded(['a', 'b', 'c', 'd'], 2);
		const logs = [];
		a.on('commit', (tr) => logs.push([...tr.moves]));
		t(a).move(4, ids(a, 'b')); // b after d: a c d | R[b]
		expect(shown(a)).toEqual(['a', 'c', 'd', 'b']);
		// The record counts one unit; the moved unit none at home.
		expect(t(a).length).toBe(4);
		expect(logs.at(-1)).toEqual([1, 1, 1]);
		const { item } = unitAt(a, 1, 1);
		expect([item.deleted, item.removed, item.gone, item.mover]).toEqual([
			true,
			false,
			false,
			records(a)[0]
		]);
		// A writer's own record leaves the clock: its next records stay level with it.
		expect(a._clock).toBe(0);
		expect(records(a)[0].content.priority).toBe(1);
		// Deleting the record shows the unit at home again: the same item, no copy.
		release(a, records(a)[0]);
		expect(shown(a)).toEqual(['a', 'b', 'c', 'd']);
		expect(logs.at(-1)).toEqual([1, 1, 1]);
		expect(unitAt(a, 1, 1).item).toBe(item);
		expect(item.movers).toBeNull();
		expect(shown(reload(a))).toEqual(['a', 'b', 'c', 'd']);
	});

	it('a record never moves a record; a unit named twice by one record shows once', () => {
		const [a] = seeded(['a', 'b', 'c'], 2);
		t(a).move(3, ids(a, 'a'));
		const r = records(a)[0];
		// A later move naming the record and `a` again: the record is skipped.
		t(a).move(0, [r.id.client, r.id.clock, 1, ...ids(a, 'a')]);
		expect(shown(a)).toEqual(['a', 'b', 'c']);
		expect(records(a)).toHaveLength(2);
		expect(r.movers).toBeNull();
	});

	it('two writers move one unit: the greater (priority, client, clock) wins, in both orders; the loser is the fallback', () => {
		for (const first of ['a', 'b']) {
			const [a, b] = seeded(['x', 'y', 'z'], 2, 3);
			t(a).move(3, ids(a, 'x')); // a: y z x   (priority 1, client 2)
			t(b).move(2, ids(b, 'x')); // b: y x z   (priority 1, client 3)
			if (first === 'a') sync(a, b);
			sync(b, a);
			sync(a, b);
			expect(shown(a)).toEqual(['y', 'x', 'z']); // client 3 wins
			expect(shown(b)).toEqual(['y', 'x', 'z']);
			expect(state(a)).toEqual(state(b));
			// Undo b's move: a's record is the fallback.
			release(
				b,
				records(b).find((r) => r.id.client === 3)
			);
			sync(b, a);
			expect([shown(a), shown(b)]).toEqual([
				['y', 'z', 'x'],
				['y', 'z', 'x']
			]);
			// Undo a's too: home, in any order.
			release(
				a,
				records(a).find((r) => r.id.client === 2)
			);
			sync(a, b);
			expect([shown(a), shown(b), shown(reload(a))]).toEqual([
				['x', 'y', 'z'],
				['x', 'y', 'z'],
				['x', 'y', 'z']
			]);
		}
	});

	it('a move made after seeing another wins over it (Lamport), whatever the client ids', () => {
		const [a, b] = seeded(['x', 'y', 'z'], 9, 2);
		t(a).move(3, ids(a, 'x')); // a (client 9): y z x
		sync(a, b);
		expect(b._clock).toBe(1);
		t(b).move(0, ids(b, 'x')); // b (client 2) saw it: priority 2
		expect(records(b).find((r) => r.id.client === 2).content.priority).toBe(2);
		sync(b, a);
		expect([shown(a), shown(b)]).toEqual([
			['x', 'y', 'z'],
			['x', 'y', 'z']
		]);
	});

	it('a group move overlapping a single move resolves per unit', () => {
		for (const first of ['a', 'b']) {
			const [a, b] = seeded(['p', 'q', 'r', 's'], 2, 3);
			t(a).move(4, ids(a, 'p', 'q')); // a: r s p q
			t(b).move(0, ids(b, 'q')); // b: q p r s
			if (first === 'a') sync(a, b);
			sync(b, a);
			sync(a, b);
			// q: b's record (client 3) wins; p: only a's record.
			expect(shown(a)).toEqual(['q', 'r', 's', 'p']);
			expect(shown(b)).toEqual(['q', 'r', 's', 'p']);
			expect(state(a)).toEqual(state(b));
		}
	});

	it('a unit moved into another sequence shows there; its home sequence is shorter', () => {
		const [a] = seeded(['x', 'y'], 2);
		const u = a.get('u');
		u.insert(0, ['m']);
		u.move(1, ids(a, 'x'));
		expect(shown(a)).toEqual(['y']);
		expect(shown(a, u)).toEqual(['m', 'x']);
		expect([t(a).length, u.length]).toEqual([1, 2]);
		const copy = reload(a);
		expect([shown(copy), shown(copy, copy.get('u'))]).toEqual([['y'], ['m', 'x']]);
	});

	it('redo copies the record with its priority: a peer’s newer move still wins', () => {
		const [a, b] = seeded(['x', 'y', 'z'], 2, 3);
		t(a).move(3, ids(a, 'x')); // priority 1
		sync(a, b);
		t(b).move(0, ids(b, 'x')); // priority 2: x y z
		const undone = records(a).find((r) => r.id.client === 2);
		release(a, undone);
		// Redo: the record copied (as the history's redo does).
		a.transact((tr) => {
			const copy = Y.redoItem(tr, undone, new Set([undone]), Y.createIdSet());
			expect(copy.content.priority).toBe(1);
		});
		sync(b, a);
		sync(a, b);
		expect([shown(a), shown(b)]).toEqual([
			['x', 'y', 'z'],
			['x', 'y', 'z']
		]);
	});
});

describe('YP22 — a removed or held unit shows nowhere; a record waits for its units', () => {
	it('a removed moved unit shows at no record (delete wins), and the record counts it gone', () => {
		const [a] = seeded(['x', 'y', 'z'], 2);
		t(a).move(3, ids(a, 'x'));
		let log;
		a.on('commit', (tr) => (log = [...tr.moves]));
		const { item } = unitAt(a, 1, 0);
		a.transact((tr) => item.delete(tr)); // the purge's delete
		expect(log).toEqual([1, 0, 1]);
		expect([item.gone, item.removed, item.mover !== null]).toEqual([true, true, true]);
		expect(shown(a)).toEqual(['y', 'z']);
		expect(shown(reload(a))).toEqual(['y', 'z']);
		release(a, records(a)[0]);
		expect(shown(a)).toEqual(['y', 'z']);
	});

	it('a held moved unit is gone until released, then shows at its mover', () => {
		const [a] = seeded(['x', 'y', 'z'], 2);
		t(a).move(3, ids(a, 'x'));
		a.get('textdel').hold(ids(a, 'x'));
		expect(shown(a)).toEqual(['y', 'z']);
		const hold = items(a.get('textdel')).find((it) => !it.deleted);
		release(a, hold);
		expect(shown(a)).toEqual(['y', 'z', 'x']);
	});

	it('a record waits for the units it names, as an item waits for its origin; they show at it when they arrive', () => {
		const [a, b, c] = seeded(['x', 'y'], 2, 3, 4);
		t(c).insert(2, ['w']);
		sync(c, b);
		t(b).move(0, ids(b, 'w')); // b moves c's w to the front
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(c)), 'remote');
		expect(a.store.pendingStructs).not.toBeNull();
		expect(records(a)).toHaveLength(0);
		expect(shown(a)).toEqual(['x', 'y']);
		let log;
		a.on('commit', (tr) => (log = [...tr.moves]));
		sync(c, a);
		expect(a.store.pendingStructs).toBeNull();
		expect(log).toEqual([4, 0, 1]);
		expect(shown(a)).toEqual(['w', 'x', 'y']);
		expect(shown(reload(a))).toEqual(['w', 'x', 'y']);
	});

	it('a record waits while a skip stands for a unit it names: the gap fills first, then it sorts by the units', () => {
		// c writes w in the sequence, then q in another root sequence; a receives
		// q alone (a dropped message): a Skip stands for w in a's store, and the
		// clock counts it.
		const [a, b, c] = seeded(['x', 'y'], 2, 3, 4);
		t(c).insert(2, ['w']);
		c.get('u').insert(0, ['q']);
		sync(c, b);
		let moveUpdate;
		b.on('update', (u) => (moveUpdate = u));
		t(b).move(0, ids(b, 'w')); // b moves c's w to the front
		const sv = Y.decodeStateVector(Y.encodeStateVector(a));
		sv.set(4, 1);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(c, Y.encodeStateVector(sv)), 'remote');
		expect(a.store.getClock(4)).toBe(2);
		expect(a.store.skips.has(4, 0)).toBe(true);
		expect(shown(a)).toEqual(['x', 'y']);
		// b's record alone (its own update) names 4:0, which a's clock covers but
		// a skip stands for: it waits (a state-vector sync would fill the gap first).
		Y.applyUpdate(a, moveUpdate, 'remote');
		expect(a.store.pendingStructs).not.toBeNull();
		expect(records(a)).toHaveLength(0);
		expect(shown(a)).toEqual(['x', 'y']);
		let log;
		a.on('commit', (tr) => (log = [...tr.moves]));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(c), 'remote');
		expect(a.store.pendingStructs).toBeNull();
		expect(a.store.skips.isEmpty()).toBe(true);
		expect(log).toEqual([4, 0, 1]);
		expect(shown(a)).toEqual(['w', 'x', 'y']);
		expect(shown(reload(a))).toEqual(['w', 'x', 'y']);
		sync(a, c);
		expect(shown(c)).toEqual(['w', 'x', 'y']);
	});

	it('updates holding records merge, diff and reload as the state does; ref 12 is one unit', () => {
		const [a] = seeded(['a', 'b', 'c', 'd', 'e'], 2);
		const updates = [];
		a.on('update', (u) => updates.push(u));
		t(a).move(5, ids(a, 'a'));
		t(a).move(0, ids(a, 'e', 'd'));
		t(a).insert(2, ['f']);
		t(a).move(1, ids(a, 'c'));
		const fresh = mk(9);
		Y.applyUpdate(fresh, Y.encodeStateAsUpdate(seeded(['a', 'b', 'c', 'd', 'e'], 5)[0]));
		Y.applyUpdate(fresh, Y.mergeUpdates(updates));
		expect(shown(fresh)).toEqual(shown(a));
		const half = mk(10);
		Y.applyUpdate(half, Y.encodeStateAsUpdate(seeded(['a', 'b', 'c', 'd', 'e'], 6)[0]));
		Y.applyUpdate(half, Y.mergeUpdates(updates.slice(0, 2)));
		Y.applyUpdate(half, Y.diffUpdate(Y.mergeUpdates(updates), Y.encodeStateVector(half)));
		expect(shown(half)).toEqual(shown(a));
		for (const r of records(a)) expect(r.length).toBe(1);
		const { structs } = Y.decodeUpdate(Y.mergeUpdates(updates));
		expect(structs.filter((s) => s.content instanceof Y.ContentMove)).toHaveLength(3);
	});

	it('a record keeps its content when collected (its class orders concurrent inserts)', () => {
		const [a] = seeded(['x', 'y'], 2);
		t(a).move(2, ids(a, 'x'));
		const r = records(a)[0];
		release(a, r);
		expect(r.content).toBeInstanceOf(Y.ContentMove);
		expect(shown(reload(a))).toEqual(['x', 'y']);
	});
});

describe('YP22 — a record sorts after the slots of its origin, after-records before before-records, two records by their units’ home order', () => {
	it('two records at one gap moving units of one sequence: the units’ home order, whatever the client ids', () => {
		for (const [ca, cb] of [
			[2, 3],
			[3, 2]
		]) {
			const [a, b] = seeded(['p', 'x', 'y', 'z', 'q'], ca, cb);
			t(a).move(1, ids(a, 'z'), 1); // z leaves for the gap after p
			t(b).move(1, ids(b, 'x'), 1); // x too, at once
			sync(a, b);
			sync(b, a);
			expect(shown(a)).toEqual(['p', 'x', 'z', 'y', 'q']);
			expect(shown(b)).toEqual(['p', 'x', 'z', 'y', 'q']);
			expect(shown(reload(a))).toEqual(['p', 'x', 'z', 'y', 'q']);
		}
	});

	it('a record standing at a unit (`at`) sorts by that unit’s place, then its part, whatever the client ids', () => {
		for (const [ca, cb] of [
			[2, 3],
			[3, 2]
		]) {
			const [a, b] = seeded(['p', 'x', 'y', 'q'], ca, cb);
			const [c, k] = idOf(a, 'x');
			t(a).move(1, ids(a, 'y'), 1, 0, Y.createID(c, k)); // y leaves for the gap after p, standing at x (a head's part)
			t(b).move(1, ids(b, 'x'), 1, 3); // x leaves for the same gap, standing at itself
			sync(a, b);
			sync(b, a);
			expect(shown(a)).toEqual(['p', 'y', 'x', 'q']);
			expect(shown(b)).toEqual(['p', 'y', 'x', 'q']);
			expect(shown(reload(a))).toEqual(['p', 'y', 'x', 'q']);
			const r = records(a).find((it) => it.content.at !== null);
			expect([r.content.part, r.content.at.client, r.content.at.clock]).toEqual([0, c, k]);
		}
	});

	it('two records at one gap moving units of two sequences: the client id', () => {
		for (const [ca, cb] of [
			[2, 3],
			[3, 2]
		]) {
			const [a, b] = seeded(['p', 'x', 'y'], ca, cb);
			a.get('u').insert(0, ['m']);
			sync(a, b);
			t(a).move(1, ids(a, 'm', a.get('u')), 1); // m leaves u for the gap after p
			t(b).move(1, ids(b, 'y'), 1); // y leaves for the same gap
			sync(a, b);
			sync(b, a);
			// Incomparable units, equal parts and priorities: the stronger record (the greater client) first.
			const want = ca > cb ? ['p', 'm', 'y', 'x'] : ['p', 'y', 'm', 'x'];
			expect(shown(a)).toEqual(want);
			expect(shown(b)).toEqual(want);
		}
	});

	it('a slot and a record written at one gap by two writers: the slot first, whatever the client ids', () => {
		for (const [ca, cb] of [
			[2, 3],
			[3, 2]
		]) {
			const [a, b] = seeded(['x', 'y'], ca, cb);
			t(a).insert(1, ['n']); // a: x n y
			t(b).move(1, ids(b, 'y')); // b: x y (y moved to right after x)
			sync(a, b);
			sync(b, a);
			expect(shown(a)).toEqual(['x', 'n', 'y']);
			expect(shown(b)).toEqual(['x', 'n', 'y']);
		}
	});

	it('an after-record and a before-record at one gap: the after-record first', () => {
		for (const [ca, cb] of [
			[2, 3],
			[3, 2]
		]) {
			const [a, b] = seeded(['x', 'y', 'z', 'w'], ca, cb);
			t(a).move(1, ids(a, 'z'), 0); // leaving x for the gap after it
			t(b).move(1, ids(b, 'w'), 1); // leaving y for the gap before it
			sync(a, b);
			sync(b, a);
			expect(shown(a)).toEqual(['x', 'z', 'w', 'y']);
			expect(shown(b)).toEqual(['x', 'z', 'w', 'y']);
		}
	});
});

describe('YP22 — differentials', () => {
	it.each([2020, 7, 99])(
		'search markers (seed %i): moves, releases and inserts at random places read and write as with markers off',
		(seed) => {
			const rand = mulberry32(seed);
			const values = Array.from({ length: 40 }, (_, i) => `v${i}`);
			const [a, b] = seeded(values, 2, 2);
			t(b)._searchMarker = null;
			for (let step = 0; step < 300; step++) {
				const len = t(a).length;
				const r = rand();
				const at = Math.floor(rand() * (len + 1));
				const pick = rand();
				for (const doc of [a, b]) {
					const live = shown(doc);
					if (r < 0.45 && live.length > 0) {
						const v = live[Math.floor(pick * live.length)];
						doc.get('t').move(Math.min(at, doc.get('t').length), idOf(doc, v));
					} else if (r < 0.6 && records(doc).length > 0) {
						release(doc, records(doc)[Math.floor(pick * records(doc).length)]);
					} else doc.get('t').insert(Math.min(at, doc.get('t').length), [`s${step}`]);
				}
				expect(shown(a), `step ${step}`).toEqual(shown(b));
				expect(state(a)).toEqual(state(b));
			}
		}
	);

	it.each([11, 23])(
		'three replicas (seed %i): random moves and releases synced in random order converge',
		(seed) => {
			const rand = mulberry32(seed);
			const values = Array.from({ length: 12 }, (_, i) => `v${i}`);
			const docs = seeded(values, 2, 3, 4);
			for (let round = 0; round < 40; round++) {
				for (const doc of docs) {
					const live = shown(doc);
					const r = rand();
					if (r < 0.6 && live.length > 1) {
						const v = live[Math.floor(rand() * live.length)];
						t(doc).move(
							Math.floor(rand() * (t(doc).length + 1)),
							idOf(doc, v),
							rand() < 0.5 ? 0 : 1
						);
					} else if (records(doc).length > 0) {
						release(doc, records(doc)[Math.floor(rand() * records(doc).length)]);
					}
				}
				const order = [...docs].sort(() => rand() - 0.5);
				for (const x of order) for (const y of order) if (x !== y && rand() < 0.7) sync(x, y);
			}
			for (const x of docs) for (const y of docs) if (x !== y) sync(x, y);
			for (const d of docs) {
				expect(shown(d)).toEqual(shown(docs[0]));
				expect(new Set(shown(d)).size).toBe(shown(d).length);
				expect(shown(d).length).toBe(12);
			}
			expect(shown(reload(docs[0]))).toEqual(shown(docs[0]));
		}
	);
});
