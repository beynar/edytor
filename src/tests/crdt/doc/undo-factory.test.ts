/**
 * Gate-2 finding 10 — the supported undo seam.
 *
 * `ed.createUndoManager()` is the factory U08 consumes: registry-scoped and
 * attached only after the doc carries the schema version record, so
 *
 * - `meta.v`/`meta.schema` writes are undo-inert (outside the `blocks`
 *   scope — undo can never strip the version stamp),
 * - the deterministic bootstrap insert predates attach and is never
 *   captured (undo can never leave a "versioned but empty" doc),
 * - remote/provider writes carry foreign origins and never enter the local
 *   stack.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { SCHEMA_VERSION, META_KEY } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

let clientSeq = 1000;
const seeded = () => {
	const doc = new Y.Doc();
	// Deterministic client ids — a random collision with another test's doc
	// would make remote writes look local (the engine even re-ids on clash).
	doc.clientID = clientSeq++;
	const ed = E.create(doc);
	ed.init();
	ed.insertText(DEFAULT_SEED_ID, 0, 'hello');
	return { doc, ed };
};

const undoOps = { captureTimeout: 0 };

describe('ed.createUndoManager — the supported undo seam', () => {
	it('undoes local content ops, never the bootstrap or version stamp', () => {
		const { doc, ed } = seeded();
		const um = ed.createUndoManager(undoOps);
		ed.insertText(DEFAULT_SEED_ID, 5, ' world');
		expect(ed.runs(DEFAULT_SEED_ID)[0].text).toBe('hello world');
		um.undo();
		expect(ed.runs(DEFAULT_SEED_ID)[0].text).toBe('hello');
		// Drain the stack: nothing before attach can be captured — the doc
		// keeps its bootstrap block and its meta.v version record.
		while (um.undoStack.length > 0) um.undo();
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
		expect(doc.get(META_KEY).getAttr('v')).toBe(SCHEMA_VERSION);
		expect(E.isInitialized(doc)).toBe(true);
	});

	it('undoing block ops leaves meta.v untouched', () => {
		const { doc, ed } = seeded();
		const um = ed.createUndoManager(undoOps);
		ed.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' });
		expect(ed.childrenIds(null)).toContain('b2');
		um.undo();
		expect(ed.childrenIds(null)).not.toContain('b2');
		expect(doc.get(META_KEY).getAttr('v')).toBe(SCHEMA_VERSION);
		um.redo();
		expect(ed.childrenIds(null)).toContain('b2');
	});

	it('remote-applied writes never enter the local undo stack', () => {
		const { doc, ed } = seeded();
		const um = ed.createUndoManager(undoOps);
		// A second replica: receive the local state FIRST (so both share one
		// bootstrap identity — a second init would LWW-race it), write
		// remotely, apply the remote state here.
		const remote = new Y.Doc();
		remote.clientID = clientSeq++;
		const edR = E.create(remote);
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
		edR.insertText(DEFAULT_SEED_ID, 0, 'REMOTE-');
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), 'fake-provider');
		expect(ed.runs(DEFAULT_SEED_ID)[0].text).toBe('REMOTE-hello');
		// The remote write must not be undoable locally.
		expect(um.undoStack.length).toBe(0);
		um.undo(); // no-op
		expect(ed.runs(DEFAULT_SEED_ID)[0].text).toBe('REMOTE-hello');
	});

	it('a doc-scoped manager attached before init cannot undo the seed', () => {
		// R13 §2.1 / D-3: the seed is applied as an update with a non-local
		// origin, so even a doc-scoped manager attached first never captures
		// it (it used to leave a versioned-but-empty document).
		const doc = new Y.Doc();
		const rawUm = new Y.UndoManager(doc, undoOps);
		const ed = E.create(doc);
		ed.init();
		expect(rawUm.undoStack.length).toBe(0);
		rawUm.undo();
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
	});

	it('createUndoManager on an uninitialized doc initializes first, then attaches', () => {
		const doc = new Y.Doc();
		const ed = E.create(doc);
		const um = ed.createUndoManager(undoOps);
		expect(ed.isInitialized()).toBe(true);
		// Nothing captured — bootstrap + stamp both predate attach.
		expect(um.undoStack.length).toBe(0);
		um.undo();
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
	});
});
