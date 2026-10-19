/**
 * `hist.release.end` (`docs/editor-delete-contract.md`): a session's history
 * ends when its page leaves for good (`document.endHistory()`, which the view
 * calls at a `pagehide` the back/forward cache keeps nothing of). Its steps
 * are released as dropped steps are (`hist.delete-marks.release`), and one
 * release record names the writer and the clock it ended at: the room's
 * purge removes what that writer's delete and withdraw marks hide at its
 * next run, past the horizon or not (`room.purge.what`). Another session's
 * deletes wait for the horizon, its undo intact; a restore of an older
 * version still brings the released content back, from the version.
 *
 * "The room" here is a replica that runs the purge and relays it, as
 * `DocumentRoom` does; `purge(room, null)` is its tick with no epoch due.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, defaultSemantics } from '$lib/crdt/index.js';
import { releasesOf } from '$lib/crdt/purge.js';
import { replica, seedUpdate, syncAll, wellFormed, LIVE } from './replica-harness.js';
import { blockNodeOf } from '../../../lib/crdt/placement/model.js';

const crdt = bindCrdt(Y);
const PURGE = Symbol('purge');
const RESTORE = Symbol('restore');

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

const seed = seedUpdate(
	[
		{ id: 'p1', text: 'live text' },
		{ id: 'p2', text: 'doomed paragraph' },
		{ id: 'p3', text: 'another one' },
		{ id: 'p4', text: 'kept by bob' }
	],
	defaultSemantics
);

const open = (name: string, offset: number) =>
	replica(name, seed, LIVE + offset, { semantics: defaultSemantics });

/** The room's purge: one transaction of its own (`null`: no epoch due). */
const purge = (room, horizon) =>
	room.doc.transact(() => crdt.doc.purge(room.doc, room.ed, horizon), PURGE);

const healthy = (...reps) => {
	for (const r of reps) {
		expect(wellFormed(r.ed, { doc: r.doc, semantics: defaultSemantics })).toEqual([]);
		expect(r.problems).toEqual([]);
		expect(r.pending()).toBe(false);
	}
};

const registryHas = (r, id: string) => blockNodeOf(r.doc, id) !== null;
const holdsText = (r, text: string) =>
	new TextDecoder('utf-8', { fatal: false }).decode(Y.encodeStateAsUpdate(r.doc)).includes(text);
const ids = (r) => r.ed.toJSON().children.map((b) => b.id);

describe('hist.release.end: a session that ended releases its deletes', () => {
	it('its held text goes at once, the blocks it deleted at the next purge, with no horizon', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.deleteText('p1', 0, 5)); // 'live '
		ok(ada.ed.deleteBlocks(['p2']));
		syncAll([room, ada]);
		const before = room.canonical();
		expect(holdsText(room, 'live ')).toBe(true);
		expect(holdsText(room, 'doomed')).toBe(true);
		// The page leaves: one update, the held text deleted for good and one record.
		const ended = ada.capture(() => ada.document.endHistory());
		expect(ended).toHaveLength(1);
		room.receiveAll(ended);
		expect(releasesOf(room.doc).get(ada.doc.clientID)).toBeGreaterThan(0);
		expect(holdsText(room, 'live ')).toBe(false);
		// The block's delete is a mark: its text waits for the purge, which no longer waits for the horizon.
		expect(holdsText(room, 'doomed')).toBe(true);
		const report = purge(room, null);
		expect(report).toMatchObject({ removed: 1 });
		syncAll([room, ada]);
		for (const r of [room, ada]) {
			expect(registryHas(r, 'p2')).toBe(false);
			expect(holdsText(r, 'doomed')).toBe(false);
			expect(r.canonical()).toBe(before);
		}
		// No horizon was written: no history drops a step for it.
		expect(room.doc.get('horizon').getAttr('h')).toBeUndefined();
		// The ended history holds nothing; a fresh one starts empty.
		expect(ada.undo()).toBe(null);
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it("another session's deletes wait for the horizon, and its undo still restores them", () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const bob = open('bob', 3);
		ok(ada.ed.deleteBlocks(['p2']));
		ok(bob.ed.deleteBlocks(['p4']));
		syncAll([room, ada, bob]);
		ada.document.endHistory();
		syncAll([room, ada, bob]);
		const report = purge(room, null);
		expect(report).toMatchObject({ removed: 1 });
		syncAll([room, ada, bob]);
		expect(registryHas(room, 'p2')).toBe(false);
		expect(registryHas(room, 'p4')).toBe(true);
		expect(holdsText(room, 'kept by bob')).toBe(true);
		// Bob's history is his own: his undo brings p4 back, with its text.
		bob.undo();
		syncAll([room, ada, bob]);
		for (const r of [room, ada, bob]) {
			expect(ids(r)).toEqual(['p1', 'p3', 'p4']);
			expect(r.ed.blockText('p4')).toBe('kept by bob');
		}
		healthy(room, ada, bob);
		for (const r of [room, ada, bob]) r.destroy();
	});

	it('two sessions of one actor: each end releases its own writer only', () => {
		const room = open('room', 1);
		const tab1 = replica('ada', seed, LIVE + 2, { semantics: defaultSemantics });
		const tab2 = replica('ada', seed, LIVE + 3, { semantics: defaultSemantics });
		ok(tab1.ed.deleteBlocks(['p2']));
		ok(tab2.ed.deleteBlocks(['p3']));
		syncAll([room, tab1, tab2]);
		tab1.document.endHistory();
		syncAll([room, tab1, tab2]);
		expect([...releasesOf(room.doc).keys()]).toEqual([tab1.doc.clientID]);
		purge(room, null);
		syncAll([room, tab1, tab2]);
		expect(registryHas(room, 'p2')).toBe(false);
		expect(registryHas(room, 'p3')).toBe(true);
		tab2.undo();
		syncAll([room, tab1, tab2]);
		expect(ids(room)).toEqual(['p1', 'p3', 'p4']);
		healthy(room, tab1, tab2);
		for (const r of [room, tab1, tab2]) r.destroy();
	});

	it('a session that only read, or only typed, releases nothing to the purge', () => {
		const room = open('room', 1);
		const reader = open('reader', 2);
		const typist = open('typist', 3);
		reader.ed.toJSON();
		expect(reader.capture(() => reader.document.endHistory())).toEqual([]);
		ok(typist.ed.insertText('p1', 9, '!'));
		syncAll([room, reader, typist]);
		typist.document.endHistory();
		syncAll([room, reader, typist]);
		expect(releasesOf(room.doc).size).toBe(0);
		expect(purge(room, null)).toMatchObject({ removed: 0, emptied: 0, marks: 0 });
		expect(room.ed.blockText('p1')).toBe('live text!');
		healthy(room, reader, typist);
		for (const r of [room, reader, typist]) r.destroy();
	});

	it('a restore of a version before the release brings the purged block back from the version', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		const version = room.ed.toJSON();
		ok(ada.ed.deleteBlocks(['p2']));
		syncAll([room, ada]);
		ada.document.endHistory();
		syncAll([room, ada]);
		purge(room, null);
		syncAll([room, ada]);
		expect(registryHas(room, 'p2')).toBe(false);
		room.doc.transact(() => crdt.doc.restoreTo(room.doc, room.ed, version), RESTORE);
		syncAll([room, ada]);
		for (const r of [room, ada]) {
			expect(r.ed.toJSON()).toEqual(version);
			expect(r.ed.blockText('p2')).toBe('doomed paragraph');
		}
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});

	it('the horizon covers a release record: the purge drops it', () => {
		const room = open('room', 1);
		const ada = open('ada', 2);
		ok(ada.ed.deleteBlocks(['p2']));
		syncAll([room, ada]);
		ada.document.endHistory();
		syncAll([room, ada]);
		expect(purge(room, null)).toMatchObject({ removed: 1, released: 0 });
		const report = purge(room, { at: 1, sv: Y.encodeStateVector(room.doc) });
		expect(report.released).toBe(1);
		syncAll([room, ada]);
		expect(releasesOf(room.doc).size).toBe(0);
		expect(releasesOf(ada.doc).size).toBe(0);
		healthy(room, ada);
		room.destroy();
		ada.destroy();
	});
});
