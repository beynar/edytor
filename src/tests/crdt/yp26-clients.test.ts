/**
 * Fork patch YP26 (UPSTREAM.md): an update writes each client id once, in a
 * table of its own, and an index wherever an id names a client (the struct
 * sections, the origins, the parents, the delete set). What many sessions
 * store reads back as written, through `applyUpdate`, `decodeUpdate`,
 * `mergeUpdates` and `diffUpdate`, and a session costs its id once.
 */
// @ts-nocheck -- drives the vendored engine's plain JS directly.
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { storedOf } from './harness/stored.js';

/** `n` replicas (53-bit client ids) typing into, deleting from and syncing one text. */
const sessions = (n: number) => {
	const docs = Array.from({ length: n }, (_, i) => {
		const doc = new Y.Doc();
		doc.clientID = 2 ** 52 + i * 7919;
		return doc;
	});
	for (let round = 0; round < 3; round++)
		docs.forEach((doc, i) => {
			const t = doc.get('t');
			t.insert(Math.min(i, t.length), `s${i}r${round} `);
			if (t.length > 6) t.delete(1, 2);
			doc.get('m').setAttr(`k${i}`, { by: i, round });
			const next = docs[(i + 1) % docs.length];
			Y.applyUpdate(next, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(next)));
		});
	for (const a of docs)
		for (const b of docs)
			if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
	return docs;
};

describe('YP26 — one client table per update', () => {
	it('what many sessions store reads back as written, through every path that decodes', () => {
		const docs = sessions(12);
		const want = storedOf(Y, docs[0]);
		for (const doc of docs) expect(storedOf(Y, doc)).toBe(want);
		const update = Y.encodeStateAsUpdate(docs[0]);
		const { ds } = Y.decodeUpdate(update);
		expect(ds.clients.size).toBeGreaterThan(1); // the delete set names several clients
		const back = new Y.Doc();
		Y.applyUpdate(back, update);
		expect(storedOf(Y, back)).toBe(want);
		const half = Y.diffUpdate(update, Y.encodeStateVector(docs[1]));
		const merged = new Y.Doc();
		Y.applyUpdate(merged, Y.mergeUpdates([Y.encodeStateAsUpdate(docs[1]), half]));
		expect(storedOf(Y, merged)).toBe(want);
	});

	it('a session costs its id once, however often its items are named', () => {
		const one = new Y.Doc();
		one.clientID = 2 ** 52 + 1;
		const t = one.get('t');
		const other = new Y.Doc();
		other.clientID = 2 ** 52 + 2;
		// Two writers' runs interleaved: every origin names the other client.
		for (let i = 0; i < 200; i++) {
			const [doc, peer] = i % 2 ? [one, other] : [other, one];
			doc.get('t').insert(doc.get('t').length, 'ab');
			Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
		}
		const update = Y.encodeStateAsUpdate(one);
		const { structs } = Y.decodeUpdate(update);
		expect(structs.length).toBeGreaterThan(150);
		// 8 bytes a 53-bit id: the two ids once, not an id per struct.
		expect(update.length).toBeLessThan(structs.length * 6);
		expect(t.length).toBe(400);
	});

	it('an index past the table is refused', () => {
		// One section of client 5 holding one string item whose origin names index 4.
		const e = new Y.UpdateEncoder();
		encoding.writeVarUint(e.restEncoder, 1);
		encoding.writeVarUint(e.restEncoder, 1);
		e.writeClient(5);
		encoding.writeVarUint(e.restEncoder, 1);
		e.writeInfo(4 | 0x80);
		e.clientEncoder.write(4);
		e.leftClockEncoder.write(0);
		e.writeString('x');
		encoding.writeVarUint(e.restEncoder, 0);
		expect(() => Y.decodeUpdate(e.toUint8Array())).toThrow(/an unknown client/);
	});
});
