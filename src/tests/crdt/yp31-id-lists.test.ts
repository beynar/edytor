/**
 * Vendored-engine patch YP31 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a hold
 * record (YP20's `ContentHold`, content ref 11) holds what it names only as
 * an entry of a root's sequence (the document's records list). Inside a
 * nested node's sequence it is a list of ids in the same codec that holds
 * nothing: writing it, deleting it, merging it, splitting it and receiving it
 * before the items it names leave every item as it was. Edytor's shared
 * suggestions keep their proposals and decisions in such lists.
 *
 * Expected values come from that rule, never from running code.
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
const text = (doc) => t(doc).toString();
/** The nested list (a node under a root map), created by `doc`. */
const nested = (doc) => {
	const root = doc.get('suggest');
	let node = root.getAttr('s');
	if (node === undefined) {
		doc.transact(() => root.setAttr('s', new Y.Node('suggestion')));
		node = root.getAttr('s');
	}
	return node;
};
const sync = (from, to) =>
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
const reload = (doc) => {
	const copy = new Y.Doc();
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return copy;
};
/** The id triples of the live entries of `list`. */
const ids = (list) => {
	const out = [];
	for (let it = list._start; it !== null; it = it.right)
		if (!it.deleted) for (const triple of it.content.getContent()) out.push([...triple]);
	return out;
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

describe('YP31 — a hold record inside a nested node holds nothing', () => {
	it('written, the items it names still show; the root records list still holds', () => {
		const [a] = seeded('abcdef', 2);
		const logs = [];
		a.on('commit', (tr) => logs.push([...tr.holds]));
		nested(a).hold([1, 1, 2]);
		expect(text(a)).toBe('abcdef');
		expect(t(a).length).toBe(6);
		// Nothing hidden: the item it names is logged with no length (YP32), its text re-read.
		expect(logs.at(-1)).toEqual([1, 0, 0]);
		expect(ids(nested(a))).toEqual([[1, 1, 2]]);
		// The same ids in the root records list are a hold (YP20, unchanged).
		a.get('textdel').hold([1, 1, 2]);
		expect(text(a)).toBe('adef');
	});

	it('deleted, it releases nothing a root record holds', () => {
		const [a] = seeded('abcdef', 2);
		a.get('textdel').hold([1, 2, 1]);
		nested(a).hold([1, 2, 1]);
		expect(text(a)).toBe('abdef');
		a.transact(() => nested(a).delete(0, 1));
		expect(ids(nested(a))).toEqual([]);
		expect(text(a)).toBe('abdef');
	});

	it('consecutive entries of one writer merge into one item; a delete of one splits it', () => {
		const [a] = seeded('abcdef', 2);
		const list = nested(a);
		list.hold([1, 5, 1]);
		list.hold([1, 4, 1]);
		list.hold([1, 3, 1]);
		expect(list._start.length).toBe(3);
		expect(list._start.right).toBe(null);
		a.transact(() => list.delete(1, 1));
		expect(ids(list)).toEqual([
			[1, 5, 1],
			[1, 3, 1]
		]);
		expect(text(a)).toBe('abcdef');
	});

	it('a peer and a reload read the same entries; nothing they name is hidden', () => {
		const [a, b] = seeded('abcdef', 2, 3);
		nested(a).hold([1, 0, 3]);
		sync(a, b);
		expect(ids(nested(b))).toEqual([[1, 0, 3]]);
		expect(text(b)).toBe('abcdef');
		const copy = reload(a);
		expect(ids(nested(copy))).toEqual([[1, 0, 3]]);
		expect(text(copy)).toBe('abcdef');
	});

	it('received before the items it names, it waits for nothing and holds nothing when they arrive', () => {
		const author = mk(1);
		t(author).insert(0, 'abc');
		const writer = mk(2);
		// The writer names the author's items it has not received.
		nested(writer).hold([1, 0, 2]);
		const reader = mk(3);
		sync(writer, reader);
		expect(reader.store.pendingHolds).toBe(null);
		expect(reader.store.pendingStructs).toBe(null);
		sync(author, reader);
		expect(text(reader)).toBe('abc');
		expect(ids(nested(reader))).toEqual([[1, 0, 2]]);
	});

	it('the node deleted with its entries leaves the text as it was', () => {
		const [a] = seeded('abcdef', 2);
		nested(a).hold([1, 0, 6]);
		a.transact(() => a.get('suggest').deleteAttr('s'));
		expect(text(a)).toBe('abcdef');
		expect(text(reload(a))).toBe('abcdef');
	});
});
