/**
 * H7 (CRDT study 2026-10, Phase 3; contract rows `room.purge.what`,
 * `room.purge.stale` and `hist.purge.horizon`): `crdt.doc.purge` writes
 * real deletes of what was deleted before a horizon, as the room's own
 * transaction, so every replica applies them and collects the content:
 *
 * - a deleted block whose text family is all dead and that nothing is
 *   placed under goes whole (its registry entry); any other keeps its node,
 *   its stream's text, data leaves and claims deleted;
 * - text delete mark records past the horizon go; a withdrawn creation
 *   goes; a runner-up placement candidate of an old, accepted winner goes;
 * - a history drops the steps below the horizon: their undo restores
 *   nothing, a newer step still undoes;
 * - a replica that missed the purge (offline past the horizon) reconnects:
 *   its edits to live content are kept, those inside purged content are
 *   dropped, and every replica converges with no update left pending.
 *
 * "The room" here is a replica that runs the purge and relays it, as
 * `DocumentRoom` does; the horizon is its state vector at an epoch.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, defaultSemantics } from '$lib/crdt/index.js';
import { packed } from '$lib/crdt/storage.js';
import { replica, seedUpdate, syncAll, wellFormed, LIVE } from './replica-harness.js';

const crdt = bindCrdt(Y);
const PURGE = Symbol('purge');

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

const seed = seedUpdate(
	[
		{ id: 'p1', text: 'live text' },
		{ id: 'p2', text: 'doomed paragraph', data: { color: 'red' } },
		{ id: 'p3', text: 'parent', children: [{ id: 'p3a', text: 'child' }] },
		{ id: 'p4', text: 'mover' }
	],
	defaultSemantics
);

const open = (name: string, offset: number) =>
	replica(name, seed, LIVE + offset, { semantics: defaultSemantics });

/** An epoch now: the room's state vector, as `room.purge.timing` records it. */
const epoch = (room) => ({ at: 1, sv: Y.encodeStateVector(room.doc) });

/** The room's purge: one transaction of its own. */
const purge = (room, horizon) =>
	room.doc.transact(() => crdt.doc.purge(room.doc, room.ed, horizon), PURGE);

const healthy = (...reps) => {
	for (const r of reps) {
		expect(wellFormed(r.ed, { doc: r.doc, semantics: defaultSemantics })).toEqual([]);
		expect(r.problems).toEqual([]);
		expect(r.pending()).toBe(false);
	}
};

const registryHas = (r, id: string) => r.ed.model.blockNodeOf(r.doc, id) !== null;
/** Whether `text` appears in the bytes a replica would store. */
const holdsText = (r, text: string) =>
	new TextDecoder('utf-8', { fatal: false }).decode(Y.encodeStateAsUpdate(r.doc)).includes(text);

describe('H7: purge what was deleted before the horizon', () => {
	it('a deleted block goes whole: its entry, text and data leave every replica', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.deleteBlocks(['p2']));
		syncAll([room, ada]);
		expect(holdsText(room, 'doomed')).toBe(true);
		const report = purge(room, epoch(room));
		expect(report).toMatchObject({ removed: 1, emptied: 0 });
		syncAll([room, ada]);
		for (const r of [room, ada]) {
			expect(registryHas(r, 'p2')).toBe(false);
			expect(holdsText(r, 'doomed')).toBe(false);
			expect(r.canonical()).toBe(room.canonical());
		}
		// A fresh replica loading the room's state never sees it.
		const fresh = replica('fresh', Y.encodeStateAsUpdate(room.doc), LIVE + 9, {
			semantics: defaultSemantics
		});
		expect(holdsText(fresh, 'doomed')).toBe(false);
		expect(fresh.canonical()).toBe(room.canonical());
		healthy(room, ada, fresh);
		for (const r of [room, ada, fresh]) r.destroy();
	});

	it('only what was deleted before the horizon: a later delete stays, and its undo works', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.deleteBlocks(['p2']));
		syncAll([room, ada]);
		const horizon = epoch(room);
		ok(ada.ed.deleteBlocks(['p4'])); // after the epoch
		syncAll([room, ada]);
		purge(room, horizon);
		syncAll([room, ada]);
		expect(registryHas(room, 'p2')).toBe(false);
		expect(registryHas(room, 'p4')).toBe(true);
		expect(holdsText(room, 'mover')).toBe(true);
		// Ada's history dropped the old step: one undo brings p4 back, the next nothing.
		ada.undo();
		expect(ada.ed.toJSON().children.map((b) => b.id)).toEqual(['p1', 'p3', 'p4']);
		expect(ada.undo()).toBe(null);
		expect(ada.ed.toJSON().children.map((b) => b.id)).toEqual(['p1', 'p3', 'p4']);
		syncAll([room, ada]);
		expect(room.canonical()).toBe(ada.canonical());
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it('deleted text: the delete marks go, and an undo of the old delete restores nothing', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.deleteText('p1', 0, 5)); // 'live '
		syncAll([room, ada]);
		const marks = (r) => r.doc.get('textdel').length;
		expect(marks(room)).toBe(1);
		const report = purge(room, epoch(room));
		expect(report.marks).toBe(1);
		syncAll([room, ada]);
		expect(marks(room)).toBe(0);
		expect(marks(ada)).toBe(0);
		expect(ada.undo()).toBe(null);
		expect(ada.ed.blockText('p1')).toBe('text');
		// The history released what it kept: the deleted text is collected on Ada too.
		expect(holdsText(ada, 'live ')).toBe(false);
		syncAll([room, ada]);
		expect(room.canonical()).toBe(ada.canonical());
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it('a deleted parent of a live child keeps its node; the child stays where it shows', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const bob = open('bob', 3);
		// Ada deletes p3 (its child p3a moves into its slot) while Bob, concurrently,
		// nests p4 under p3: p4 shows in p3's slot by read-time promotion.
		ok(ada.ed.deleteBlocks(['p3']));
		ok(bob.ed.moveBlocks(['p4'], { parent: 'p3', index: 1 }));
		syncAll([room, ada, bob]);
		const before = room.canonical();
		expect(room.ed.toJSON().children.map((b) => b.id)).toContain('p4');
		const report = purge(room, epoch(room));
		expect(report).toMatchObject({ removed: 0, emptied: 1 });
		syncAll([room, ada, bob]);
		expect(room.canonical()).toBe(before);
		expect(registryHas(room, 'p3')).toBe(true);
		expect(holdsText(room, 'parent')).toBe(false);
		expect(ada.canonical()).toBe(before);
		expect(bob.canonical()).toBe(before);
		healthy(room, ada, bob);
		for (const r of [room, ada, bob]) r.destroy();
	});

	it('a deleted split-born block keeps its node (its boundary delimits a live text); its text, data and claims go', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.splitBlock('p1', 5, 'p1b')); // 'live ' | 'text'
		ok(ada.ed.setBlockData('p1b', { tag: 'gone' }));
		ok(ada.ed.mergeBlocks('p4', 'p1b')); // p1b claims p4
		ok(ada.ed.deleteBlocks(['p1b']));
		syncAll([room, ada]);
		const before = room.canonical();
		purge(room, epoch(room));
		syncAll([room, ada]);
		expect(room.canonical()).toBe(before);
		const node = room.ed.model.blockNodeOf(room.doc, 'p1b');
		expect(node).not.toBe(null);
		expect([...node.attrKeys()].filter((k) => k.startsWith('d/') || k === 'data')).toEqual([]);
		expect(room.ed.model.view(room.doc).blocks.get('p1b').claims).toEqual([]);
		expect(ada.ed.blockText('p1')).toBe('live ');
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it('a withdrawn creation goes; a runner-up candidate of an old winner goes', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(
			ada.ed.insertBlocks({ parent: null, index: 4 }, [
				{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'undone' }] }
			])
		);
		ada.undo(); // withdrawn (`hist.undo.withdraw`)
		ok(ada.ed.moveBlocks(['p4'], { parent: null, index: 0 }));
		ok(ada.ed.moveBlocks(['p4'], { parent: null, index: 3 }));
		syncAll([room, ada]);
		const candidates = (r) => r.ed.model.candidatesOf(r.ed.model.blockNodeOf(r.doc, 'p4')).length;
		const held = candidates(room);
		expect(held).toBeGreaterThanOrEqual(2);
		expect(registryHas(room, 'x')).toBe(true);
		const before = room.canonical();
		const report = purge(room, epoch(room));
		expect(report.candidates).toBe(held - 1);
		syncAll([room, ada]);
		expect(registryHas(room, 'x')).toBe(false);
		expect(candidates(room)).toBe(1);
		expect(candidates(ada)).toBe(1);
		expect(room.canonical()).toBe(before);
		expect(ada.canonical()).toBe(before);
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it('a replica offline past the horizon reconnects: its live edits kept, the purged ones dropped, all converge', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const carl = open('carl', 3); // goes offline now
		ok(ada.ed.deleteBlocks(['p2']));
		ok(ada.ed.splitBlock('p1', 5, 'p1b'));
		ok(ada.ed.deleteBlocks(['p1b']));
		room.receiveAll(ada.log);
		purge(room, epoch(room));
		ada.receiveAll(room.log);
		// Offline all along, Carl types into a live block and into deleted ones,
		// and moves p4 under p2.
		ok(carl.ed.insertText('p1', 0, 'C:'));
		ok(carl.ed.insertText('p2', 0, 'lost '));
		ok(carl.ed.insertText('p1', 9, '!')); // inside what became p1b's stream
		ok(carl.ed.moveBlocks(['p4'], { parent: 'p2', index: 0 }));
		// He reconnects: the room and Ada exchange with him.
		syncAll([room, ada, carl], 2);
		expect(carl.canonical()).toBe(room.canonical());
		expect(ada.canonical()).toBe(room.canonical());
		// p4, moved under the removed p2, resolves to the root (a parent the
		// registry lacks), at the rank Carl gave it: visible, on every replica.
		const json = room.ed.toJSON();
		expect(json.children.map((b) => b.id).sort()).toEqual(['p1', 'p3', 'p4']);
		expect(room.ed.blockText('p1')).toBe('C:live ');
		expect(holdsText(room, 'lost')).toBe(false);
		healthy(room, ada, carl);
		for (const r of [room, ada, carl]) r.destroy();
	});

	it('a purge concurrent with an edit converges', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const bob = open('bob', 3);
		ok(ada.ed.deleteBlocks(['p2', 'p4']));
		syncAll([room, ada, bob]);
		const horizon = epoch(room);
		purge(room, horizon);
		ok(bob.ed.insertText('p1', 4, ' and more'));
		ok(bob.ed.splitBlock('p3', 2, 'p3b'));
		syncAll([room, ada, bob], 2);
		expect(ada.canonical()).toBe(room.canonical());
		expect(bob.canonical()).toBe(room.canonical());
		expect(room.ed.blockText('p1')).toBe('live and more text');
		healthy(room, ada, bob);
		for (const r of [room, ada, bob]) r.destroy();
	});

	it('the horizon record is written last; a second purge at the same horizon deletes nothing more', () => {
		const room = open('room', 1);
		ok(room.ed.deleteBlocks(['p2']));
		const horizon = epoch(room);
		purge(room, horizon);
		expect(crdt.doc.horizonOf(room.doc)).toEqual(horizon);
		const sv = Y.encodeStateVector(room.doc);
		const report = purge(room, horizon);
		expect(report).toMatchObject({ removed: 0, emptied: 0, marks: 0, records: 0, candidates: 0 });
		// Only the record is written again (one attr); the room never repeats a horizon.
		expect(Y.decodeStateVector(Y.encodeStateVector(room.doc)).get(room.doc.clientID)).toBe(
			(Y.decodeStateVector(sv).get(room.doc.clientID) ?? 0) + 1
		);
		room.destroy();
	});

	it('a block merged away before the horizon loses its own attribution record; the block it merged into keeps the union (room.purge.merged)', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const bob = open('bob', 3);
		ok(ada.ed.splitBlock('p1', 5, 'p1b')); // 'live ' | 'text'
		syncAll([room, ada, bob]);
		ok(bob.ed.setBlockData('p1b', { color: 'blue' }));
		ok(ada.ed.setBlockData('p1', { color: 'red' }));
		syncAll([room, ada, bob]);
		expect(room.ed.blockAttribution('p1b')).toMatchObject({ createdBy: 'ada' });
		expect([...room.ed.blockAttribution('p1b').contributors]).toEqual(['bob']);
		ok(ada.ed.mergeBlocks('p1b', 'p1')); // p1 claims p1b: 'live text'
		syncAll([room, ada, bob]);
		const horizon = epoch(room);
		// Merged after the horizon: kept, an undo may still split it again.
		ok(bob.ed.splitBlock('p4', 2, 'p4b'));
		ok(bob.ed.mergeBlocks('p4b', 'p4'));
		syncAll([room, ada, bob]);
		const before = room.canonical();
		const record = (r, id) => r.doc.get('blockattr').getAttr(`b/${id}`);
		expect(record(room, 'p1b')).toBeDefined();
		const report = purge(room, horizon);
		expect(report.merged).toBe(1);
		syncAll([room, ada, bob]);
		for (const r of [room, ada, bob]) {
			expect(r.canonical()).toBe(before);
			expect(record(r, 'p1b')).toBeUndefined();
			expect(record(r, 'p4b')).toBeDefined();
			// The registry entry stays: its stream shows in the block it merged into.
			expect(registryHas(r, 'p1b')).toBe(true);
			expect(r.ed.blockText('p1')).toBe('live text');
			expect([...r.ed.blockAttribution('p1').contributors].sort()).toEqual(['ada', 'bob']);
		}
		// Bob's history kept the merge after the horizon: undo splits p4 again.
		bob.undo();
		syncAll([room, ada, bob]);
		expect(room.ed.toJSON().children.map((b) => b.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p4b']);
		healthy(room, ada, bob);
		for (const r of [room, ada, bob]) r.destroy();
	});
});

describe('H7: the stored size after a purge', () => {
	it('1,000 of 1,001 blocks deleted, then purged: about the visible content plus a small overhead', async () => {
		const blocks = Array.from({ length: 1001 }, (_, i) => ({
			id: `b${i}`,
			text: `paragraph number ${i} with some text in it`
		}));
		const room = replica('room', seedUpdate(blocks, defaultSemantics), LIVE + 1, {
			semantics: defaultSemantics
		});
		const size = () => Y.encodeStateAsUpdateV2(room.doc).length;
		const full = size();
		ok(room.ed.deleteBlocks(blocks.slice(1).map((b) => b.id)));
		const deleted = size();
		const report = purge(room, epoch(room));
		expect(report.removed).toBe(1000);
		const purged = size();
		// A document holding only the visible block, for scale.
		const alone = replica('alone', seedUpdate([blocks[0]], defaultSemantics), LIVE + 2, {
			semantics: defaultSemantics
		});
		const visible = Y.encodeStateAsUpdateV2(alone.doc).length;
		const stored = async (r) => (await packed(Y.encodeStateAsUpdateV2(r.doc))).length;
		console.info(
			`H7 size (v2 / gzip v2): purged ${purged} / ${await stored(room)} B, deleted ${deleted} B, full ${full} B, visible alone ${visible} / ${await stored(alone)} B`
		);
		expect(deleted).toBeGreaterThan(full);
		expect(purged * 5).toBeLessThan(deleted);
		// What stays of a removed block: its registry key and its attribution
		// record's key, as engine tombstones (a map never forgets a key).
		expect(purged).toBeLessThan(visible + 1000 * 48);
		room.destroy();
		alone.destroy();
	});
});
