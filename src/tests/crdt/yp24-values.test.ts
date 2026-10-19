/**
 * Fork patches YP24 and YP28 (UPSTREAM.md): a content value is written in
 * lib0's `writeAny` layout with its strings and object keys through the
 * update's string table (YP24), an integer past 31 bits as a varint, and a
 * pair of such an integer and a clock (an item id, a block slot's split key)
 * with its first through the client table (YP28). Every value reads back as
 * written, whatever its shape, and a repeated string costs one table entry.
 */
// @ts-nocheck -- drives the vendored engine's plain JS directly.
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { storedOf } from './harness/stored.js';

const VALUES = [
	'paragraph',
	'',
	'é ⚡ 𝄞',
	0,
	-1,
	2 ** 31 - 1,
	2 ** 31,
	2 ** 32 + 5,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 2,
	-(2 ** 40),
	0.5,
	Math.PI,
	true,
	false,
	null,
	[],
	[1, 2],
	[2 ** 40, 7],
	[2 ** 40, -1],
	[2 ** 40, 0.5],
	[2 ** 40, 7, 8],
	{ b: 'b_x', s: [2 ** 52 + 3, 41] },
	{ s: 'b_x', n: 3448763008 },
	{ m: 'b_y' },
	{ nested: { deep: ['paragraph', { paragraph: 'paragraph' }] }, '': 1, __proto__x: 2 },
	new Uint8Array([1, 2, 3])
];

describe('YP24, YP28 — content values through the update tables', () => {
	it('every value reads back as written, through every path that decodes', () => {
		const doc = new Y.Doc();
		doc.clientID = 2 ** 52 + 3;
		const list = doc.get('list');
		list.insert(0, VALUES);
		const map = doc.get('map');
		VALUES.forEach((v, i) => map.setAttr(`k${i}`, v));
		const update = Y.encodeStateAsUpdate(doc);
		const back = new Y.Doc();
		Y.applyUpdate(back, update);
		expect(back.get('list').toArray()).toEqual(VALUES);
		VALUES.forEach((v, i) => expect(back.get('map').getAttr(`k${i}`)).toEqual(v));
		const merged = new Y.Doc();
		Y.applyUpdate(
			merged,
			Y.mergeUpdates([Y.diffUpdate(update, Y.encodeStateVector(new Y.Doc())), update])
		);
		expect(storedOf(Y, merged)).toBe(storedOf(Y, doc));
		expect(Buffer.from(Y.encodeStateAsUpdate(back)).equals(Buffer.from(update))).toBe(true);
	});

	it('a repeated string and a repeated key cost one table entry', () => {
		const doc = new Y.Doc();
		doc.clientID = 9;
		const map = doc.get('map');
		map.setAttr('first', { type: 'paragraph-with-a-long-name' });
		const one = Y.encodeStateAsUpdate(doc).length;
		for (let i = 0; i < 100; i++) map.setAttr(`k${i}`, { type: 'paragraph-with-a-long-name' });
		const perEntry = (Y.encodeStateAsUpdate(doc).length - one) / 100;
		// A key `k<i>` of its own, and a reference to "type" and to the value.
		expect(perEntry).toBeLessThan(12);
	});
});
