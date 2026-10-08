/**
 * arch-v2 §8.4 F-I16 (doc lane), §11.1 K15 — the composition capture window.
 *
 * A composition session keeps its previews and its commit in one undo step
 * by refreshing the engine's plain `UndoManager.lastChange` field before each
 * of its writes (R7: "composition previews are mechanical tracked writes
 * inside their session's capture group"). This pins the engine behavior the
 * session relies on, so an upstream merge that changes the field fails here
 * first (K15's fallback: a `captureTransaction` rule keyed by the session).
 *
 * Expected values come from the plan (undo gives the pre-composition text,
 * redo the committed text), never from running the code.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);
const CAPTURE_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const session = () => {
	const doc = new Y.Doc();
	const ed = E.create(doc);
	ed.init({ content: [{ id: 'p', type: 'paragraph', content: [{ kind: 'text', text: 'note' }] }] });
	const um = ed.createUndoManager({ captureTimeout: CAPTURE_MS });
	return { ed, um, text: () => ed.blockText('p') };
};

/** Previews にほん and the commit 日本, each after a gap longer than the capture timeout. */
const compose = async (
	ed: ReturnType<typeof session>['ed'],
	before: (step: number) => void
): Promise<void> => {
	let shown = 0;
	const steps = ['に', 'にほ', 'にほん', '日本'];
	for (const [index, value] of steps.entries()) {
		await sleep(CAPTURE_MS * 2);
		before(index);
		ed.transact(() => {
			if (shown) ed.deleteText('p', 4, shown);
			ed.insertText('p', 4, value);
		});
		shown = value.length;
	}
};

describe('K15 — the capture window held open by refreshing lastChange', () => {
	test('refreshed before each write: one stack item; undo → note, redo → note日本', async () => {
		const { ed, um, text } = session();
		await compose(ed, (step) => {
			if (step === 0) um.stopCapturing();
			else um.lastChange = Date.now();
		});
		expect(text()).toBe('note日本');
		expect(um.undoStack.length).toBe(1);
		um.undo();
		expect(text()).toBe('note');
		um.redo();
		expect(text()).toBe('note日本');
	});

	test('not refreshed: the gaps split the session and one undo leaves a preview', async () => {
		const { ed, um, text } = session();
		await compose(ed, () => {});
		expect(um.undoStack.length).toBe(4);
		um.undo();
		expect(text()).toBe('noteにほん');
	});
});
