/**
 * Vendored-engine patch YP33 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a
 * transaction logs what it did to items, in order, in one log
 * (`transaction.log`: per run of one writer's items `kind, client, clock,
 * len`; an item that continues the last entry extends it): kind 0 an edit
 * (integrated `+len`, removed `-len`; an item integrated removed logs none),
 * kind 1 a hold record's (YP20: shown `+len`, hidden `-len`; a removed held
 * item is logged shown, so its kinds 0 and 1 sum to its visibility change),
 * kind 2 a mover change (YP22).
 *
 * Expected values come from that rule, never from running code. The index
 * fold that reads the log is covered by the index's self-checks.
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
const seeded = (content: string | unknown[], client: number) => {
	const seed = mk(1);
	t(seed).insert(0, content);
	const doc = mk(client);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
	return doc;
};
/** The log of each transaction `fn` runs in `doc`. */
const logsOf = (doc, fn: () => void) => {
	const logs = [];
	const on = (tr) => logs.push([...tr.log]);
	doc.on('commit', on);
	fn();
	doc.off('commit', on);
	return logs;
};

describe('YP33 — one log of what a transaction did to items', () => {
	it('edits: an insert logs its units, a delete their removal, in order', () => {
		const a = seeded('abc', 2);
		const logs = logsOf(a, () =>
			a.transact(() => {
				t(a).insert(1, 'xy'); // client 2, clocks 0..1
				t(a).delete(0, 1); // a: client 1, clock 0
			})
		);
		expect(logs).toEqual([[0, 2, 0, 2, 0, 1, 0, -1]]);
	});

	it('holds: a held delete logs the hold and its record; a held item removed logs its give-back', () => {
		const a = seeded('abc', 2);
		let logs = logsOf(a, () => t(a).delete(1, 1, a.get('textdel')));
		// The record (2:0) is logged as it integrates, then the hold it makes on b (1:1).
		expect(logs).toEqual([[0, 2, 0, 1, 1, 1, 1, -1]]);
		const b = t(a)._start.right;
		logs = logsOf(a, () => a.transact((tr) => b.delete(tr)));
		expect(logs).toEqual([[1, 1, 1, 1, 0, 1, 1, -1]]);
		expect(t(a).toString()).toBe('ac');
	});

	it('moves: a record logs itself, then the units it moves', () => {
		const a = seeded(['a', 'b', 'c'], 2);
		const logs = logsOf(a, () => t(a).move(3, [1, 1, 1])); // b after c
		expect(logs).toEqual([[0, 2, 0, 1, 2, 1, 1, 1]]);
	});

	it('a run of one writer: an item that continues the last entry (kind, client, next clock, sign) extends it', () => {
		const a = seeded('abcd', 2);
		const logs = logsOf(a, () =>
			a.transact(() => {
				t(a).insert(4, 'x'); // 2:0
				t(a).insert(5, 'y'); // 2:1, continues 2:0
				t(a).delete(0, 1); // 1:0
				t(a).delete(0, 1); // 1:1, continues 1:0
				t(a).insert(0, 'z'); // 2:2: the last entry is a removal
			})
		);
		expect(logs).toEqual([[0, 2, 0, 2, 0, 1, 0, -2, 0, 2, 2, 1]]);
	});

	it('a remote update logs what it integrates and removes; an item integrated removed logs none', () => {
		const a = mk(2);
		t(a).insert(0, 'ab');
		t(a).delete(0, 1);
		// a's 'a' is collected: an update from a carries it removed.
		const b = mk(3);
		const logs = logsOf(b, () => Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote'));
		expect(logs).toEqual([[0, 2, 1, 1]]);
		const c = seeded('ab', 4);
		const d = mk(6);
		Y.applyUpdate(d, Y.encodeStateAsUpdate(c));
		t(c).delete(1, 1);
		expect(logsOf(d, () => Y.applyUpdate(d, Y.encodeStateAsUpdate(c), 'remote'))).toEqual([
			[0, 1, 1, -1]
		]);
	});
});
