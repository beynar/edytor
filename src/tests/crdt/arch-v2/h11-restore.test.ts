/**
 * H11 (CRDT study 2026-10, Phase 3; contract row `room.history.restore`):
 * `crdt.doc.restoreTo(doc, facade, json)` makes the visible document equal
 * a JSON snapshot in one transaction, keeping every id the registry holds
 * and writing only what differs — across splits, merges, nesting, lists,
 * code lines, marks, inline atoms and data — and converges with a
 * concurrent edit; a history tracking its origin undoes it in one step.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { bindCrdt, defaultSemantics, loadDocument } from '$lib/crdt/index.js';
import { seedUpdate, wellFormed } from './p1-harness.js';

const crdt = bindCrdt(Y);
const RESTORE = Symbol('restore');

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

const seed = seedUpdate(
	[
		{
			id: 'h',
			type: 'heading',
			data: { level: 'h1' },
			content: [{ text: 'Title ', marks: { bold: true } }, { text: 'plain' }]
		},
		{ id: 'p1', text: 'alpha beta' },
		{
			id: 'p2',
			content: [
				{ text: 'see ' },
				{ type: 'mention', id: 'm1', data: { user: 'ada' } },
				{ text: '!' }
			]
		},
		{
			id: 'l',
			type: 'unordered-list',
			children: [
				{ id: 'i1', type: 'list-item', text: 'one' },
				{ id: 'i2', type: 'list-item', text: 'two' }
			]
		},
		{
			id: 'c',
			type: 'code',
			children: [{ id: 'cl1', type: 'codeLine', text: 'let x = 1' }]
		},
		{ id: 'p3', text: 'gamma', children: [{ id: 'p3a', text: 'nested' }] }
	],
	defaultSemantics
);

const open = (name: string, clientID: number) => {
	const document = loadDocument(seed, {
		actor: { id: name },
		history: { captureTimeout: 0 },
		semantics: defaultSemantics
	});
	document.doc.clientID = clientID;
	return document;
};

const restore = (document, json) =>
	document.doc.transact(() => crdt.doc.restoreTo(document.doc, document.facade, json), RESTORE);

const healthy = (document) =>
	expect(wellFormed(document.facade, { doc: document.doc, semantics: defaultSemantics })).toEqual(
		[]
	);

/** A day of edits over every structure the seed holds. */
const edit = (f) => {
	ok(f.splitBlock('p1', 5, 'p1b'));
	ok(f.mergeBlocks('p2', 'p1'));
	ok(f.setMark('h', 0, 5, 'italic', true));
	ok(f.insertText('h', 11, ' more'));
	ok(f.deleteBlocks(['i1']));
	ok(
		f.insertBlocks({ parent: 'l', index: 1 }, [
			{ id: 'i3', type: 'list-item', content: [{ kind: 'text', text: 'three' }] }
		])
	);
	ok(f.moveBlocks(['p3a'], { parent: null, index: 0 }));
	ok(f.setBlockData('h', { level: 'h2', color: 'red' }));
	ok(f.setBlock('p3', { type: 'heading', data: { level: 'h3' } }));
	ok(f.insertText('cl1', 9, '0'));
	ok(f.deleteBlocks(['c']));
};

describe('H11: restore a snapshot as a forward edit', () => {
	it('back to the morning and forward again: the JSON equals the snapshot each time, ids kept', () => {
		const a = open('ada', 2 ** 26 + 7);
		const morning = a.facade.toJSON();
		edit(a.facade);
		const evening = a.facade.toJSON();
		expect(evening).not.toEqual(morning);
		const report = restore(a, morning);
		expect(a.facade.toJSON()).toEqual(morning);
		healthy(a);
		// Ids are kept: p2 (merged away) is freed from p1's claim, i1 and c
		// (deleted) are the same registry nodes, revived; nothing is created.
		expect(report.created).toBe(0);
		expect(report.revived).toBe(2);
		restore(a, evening);
		expect(a.facade.toJSON()).toEqual(evening);
		healthy(a);
		// A restore of the current state writes nothing.
		const before = Y.encodeStateVector(a.doc);
		restore(a, evening);
		expect(Y.encodeStateVector(a.doc)).toEqual(before);
		a.destroy();
	});

	it('unchanged text keeps its identity: only the changed middle is rewritten', () => {
		const a = open('ada', 2 ** 26 + 7);
		const morning = a.facade.toJSON();
		const anchor = a.facade.anchorAt('p1', 8, 'right'); // the 'e' of 'beta'
		ok(a.facade.insertText('p1', 5, ' GAMMA'));
		restore(a, morning);
		expect(a.facade.blockText('p1')).toBe('alpha beta');
		expect(a.facade.resolveAnchor(anchor)).toEqual({ blockId: 'p1', offset: 8 });
		a.destroy();
	});

	it('a restore concurrent with an edit converges on both replicas, the edit kept', () => {
		const a = open('ada', 2 ** 26 + 7);
		const b = open('bob', 2 ** 26 + 9);
		const sync = (from, to) =>
			crdt.sync.applyRemote(
				to.doc,
				Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
				'remote'
			);
		const morning = a.facade.toJSON();
		edit(a.facade);
		sync(a, b);
		// Concurrently: Ada restores the morning; Bob types into p1 and moves p3.
		restore(a, morning);
		ok(b.facade.insertText('p1', 0, '>> '));
		ok(b.facade.moveBlocks(['p3'], { parent: null, index: 0 }));
		sync(a, b);
		sync(b, a);
		expect(a.facade.toJSON()).toEqual(b.facade.toJSON());
		expect(a.facade.blockText('p1')).toContain('>> ');
		healthy(a);
		healthy(b);
		a.destroy();
		b.destroy();
	});

	it('a history tracking the restore undoes it in one step', () => {
		const a = open('ada', 2 ** 26 + 7);
		const morning = a.facade.toJSON();
		edit(a.facade);
		const evening = a.facade.toJSON();
		const um = a.facade.createUndoManager({
			captureTimeout: 0,
			trackedOrigins: new Set([RESTORE])
		});
		restore(a, morning);
		expect(um.undoStack).toHaveLength(1);
		um.undo();
		expect(a.facade.toJSON()).toEqual(evening);
		healthy(a);
		a.destroy();
	});

	it('an empty snapshot deletes every block; restoring back revives them', () => {
		const a = open('ada', 2 ** 26 + 7);
		const morning = a.facade.toJSON();
		restore(a, { children: [] });
		expect(a.facade.toJSON()).toEqual({ children: [] });
		restore(a, morning);
		expect(a.facade.toJSON()).toEqual(morning);
		healthy(a);
		a.destroy();
	});

	it('a snapshot block the registry lacks is created; document data is restored', () => {
		const a = open('ada', 2 ** 26 + 7);
		const target = {
			data: { title: 'Old title' },
			children: [
				{ id: 'new', type: 'paragraph', data: {}, content: [{ text: 'brand new' }] },
				...a.facade.toJSON().children
			]
		};
		ok(a.facade.patchData(null, [{ path: ['title'], value: 'Now' }]));
		const report = restore(a, target);
		expect(report.created).toBe(1);
		expect(a.facade.toJSON()).toEqual(target);
		healthy(a);
		a.destroy();
	});
});
