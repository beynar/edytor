/**
 * P4 (CRDT study 2026-10; contract row `hist.delete-marks.fold`): a text
 * delete in the step that wrote this writer's last delete record folds into
 * it — a backspace run is one record, not one per keystroke — and the P11
 * rules hold on folded records: an undo takes back exactly the step's
 * deletes, a writer's undo never brings back what another writer's delete
 * still holds.
 *
 * Expected values come from the contract (P11's rule in
 * `text-delete-marks.test.ts`), never from production output.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { loadDocument } from '../../../lib/crdt/index.js';
import { crdt, REMOTE, replica, seedUpdate } from './replica-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** The live delete records of `doc` (elements of the `textdel` list). */
const records = (doc) => doc.get('textdel').length;

/** A replica whose history groups every write into one step (a long capture window). */
const grouped = (name, seed, cid) => {
	const document = loadDocument(seed, {
		actor: { id: name },
		history: { captureTimeout: 60_000 }
	});
	document.doc.clientID = cid;
	document.history; // attach the history
	return document;
};

describe('P4 — delete records folded per step', () => {
	it('a backspace run in one step is one record; one undo restores the whole run', () => {
		const document = grouped('A', seedUpdate([{ id: 'p', text: 'hello world' }]), 2 ** 26 + 3);
		const ed = document.facade;
		for (let i = 0; i < 5; i++) ok(ed.deleteText('p', 10 - i, 1));
		expect(ed.blockText('p')).toBe('hello ');
		expect(records(document.doc)).toBe(1);
		document.history.undo();
		expect(ed.blockText('p')).toBe('hello world');
		expect(records(document.doc)).toBe(0);
		document.history.redo();
		expect(ed.blockText('p')).toBe('hello ');
		expect(records(document.doc)).toBe(1);
		document.destroy();
	});

	it('steps of their own keep records of their own (captureTimeout 0)', () => {
		const r = replica('A', seedUpdate([{ id: 'p', text: 'hello' }]), 2 ** 26 + 5);
		ok(r.ed.deleteText('p', 4, 1));
		ok(r.ed.deleteText('p', 3, 1));
		expect(records(r.doc)).toBe(2);
		r.undo();
		expect(r.ed.blockText('p')).toBe('hell');
		r.undo();
		expect(r.ed.blockText('p')).toBe('hello');
		r.destroy();
	});

	it('without a history every delete of this writer folds while the record stays small', () => {
		const document = loadDocument(seedUpdate([{ id: 'p', text: 'abcdefghijklmnopqrstuvwxyz' }]), {
			actor: { id: 'A' }
		});
		const ed = document.facade;
		// A backspace run: contiguous, one span.
		for (let i = 0; i < 10; i++) ok(ed.deleteText('p', 25 - i, 1));
		expect(records(document.doc)).toBe(1);
		// Scattered deletes: one span each, folded up to the cap (8 spans).
		for (let i = 0; i < 7; i++) ok(ed.deleteText('p', i, 1));
		expect(records(document.doc)).toBe(1);
		// The ninth span starts a record of its own.
		ok(ed.deleteText('p', 7, 1));
		expect(records(document.doc)).toBe(2);
		document.destroy();
	});

	it('a peer’s delete held while the folding writer undoes stays in effect (P11 on folded records)', () => {
		const seed = seedUpdate([{ id: 'p', text: 'abcdef' }]);
		const a = grouped('A', seed, 2 ** 26 + 11);
		const b = replica('B', seed, 2 ** 26 + 12);
		const fromA = [];
		a.doc.on('update', (u, origin) => origin !== REMOTE && fromA.push(u));
		const toA = (u) => crdt.sync.applyRemote(a.doc, u, REMOTE);
		// A backspaces "def" in one step (one folded record).
		ok(a.facade.deleteText('p', 5, 1));
		ok(a.facade.deleteText('p', 4, 1));
		ok(a.facade.deleteText('p', 3, 1));
		expect(records(a.doc)).toBe(1);
		// B deletes "e" concurrently; both see both.
		ok(b.ed.deleteText('p', 4, 1));
		b.receiveAll(fromA.splice(0));
		b.log.splice(0).forEach(toA);
		expect(a.facade.blockText('p')).toBe('abc');
		// A undoes its run: "d" and "f" come back, "e" stays B's delete.
		a.history.undo();
		for (let round = 0; round < 4; round++) {
			b.receiveAll(fromA.splice(0));
			b.log.splice(0).forEach(toA);
		}
		expect(a.facade.blockText('p')).toBe('abcdf');
		expect(b.ed.blockText('p')).toBe('abcdf');
		// B undoes too: "e" comes back once.
		b.undo();
		for (let round = 0; round < 4; round++) {
			b.log.splice(0).forEach(toA);
			b.receiveAll(fromA.splice(0));
		}
		expect(a.facade.blockText('p')).toBe('abcdef');
		expect(b.ed.blockText('p')).toBe('abcdef');
		expect(b.problems).toEqual([]);
		a.destroy();
		b.destroy();
	});
});
