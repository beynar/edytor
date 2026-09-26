// @ts-nocheck
/**
 * U3 virtual-time coverage: production history coalescing driven by the
 * controlled clock, tested just before, at, and after the capture deadline —
 * no wall-clock sleeps.
 *
 * `vclock` mocks `lib0-v14/time.getUnixTime` for the whole module graph, so
 * the vendored `UndoManager`'s `now - lastChange < captureTimeout` merge
 * condition is fully deterministic.
 */
import { describe, expect, it } from 'vitest';
import { vclock } from './vclock.js';
import { createPeerPair } from './peer-set.js';
import { createModelOps } from './ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';

const ops = createModelOps();

const setup = (captureTimeout = 200) => {
	vclock.set(10_000);
	const set = createPeerPair(MODEL_BASE_SEED);
	set.clock = () => vclock.now;
	set.A.enableUndo({ scope: set.A.doc.get('blocks'), captureTimeout });
	return set;
};

describe('virtual clock — undo capture windows', () => {
	it('two edits inside the window coalesce into one stack item', () => {
		const { A } = setup();
		ops.insertText(A, 'b1', 5, 'x');
		vclock.advance(50);
		ops.insertText(A, 'b1', 6, 'y');
		expect(A.undoManager.undoStack.length).toBe(1);
	});

	it('an edit landing exactly at the deadline starts a new item', () => {
		const { A } = setup(200);
		ops.insertText(A, 'b1', 5, 'x');
		vclock.advance(200); // now - lastChange == captureTimeout → NOT merged
		ops.insertText(A, 'b1', 6, 'y');
		expect(A.undoManager.undoStack.length).toBe(2);
	});

	it('an edit one tick before the deadline still coalesces', () => {
		const { A } = setup(200);
		ops.insertText(A, 'b1', 5, 'x');
		vclock.advance(199);
		ops.insertText(A, 'b1', 6, 'y');
		expect(A.undoManager.undoStack.length).toBe(1);
	});

	it('undo across a coalesced item restores both edits atomically', () => {
		const { A } = setup();
		const before = ops.blockText(A, 'b1');
		ops.insertText(A, 'b1', 5, 'x');
		vclock.advance(50);
		ops.insertText(A, 'b1', 6, 'y');
		expect(ops.blockText(A, 'b1')).not.toBe(before);
		A.undoManager.undo();
		expect(ops.blockText(A, 'b1')).toBe(before);
	});

	it('trace timestamps follow the virtual clock', () => {
		const set = setup();
		vclock.advance(42);
		ops.insertText(set.A, 'b1', 0, 'z');
		const t = set.trace.filter((e) => e.kind === 'transact').at(-1)?.t;
		expect(t).toBe(vclock.now);
	});
});
