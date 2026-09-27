/**
 * U06 mirror tests — an INDEPENDENT mirror driven purely by `onChange`
 * {@link DocChange} payloads must reconstruct exactly what a fresh
 * `project()`/`toJSON()` produces after every transaction, local or remote.
 *
 * The mirror is deliberately dumb: it keeps `parent → child id order`,
 * `id → {type,data}`, and `id → content` maps, applies each DocChange, then
 * serializes. No access to the document beyond the event payloads.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair } from '../harness/peer-set.js';
import { remoteOrigin } from '../harness/peer-set.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

const newDoc = (clientID = 7) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	return doc;
};

const sameMarks = (a, b) =>
	a === b ||
	(a !== undefined &&
		b !== undefined &&
		JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort()));

/** Canonical run form — merge adjacent text items with equal marks. */
const mergeRuns = (items) => {
	const out = [];
	for (const item of items ?? []) {
		if (item.kind === 'text') {
			const last = out[out.length - 1];
			if (last && last.kind === 'text' && sameMarks(last.marks, item.marks)) {
				last.text += item.text;
				continue;
			}
		}
		out.push(item);
	}
	return out;
};

/** Canonicalize a projected tree (content → merged runs). */
const canonProjected = (doc) => {
	const emit = (b) => ({
		id: b.id,
		type: b.type,
		data: b.data,
		content: mergeRuns(b.content),
		children: b.children.map(emit)
	});
	return { children: doc.children.map(emit) };
};

/**
 * The mirror — a self-contained tree state updated ONLY from DocChange.
 * `apply` enforces the payload contract (moved ids land inside an `order`
 * entry; added roots carry their whole subtree) so a malformed event fails
 * loudly instead of drifting silently.
 */
const makeMirror = () => {
	const order = new Map(); // parent|null → BlockId[]
	const meta = new Map(); // id → {type, data}
	const content = new Map(); // id → ContentItem[]

	// Children claimed by the change's own order lists survive the drop
	// (keepChildren deletes reparent them in the same transaction).
	let claimed = new Set();
	const dropSubtree = (id) => {
		for (const c of order.get(id) ?? []) if (!claimed.has(c)) dropSubtree(c);
		order.delete(id);
		meta.delete(id);
		content.delete(id);
	};
	const addSubtree = (pb) => {
		meta.set(pb.id, { type: pb.type, data: pb.data });
		content.set(pb.id, pb.content);
		order.set(
			pb.id,
			pb.children.map((c) => c.id)
		);
		for (const c of pb.children) addSubtree(c);
	};

	/** Seed from the initial projection — `onChange` is a DIFF stream, so a
	 * mirror always starts from `ed.project()` then applies events. */
	const seed = (projected) => {
		order.set(
			null,
			projected.children.map((c) => c.id)
		);
		for (const c of projected.children) addSubtree(c);
	};

	const apply = (change) => {
		claimed = new Set();
		for (const [, ids] of change.order) for (const id of ids) claimed.add(id);
		for (const [, pb] of change.added) addSubtree(pb);
		for (const id of change.removed) dropSubtree(id);
		claimed = new Set();
		for (const [parent, ids] of change.order) order.set(parent, ids);
		for (const [id, m] of change.meta) meta.set(id, m);
		for (const [id, runs] of change.content) content.set(id, runs);
		// Contract checks — every moved id must be claimed by exactly one
		// order list, and every ordered id must be known.
		for (const id of change.moved) {
			let claimed = false;
			for (const [, ids] of change.order) if (ids.includes(id)) claimed = true;
			expect(claimed, `moved id ${id} not claimed by any order entry`).toBe(true);
		}
		for (const [, ids] of order) {
			for (const id of ids) {
				expect(meta.has(id), `ordered id ${id} has no meta`).toBe(true);
			}
		}
	};

	const serialize = () => {
		const emit = (id) => ({
			id,
			type: meta.get(id).type,
			data: meta.get(id).data,
			content: mergeRuns(content.get(id) ?? []),
			children: (order.get(id) ?? []).map(emit)
		});
		return { children: (order.get(null) ?? []).map(emit) };
	};

	return { seed, apply, serialize };
};

const seed = (ed) => {
	ed.init({
		content: [
			{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] },
			{
				id: 'b2',
				type: 'paragraph',
				content: [{ kind: 'text', text: 'second', marks: { bold: true } }]
			},
			{
				id: 'b3',
				type: 'list',
				content: [{ kind: 'text', text: 'parent' }],
				children: [
					{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child a' }] },
					{ id: 'b3b', type: 'paragraph', content: [{ kind: 'text', text: 'child b' }] }
				]
			}
		]
	});
	return ed;
};

describe('event-driven mirror', () => {
	it('tracks every local op exactly', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const mirror = makeMirror();
		const events = [];
		mirror.seed(ed.project()); // initial snapshot; events carry diffs from here
		ed.onChange((c) => {
			events.push(c);
			mirror.apply(c);
			// Every single transaction must leave the mirror == fresh projection.
			expect(mirror.serialize()).toEqual(canonProjected(ed.project()));
		});

		ed.insertText('b1', 0, 'X');
		ed.setMark('b1', 0, 5, 'italic', true);
		ed.insertInline('b1', 3, { id: 'm1', type: 'mention', data: { u: 'a' } });
		ed.setInlineData('b1', 'm1', { u: 'b' });
		ed.moveBlock('b1', { parent: 'b3', index: 0 });
		ed.nestBlock('b2', 'b3');
		ed.unNestBlock('b2');
		ed.splitBlock('b1', 4, 'b1-tail');
		ed.mergeBlocks('b1-tail', 'b1');
		ed.mergeBackward('b3');
		ed.setBlockType('b2', 'heading');
		ed.setBlockData('b2', { level: 3 });
		ed.insertBlock({ parent: null, index: 0 }, { id: 'new', type: 'paragraph' });
		ed.duplicateBlock('new', (o) => `${o}-dup`);
		ed.deleteBlock('new');
		ed.moveBlocks(['b1', 'b2'], { parent: null, index: 0 });
		ed.deleteText('b1', 0, 2);
		ed.removeInline('b1', 'm1');
		ed.clearMarks('b1', 0, 4);
		ed.setBlock('b2', { content: [{ kind: 'text', text: 'reset' }] });
		ed.deleteBlock('b3', { keepChildren: true });

		expect(events.length).toBeGreaterThanOrEqual(20);
		expect(mirror.serialize()).toEqual(canonProjected(ed.project()));
		expect(events.map((e) => e.version)).toEqual(events.map((_, i) => i + 1));
		ed.dispose();
	});

	it('tracks remote-applied updates with local=false and the remote origin', () => {
		const a = newDoc(11);
		const b = newDoc(22);
		const edA = seed(E.create(a));
		E.init(b); // same bootstrap+content? No — apply A's state instead.
		const edB = E.create(b);

		// Sync B fully with A's seeded state (B's own init is redundant state,
		// converged below).
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a), remoteOrigin('A'));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b), remoteOrigin('B'));

		const mirror = makeMirror();
		const events = [];
		mirror.seed(edB.project());
		edB.onChange((c) => {
			events.push(c);
			mirror.apply(c);
			expect(mirror.serialize()).toEqual(canonProjected(edB.project()));
		});

		// Remote ops authored on A arrive on B as remote transactions.
		edA.transact(() => {
			edA.insertText('b1', 0, 'REMOTE ');
			edA.moveBlock('b2', { parent: 'b3', index: 0 });
		});
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), remoteOrigin('A'));

		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e.local === false)).toBe(true);
		expect(events.every((e) => e.origin?.['crdt-harness/remote'] === true)).toBe(true);
		expect(mirror.serialize()).toEqual(canonProjected(edA.project()));
	});

	it('the first event on an uninitialized doc reports the bootstrap insert', () => {
		const doc = newDoc();
		const ed = E.create(doc);
		const mirror = makeMirror();
		ed.onChange((c) => mirror.apply(c));
		ed.init();
		expect(mirror.serialize()).toEqual(canonProjected(ed.project()));
		expect(mirror.serialize().children[0].id).toBe(DEFAULT_SEED_ID);
		ed.dispose();
	});

	it('removed subtree roots collapse (descendants not individually listed)', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const events = [];
		ed.onChange((c) => events.push(c));
		ed.deleteBlock('b3'); // removes b3 + b3a + b3b in one transaction
		const last = events[events.length - 1];
		expect([...last.removed]).toEqual(['b3']); // root only
	});

	it('unsubscribe stops events; dispose detaches the doc listener', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		let n = 0;
		const off = ed.onChange(() => n++);
		ed.insertText('b1', 0, 'a');
		expect(n).toBe(1);
		off();
		ed.insertText('b1', 0, 'b');
		expect(n).toBe(1);
		ed.dispose();
		// A fresh facade still observes — dispose did not break the doc.
		const ed2 = E.create(doc);
		ed2.onChange(() => n++);
		ed2.insertText('b1', 0, 'c');
		expect(n).toBe(2);
	});
});
