/**
 * U05 task 1 — EMPIRICAL contract pins for the deep-observer event surface:
 * `observeDeep` fires one event per transaction per ancestor root, and the
 * event's deep change (read through the test port `eventDeltaDeep`) is the
 * nested modify-delta — `{attrs: {<blockId>: {type:'modify', value:{attrs:
 * {content|slices|del|at: …}}}}`.
 *
 * The pins of the maintained `Node.delta` cache went with the cache itself:
 * YP16 removed the engine's delta layer (UPSTREAM.md).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { createPeerPair } from '../harness/peer-set.js';
import { eventDeltaDeep } from '../harness/delta.js';

/** A registry-rooted schema subtree: block with content/slices/at children. */
const makeBlock = (id) => {
	const blk = new Y.Node('block');
	blk.setAttr('id', id);
	blk.setAttr('type', 'paragraph');
	blk.setAttr('content', new Y.Node('content'));
	blk.setAttr('slices', new Y.Node('slices'));
	blk.setAttr('at', new Y.Node('at'));
	return blk;
};

describe('observeDeep / deltaDeep — the invalidation payload', () => {
	it('fires one event per transaction; deltaDeep is the nested modify-delta keyed by block id', () => {
		const doc = new Y.Doc();
		const reg = doc.get('blocks');
		reg.setAttr('b1', makeBlock('b1'));
		const events = [];
		reg.observeDeep((e) => events.push(e));
		doc.transact(() => {
			reg.getAttr('b1').getAttr('content').insert(0, 'hi', { bold: true });
		});
		doc.transact(() => {
			reg
				.getAttr('b1')
				.getAttr('slices')
				.insert(0, [{ m: 'b2' }]);
		});
		expect(events).toHaveLength(2); // one event per transaction, not per change
		const deep0 = eventDeltaDeep(events[0]).toJSON();
		const deep1 = eventDeltaDeep(events[1]).toJSON();
		// Root attrs are keyed by block id; each is a modify into the block delta.
		expect(deep0.attrs.b1.type).toBe('modify');
		expect(deep0.attrs.b1.value.attrs.content.type).toBe('modify');
		expect(deep0.attrs.b1.value.attrs.content.value.children).toEqual([
			{ type: 'insert', insert: 'hi', format: { bold: true } }
		]);
		expect(deep1.attrs.b1.value.attrs.slices.type).toBe('modify');
		// Facets that did NOT change are absent from the block's attr map.
		expect(deep0.attrs.b1.value.attrs.slices).toBeUndefined();
		expect(deep0.attrs.b1.value.attrs.at).toBeUndefined();
		expect(deep0.attrs.b1.value.attrs.del).toBeUndefined();
	});

	it('covers multiple changed blocks and `del` attr ops in one transaction', () => {
		const doc = new Y.Doc();
		const reg = doc.get('blocks');
		reg.setAttr('b1', makeBlock('b1'));
		reg.setAttr('b2', makeBlock('b2'));
		let deep = null;
		reg.observeDeep((e) => (deep = eventDeltaDeep(e).toJSON()));
		doc.transact(() => {
			reg.getAttr('b1').getAttr('content').insert(0, 'x');
			reg.getAttr('b2').setAttr('del', true);
			reg.getAttr('b2').getAttr('at').setAttr('2.1', { p: null, r: 'z9' });
		});
		expect(deep.attrs.b1.value.attrs.content.type).toBe('modify');
		expect(deep.attrs.b2.value.attrs.del).toEqual({ type: 'insert', value: true });
		expect(deep.attrs.b2.value.attrs.at.type).toBe('modify');
	});

	it('marks new registry entries as insert ops (split-sibling path)', () => {
		const doc = new Y.Doc();
		const reg = doc.get('blocks');
		let deep = null;
		reg.observeDeep((e) => (deep = eventDeltaDeep(e).toJSON()));
		doc.transact(() => {
			const blk = makeBlock('n1');
			const sl = new Y.Node('slices');
			blk.setAttr('slices', sl);
			// Detached getAttr() reads return undefined — keep the node handle.
			sl.insert(0, [{ t: 'b1', s: { i: null, a: -1 }, e: { i: null, a: 0 } }]);
			reg.setAttr('n1', blk);
		});
		expect(deep.attrs.n1.type).toBe('insert');
		// The inserted value's own delta exposes the slices payload — the run
		// view treats new entries as structure+content so pre-existing text
		// coverage claims (split tails) invalidate correctly.
		expect(deep.attrs.n1.value.attrs.slices).toBeDefined();
	});
});
