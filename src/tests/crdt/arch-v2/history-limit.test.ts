/**
 * P6 (CRDT study 2026-10): the undo history keeps the newest `limit` steps
 * (`history.limit`, 200 by default). A step that falls off releases what it
 * kept (the deleted content its undo would have restored), so the engine
 * collects that content and the document stops growing with old history;
 * the steps that remain undo as before, deleted text included (P11).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument, loadDocument, SemanticConflictError } from '$lib/crdt/index.js';
import { DEFAULT_HISTORY_LIMIT } from '$lib/crdt/edytor-doc.js';
import { seedUpdate } from './replica-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** A document holding one paragraph `p` ('x'), every commit its own step. */
const open = (limit?: number) =>
	loadDocument(seedUpdate([{ id: 'p', text: 'x' }]), {
		actor: { id: 'ada' },
		history: { captureTimeout: 0, ...(limit === undefined ? {} : { limit }) }
	});

describe('P6: the undo history keeps its newest steps', () => {
	it('holds 200 steps by default', () => {
		expect(DEFAULT_HISTORY_LIMIT).toBe(200);
		const document = open();
		const ed = document.facade;
		const um = document.history;
		for (let i = 0; i < 230; i++) ok(ed.insertText('p', 1, 'a'));
		expect(um.undoStack.length).toBe(200);
		document.destroy();
	});

	it('drops the oldest step past the limit; the kept ones undo', () => {
		const document = open(3);
		const ed = document.facade;
		const um = document.history;
		for (const ch of ['1', '2', '3', '4', '5'])
			ok(ed.insertText('p', ed.blockText('p').length, ch));
		expect(ed.blockText('p')).toBe('x12345');
		expect(um.undoStack.length).toBe(3);
		um.undo();
		um.undo();
		um.undo();
		expect(ed.blockText('p')).toBe('x12');
		expect(um.canUndo()).toBe(false);
		um.undo();
		expect(ed.blockText('p')).toBe('x12');
		um.redo();
		expect(ed.blockText('p')).toBe('x123');
		document.destroy();
	});

	it('Infinity keeps every step', () => {
		const document = open(Infinity);
		const ed = document.facade;
		for (let i = 0; i < 230; i++) ok(ed.insertText('p', 1, 'a'));
		expect(document.history.undoStack.length).toBe(230);
		document.destroy();
	});

	it('a kept text delete still comes back (P11)', () => {
		const document = open(2);
		const ed = document.facade;
		ok(ed.insertText('p', 1, 'hello'));
		ok(ed.deleteText('p', 1, 5));
		ok(ed.insertText('p', 1, '!'));
		expect(ed.blockText('p')).toBe('x!');
		document.history.undo();
		document.history.undo();
		expect(ed.blockText('p')).toBe('xhello');
		expect(document.history.canUndo()).toBe(false);
		document.destroy();
	});

	it('a dropped step releases what it kept: the deleted text is collected', () => {
		const text = 'lorem ipsum '.repeat(200);
		const run = (limit: number) => {
			const document = open(limit);
			const ed = document.facade;
			ok(ed.insertText('p', 1, text));
			ok(ed.deleteText('p', 1, text.length));
			const kept = document.encode().length;
			// Two more steps: with a limit of 2 the delete falls off.
			ok(ed.insertText('p', 1, 'a'));
			ok(ed.insertText('p', 2, 'b'));
			const after = document.encode().length;
			const steps = document.history.undoStack.length;
			document.destroy();
			return { kept, after, steps };
		};
		const capped = run(2);
		const open100 = run(100);
		// While its step is held, the deleted text is kept (its undo restores it).
		expect(capped.kept).toBeGreaterThan(text.length);
		expect(open100.after).toBeGreaterThan(text.length);
		// Once the step falls off, the engine collects it.
		expect(capped.steps).toBe(2);
		expect(capped.after).toBeLessThan(capped.kept - text.length / 2);
		expect(capped.after).toBeLessThan(open100.after - text.length / 2);
	});

	it('a reattach naming another limit is a conflict', () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc, { history: { limit: 10 } });
		expect(document.historyLimit).toBe(10);
		expect(attachDocument(doc, { history: { limit: 10 } })).toBe(document);
		expect(() => attachDocument(doc, { history: { limit: 20 } })).toThrowError(
			SemanticConflictError
		);
		document.destroy();
	});
});
