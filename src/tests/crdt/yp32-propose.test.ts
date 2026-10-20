/**
 * Vendored-engine patch YP32 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): a
 * delete that proposes. `YNode#delete(index, length, into, fresh, propose)`
 * sorts each live unit it reaches: `1` held by the record appended to
 * `into` (YP20), `2` named by one id list appended to `propose.into` (a
 * nested node: it holds nothing, YP31), `3` stepped over. Proposed and
 * stepped-over units read gone until `unhide(transaction)`, so what the
 * transaction writes next reads the offsets the delete left; then they
 * show again. Without `propose` the delete is YP20's.
 *
 * Expected values come from that rule, never from running code.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';

const doc = (s: string) => {
	const d = new Y.Doc();
	d.clientID = 1;
	d.get('t').insert(0, s);
	d.clientID = 2;
	return d;
};
const text = (d) => d.get('t').toString();
/** The id triples of the live entries of `list`. */
const ids = (list) => {
	const out = [];
	for (let it = list._start; it !== null; it = it.right)
		if (!it.deleted) for (const triple of it.content.getContent()) out.push([...triple]);
	return out;
};
const record = (d) => {
	const root = d.get('suggest');
	d.transact(() => root.setAttr('s', new Y.Node('suggestion')));
	return root.getAttr('s');
};

describe('YP32 — a delete that proposes', () => {
	it('proposes what it sorts 2, holds what it sorts 1, steps over 3; hides 2 and 3 until unhide', () => {
		const d = doc('abcdef');
		const rec = record(d);
		// b: its author's own (held), c d: proposed, e: already proposed (stepped over).
		const sort = (_client, clock) => (clock === 1 ? 1 : clock === 4 ? 3 : 2);
		let during = '';
		d.transact((tr) => {
			d.get('t').delete(1, 4, d.get('textdel'), null, { into: rec, sort });
			during = text(d);
			// What the transaction writes next reads the delete's offsets: after the proposed text.
			d.get('t').insert(1, 'X');
			Y.unhide(tr);
		});
		expect(during).toBe('af');
		expect(text(d)).toBe('acdeXf');
		expect(ids(rec)).toEqual([[1, 2, 2]]);
		expect(ids(d.get('textdel'))).toEqual([[1, 1, 1]]);
	});

	it('a peer reads the proposal as an id list: nothing hidden, the held unit held', () => {
		const d = doc('abcdef');
		const rec = record(d);
		d.transact((tr) => {
			d.get('t').delete(0, 3, d.get('textdel'), null, {
				into: rec,
				sort: (_c, clock) => (clock === 0 ? 1 : 2)
			});
			Y.unhide(tr);
		});
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(d));
		expect(text(peer)).toBe('bcdef');
		expect(ids(peer.get('suggest').getAttr('s'))).toEqual([[1, 1, 2]]);
	});

	it('without propose, the delete is YP20s', () => {
		const [a, b] = [doc('abcdef'), doc('abcdef')];
		a.get('t').delete(1, 2, a.get('textdel'));
		b.get('t').delete(1, 2, b.get('textdel'), null, null);
		expect(text(a)).toBe('adef');
		expect(Y.encodeStateAsUpdate(b)).toEqual(Y.encodeStateAsUpdate(a));
	});
});
