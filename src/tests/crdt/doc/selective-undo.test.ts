/**
 * U09 — selective local undo under concurrent remote edits.
 *
 * The local undo stack is registry-scoped and captures only LOCAL
 * transactions (remote-applied updates are non-local and carry foreign
 * origins). These tests prove that undoing local work never reverts
 * concurrent remote writes, that structural ops (moves) undo cleanly
 * while remote text edits survive, and that undo+redo converge on both
 * replicas.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, BOOTSTRAP_BLOCK_ID } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);

let clientSeq = 3000;
const undoOps = { captureTimeout: 0 };

const textOf = (ed: ReturnType<typeof E.create>, id: string) =>
	ed
		.runs(id)
		.map((r) => (r.kind === 'text' ? r.text : '​'))
		.join('');

/**
 * Two replicas sharing one bootstrap identity. `sync` pushes
 * state-vector deltas both ways — like a provider round-trip — with a
 * foreign origin so remote writes can never enter the local undo stack.
 */
const pair = () => {
	const d1 = new Y.Doc();
	d1.clientID = clientSeq++;
	const e1 = E.create(d1);
	e1.init();
	const d2 = new Y.Doc();
	d2.clientID = clientSeq++;
	Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
	const e2 = E.create(d2);
	const um = e1.createUndoManager(undoOps);
	const push = (from: Y.Doc, to: Y.Doc) =>
		Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
	const sync = () => {
		push(d1, d2);
		push(d2, d1);
	};
	return { d1, d2, e1, e2, um, push, sync };
};

describe('selective undo — remote writes are never undone locally', () => {
	it('concurrent text edits: local undo removes only the local insert', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'base');
		sync();

		e1.insertText(BOOTSTRAP_BLOCK_ID, 4, '-LOCAL');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'REMOTE-');
		sync();
		const merged = textOf(e1, BOOTSTRAP_BLOCK_ID);
		expect(merged).toContain('REMOTE-');
		expect(merged).toContain('-LOCAL');
		expect(merged).toContain('base');
		expect(e1.toJSON()).toEqual(e2.toJSON());

		um.undo();
		sync();
		const undone = textOf(e1, BOOTSTRAP_BLOCK_ID);
		expect(undone).toContain('REMOTE-');
		expect(undone).not.toContain('-LOCAL');
		expect(undone).toContain('base');
		expect(e1.toJSON()).toEqual(e2.toJSON());
	});

	it('local edit then remote text edit: undo keeps the remote text', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hello');
		sync();

		e1.insertText(BOOTSTRAP_BLOCK_ID, 5, ' local');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'R');
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('Rhello local');

		um.undo();
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('Rhello');
		expect(e1.toJSON()).toEqual(e2.toJSON());
	});

	it('local move + remote text edit: undo restores position, keeps remote text', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'a');
		e1.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		e1.insertText('b2', 0, 'b');
		e1.insertBlock({ parent: null, index: 2 }, { id: 'wrap', type: 'paragraph' });
		sync();

		// Local: nest b2 under wrap. Remote: append text into b2.
		e1.nestBlock('b2', 'wrap');
		e2.insertText('b2', 1, '-remote');
		sync();
		expect(e1.parentOf('b2')).toBe('wrap');
		expect(textOf(e1, 'b2')).toBe('b-remote');
		expect(e1.toJSON()).toEqual(e2.toJSON());

		um.undo();
		sync();
		expect(e1.parentOf('b2')).toBeNull();
		expect(textOf(e1, 'b2')).toBe('b-remote');
		expect(e1.toJSON()).toEqual(e2.toJSON());
	});

	it('undo + redo converge on both replicas', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'doc');
		sync();

		e1.insertText(BOOTSTRAP_BLOCK_ID, 3, '-L1');
		e1.insertText(BOOTSTRAP_BLOCK_ID, 6, '-L2');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'R>');
		sync();

		um.undo(); // removes -L2
		sync();
		um.redo(); // restores -L2
		sync();

		const converged = textOf(e1, BOOTSTRAP_BLOCK_ID);
		expect(converged).toBe('R>doc-L1-L2');
		expect(e1.toJSON()).toEqual(e2.toJSON());
	});

	it('remote edits between local ops only peel the local stack', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'xy');
		sync();

		e1.insertText(BOOTSTRAP_BLOCK_ID, 2, '1');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'r');
		sync();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 4, '2');
		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 's');
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('srxy12');

		um.undo(); // peel '2'
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('srxy1');
		um.undo(); // peel '1'
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('srxy');
		expect(e1.toJSON()).toEqual(e2.toJSON());
		// One item left: the pre-sync 'xy' insert. Remote inserts remain —
		// undo never touched them, and nothing remote was captured.
		expect(um.undoStack.length).toBe(1);
	});

	it('a remote delete next to a local insert stays deleted after undo', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'ab');
		sync();

		e1.insertText(BOOTSTRAP_BLOCK_ID, 2, 'L');
		e2.deleteText(BOOTSTRAP_BLOCK_ID, 0, 1); // remote removes 'a'
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('bL');

		um.undo();
		sync();
		expect(textOf(e1, BOOTSTRAP_BLOCK_ID)).toBe('b');
		expect(e1.toJSON()).toEqual(e2.toJSON());
	});

	it('remote-applied updates never enter the local stack even mid-session', () => {
		const { d1, d2, e1, e2, um, sync } = pair();
		e1.insertText(BOOTSTRAP_BLOCK_ID, 0, 'hi');
		sync();
		const depthAfterLocal = um.undoStack.length;

		e2.insertText(BOOTSTRAP_BLOCK_ID, 0, 'RR');
		e2.insertBlock({ parent: null, index: 1 }, { id: 'rb', type: 'paragraph' });
		sync();
		// Remote transactions are non-local → nothing captured.
		expect(um.undoStack.length).toBe(depthAfterLocal);
	});
});
