/**
 * Fork patch YP25 (UPSTREAM.md): a paired mark's value is written in parts —
 * flags, the Lamport stamp, the operation id only where it is not the item's
 * own (a start) or its own client's (an end), the value only where it is
 * neither `true` nor `null` — and any other format value whole. Every shape
 * reads back as written: through `applyUpdate`, `decodeUpdate`,
 * `mergeUpdates` and `diffUpdate`, and the same store gives the same bytes.
 */
// @ts-nocheck -- drives the vendored engine's plain JS directly.
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { ContentFormat } from '../../lib/crdt/vendor/yjs/src/structs/Item.js';
import { storedOf } from './harness/stored.js';

const START = '\u0001';
const END = '\u0002';

/** The format items of `doc`'s text `t`, as `[key, value]`. */
const formats = (doc) => {
	const out = [];
	for (let it = doc.get('t')._start; it !== null; it = it.right)
		if (it.content instanceof ContentFormat) out.push([it.content.key, it.content.value]);
	return out;
};

/** A document whose text holds format items of every shape, a few written by hand. */
const sample = () => {
	const doc = new Y.Doc();
	doc.clientID = 77;
	const t = doc.get('t');
	t.insert(0, 'hello world, a third run of text');
	t.mark(0, 5, 'bold', true, 0, 1);
	t.mark(6, 5, 'link', 'https://example.com/a', 1, 0);
	t.mark(2, 6, 'bold', null, 0, 1);
	t.mark(12, 4, 'comment', { id: 'c1', at: [1, 2] }, 0, 0);
	// A redo's copy keeps the original operation id (not its own); an end
	// naming another writer's start; values of another shape (a plain
	// format, a start with a negative stamp, an end with three sides).
	doc.transact((tr) => {
		const hand = [
			[`${START}italic`, [true, 9, 12345, 3, 0]],
			[`${END}italic`, [12345, 3, 1]],
			[`${START}code`, [false, 4, 77, 0, 1]],
			['plain', { b: true }],
			[`${START}x`, [true, -1, 77, 2, 0]],
			[`${END}x`, [77, 2, 2]],
			[`${END}y`, [77, 100000, 0]]
		];
		for (const [key, value] of hand) {
			const right = t._start;
			const item = new Y.Item(
				Y.createID(77, doc.store.getClock(77)),
				null,
				null,
				right,
				right.id,
				t,
				null,
				new ContentFormat(key, value)
			);
			item.integrate(tr, 0);
		}
	});
	return doc;
};

describe('YP25 — paired marks written in parts', () => {
	it('every shape reads back as written, through every path that decodes', () => {
		const doc = sample();
		const want = formats(doc);
		expect(want.length).toBe(15);
		const update = Y.encodeStateAsUpdate(doc);
		const back = new Y.Doc();
		Y.applyUpdate(back, update);
		expect(formats(back)).toEqual(want);
		const decoded = Y.decodeUpdate(update).structs.flatMap((s) =>
			s.content instanceof ContentFormat ? [[s.content.key, s.content.value]] : []
		);
		expect(decoded.sort()).toEqual([...want].sort());
		// A merge of two halves and a diff against an empty state re-encode every struct.
		const empty = Y.encodeStateVector(new Y.Doc());
		const merged = new Y.Doc();
		Y.applyUpdate(merged, Y.mergeUpdates([Y.diffUpdate(update, empty), update]));
		expect(formats(merged)).toEqual(want);
		expect(storedOf(Y, merged)).toBe(storedOf(Y, doc));
		expect(Buffer.from(Y.encodeStateAsUpdate(back)).equals(Buffer.from(update))).toBe(true);
	});

	it('a mark costs a few bytes: its own id and its start are implied', () => {
		const doc = new Y.Doc();
		doc.clientID = 2 ** 52 + 7; // a 53-bit client id (a float64 inside a JSON value)
		const t = doc.get('t');
		t.insert(0, 'x'.repeat(200));
		const before = Y.encodeStateAsUpdate(doc).length;
		for (let i = 0; i < 20; i++) t.mark(i * 10, 5, 'bold', true, 0, 1);
		const perMark = (Y.encodeStateAsUpdate(doc).length - before) / 20;
		// Two items (a start and an end) with their headers: was 66 bytes.
		expect(perMark).toBeLessThan(26);
	});
});
