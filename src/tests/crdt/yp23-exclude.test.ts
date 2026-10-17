/**
 * Vendored-engine patch YP23 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): an
 * update's block set is trimmed to what the store lacks before it integrates
 * (`BlockSet.exclude`, upstream v14). Upstream read the first and last struct
 * of a client once, before the loop over the known ranges; the first range's
 * trim splits a struct in place, so the bounds were stale for the next range,
 * which was skipped: a struct spanning a skip, known ids and the state's end
 * (a GC of a whole subtree) integrated whole over the known middle, and its
 * delete-set entry outran the store (`tryMerge` threw at cleanup).
 *
 * Expected values come from the rule — the trimmed set holds a skip per known
 * range and the arriving structs only where the store has nothing — never
 * from running code.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0-v14/decoding';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { readBlockSet } from '../../lib/crdt/vendor/yjs/src/utils/BlockSet.js';
import { UpdateDecoder } from '../../lib/crdt/vendor/yjs/src/utils/UpdateDecoder.js';
import { createIdSet } from '../../lib/crdt/vendor/yjs/src/utils/ids.js';

const CLIENT = 1000;
const mk = (client: number) => {
	const doc = new Y.Doc();
	doc.clientID = client;
	return doc;
};
/** A node under the root holding `n` one-character items, written one per transaction. */
const grow = (doc, n: number) => {
	const node = new Y.Node('n');
	doc.get('r').insert(doc.get('r').length, [node]);
	for (let i = 0; i < n; i++) node.insert(i, String.fromCharCode(97 + (i % 26)));
	return node;
};
const remove = (doc, node) => {
	const r = doc.get('r');
	for (let i = 0, it = r._start; it !== null; it = it.right) {
		if (it.deleted) continue;
		if (it.content.type === node) {
			r.delete(i, 1);
			return;
		}
		i += it.length;
	}
	throw new Error('node not found');
};
/** `[clock, length, kind]` per struct of `client` in a block set. */
const refsOf = (set, client: number) =>
	set.clients.get(client).refs.map((s) => [s.id.clock, s.length, s.constructor.name]);
const blockSetOf = (update: Uint8Array) =>
	readBlockSet(new UpdateDecoder(decoding.createDecoder(update)));

describe('YP23: a block set trimmed to what the store lacks', () => {
	it('trims every known range of a client, not only the first (the bounds are read per range)', () => {
		// One writer: a node with 58 items, then removed — its items are one GC
		// struct in its state (1..59), its own item deleted content at 0.
		const x = mk(CLIENT);
		remove(x, grow(x, 58));
		expect(x.store.getClock(CLIENT)).toBe(59);
		const set = blockSetOf(Y.encodeStateAsUpdate(x));
		const known = createIdSet();
		known.add(CLIENT, 0, 5);
		known.add(CLIENT, 9, 25);
		set.exclude(known);
		const refs = refsOf(set, CLIENT);
		// A skip stands for each known range; nothing else overlaps them.
		expect(refs.filter(([, , kind]) => kind === 'Skip')).toEqual([
			[0, 5, 'Skip'],
			[9, 25, 'Skip']
		]);
		for (const [clock, length, kind] of refs) {
			if (kind === 'Skip') continue;
			const end = clock + length;
			expect(
				(clock >= 5 && end <= 9) || clock >= 34,
				`${kind} ${clock}+${length} overlaps a known range`
			).toBe(true);
		}
		// The arriving structs cover exactly what the store lacks.
		const covered = refs
			.filter(([, , kind]) => kind !== 'Skip')
			.reduce((n, [, length]) => n + length, 0);
		expect(covered).toBe(4 + 25);
		expect(refs.map(([clock]) => clock)).toEqual(
			[...refs.map(([clock]) => clock)].sort((a, b) => a - b)
		);
	});

	it('a replica with a gap takes a GC spanning the gap, known ids and the end of its state', () => {
		// X: a node with 33 items (clocks 0..34); R takes its first five clocks.
		const x = mk(CLIENT);
		const r = mk(2000);
		const n1 = grow(x, 4);
		Y.applyUpdate(r, Y.encodeStateAsUpdate(x), 'remote');
		expect(r.store.getClock(CLIENT)).toBe(5);
		for (let i = 4; i < 33; i++) n1.insert(i, 'z');
		expect(x.store.getClock(CLIENT)).toBe(34);
		// X removes the node: its items are GC structs. R receives clock 9
		// onwards only (a dropped message), so it integrates around a skip.
		remove(x, n1);
		const sv = Y.encodeStateVector(r);
		Y.applyUpdate(r, Y.encodeStateAsUpdate(x, Y.encodeStateVector(mk(1))), 'remote');
		void sv;
		expect(r.store.getClock(CLIENT)).toBe(34);
		// Then X writes and removes a second node: one GC spans 1..59 in its state.
		remove(x, grow(x, 24));
		expect(x.store.getClock(CLIENT)).toBe(59);
		// Before YP23 this threw at the transaction's cleanup (`tryMerge`): the
		// GC integrated whole over R's known 9..34, and the delete set named
		// ids R's store did not have.
		expect(() => Y.applyUpdate(r, Y.encodeStateAsUpdate(x), 'remote')).not.toThrow();
		expect(r.store.getClock(CLIENT)).toBe(59);
		expect(Y.encodeStateVector(r)).toEqual(Y.encodeStateVector(x));
		expect(r.get('r').length).toBe(0);
	});
});
