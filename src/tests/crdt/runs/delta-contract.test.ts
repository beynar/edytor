/**
 * U05 task 1 — EMPIRICAL contract pins for the vendored v14 `Node.delta`
 * maintained cache (`src/lib/crdt/vendor/yjs/src/ynode.js`, `YNode._delta`).
 *
 * VERDICT (all of it asserted below, none of it assumed):
 *
 * - The cache is LAZY: `_delta` is `null` until `.delta` is first read, then
 *   materialized once and maintained in place — the SAME object identity
 *   across all subsequent edits.
 * - The cache is AUTHORITATIVE once materialized on an INTEGRATED node: it
 *   equals a fresh `toDelta()` after local edits, after remote update
 *   application, and after undo/redo.
 * - The cache is LIVE AND SHARED — the engine patches it in place during
 *   transaction cleanup. A consumer that mutates the returned object
 *   CORRUPTS it (stale fingerprint memos + foreign content): the same cache
 *   object then diverges from `toDelta()` permanently. Consumers must treat
 *   it as read-only engine internals and `clone()` at snapshot boundaries.
 * - The cache POISONS on detached reads: reading `.delta` before the node
 *   is integrated materializes an empty render that is NEVER back-filled —
 *   pre-integration writes stay invisible to the cache forever after.
 *   `itemsOfRange` refuses to read `.delta` on `doc === null` nodes.
 *
 * Event surface pinned here too: `observeDeep` fires one event per
 * transaction per ancestor root, and `event.deltaDeep.toJSON()` is the
 * nested modify-delta — `{attrs: {<blockId>: {type:'modify', value:{attrs:
 * {content|slices|del|at: …}}}}` — the invalidation map the run view
 * consumes.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as deltaLib from 'lib0-v14/delta';
import { createPeerPair } from '../harness/peer-set.js';

const j = (d) => JSON.stringify(d.toJSON());
/** Deep-equality on delta JSON (format-object key ORDER is not stable
 *  between the maintained cache and a fresh render — both are legal). */
const sameDelta = (a, b) => expect(a.toJSON()).toEqual(b.toJSON());

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

describe('v14 Node.delta — lifecycle', () => {
	it('is lazy: _delta is null until first read, then identity-stable across edits', () => {
		const doc = new Y.Doc();
		const t = doc.get('text');
		t.insert(0, 'hello', { bold: true });
		expect(t._delta).toBeNull(); // never materialized by writes alone
		const d1 = t.delta;
		expect(t._delta).not.toBeNull();
		t.insert(5, ' world');
		t.format(0, 5, { italic: true });
		expect(t.delta).toBe(d1); // SAME object — live, updated in place
		sameDelta(t.delta, t.toDelta({ deep: true }));
	});

	it('stays equal to a fresh toDelta() after remote update application', () => {
		const seed = new Y.Doc();
		seed.get('text').insert(0, 'hello world');
		const set = createPeerPair(Y.encodeStateAsUpdate(seed));
		const ta = set.A.doc.get('text');
		const tb = set.B.doc.get('text');
		const cacheB = tb.delta; // materialize BEFORE remote edits arrive
		set.A.transact(() => {
			ta.insert(0, '>>');
			ta.format(2, 3, { italic: true });
		});
		set.deliver('A', 'B');
		// The maintained cache patched itself during remote cleanup — it must
		// still equal a fresh authoritative render.
		sameDelta(cacheB, tb.toDelta({ deep: true }));
		expect(j(cacheB)).toContain('italic');
	});

	it('stays equal to a fresh toDelta() after undo and redo', () => {
		const doc = new Y.Doc();
		const t = doc.get('text');
		t.insert(0, 'hello');
		const um = new Y.UndoManager(doc, { trackedOrigins: new Set(['local']) });
		const cache = t.delta;
		doc.transact(() => t.insert(5, ' world'), 'local');
		doc.transact(() => t.format(0, 5, { bold: true }), 'local');
		um.undo();
		sameDelta(cache, t.toDelta({ deep: true }));
		expect(j(cache)).not.toContain('bold');
		um.undo();
		sameDelta(cache, t.toDelta({ deep: true }));
		// The seed insert predates the UndoManager (untracked origin) — 'hello' survives.
		expect(j(cache)).toContain('hello');
		um.redo();
		um.redo();
		sameDelta(cache, t.toDelta({ deep: true }));
	});
});

describe('v14 Node.delta — consumer rules', () => {
	it('consumer mutation CORRUPTS the live cache (poison is visible and permanent)', () => {
		const doc = new Y.Doc();
		const t = doc.get('text');
		t.insert(0, 'abcdef');
		const cache = t.delta;
		// A consumer reaching into the delta and mutating op payloads —
		// the exact thing the contract forbids.
		cache.children.start.insert = 'POISONED';
		t.insert(6, '!');
		expect(cache.toJSON()).not.toEqual(t.toDelta({ deep: true }).toJSON());
		expect(j(cache)).toContain('POISON');
	});

	it('toJSON()/lib0 clone() are the supported snapshot boundaries — later edits never patch them', () => {
		const doc = new Y.Doc();
		const t = doc.get('text');
		t.insert(0, 'abcdef');
		const jsonSnap = t.delta.toJSON();
		// The vendored DeltaBuilder exposes no `.clone()`; lib0's delta
		// `slice`/`clone` is the object-level snapshot path.
		const objSnap = deltaLib.slice(t.delta);
		t.insert(6, '!');
		expect(jsonSnap).not.toEqual(t.delta.toJSON());
		expect(JSON.stringify(jsonSnap)).not.toContain('!');
		expect(j(objSnap)).not.toBe(j(t.delta));
		expect(j(objSnap)).not.toContain('!');
		expect(j(t.delta)).toContain('abcdef!');
	});

	it('POISONS on detached reads — pre-integration content never enters the cache', () => {
		const doc = new Y.Doc();
		const n = new Y.Node('content');
		n.insert(0, 'pre-integration'); // write while detached
		const early = n.delta; // READ while detached — materializes empty cache
		expect(j(early)).toBe('{"type":"delta","name":"content"}');
		doc.get('t').insert(0, [n]); // integrate
		n.insert(15, ' post');
		// The cache missed the pre-integration 'pre-integration' entirely —
		// it only learned about ' post'. Fresh render shows the truth.
		expect(n.delta.toJSON()).not.toEqual(n.toDelta({ deep: true }).toJSON());
		expect(j(n.toDelta({ deep: true }))).toContain('pre-integration');
	});
});

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
		const deep0 = events[0].deltaDeep.toJSON();
		const deep1 = events[1].deltaDeep.toJSON();
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
		reg.observeDeep((e) => (deep = e.deltaDeep.toJSON()));
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
		reg.observeDeep((e) => (deep = e.deltaDeep.toJSON()));
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
